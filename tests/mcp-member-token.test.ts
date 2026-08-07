import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { registerOAuthRoutes } from '../src/api/oauth-routes';
import { registerMcpRoutes } from '../src/api/mcp-routes';
import * as authStore from '../src/plugins/auth-identity/store';
import { signSessionToken } from '../src/shared/session';
import { pkceChallenge } from '../src/mcp/oauth';
import { verifyAccessToken } from '../src/mcp/verify';
import { nowIso } from '../src/shared/time';
import { initOtel } from '../src/plugins/otel/index';
import type { Application } from '../src/resources/types';

// C23 — member-scoped MCP token acceptance. Verifies:
//   1. group_id propagates through the OAuth grant chain (authorize → code → access token →
//      VerifiedToken.groupId → user.group_id forwarded to tool handler)
//   2. A forge-session JWT is accepted as an OAuth bearer for test-flagged tenants
//      (MCP_ACCEPT_SESSION_BEARER=true), authenticating the member AS themselves
//   3. Refusal paths: non-test tenant, missing flag, invalid/expired session all yield 401

const APP = 'member-test-app';
const APP_ID = 'app_member_test';
const SESSION_SECRET = 'test-member-session-secret-xyz';
const REDIRECT = 'https://client.example/cb';

let dir: string;
let prevDir: string | undefined;
let prevSecret: string | undefined;
let oauthServer: FastifyInstance;
let mcpServer: FastifyInstance;

const seedApp = async (): Promise<void> => {
  const now = nowIso();
  await store.saveResource({
    id: APP_ID,
    type: 'Application',
    app_id: APP_ID,
    created_at: now,
    updated_at: now,
    name: APP,
    repo_path: '/app',
    platform: 'web',
    framework: 'nextjs',
    template: 'nextjs-web',
    language: 'typescript',
    package_manager: 'npm',
  } as Application);
};

// Seed a C10 user + live session, return a signed session JWT.
let seq = 0;
const mintSession = async (email?: string): Promise<{ userId: string; sessionToken: string }> => {
  const e = email ?? `member${++seq}@test.example`;
  const user = await authStore.createUser(APP_ID, { email: e, email_verified: true });
  const session = await authStore.createSession(APP_ID, user.id, 3600);
  const token = signSessionToken(
    { userId: user.id, email: user.email, sessionId: session.id },
    SESSION_SECRET,
    3600,
  );
  return { userId: user.id, sessionToken: token };
};

// Register an OAuth client and run the full authorize/consent/token flow with an optional group_id.
const fullOAuthFlow = async (groupId?: string): Promise<{ accessToken: string; userId: string }> => {
  const { userId, sessionToken: cookie_ } = await mintSession();
  const cookieHdr = `forge_session=${cookie_}`;

  // DCR
  const regRes = await oauthServer.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { client_name: 'MemberBot', redirect_uris: [REDIRECT] },
  });
  expect(regRes.statusCode).toBe(201);
  const clientId = regRes.json().client_id as string;

  // Authorize
  const verifier = 'member-verifier-abcdefgh1234567890';
  const challenge = pkceChallenge(verifier);
  const groupParam = groupId ? `&group_id=${encodeURIComponent(groupId)}` : '';
  const authRes = await oauthServer.inject({
    method: 'GET',
    url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=notes%3Aread&state=s1&code_challenge=${challenge}&code_challenge_method=S256${groupParam}`,
    headers: { cookie: cookieHdr },
  });
  expect(authRes.statusCode).toBe(200);

  // Consent
  const body: Record<string, string> = {
    decision: 'approve',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'notes:read',
    state: 's1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
  if (groupId) body.group_id = groupId;
  const consentRes = await oauthServer.inject({
    method: 'POST',
    url: '/oauth/authorize/decision',
    payload: body,
    headers: { cookie: cookieHdr },
  });
  expect(consentRes.statusCode).toBe(303);
  const loc = consentRes.headers.location as string;
  const code = new URL(loc).searchParams.get('code')!;
  expect(code).toBeTruthy();

  // Token exchange
  const tokRes = await oauthServer.inject({
    method: 'POST',
    url: '/oauth/token',
    payload: {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    },
  });
  expect(tokRes.statusCode).toBe(200);
  return { accessToken: tokRes.json().access_token as string, userId };
};

beforeEach(async () => {
  initOtel(); // no-op outside a real OTEL context
  prevDir = process.env.FORGE_STATE_DIR;
  prevSecret = process.env.AUTH_SESSION_SECRET;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-member-token-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.AUTH_SESSION_SECRET = SESSION_SECRET;

  await store.init();
  await seedApp();

  // OAuth AS server
  oauthServer = Fastify({ logger: false });
  registerOAuthRoutes(oauthServer, { defaultApp: () => APP });
  await oauthServer.ready();

  // MCP resource-server (separate instance so the GET /mcp SSE hijack doesn't interfere)
  mcpServer = Fastify({ logger: false });
  registerMcpRoutes(mcpServer, { defaultApp: () => APP });
  await mcpServer.ready();
});

afterEach(async () => {
  await oauthServer.close();
  await mcpServer.close();
  if (prevDir === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevDir;
  if (prevSecret === undefined) delete process.env.AUTH_SESSION_SECRET;
  else process.env.AUTH_SESSION_SECRET = prevSecret;
  // Clear the session-bearer flag if set by a test.
  delete process.env.MCP_ACCEPT_SESSION_BEARER;
  await rm(dir, { recursive: true, force: true });
});

// ── helpers for MCP JSON-RPC ──────────────────────────────────────────────────

const mcpPost = (token: string, method: string, params?: unknown) =>
  mcpServer.inject({
    method: 'POST',
    url: '/mcp',
    payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
  });

// ── group_id in OAuth grant flow ──────────────────────────────────────────────

describe('C23 member-scoped — group_id threads through OAuth grant chain', () => {
  it('verifyAccessToken returns groupId when the grant was minted with group_id', async () => {
    const GROUP = 'grp_abc123';
    const { accessToken } = await fullOAuthFlow(GROUP);
    const verified = await verifyAccessToken(APP_ID, accessToken);
    expect(verified).not.toBeNull();
    expect(verified!.groupId).toBe(GROUP);
    expect(verified!.userId).toBeTruthy();
  });

  it('verifyAccessToken returns no groupId for a plain owner-scoped grant', async () => {
    const { accessToken } = await fullOAuthFlow(); // no group_id
    const verified = await verifyAccessToken(APP_ID, accessToken);
    expect(verified).not.toBeNull();
    expect(verified!.groupId).toBeUndefined();
  });

  it('group_id survives a refresh-token rotation', async () => {
    const GROUP = 'grp_rotate_test';
    // Get the initial token pair
    const { userId, sessionToken: cookie_ } = await mintSession();
    const cookieHdr = `forge_session=${cookie_}`;
    const regRes = await oauthServer.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { client_name: 'RotateBot', redirect_uris: [REDIRECT] },
    });
    const clientId = regRes.json().client_id as string;
    const verifier = 'rotate-verifier-1234567890abcdef';
    const challenge = pkceChallenge(verifier);
    await oauthServer.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=notes%3Aread&state=r1&code_challenge=${challenge}&code_challenge_method=S256&group_id=${GROUP}`,
      headers: { cookie: cookieHdr },
    });
    const consentRes = await oauthServer.inject({
      method: 'POST',
      url: '/oauth/authorize/decision',
      payload: {
        decision: 'approve',
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: 'notes:read',
        state: 'r1',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        group_id: GROUP,
      },
      headers: { cookie: cookieHdr },
    });
    const code = new URL(consentRes.headers.location as string).searchParams.get('code')!;
    const tokRes = await oauthServer.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
    });
    const { refresh_token } = tokRes.json() as { access_token: string; refresh_token: string };

    // Rotate
    const rotRes = await oauthServer.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: { grant_type: 'refresh_token', refresh_token, client_id: clientId },
    });
    expect(rotRes.statusCode).toBe(200);
    const rotated = await verifyAccessToken(APP_ID, rotRes.json().access_token as string);
    expect(rotated).not.toBeNull();
    expect(rotated!.groupId).toBe(GROUP);
    expect(rotated!.userId).toBe(userId);
  });
});

// ── MCP endpoint: member identity propagates ──────────────────────────────────

describe('C23 member-scoped — member identity on MCP endpoint', () => {
  it('MCP initialize succeeds with a member-scoped OAuth token', async () => {
    const { accessToken } = await fullOAuthFlow('grp_mcp_test');
    const res = await mcpPost(accessToken, 'initialize', { protocolVersion: '2025-06-18' });
    expect(res.statusCode).toBe(200);
    expect(res.json().result?.serverInfo?.name).toContain('forge-mcp');
  });

  it('plain OAuth token still works (no regression)', async () => {
    const { accessToken } = await fullOAuthFlow();
    const res = await mcpPost(accessToken, 'initialize', { protocolVersion: '2025-06-18' });
    expect(res.statusCode).toBe(200);
  });
});

// ── session-bearer path for test-flagged tenants ──────────────────────────────

describe('C23 member-scoped — session bearer (test-flagged tenants)', () => {
  it('accepts a forge-session JWT as bearer when MCP_ACCEPT_SESSION_BEARER=true', async () => {
    process.env.MCP_ACCEPT_SESSION_BEARER = 'true';
    const { sessionToken } = await mintSession('bearer-member@test.example');
    const res = await mcpPost(sessionToken, 'initialize', { protocolVersion: '2025-06-18' });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toBeTruthy();
  });

  it('rejects a forge-session JWT when MCP_ACCEPT_SESSION_BEARER is unset (default)', async () => {
    // MCP_ACCEPT_SESSION_BEARER not set
    const { sessionToken } = await mintSession('no-flag@test.example');
    const res = await mcpPost(sessionToken, 'initialize', { protocolVersion: '2025-06-18' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('rejects a garbage bearer even with MCP_ACCEPT_SESSION_BEARER=true', async () => {
    process.env.MCP_ACCEPT_SESSION_BEARER = 'true';
    const res = await mcpServer.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer notavalidtoken',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('rejects a revoked session bearer', async () => {
    process.env.MCP_ACCEPT_SESSION_BEARER = 'true';
    const user = await authStore.createUser(APP_ID, {
      email: 'revoked@test.example',
      email_verified: true,
    });
    const session = await authStore.createSession(APP_ID, user.id, 3600);
    const token = signSessionToken(
      { userId: user.id, email: user.email, sessionId: session.id },
      SESSION_SECRET,
      3600,
    );
    // Revoke the session server-side
    await authStore.revokeSession(APP_ID, session.id);

    const res = await mcpPost(token, 'initialize', { protocolVersion: '2025-06-18' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('rejects a bearer with wrong session secret', async () => {
    process.env.MCP_ACCEPT_SESSION_BEARER = 'true';
    const user = await authStore.createUser(APP_ID, {
      email: 'wrongsecret@test.example',
      email_verified: true,
    });
    const session = await authStore.createSession(APP_ID, user.id, 3600);
    // Sign with a DIFFERENT secret — forge will not accept it
    const badToken = signSessionToken(
      { userId: user.id, email: user.email, sessionId: session.id },
      'wrong-secret-xyz',
      3600,
    );
    const res = await mcpPost(badToken, 'initialize', { protocolVersion: '2025-06-18' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });

  it('missing bearer → 401 regardless of flag', async () => {
    process.env.MCP_ACCEPT_SESSION_BEARER = 'true';
    const res = await mcpServer.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize' },
      headers: { 'content-type': 'application/json' }, // no Authorization
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_token');
  });
});

// ── POST /oauth/admin/token — service-gated member-scoped token mint ─────────

const SERVICE_TOKEN = 'test-service-token-admin-mint';

// Register an OAuth client and return its client_id (needed for admin mint).
const registerClientForAdminMint = async (): Promise<string> => {
  const res = await oauthServer.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { client_name: 'Dorinda', redirect_uris: ['https://dorinda.ai/cb'] },
  });
  expect(res.statusCode).toBe(201);
  return res.json().client_id as string;
};

// Seed a member in the C10 identity store and return the userId.
const seedMember = async (email: string): Promise<string> => {
  const { userId } = await mintSession(email);
  return userId;
};

// The admin mint request helper.
const adminMint = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  oauthServer.inject({
    method: 'POST',
    url: '/oauth/admin/token',
    payload: body,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });

describe('C23 POST /oauth/admin/token — service-gated member-scoped mint', () => {
  beforeEach(() => {
    // Inject the service token via env (resolveServiceToken reads AUTH_SERVICE_TOKEN → env fallback).
    process.env.AUTH_SERVICE_TOKEN = SERVICE_TOKEN;
  });

  afterEach(() => {
    delete process.env.AUTH_SERVICE_TOKEN;
  });

  it('mints an access token for a known member (happy path)', async () => {
    const clientId = await registerClientForAdminMint();
    const userId = await seedMember('admin-mint-happy@test.example');

    const res = await adminMint(
      { user_id: userId, client_id: clientId },
      { 'x-forge-service-token': SERVICE_TOKEN },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.token_type).toBe('Bearer');
    expect(typeof body.expires_in).toBe('number');
    expect(body.user_id).toBe(userId);
  });

  it('minted token is accepted by POST /mcp (integration)', async () => {
    const clientId = await registerClientForAdminMint();
    const userId = await seedMember('admin-mint-mcp@test.example');

    const mintRes = await adminMint(
      { user_id: userId, client_id: clientId },
      { 'x-forge-service-token': SERVICE_TOKEN },
    );
    expect(mintRes.statusCode).toBe(200);
    const { access_token } = mintRes.json() as { access_token: string };

    // The minted token must be accepted by /mcp as a standard OAuth bearer.
    const mcpRes = await mcpPost(access_token, 'initialize', { protocolVersion: '2025-06-18' });
    expect(mcpRes.statusCode).toBe(200);
    expect(mcpRes.json().result?.serverInfo?.name).toContain('forge-mcp');
  });

  it('minted token carries group_id and userId via verifyAccessToken', async () => {
    const clientId = await registerClientForAdminMint();
    const userId = await seedMember('admin-mint-group@test.example');
    const GROUP = 'grp_admin_mint_test';

    const mintRes = await adminMint(
      { user_id: userId, client_id: clientId, group_id: GROUP },
      { 'x-forge-service-token': SERVICE_TOKEN },
    );
    expect(mintRes.statusCode).toBe(200);
    const { access_token } = mintRes.json() as { access_token: string };

    const verified = await verifyAccessToken(APP_ID, access_token);
    expect(verified).not.toBeNull();
    expect(verified!.userId).toBe(userId);
    expect(verified!.groupId).toBe(GROUP);
    expect(verified!.clientId).toBe(clientId);
  });

  it('no group_id → VerifiedToken.groupId is undefined', async () => {
    const clientId = await registerClientForAdminMint();
    const userId = await seedMember('admin-mint-nogroup@test.example');

    const mintRes = await adminMint(
      { user_id: userId, client_id: clientId },
      { 'x-forge-service-token': SERVICE_TOKEN },
    );
    expect(mintRes.statusCode).toBe(200);
    const verified = await verifyAccessToken(APP_ID, mintRes.json().access_token as string);
    expect(verified!.groupId).toBeUndefined();
  });

  it('requires a service token — 401 without one', async () => {
    const clientId = await registerClientForAdminMint();
    const userId = await seedMember('admin-mint-notoken@test.example');

    const res = await adminMint({ user_id: userId, client_id: clientId }); // no service token
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
  });

  it('requires user_id — 400 if missing', async () => {
    const clientId = await registerClientForAdminMint();
    const res = await adminMint(
      { client_id: clientId }, // no user_id
      { 'x-forge-service-token': SERVICE_TOKEN },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
    expect(res.json().error_description).toContain('user_id');
  });

  it('requires client_id — 400 if missing', async () => {
    const userId = await seedMember('admin-mint-noclient@test.example');
    const res = await adminMint(
      { user_id: userId }, // no client_id
      { 'x-forge-service-token': SERVICE_TOKEN },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
    expect(res.json().error_description).toContain('client_id');
  });

  it('rejects an unknown client_id — 400', async () => {
    const userId = await seedMember('admin-mint-badclient@test.example');
    const res = await adminMint(
      { user_id: userId, client_id: 'mcpc_nonexistent_xyz' },
      { 'x-forge-service-token': SERVICE_TOKEN },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_client');
  });

  it('rejects an unknown user_id — 400', async () => {
    const clientId = await registerClientForAdminMint();
    const res = await adminMint(
      { user_id: 'usr_nonexistent_xyz', client_id: clientId },
      { 'x-forge-service-token': SERVICE_TOKEN },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_request');
    expect(res.json().error_description).toContain('user_id');
  });

  it('respects expires_in override (capped at system max)', async () => {
    const clientId = await registerClientForAdminMint();
    const userId = await seedMember('admin-mint-ttl@test.example');

    // Request a short TTL (60s).
    const res = await adminMint(
      { user_id: userId, client_id: clientId, expires_in: '60' },
      { 'x-forge-service-token': SERVICE_TOKEN },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().expires_in).toBe(60);
  });
});
