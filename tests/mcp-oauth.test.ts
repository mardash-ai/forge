import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { registerOAuthRoutes } from '../src/api/oauth-routes';
import * as authStore from '../src/plugins/auth-identity/store';
import { signSessionToken } from '../src/shared/session';
import { pkceChallenge } from '../src/mcp/oauth';
import { verifyAccessToken } from '../src/mcp/verify';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';

// C23 — the OAuth 2.1 authorization-server flow, end to end. Exercised through the configured MCP store
// (filesystem on the default run, Postgres on the pg run) + the C10 session — so this whole suite validates
// register → authorize → consent → code → token (PKCE) → refresh rotation → revoke on BOTH backends.
const APP = 'demo';
const APP_ID = 'app_demo';
const SESSION_SECRET = 'test-oauth-session-secret';
const REDIRECT = 'https://client.example/cb';
let dir: string;
let prevDir: string | undefined;
let prevSecret: string | undefined;
let server: FastifyInstance;

const seedApp = async (): Promise<void> => {
  const now = nowIso();
  await store.saveResource({
    id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
    name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web', language: 'typescript', package_manager: 'npm',
  } as Application);
};

// Craft a logged-in C10 session cookie (a real user + server-side session + signed access token). Each call
// mints a UNIQUE user so a test can log in more than once (e.g. one login per authorization code).
let userSeq = 0;
const loginCookie = async (email = `user${++userSeq}@demo.test`): Promise<{ userId: string; cookie: string }> => {
  const user = await authStore.createUser(APP_ID, { email, email_verified: true });
  const session = await authStore.createSession(APP_ID, user.id, 3600);
  const token = signSessionToken({ userId: user.id, email: user.email, sessionId: session.id }, SESSION_SECRET, 3600);
  return { userId: user.id, cookie: `forge_session=${token}` };
};

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevSecret = process.env.AUTH_SESSION_SECRET;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-mcp-oauth-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.AUTH_SESSION_SECRET = SESSION_SECRET; // resolveAuthConfig picks this up via the env fallback
  await store.init();
  await seedApp();
  server = Fastify({ logger: false });
  registerOAuthRoutes(server, { defaultApp: () => APP });
  await server.ready();
});
afterEach(async () => {
  await server.close();
  if (prevDir === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prevDir;
  if (prevSecret === undefined) delete process.env.AUTH_SESSION_SECRET; else process.env.AUTH_SESSION_SECRET = prevSecret;
  await rm(dir, { recursive: true, force: true });
});

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  server.inject({ method: 'POST', url, payload: payload as object, headers });
const get = (url: string, headers: Record<string, string> = {}) => server.inject({ method: 'GET', url, headers });

// Register a public (PKCE) client and return its client_id.
const registerClient = async (): Promise<string> => {
  const r = await post('/oauth/register', { client_name: 'ChatGPT', redirect_uris: [REDIRECT] });
  expect(r.statusCode).toBe(201);
  return r.json().client_id;
};

const authorizeUrl = (clientId: string, challenge: string, scope = 'notes:read') =>
  `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent(scope)}&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`;

describe('C23 — discovery + dynamic client registration', () => {
  it('serves AS metadata and registers a public client', async () => {
    const meta = (await get('/.well-known/oauth-authorization-server', { host: 'app.example' })).json();
    expect(meta).toMatchObject({
      issuer: 'https://app.example',
      authorization_endpoint: 'https://app.example/oauth/authorize',
      token_endpoint: 'https://app.example/oauth/token',
      code_challenge_methods_supported: ['S256'],
    });
    const reg = await post('/oauth/register', { client_name: 'App', redirect_uris: [REDIRECT] });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().client_id).toMatch(/^mcpc_/);
    expect(reg.json().client_secret).toBeUndefined(); // public client — no secret

    // A registration with no valid redirect_uri is rejected.
    expect((await post('/oauth/register', { redirect_uris: [] })).statusCode).toBe(400);
  });

  // The AS issuer is the MACHINE-FACING api host — FORGE_MCP_PUBLIC_URL pins it, winning over the
  // browser-facing FORGE_OAUTH_PUBLIC_URL (the app host) when both are set (the host-split).
  it('the AS issuer prefers FORGE_MCP_PUBLIC_URL over FORGE_OAUTH_PUBLIC_URL (host split)', async () => {
    const prevMcp = process.env.FORGE_MCP_PUBLIC_URL;
    const prevOauth = process.env.FORGE_OAUTH_PUBLIC_URL;
    process.env.FORGE_OAUTH_PUBLIC_URL = 'https://app.dorinda.ai';
    process.env.FORGE_MCP_PUBLIC_URL = 'https://api.dorinda.ai';
    try {
      const meta = (await get('/.well-known/oauth-authorization-server')).json();
      expect(meta.issuer).toBe('https://api.dorinda.ai');
      expect(meta.token_endpoint).toBe('https://api.dorinda.ai/oauth/token');
    } finally {
      if (prevMcp === undefined) delete process.env.FORGE_MCP_PUBLIC_URL; else process.env.FORGE_MCP_PUBLIC_URL = prevMcp;
      if (prevOauth === undefined) delete process.env.FORGE_OAUTH_PUBLIC_URL; else process.env.FORGE_OAUTH_PUBLIC_URL = prevOauth;
    }
  });
});

describe('C23 — authorize + consent (requires a C10 login)', () => {
  it('bounces to the hosted login when unauthenticated, renders consent when logged in', async () => {
    const clientId = await registerClient();
    const challenge = pkceChallenge('verifier-abc-1234567890');

    const anon = await get(authorizeUrl(clientId, challenge));
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toContain('/auth/login?next=');

    const { cookie } = await loginCookie();
    const consent = await get(authorizeUrl(clientId, challenge), { cookie });
    expect(consent.statusCode).toBe(200);
    expect(consent.body).toContain('notes:read');
    expect(consent.body.toLowerCase()).toContain('allow');
  });

  it('rejects an unregistered redirect_uri and a missing PKCE challenge', async () => {
    const clientId = await registerClient();
    const { cookie } = await loginCookie();
    const bad = await get(`/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('https://evil.test/cb')}&code_challenge=x`, { cookie });
    expect(bad.statusCode).toBe(400);
    // No code_challenge → redirect back with error=invalid_request (PKCE mandatory).
    const noPkce = await get(`/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}`, { cookie });
    expect(noPkce.statusCode).toBe(303);
    expect(noPkce.headers.location).toContain('error=invalid_request');
  });
});

describe('C23 — the full authorization_code + PKCE + refresh flow', () => {
  const verifier = 'the-pkce-code-verifier-0123456789abcdef';

  const runToCode = async (): Promise<{ clientId: string; code: string; userId: string }> => {
    const clientId = await registerClient();
    const challenge = pkceChallenge(verifier);
    const { cookie, userId } = await loginCookie();
    // approve the consent → an authorization code on the redirect
    const decision = await post('/oauth/authorize/decision', {
      client_id: clientId, redirect_uri: REDIRECT, scope: 'notes:read notes:write', state: 'xyz',
      code_challenge: challenge, code_challenge_method: 'S256', decision: 'approve',
    }, { cookie });
    expect(decision.statusCode).toBe(303);
    const url = new URL(decision.headers.location as string);
    expect(url.searchParams.get('state')).toBe('xyz');
    return { clientId, code: url.searchParams.get('code')!, userId };
  };

  it('exchanges a code for scoped tokens, rotates the refresh, and revokes', async () => {
    const { clientId, code, userId } = await runToCode();

    // Wrong verifier → invalid_grant (PKCE enforced).
    const badPkce = await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: 'wrong', client_id: clientId, redirect_uri: REDIRECT });
    expect(badPkce.statusCode).toBe(400);
    expect(badPkce.json().error).toBe('invalid_grant');

    // The code is now CONSUMED by the failed attempt (one-shot) — mint a fresh one for the happy path.
    const fresh = await runToCode();
    const tok = await post('/oauth/token', { grant_type: 'authorization_code', code: fresh.code, code_verifier: verifier, client_id: fresh.clientId, redirect_uri: REDIRECT });
    expect(tok.statusCode).toBe(200);
    const body = tok.json();
    expect(body).toMatchObject({ token_type: 'Bearer', scope: 'notes:read notes:write' });
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');

    // The access token verifies → user + scopes (the resource-server seam).
    const verified = await verifyAccessToken(APP_ID, body.access_token);
    expect(verified).toMatchObject({ userId: fresh.userId, clientId: fresh.clientId });
    expect(verified!.scopes.sort()).toEqual(['notes:read', 'notes:write']);

    // Refresh rotates: a new access + refresh; the OLD refresh is now dead (one-shot rotation).
    const refreshed = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: fresh.clientId });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().access_token).not.toBe(body.access_token);
    const replay = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: fresh.clientId });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_grant');

    // Refresh may NARROW scope but never widen it.
    const narrowed = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshed.json().refresh_token, client_id: fresh.clientId, scope: 'notes:read' });
    expect(narrowed.json().scope).toBe('notes:read');

    // Revoke the access token → it no longer verifies.
    await post('/oauth/revoke', { token: tok.json().access_token });
    expect(await verifyAccessToken(APP_ID, tok.json().access_token)).toBeNull();
    // (unused) keep userId referenced
    expect(userId).toBeTruthy();
  });

  it('denying consent redirects with error=access_denied', async () => {
    const clientId = await registerClient();
    const challenge = pkceChallenge(verifier);
    const { cookie } = await loginCookie();
    const decision = await post('/oauth/authorize/decision', {
      client_id: clientId, redirect_uri: REDIRECT, scope: 'notes:read', state: 'zzz',
      code_challenge: challenge, code_challenge_method: 'S256', decision: 'deny',
    }, { cookie });
    expect(decision.statusCode).toBe(303);
    expect(decision.headers.location).toContain('error=access_denied');
  });
});

// Change A — RFC 8707 resource indicator: the `resource` requested at authorize binds onto the code and is
// threaded onto the issued access/refresh tokens; a mismatch at token exchange is rejected; and a flow with
// NO resource still issues a working (unbound) token (BACK-COMPAT — existing live clients keep working).
describe('Change A — RFC 8707 resource/audience binding round-trips authorize → token', () => {
  const verifier = 'the-pkce-code-verifier-0123456789abcdef';
  const RESOURCE = 'https://api.example/mcp';

  // Mint an authorization code, optionally carrying a `resource` (as the consent form would post it).
  const codeWithResource = async (resource?: string): Promise<{ clientId: string; code: string; userId: string }> => {
    const clientId = await registerClient();
    const challenge = pkceChallenge(verifier);
    const { cookie, userId } = await loginCookie();
    const decision = await post('/oauth/authorize/decision', {
      client_id: clientId, redirect_uri: REDIRECT, scope: 'notes:read', state: 'r1',
      code_challenge: challenge, code_challenge_method: 'S256', decision: 'approve',
      ...(resource ? { resource } : {}),
    }, { cookie });
    expect(decision.statusCode).toBe(303);
    const url = new URL(decision.headers.location as string);
    return { clientId, code: url.searchParams.get('code')!, userId };
  };

  it('binds the resource onto the access token: matching verify passes, a different resource is rejected', async () => {
    const { clientId, code, userId } = await codeWithResource(RESOURCE);
    const tok = await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE });
    expect(tok.statusCode).toBe(200);
    const access = tok.json().access_token as string;
    // Verifies for the bound resource + surfaces it on VerifiedToken.
    expect(await verifyAccessToken(APP_ID, access, RESOURCE)).toMatchObject({ userId, resource: RESOURCE });
    // Rejected against a DIFFERENT resource; and an unbound check (no expected resource) still passes.
    expect(await verifyAccessToken(APP_ID, access, 'https://evil.example/mcp')).toBeNull();
    expect(await verifyAccessToken(APP_ID, access)).toMatchObject({ userId, resource: RESOURCE });

    // The binding survives a refresh rotation.
    const refreshed = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: tok.json().refresh_token, client_id: clientId });
    expect(refreshed.statusCode).toBe(200);
    expect(await verifyAccessToken(APP_ID, refreshed.json().access_token, RESOURCE)).toMatchObject({ userId, resource: RESOURCE });
  });

  it('rejects a token exchange whose resource does not match the code (invalid_target)', async () => {
    const { clientId, code } = await codeWithResource(RESOURCE);
    const bad = await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: 'https://evil.example/mcp' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_target');
  });

  it('a code with NO resource still issues a working, UNBOUND token — back-compat', async () => {
    const { clientId, code, userId } = await codeWithResource(); // no resource requested
    const tok = await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
    expect(tok.statusCode).toBe(200);
    // Even when a resource server expects one, an unbound token still verifies (existing live tokens keep working).
    const v = await verifyAccessToken(APP_ID, tok.json().access_token, RESOURCE);
    expect(v).toMatchObject({ userId });
    expect(v!.resource).toBeUndefined();
  });

  it('threads the resource through the GET /oauth/authorize consent form', async () => {
    const clientId = await registerClient();
    const challenge = pkceChallenge(verifier);
    const { cookie } = await loginCookie();
    const consent = await get(
      `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=notes:read&state=xyz&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(RESOURCE)}`,
      { cookie },
    );
    expect(consent.statusCode).toBe(200);
    expect(consent.body).toContain('name="resource"');
    expect(consent.body).toContain(RESOURCE);
  });
});
