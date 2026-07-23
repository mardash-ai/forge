import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { getBackends } from '../src/storage/backends';
import { registerConnectRoutes } from '../src/api/connect-routes';
import { setSecret, openValue } from '../src/plugins/secrets-local/index';
import * as authStore from '../src/plugins/auth-identity/store';
import { signSessionToken } from '../src/shared/session';
import { setOutboundOAuthClient, resetOutboundOAuthClient, type OutboundOAuthClient, type TokenSet } from '../src/connectors/oauth-client';
import { resolveProvider, availableProviders } from '../src/connectors/config';
import { getFreshAccessToken } from '../src/connectors/service';
import { connectionsFile } from '../src/shared/paths';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';

// C24 — the third-party connector vault / outbound OAuth capability. Exercised through the configured
// `connections` store backend (filesystem default / Postgres on the pg run) with a STUB OAuth provider
// standing in for Google — so the connect handshake, encryption-at-rest, transparent auto-refresh, the
// broker (session AND service-token paths), disconnect, and graceful degradation are all validated on BOTH
// backends without a network call.
const APP = 'demo';
const APP_ID = 'app_demo';
const SESSION_SECRET = 'connectors-test-session-secret';

let dir: string;
let prevDir: string | undefined;
let prevKey: string | undefined;
let server: FastifyInstance;

// --- mutable stub provider ------------------------------------------------------
let exchanges: Array<{ code: string; codeVerifier: string; clientId: string }>;
let refreshes: Array<{ refreshToken: string }>;
let revokes: Array<{ token: string }>;
let nextExchange: TokenSet;
let nextRefresh: TokenSet;

const stubClient: OutboundOAuthClient = {
  authorizeUrl: (o) =>
    `${o.provider.authorization_endpoint}?client_id=${encodeURIComponent(o.clientId)}&state=${encodeURIComponent(o.state)}` +
    `&redirect_uri=${encodeURIComponent(o.redirectUri)}&code_challenge=${encodeURIComponent(o.codeChallenge)}&scope=${encodeURIComponent(o.scopes.join(' '))}`,
  exchangeCode: async (o) => {
    exchanges.push({ code: o.code, codeVerifier: o.codeVerifier, clientId: o.clientId });
    return nextExchange;
  },
  refresh: async (o) => {
    refreshes.push({ refreshToken: o.refreshToken });
    return nextRefresh;
  },
  revoke: async (o) => {
    revokes.push({ token: o.token });
  },
};

const seedApp = async (): Promise<void> => {
  const now = nowIso();
  await store.saveResource({
    id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
    name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web', language: 'typescript', package_manager: 'npm',
  } as Application);
};

// A logged-in C10 session cookie header for a fresh user.
const signIn = async (email = 'user@demo.test'): Promise<{ userId: string; cookie: string }> => {
  const user = await authStore.createUser(APP_ID, { email, email_verified: true });
  const session = await authStore.createSession(APP_ID, user.id, 3600);
  const token = signSessionToken({ userId: user.id, email: user.email, sessionId: session.id }, SESSION_SECRET);
  return { userId: user.id, cookie: `forge_session=${token}` };
};

const configureGoogle = async (): Promise<void> => {
  await setSecret(APP_ID, 'GOOGLE_CONNECT_CLIENT_ID', 'google-connect-client');
  await setSecret(APP_ID, 'GOOGLE_CONNECT_CLIENT_SECRET', 'google-connect-secret');
};

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevKey = process.env.FORGE_SECRETS_KEY;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-connectors-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_SECRETS_KEY = 'connectors-test-master-key';
  await store.init();
  await seedApp();
  await setSecret(APP_ID, 'AUTH_SESSION_SECRET', SESSION_SECRET);

  exchanges = [];
  refreshes = [];
  revokes = [];
  nextExchange = { access_token: 'google-access-1', refresh_token: 'google-refresh-1', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/gmail.send', account_label: 'user@gmail.test' };
  nextRefresh = { access_token: 'google-access-2', refresh_token: 'google-refresh-2', expires_in: 3600 };
  setOutboundOAuthClient(stubClient);

  server = Fastify({ logger: false });
  registerConnectRoutes(server, { defaultApp: () => APP });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  resetOutboundOAuthClient();
  if ((await getBackends()).connections.__truncateAllForTests) await (await getBackends()).connections.__truncateAllForTests!();
  if (prevDir === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prevDir;
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY; else process.env.FORGE_SECRETS_KEY = prevKey;
  await rm(dir, { recursive: true, force: true });
});

// Drive start → capture state → callback. Returns the callback response.
async function connect(cookie: string, opts: { scopes?: string; return_to?: string } = {}) {
  const qs = new URLSearchParams(opts as Record<string, string>).toString();
  const start = await server.inject({ method: 'GET', url: `/connect/google/start${qs ? `?${qs}` : ''}`, headers: { cookie } });
  expect(start.statusCode).toBe(302);
  const loc = new URL(start.headers.location as string);
  const state = loc.searchParams.get('state')!;
  const cb = await server.inject({ method: 'GET', url: `/connect/google/callback?code=auth-code-xyz&state=${encodeURIComponent(state)}`, headers: { cookie } });
  return { start, state, cb, authorizeUrl: loc };
}

describe('C24 — provider registry + credential resolution', () => {
  it('a provider is unconfigured until BOTH client creds resolve (graceful degradation)', async () => {
    expect(await resolveProvider(APP_ID, 'google')).toBeNull();
    expect(await availableProviders(APP_ID)).toEqual([]);
    await setSecret(APP_ID, 'GOOGLE_CONNECT_CLIENT_ID', 'id-only');
    expect(await resolveProvider(APP_ID, 'google')).toBeNull(); // secret still missing
    await setSecret(APP_ID, 'GOOGLE_CONNECT_CLIENT_SECRET', 'secret');
    const resolved = await resolveProvider(APP_ID, 'google');
    expect(resolved?.clientId).toBe('id-only');
    expect(resolved?.descriptor.default_scopes).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(await availableProviders(APP_ID)).toEqual(['google']);
  });

  it('an unknown provider is not resolvable', async () => {
    expect(await resolveProvider(APP_ID, 'nope')).toBeNull();
  });

  it('GET /connect/providers lists registered providers + whether each is configured', async () => {
    await configureGoogle();
    const res = await server.inject({ method: 'GET', url: '/connect/providers' });
    expect(res.statusCode).toBe(200);
    const providers = res.json().providers as Array<{ id: string; configured: boolean }>;
    const google = providers.find((p) => p.id === 'google')!;
    expect(google.configured).toBe(true);
    expect(providers.find((p) => p.id === 'microsoft')!.configured).toBe(false); // registered, not provisioned
  });
});

describe('C24 — connect handshake', () => {
  it('start requires a session; anonymous is bounced to the hosted login', async () => {
    await configureGoogle();
    const res = await server.inject({ method: 'GET', url: '/connect/google/start' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/auth/login?next=');
  });

  it('start on an unconfigured provider degrades to 503 (never a crash)', async () => {
    const { cookie } = await signIn();
    const res = await server.inject({ method: 'GET', url: '/connect/google/start', headers: { cookie } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('dependency_unavailable');
  });

  it('start redirects to the provider consent with PKCE + state + offline scopes', async () => {
    await configureGoogle();
    const { cookie } = await signIn();
    const start = await server.inject({ method: 'GET', url: '/connect/google/start', headers: { cookie } });
    expect(start.statusCode).toBe(302);
    const loc = new URL(start.headers.location as string);
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(loc.searchParams.get('code_challenge')).toBeTruthy();
    expect(loc.searchParams.get('scope')).toContain('gmail.send');
  });

  it('callback exchanges the code (with the PKCE verifier) and stores an ENCRYPTED connection', async () => {
    await configureGoogle();
    const { userId, cookie } = await signIn();
    const { cb } = await connect(cookie);
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain('connected=google');
    // The exchange used the code + a non-empty PKCE verifier.
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.code).toBe('auth-code-xyz');
    expect(exchanges[0]!.codeVerifier.length).toBeGreaterThan(20);

    // Tokens are SEALED at rest — the stored record holds ciphertext, never the plaintext token…
    const conn = (await (await getBackends()).connections.getConnection(APP_ID, userId, 'google'))!;
    expect(conn.status).toBe('connected');
    expect(conn.account_label).toBe('user@gmail.test');
    expect(JSON.stringify(conn)).not.toContain('google-access-1');
    expect(JSON.stringify(conn)).not.toContain('google-refresh-1');
    // …but decrypt back to the originals under the C5 master key.
    expect(await openValue(conn.access_sealed)).toBe('google-access-1');
    expect(await openValue(conn.refresh_sealed!)).toBe('google-refresh-1');
  });

  it('the connect request is ONE-SHOT — replaying the same state fails', async () => {
    await configureGoogle();
    const { cookie } = await signIn();
    const { state } = await connect(cookie);
    const replay = await server.inject({ method: 'GET', url: `/connect/google/callback?code=x&state=${encodeURIComponent(state)}`, headers: { cookie } });
    expect(replay.statusCode).toBe(302);
    expect(replay.headers.location).toContain('connect_error=invalid_state');
  });

  it('a callback whose session user differs from the initiator is rejected', async () => {
    await configureGoogle();
    const a = await signIn('a@demo.test');
    const b = await signIn('b@demo.test');
    const start = await server.inject({ method: 'GET', url: '/connect/google/start', headers: { cookie: a.cookie } });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    // User B tries to complete A's pending request.
    const cb = await server.inject({ method: 'GET', url: `/connect/google/callback?code=c&state=${encodeURIComponent(state)}`, headers: { cookie: b.cookie } });
    expect(cb.headers.location).toContain('connect_error=owner_mismatch');
    expect(exchanges).toHaveLength(0);
  });

  it('records a connector.connected C3 fact (owner-scoped), never a token', async () => {
    await configureGoogle();
    const { userId, cookie } = await signIn();
    await connect(cookie);
    const events = await (await getBackends()).events.list(APP_ID, { owner: userId });
    const connected = events.find((e) => e.type === 'connector.connected')!;
    expect(connected.subject).toBe('google');
    expect(JSON.stringify(connected)).not.toContain('google-access-1');
    expect((connected.data as { account_label?: string }).account_label).toBe('user@gmail.test');
  });
});

describe('C24 — management (list / disconnect)', () => {
  it('GET /connect lists the session user connections WITHOUT any token', async () => {
    await configureGoogle();
    const { cookie } = await signIn();
    await connect(cookie);
    const res = await server.inject({ method: 'GET', url: '/connect', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json().connections as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ provider: 'google', status: 'connected', account_label: 'user@gmail.test' });
    expect(JSON.stringify(list[0])).not.toMatch(/sealed|access_token|google-access/);
  });

  it('GET /connect requires a session', async () => {
    const res = await server.inject({ method: 'GET', url: '/connect' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /connect lists connections for a SERVICE-token + ?owner (consuming app server-to-server read)', async () => {
    await configureGoogle();
    await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', 'svc-token-123');
    const { userId, cookie } = await signIn();
    await connect(cookie); // the user connected in a session earlier
    // Later, the app's own server-to-server read authenticates over the trusted service channel with the
    // owner it already resolved — NOT by re-forwarding the browser cookie (fragile server-side). Same
    // trust model as the broker. (Fixes the Integrations "not connected" display bug.)
    const res = await server.inject({
      method: 'GET',
      url: `/connect?owner=${encodeURIComponent(userId)}`,
      headers: { 'x-forge-service-token': 'svc-token-123' },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json().connections as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ provider: 'google', status: 'connected' });
  });

  it('GET /connect with a valid service token but NO owner is refused (401)', async () => {
    await configureGoogle();
    await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', 'svc-token-123');
    const res = await server.inject({ method: 'GET', url: '/connect', headers: { 'x-forge-service-token': 'svc-token-123' } });
    expect(res.statusCode).toBe(401);
  });

  it('DELETE revokes at the provider and deletes the stored tokens', async () => {
    await configureGoogle();
    const { userId, cookie } = await signIn();
    await connect(cookie);
    const res = await server.inject({ method: 'DELETE', url: '/connect/google', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().disconnected).toBe(true);
    expect(revokes).toHaveLength(1); // Google has a revoke endpoint
    expect(await (await getBackends()).connections.getConnection(APP_ID, userId, 'google')).toBeNull();
  });
});

describe('C24 — broker (fresh access token + auto-refresh)', () => {
  it('returns the stored token while it is still valid (no refresh)', async () => {
    await configureGoogle();
    const { cookie } = await signIn();
    await connect(cookie);
    const res = await server.inject({ method: 'POST', url: '/connect/google/token', headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().access_token).toBe('google-access-1');
    expect(refreshes).toHaveLength(0);
  });

  it('transparently refreshes an expired access token and re-seals the new pair', async () => {
    await configureGoogle();
    const { userId, cookie } = await signIn();
    await connect(cookie);
    // Force the stored access token to be expired.
    const b = (await getBackends()).connections;
    const conn = (await b.getConnection(APP_ID, userId, 'google'))!;
    await b.putConnection(APP_ID, { ...conn, access_expires_at: new Date(Date.now() - 1000).toISOString() });

    const res = await server.inject({ method: 'POST', url: '/connect/google/token', headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().access_token).toBe('google-access-2');
    expect(refreshes).toHaveLength(1);
    // The refreshed pair is persisted (sealed) — a subsequent still-valid call does NOT refresh again.
    const after = (await b.getConnection(APP_ID, userId, 'google'))!;
    expect(await openValue(after.access_sealed)).toBe('google-access-2');
    expect(await openValue(after.refresh_sealed!)).toBe('google-refresh-2');
    const res2 = await server.inject({ method: 'POST', url: '/connect/google/token', headers: { cookie }, payload: {} });
    expect(res2.json().access_token).toBe('google-access-2');
    expect(refreshes).toHaveLength(1);
  });

  it('concurrent broker calls on an expired token refresh exactly ONCE (mutex)', async () => {
    await configureGoogle();
    const { userId, cookie } = await signIn();
    await connect(cookie);
    const b = (await getBackends()).connections;
    const conn = (await b.getConnection(APP_ID, userId, 'google'))!;
    await b.putConnection(APP_ID, { ...conn, access_expires_at: new Date(Date.now() - 1000).toISOString() });
    // Call the service directly to race two in-process calls through the mutex.
    const [a, c] = await Promise.all([
      getFreshAccessToken({ appId: APP_ID, owner: userId, provider: 'google' }),
      getFreshAccessToken({ appId: APP_ID, owner: userId, provider: 'google' }),
    ]);
    expect(a.access_token).toBe('google-access-2');
    expect(c.access_token).toBe('google-access-2');
    expect(refreshes).toHaveLength(1);
  });

  it('requires re-consent (409) when the access token is expired and there is no refresh token', async () => {
    await configureGoogle();
    const { userId, cookie } = await signIn();
    // Provider returned no refresh token this time.
    nextExchange = { access_token: 'access-norefresh', expires_in: 3600, scope: 'openid email' };
    await connect(cookie);
    const b = (await getBackends()).connections;
    const conn = (await b.getConnection(APP_ID, userId, 'google'))!;
    expect(conn.refresh_sealed).toBeUndefined();
    await b.putConnection(APP_ID, { ...conn, access_expires_at: new Date(Date.now() - 1000).toISOString() });
    const res = await server.inject({ method: 'POST', url: '/connect/google/token', headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('reconnect_required');
    expect((await b.getConnection(APP_ID, userId, 'google'))!.status).toBe('expired');
  });

  it('a hard refresh failure marks the connection expired and requires reconnect', async () => {
    await configureGoogle();
    const { userId, cookie } = await signIn();
    await connect(cookie);
    const b = (await getBackends()).connections;
    const conn = (await b.getConnection(APP_ID, userId, 'google'))!;
    await b.putConnection(APP_ID, { ...conn, access_expires_at: new Date(Date.now() - 1000).toISOString() });
    setOutboundOAuthClient({ ...stubClient, refresh: async () => { throw new Error('invalid_grant'); } });
    const res = await server.inject({ method: 'POST', url: '/connect/google/token', headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(409);
    expect((await b.getConnection(APP_ID, userId, 'google'))!.status).toBe('expired');
  });

  it('enforces require_scope — a missing scope is a clear 403', async () => {
    await configureGoogle();
    const { cookie } = await signIn();
    await connect(cookie);
    const res = await server.inject({ method: 'POST', url: '/connect/google/token', headers: { cookie }, payload: { require_scope: 'https://www.googleapis.com/auth/drive' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });

  it('the broker for a user with no connection is a clean 404', async () => {
    await configureGoogle();
    const { cookie } = await signIn();
    const res = await server.inject({ method: 'POST', url: '/connect/google/token', headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

describe('C24 — broker owner/auth model', () => {
  it('an unauthenticated broker call is refused (owner is NEVER client-passed)', async () => {
    await configureGoogle();
    // No session, no service token — even passing an owner in the body must not work.
    const res = await server.inject({ method: 'POST', url: '/connect/google/token', payload: { owner: 'someone' } });
    expect(res.statusCode).toBe(401);
  });

  it('a SERVICE-token call may act for a passed owner (background send path)', async () => {
    await configureGoogle();
    await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', 'svc-token-123');
    const { userId, cookie } = await signIn();
    await connect(cookie); // the user connected earlier, in a session
    // Later, a background job with the service token gets a fresh token for that user (no cookie).
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/token',
      headers: { 'x-forge-service-token': 'svc-token-123' },
      payload: { owner: userId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().access_token).toBe('google-access-1');
  });

  it('a service-token call must pass an owner', async () => {
    await configureGoogle();
    await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', 'svc-token-123');
    const res = await server.inject({ method: 'POST', url: '/connect/google/token', headers: { 'x-forge-service-token': 'svc-token-123' }, payload: {} });
    expect(res.statusCode).toBe(422);
  });

  it('a wrong service token is refused', async () => {
    await configureGoogle();
    await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', 'svc-token-123');
    const res = await server.inject({ method: 'POST', url: '/connect/google/token', headers: { 'x-forge-service-token': 'nope' }, payload: { owner: 'u' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('C24 — encryption at rest on the filesystem vault', () => {
  it('the on-disk vault file holds ONLY ciphertext (FS backend)', async () => {
    // Only meaningful on the filesystem backend (the pg run keeps ciphertext in a jsonb column instead).
    if ((await getBackends()).connections.constructor.name !== 'FsConnectionBackend') return;
    await configureGoogle();
    const { cookie } = await signIn();
    await connect(cookie);
    const raw = await readFile(connectionsFile(APP_ID), 'utf8');
    expect(raw).not.toContain('google-access-1');
    expect(raw).not.toContain('google-refresh-1');
    expect(raw).toContain('access_sealed');
  });
});
