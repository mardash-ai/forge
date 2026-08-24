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
import {
  setOutboundOAuthClient,
  resetOutboundOAuthClient,
  accountLabelFrom,
  type OutboundOAuthClient,
  type TokenSet,
} from '../src/connectors/oauth-client';
import { resolveProvider, availableProviders } from '../src/connectors/config';
import {
  setCredentialVerifier,
  resetCredentialVerifier,
  type VerifyOutcome,
} from '../src/connectors/credential-verifier';
import type { Connection, OAuthConnection } from '../src/connectors/types';
import { getFreshAccessToken, unionScopes, startConnect } from '../src/connectors/service';
import { connectionsFile } from '../src/shared/paths';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';

// These assertions are about the OAUTH arm of the connection union — narrow once, loudly, so a record
// that is unexpectedly `basic` fails with a clear message instead of `undefined is not a Sealed`.
function asOAuth(c: Connection | null | undefined): OAuthConnection {
  if (!c) throw new Error('expected a connection, got none');
  if (c.auth_kind !== 'oauth2') throw new Error(`expected an oauth2 connection, got ${c.auth_kind}`);
  return c;
}

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

// A logged-in C10 session cookie header for a fresh user.
const signIn = async (email = 'user@demo.test'): Promise<{ userId: string; cookie: string }> => {
  const user = await authStore.createUser(APP_ID, { email, email_verified: true });
  const session = await authStore.createSession(APP_ID, user.id, 3600);
  const token = signSessionToken(
    { userId: user.id, email: user.email, sessionId: session.id },
    SESSION_SECRET,
  );
  return { userId: user.id, cookie: `forge_session=${token}` };
};

const configureGoogle = async (): Promise<void> => {
  await setSecret(APP_ID, 'GOOGLE_CONNECT_CLIENT_ID', 'google-connect-client');
  await setSecret(APP_ID, 'GOOGLE_CONNECT_CLIENT_SECRET', 'google-connect-secret');
};

const configureMicrosoft = async (): Promise<void> => {
  await setSecret(APP_ID, 'MICROSOFT_CONNECT_CLIENT_ID', 'ms-connect-client');
  await setSecret(APP_ID, 'MICROSOFT_CONNECT_CLIENT_SECRET', 'ms-connect-secret');
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
  nextExchange = {
    access_token: 'google-access-1',
    refresh_token: 'google-refresh-1',
    expires_in: 3600,
    scope: 'openid email https://www.googleapis.com/auth/gmail.send',
    account_label: 'user@gmail.test',
  };
  nextRefresh = { access_token: 'google-access-2', refresh_token: 'google-refresh-2', expires_in: 3600 };
  setOutboundOAuthClient(stubClient);

  server = Fastify({ logger: false });
  registerConnectRoutes(server, { defaultApp: () => APP });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  resetOutboundOAuthClient();
  if ((await getBackends()).connections.__truncateAllForTests)
    await (
      await getBackends()
    ).connections.__truncateAllForTests!();
  if (prevDir === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevDir;
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
  await rm(dir, { recursive: true, force: true });
});

// Drive start → capture state → callback. Returns the callback response.
async function connect(cookie: string, opts: { scopes?: string; return_to?: string } = {}) {
  const qs = new URLSearchParams(opts as Record<string, string>).toString();
  const start = await server.inject({
    method: 'GET',
    url: `/connect/google/start${qs ? `?${qs}` : ''}`,
    headers: { cookie },
  });
  expect(start.statusCode).toBe(302);
  const loc = new URL(start.headers.location as string);
  const state = loc.searchParams.get('state')!;
  const cb = await server.inject({
    method: 'GET',
    url: `/connect/google/callback?code=auth-code-xyz&state=${encodeURIComponent(state)}`,
    headers: { cookie },
  });
  return { start, state, cb, authorizeUrl: loc };
}

// Generic connect helper for any provider (used by Microsoft tests).
async function connectProvider(provider: string, cookie: string) {
  const start = await server.inject({
    method: 'GET',
    url: `/connect/${provider}/start`,
    headers: { cookie },
  });
  expect(start.statusCode).toBe(302);
  const loc = new URL(start.headers.location as string);
  const state = loc.searchParams.get('state')!;
  const cb = await server.inject({
    method: 'GET',
    url: `/connect/${provider}/callback?code=auth-code-ms&state=${encodeURIComponent(state)}`,
    headers: { cookie },
  });
  return { start, state, cb, authorizeUrl: loc };
}

// Build a fake (unsigned) OIDC id_token with the given claims — used to unit-test accountLabelFrom
// without a real issuer. The function only base64-decodes the payload, so signature is irrelevant.
function fakeIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.fake_sig`;
}

describe('C24 — provider registry + credential resolution', () => {
  it('an OAUTH provider is unconfigured until BOTH client creds resolve (graceful degradation)', async () => {
    expect(await resolveProvider(APP_ID, 'google')).toBeNull();
    // `apple` is basic-auth and therefore always available — see the dedicated test below.
    expect(await availableProviders(APP_ID)).toEqual(['apple']);
    await setSecret(APP_ID, 'GOOGLE_CONNECT_CLIENT_ID', 'id-only');
    expect(await resolveProvider(APP_ID, 'google')).toBeNull(); // secret still missing
    await setSecret(APP_ID, 'GOOGLE_CONNECT_CLIENT_SECRET', 'secret');
    const resolved = await resolveProvider(APP_ID, 'google');
    if (resolved?.auth_kind !== 'oauth2') throw new Error('google must resolve as an oauth2 provider');
    expect(resolved.clientId).toBe('id-only');
    expect(resolved.descriptor.default_scopes).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(await availableProviders(APP_ID)).toEqual(['apple', 'google']);
  });

  // ⛔ THE 503-FOREVER GUARD. Apple/iCloud has no operator-provisioned OAuth client — the credential is
  // per-user and arrives at connect time. Before the auth_kind union, `resolveProvider` gated EVERY
  // provider on both client secrets resolving, so a basic provider reported configured:false forever
  // and its connect endpoint answered 503 permanently. Not a degraded state waiting on an operator: a
  // provider that could never be enabled at all. Proven RED against exactly that code before the fix.
  it('a BASIC provider is configured with NO operator client credentials (never a permanent 503)', async () => {
    // Deliberately provision nothing. There is no APPLE_CONNECT_CLIENT_ID and there never will be.
    const resolved = await resolveProvider(APP_ID, 'apple');
    expect(resolved).not.toBeNull();
    if (resolved?.auth_kind !== 'basic') throw new Error('apple must resolve as a basic provider');
    expect(resolved.descriptor.service_endpoint).toBe('https://caldav.icloud.com');
    expect(await availableProviders(APP_ID)).toContain('apple');
  });

  // Two halves of one contract (guardrail #5): forge EMITS auth_kind on discovery and dorinda-web
  // BRANCHES on it to pick redirect-vs-wizard. A provider registered without one would render a dead
  // button in the card rather than an error, so assert the property for EVERY registered provider —
  // not just the ones that exist today.
  it('every registered provider publishes an auth_kind on discovery', async () => {
    const res = await server.inject({ method: 'GET', url: '/connect/providers' });
    const providers = res.json().providers as Array<{ id: string; auth_kind?: string }>;
    expect(providers.length).toBeGreaterThanOrEqual(3);
    for (const p of providers) {
      expect(['oauth2', 'basic']).toContain(p.auth_kind);
    }
    expect(providers.find((p) => p.id === 'apple')!.auth_kind).toBe('basic');
    expect(providers.find((p) => p.id === 'google')!.auth_kind).toBe('oauth2');
  });

  // The wizard's copy travels WITH the descriptor. If these went missing the web tier would render a
  // credentials form with unlabelled fields and no link to mint the password — the single most likely
  // path to a user pasting their PRIMARY Apple password, which fails with a bare 401 (Apple plan §8).
  it('a basic provider publishes the wizard copy the web tier needs', async () => {
    const res = await server.inject({ method: 'GET', url: '/connect/providers' });
    const apple = res.json().providers.find((p: { id: string }) => p.id === 'apple');
    expect(apple.username_label).toBe('Apple Account email');
    expect(apple.password_label).toBe('App-specific password');
    expect(apple.credential_help_url).toContain('support.apple.com');
    expect(apple.default_scopes).toBeUndefined(); // scopes are an OAuth concept
  });

  // Routing mistakes must not masquerade as configuration errors. `connectorNotConfigured` tells an
  // operator to provision client credentials — for Apple that sends them hunting for a secret that
  // does not and will never exist (guardrail #7: fix the diagnostic).
  it('a basic provider on the OAUTH start path fails as wrong_auth_kind, not not-configured', async () => {
    await expect(
      startConnect({
        appId: APP_ID,
        provider: 'apple',
        owner: 'u1',
        redirectUri: 'https://app.example/connect/apple/callback',
      }),
    ).rejects.toMatchObject({ code: 'wrong_auth_kind', status: 400 });
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
    const oauthConn = asOAuth(conn as Connection);
    expect(await openValue(oauthConn.access_sealed)).toBe('google-access-1');
    expect(await openValue(oauthConn.refresh_sealed!)).toBe('google-refresh-1');
  });

  it('the connect request is ONE-SHOT — replaying the same state fails', async () => {
    await configureGoogle();
    const { cookie } = await signIn();
    const { state } = await connect(cookie);
    const replay = await server.inject({
      method: 'GET',
      url: `/connect/google/callback?code=x&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    expect(replay.statusCode).toBe(302);
    expect(replay.headers.location).toContain('connect_error=invalid_state');
  });

  it('a callback whose session user differs from the initiator is rejected', async () => {
    await configureGoogle();
    const a = await signIn('a@demo.test');
    const b = await signIn('b@demo.test');
    const start = await server.inject({
      method: 'GET',
      url: '/connect/google/start',
      headers: { cookie: a.cookie },
    });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    // User B tries to complete A's pending request.
    const cb = await server.inject({
      method: 'GET',
      url: `/connect/google/callback?code=c&state=${encodeURIComponent(state)}`,
      headers: { cookie: b.cookie },
    });
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
    expect(list[0]).toMatchObject({
      provider: 'google',
      status: 'connected',
      account_label: 'user@gmail.test',
    });
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
    const res = await server.inject({
      method: 'GET',
      url: '/connect',
      headers: { 'x-forge-service-token': 'svc-token-123' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('⛔ DELETE /connect/:provider works over the SERVICE-TOKEN + owner channel, like its plural sibling', async () => {
    // The asymmetry this pins was invisible in forge and fatal one repo away. dorinda-api talks to
    // the vault server-to-server with a service token; when this route resolved its owner from a
    // browser SESSION only, the API could disconnect ALL providers but not ONE — so the Integrations
    // card's per-provider Disconnect had no reachable endpoint and every user who pressed it saw
    // "Couldn't disconnect" (reproduced live 2026-08-21).
    //
    // Two routes serving the same callers for the same job must resolve their owner the same way.
    await configureGoogle();
    await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', 'svc-token-123');
    const { userId, cookie } = await signIn();
    await connect(cookie);

    const res = await server.inject({
      method: 'DELETE',
      url: `/connect/google?owner=${encodeURIComponent(userId)}`,
      headers: { 'x-forge-service-token': 'svc-token-123' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().disconnected).toBe(true);
    expect(revokes).toHaveLength(1); // withdrawn AT Google, not merely forgotten locally
    expect(await (await getBackends()).connections.getConnection(APP_ID, userId, 'google')).toBeNull();
  });

  it('a service token with NO owner is still refused on the per-provider DELETE (401)', async () => {
    // The service-token channel must not become an anonymous disconnect-anything door.
    await configureGoogle();
    await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', 'svc-token-123');
    const res = await server.inject({
      method: 'DELETE',
      url: '/connect/google',
      headers: { 'x-forge-service-token': 'svc-token-123' },
    });
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

/**
 * C34 account teardown. Deleting an account MUST also withdraw the grants it holds AT THE PROVIDER —
 * otherwise "delete my account" leaves a live refresh token for the user's Gmail/Calendar and the app
 * still listed under their third-party access. A consumer's purge is a MACHINE call, so this has to
 * work over the service-token + owner channel — as does the per-provider DELETE (fixed 2026-08-23;
 * it was session-only, which is why dorinda-api could never implement the card's Disconnect).
 */
describe('C24 — DELETE /connect (disconnect every provider; account teardown)', () => {
  it('revokes AT THE PROVIDER and deletes the tokens, over the service-token + owner channel', async () => {
    await configureGoogle();
    await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', 'svc-token-123');
    const { userId, cookie } = await signIn();
    await connect(cookie);

    const res = await server.inject({
      method: 'DELETE',
      url: `/connect?owner=${encodeURIComponent(userId)}`,
      headers: { 'x-forge-service-token': 'svc-token-123' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ providers: ['google'], disconnected: 1 });
    // The point of the feature: the grant is withdrawn at Google, not merely forgotten locally.
    expect(revokes).toHaveLength(1);
    expect(await (await getBackends()).connections.getConnection(APP_ID, userId, 'google')).toBeNull();
  });

  it('works for the session user too (tearing down their OWN grants)', async () => {
    await configureGoogle();
    const { userId, cookie } = await signIn();
    await connect(cookie);
    const res = await server.inject({ method: 'DELETE', url: '/connect', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ providers: ['google'], disconnected: 1 });
    expect(revokes).toHaveLength(1);
    expect(await (await getBackends()).connections.getConnection(APP_ID, userId, 'google')).toBeNull();
  });

  it('is idempotent — a second teardown revokes nothing and still answers 200', async () => {
    await configureGoogle();
    const { cookie } = await signIn();
    await connect(cookie);
    await server.inject({ method: 'DELETE', url: '/connect', headers: { cookie } });
    revokes = [];
    const again = await server.inject({ method: 'DELETE', url: '/connect', headers: { cookie } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ providers: [], disconnected: 0 });
    expect(revokes).toHaveLength(0);
  });

  it('a SESSION can never tear down another owner — ?owner= is ignored for a browser caller', async () => {
    await configureGoogle();
    const victim = await signIn('victim@test.example');
    await connect(victim.cookie);
    const attacker = await signIn('attacker@test.example');

    // The attacker holds a valid session and names the victim explicitly. `owner` is honored ONLY for a
    // valid service token (server-side); a session always resolves to its OWN userId.
    const res = await server.inject({
      method: 'DELETE',
      url: `/connect?owner=${encodeURIComponent(victim.userId)}`,
      headers: { cookie: attacker.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ providers: [], disconnected: 0 }); // tore down its OWN (nothing)
    expect(revokes).toHaveLength(0);
    // The victim's grant is untouched.
    expect(
      await (await getBackends()).connections.getConnection(APP_ID, victim.userId, 'google'),
    ).not.toBeNull();
  });

  it('refuses an unauthenticated call, and a service token with NO owner (never a blind teardown)', async () => {
    await configureGoogle();
    await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', 'svc-token-123');
    expect((await server.inject({ method: 'DELETE', url: '/connect' })).statusCode).toBe(401);
    expect(
      (
        await server.inject({
          method: 'DELETE',
          url: '/connect',
          headers: { 'x-forge-service-token': 'svc-token-123' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await server.inject({
          method: 'DELETE',
          url: '/connect?owner=someone',
          headers: { 'x-forge-service-token': 'wrong-token' },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('C24 — broker (fresh access token + auto-refresh)', () => {
  it('returns the stored token while it is still valid (no refresh)', async () => {
    await configureGoogle();
    const { cookie } = await signIn();
    await connect(cookie);
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/token',
      headers: { cookie },
      payload: {},
    });
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
    const conn = asOAuth(await b.getConnection(APP_ID, userId, 'google'));
    await b.putConnection(APP_ID, { ...conn, access_expires_at: new Date(Date.now() - 1000).toISOString() });

    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/token',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().access_token).toBe('google-access-2');
    expect(refreshes).toHaveLength(1);
    // The refreshed pair is persisted (sealed) — a subsequent still-valid call does NOT refresh again.
    const after = (await b.getConnection(APP_ID, userId, 'google'))!;
    expect(await openValue(asOAuth(after).access_sealed)).toBe('google-access-2');
    expect(await openValue(asOAuth(after).refresh_sealed!)).toBe('google-refresh-2');
    const res2 = await server.inject({
      method: 'POST',
      url: '/connect/google/token',
      headers: { cookie },
      payload: {},
    });
    expect(res2.json().access_token).toBe('google-access-2');
    expect(refreshes).toHaveLength(1);
  });

  it('concurrent broker calls on an expired token refresh exactly ONCE (mutex)', async () => {
    await configureGoogle();
    const { userId, cookie } = await signIn();
    await connect(cookie);
    const b = (await getBackends()).connections;
    const conn = asOAuth(await b.getConnection(APP_ID, userId, 'google'));
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
    const conn = asOAuth(await b.getConnection(APP_ID, userId, 'google'));
    expect(conn.refresh_sealed).toBeUndefined();
    await b.putConnection(APP_ID, { ...conn, access_expires_at: new Date(Date.now() - 1000).toISOString() });
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/token',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('reconnect_required');
    expect((await b.getConnection(APP_ID, userId, 'google'))!.status).toBe('expired');
  });

  it('a hard refresh failure marks the connection expired and requires reconnect', async () => {
    await configureGoogle();
    const { userId, cookie } = await signIn();
    await connect(cookie);
    const b = (await getBackends()).connections;
    const conn = asOAuth(await b.getConnection(APP_ID, userId, 'google'));
    await b.putConnection(APP_ID, { ...conn, access_expires_at: new Date(Date.now() - 1000).toISOString() });
    setOutboundOAuthClient({
      ...stubClient,
      refresh: async () => {
        throw new Error('invalid_grant');
      },
    });
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/token',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect((await b.getConnection(APP_ID, userId, 'google'))!.status).toBe('expired');
  });

  it('enforces require_scope — a missing scope is a clear 403', async () => {
    await configureGoogle();
    const { cookie } = await signIn();
    await connect(cookie);
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/token',
      headers: { cookie },
      payload: { require_scope: 'https://www.googleapis.com/auth/drive' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
  });

  it('the broker for a user with no connection is a clean 404', async () => {
    await configureGoogle();
    const { cookie } = await signIn();
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/token',
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

describe('C24 — broker owner/auth model', () => {
  it('an unauthenticated broker call is refused (owner is NEVER client-passed)', async () => {
    await configureGoogle();
    // No session, no service token — even passing an owner in the body must not work.
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/token',
      payload: { owner: 'someone' },
    });
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
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/token',
      headers: { 'x-forge-service-token': 'svc-token-123' },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it('a wrong service token is refused', async () => {
    await configureGoogle();
    await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', 'svc-token-123');
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/token',
      headers: { 'x-forge-service-token': 'nope' },
      payload: { owner: 'u' },
    });
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

// ---------------------------------------------------------------------------
// C24 — accountLabelFrom: preferred_username fallback for Microsoft personal
// accounts (MSA). Work/school accounts carry the `email` claim in the OIDC
// id_token; personal MSA accounts only have `preferred_username`. The provider
// descriptor's account_label_claims chain handles both.
// ---------------------------------------------------------------------------
describe('C24 — accountLabelFrom: preferred_username fallback for personal Microsoft accounts', () => {
  // Use the real Microsoft descriptor shape (just the claims list matters).
  const msDescriptor = { account_label_claims: ['email', 'preferred_username'] } as Parameters<
    typeof accountLabelFrom
  >[0];
  const googleDescriptor = { account_label_claims: ['email'] } as Parameters<typeof accountLabelFrom>[0];

  it('returns the email claim for work/school accounts (email is present)', () => {
    const token = fakeIdToken({ email: 'user@company.com', preferred_username: 'user@company.com' });
    expect(accountLabelFrom(msDescriptor, token)).toBe('user@company.com');
  });

  it('falls back to preferred_username when the email claim is absent (personal MSA account)', () => {
    // Personal Microsoft accounts omit the `email` claim in the id_token — only preferred_username is set.
    const token = fakeIdToken({ preferred_username: 'user@outlook.com' });
    expect(accountLabelFrom(msDescriptor, token)).toBe('user@outlook.com');
  });

  it('returns undefined when neither email nor preferred_username is present', () => {
    const token = fakeIdToken({ sub: 'abc123', name: 'Alice' });
    expect(accountLabelFrom(msDescriptor, token)).toBeUndefined();
  });

  it('Google descriptor only checks email — preferred_username alone yields undefined', () => {
    // A Google descriptor has no preferred_username fallback; a token without email returns nothing.
    const token = fakeIdToken({ preferred_username: 'user@gmail.com' });
    expect(accountLabelFrom(googleDescriptor, token)).toBeUndefined();
  });

  it('returns undefined when no id_token is supplied', () => {
    expect(accountLabelFrom(msDescriptor, undefined)).toBeUndefined();
  });

  it('takes the FIRST non-empty claim in order (email wins when both present)', () => {
    const token = fakeIdToken({ email: 'work@corp.test', preferred_username: 'personal@outlook.com' });
    // email is tried first per the chain — it wins.
    expect(accountLabelFrom(msDescriptor, token)).toBe('work@corp.test');
  });
});

// ---------------------------------------------------------------------------
// C24 — unionScopes helper: the heart of the scope narrowing guard.
// ---------------------------------------------------------------------------
describe('C24 — unionScopes (scope-narrowing guard helper)', () => {
  it('returns the union — scopes present in EITHER list survive', () => {
    const result = unionScopes(
      ['openid', 'email', 'Mail.Send', 'Calendars.ReadWrite'],
      ['openid', 'email', 'Mail.Read'],
    );
    // Mail.Send and Calendars.ReadWrite must survive even though they were absent from `incoming`.
    expect(result).toContain('Mail.Send');
    expect(result).toContain('Calendars.ReadWrite');
    expect(result).toContain('Mail.Read');
    expect(result).toEqual(['Calendars.ReadWrite', 'Mail.Read', 'Mail.Send', 'email', 'openid']);
  });

  it('is a no-op when incoming is a superset of existing', () => {
    expect(unionScopes(['openid'], ['openid', 'Mail.Send'])).toEqual(['Mail.Send', 'openid']);
  });

  it('handles empty existing (first connect — no prior scopes to preserve)', () => {
    expect(unionScopes([], ['openid', 'Mail.Send'])).toEqual(['Mail.Send', 'openid']);
  });

  it('handles empty incoming (degrades gracefully — existing scopes fully preserved)', () => {
    expect(unionScopes(['openid', 'Mail.Send'], [])).toEqual(['Mail.Send', 'openid']);
  });

  it('deduplicates — a scope present in both lists appears once', () => {
    const result = unionScopes(['openid', 'email'], ['openid', 'email']);
    expect(result).toHaveLength(2);
    expect(result).toEqual(['email', 'openid']);
  });
});

// ---------------------------------------------------------------------------
// C24 — Microsoft connector: connect flow, no-revoke disconnect, and the
// SCOPE NARROWING GUARD (partial re-consent CANNOT shrink stored scopes).
//
// Microsoft has no `include_granted_scopes` equivalent: a user who re-consents
// to a SUBSET of previously-granted scopes returns a callback whose `scope`
// response field contains only the newly-granted scopes. Overwriting the stored
// list with the callback's list would silently revoke already-granted capabilities
// (e.g. losing Mail.Send after a Mail.Read-only re-consent). The C24
// completeConnect MUST union old + new scopes — this test would FAIL against
// the naive overwrite.
// ---------------------------------------------------------------------------
describe('C24 — Microsoft connector: connect flow + scope narrowing guard', () => {
  it('Microsoft connect redirects to the Microsoft authorization endpoint', async () => {
    await configureMicrosoft();
    const { cookie } = await signIn('ms-user@demo.test');
    const start = await server.inject({
      method: 'GET',
      url: '/connect/microsoft/start',
      headers: { cookie },
    });
    expect(start.statusCode).toBe(302);
    const loc = new URL(start.headers.location as string);
    expect(loc.origin + loc.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    // Default scopes include the full Microsoft scope set.
    const scope = loc.searchParams.get('scope') ?? '';
    expect(scope).toContain('Mail.Send');
    expect(scope).toContain('Calendars.ReadWrite');
    expect(scope).toContain('offline_access');
  });

  it('Microsoft callback stores a sealed connection and labels it with account_label', async () => {
    await configureMicrosoft();
    const { userId, cookie } = await signIn('ms-user2@demo.test');
    nextExchange = {
      access_token: 'ms-access-1',
      refresh_token: 'ms-refresh-1',
      expires_in: 3600,
      scope: 'openid email offline_access Mail.Read Mail.Send Calendars.ReadWrite',
      account_label: 'user@outlook.test',
    };
    const { cb } = await connectProvider('microsoft', cookie);
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain('connected=microsoft');

    const conn = (await (await getBackends()).connections.getConnection(APP_ID, userId, 'microsoft'))!;
    expect(conn.status).toBe('connected');
    expect(conn.account_label).toBe('user@outlook.test');
    // Tokens are sealed at rest.
    expect(JSON.stringify(conn)).not.toContain('ms-access-1');
    expect(await openValue(asOAuth(conn as Connection).access_sealed)).toBe('ms-access-1');
  });

  it('Microsoft disconnect drops stored tokens WITHOUT a provider revoke call (no revoke_endpoint)', async () => {
    await configureMicrosoft();
    const { userId, cookie } = await signIn('ms-user3@demo.test');
    nextExchange = {
      access_token: 'ms-access-x',
      refresh_token: 'ms-refresh-x',
      expires_in: 3600,
      scope: 'openid email offline_access Mail.Read Mail.Send',
      account_label: 'user@outlook.test',
    };
    await connectProvider('microsoft', cookie);
    revokes = [];

    const res = await server.inject({ method: 'DELETE', url: '/connect/microsoft', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().disconnected).toBe(true);
    // Microsoft has no revoke_endpoint — NO revoke call must be made.
    expect(revokes).toHaveLength(0);
    // Tokens are gone locally.
    expect(await (await getBackends()).connections.getConnection(APP_ID, userId, 'microsoft')).toBeNull();
  });

  it('a partial Microsoft re-consent CANNOT narrow the stored scope list (union preserved)', async () => {
    // This test would FAIL if completeConnect used a naive scope overwrite instead of unionScopes.
    await configureMicrosoft();
    const { userId, cookie } = await signIn('ms-scope-guard@demo.test');

    // --- First connect: full scope grant ------------------------------------------
    nextExchange = {
      access_token: 'ms-access-full',
      refresh_token: 'ms-refresh-full',
      expires_in: 3600,
      scope: 'openid email offline_access Mail.Read Mail.Send Calendars.ReadWrite',
      account_label: 'user@outlook.test',
    };
    await connectProvider('microsoft', cookie);

    const b = (await getBackends()).connections;
    const conn1 = (await b.getConnection(APP_ID, userId, 'microsoft'))!;
    expect(conn1.scopes).toContain('Mail.Send');
    expect(conn1.scopes).toContain('Calendars.ReadWrite');

    // --- Second connect: PARTIAL re-consent (user only approved Mail.Read) ----------
    // Microsoft's callback returns ONLY the newly-consented scope — NOT the previously-granted ones.
    // A naive overwrite would destroy Mail.Send and Calendars.ReadWrite.
    nextExchange = {
      access_token: 'ms-access-partial',
      refresh_token: 'ms-refresh-partial',
      expires_in: 3600,
      scope: 'openid email offline_access Mail.Read', // Mail.Send + Calendars.ReadWrite ABSENT
      account_label: 'user@outlook.test',
    };
    await connectProvider('microsoft', cookie);

    const conn2 = (await b.getConnection(APP_ID, userId, 'microsoft'))!;
    // The UNION must be stored — previously-granted scopes survive the partial re-consent.
    expect(conn2.scopes).toContain('Mail.Send'); // MUST survive
    expect(conn2.scopes).toContain('Calendars.ReadWrite'); // MUST survive
    expect(conn2.scopes).toContain('Mail.Read'); // newly granted
    // Exact union (sorted, no duplicates).
    expect(conn2.scopes).toEqual([
      'Calendars.ReadWrite',
      'Mail.Read',
      'Mail.Send',
      'email',
      'offline_access',
      'openid',
    ]);
  });
});

describe('C24 — basic-auth connect (POST /connect/:provider/credentials)', () => {
  const APPLE_USER = 'dorinda-test@mardash.ai';
  const APPLE_PASS = 'abcd-efgh-ijkl-mnop'; // the app-specific-password shape

  // Record what the verifier was asked, so we can prove the REAL credential reached it (a verifier that
  // is called with a trimmed/mangled password would pass every assertion about outcomes and still be
  // broken in production).
  let seen: Array<{ username: string; password: string }> = [];
  const verifierReturning = (outcome: VerifyOutcome) => ({
    verify: async (input: { username: string; password: string }) => {
      seen.push({ username: input.username, password: input.password });
      return outcome;
    },
  });

  beforeEach(() => {
    seen = [];
    resetCredentialVerifier();
  });
  afterEach(() => resetCredentialVerifier());

  const post = (cookie: string, body: Record<string, unknown>) =>
    server.inject({ method: 'POST', url: '/connect/apple/credentials', headers: { cookie }, payload: body });

  const storedApple = async (userId: string) =>
    (await getBackends()).connections.getConnection(APP_ID, userId, 'apple');

  it('stores a SEALED credential after the verifier confirms it, and never the plaintext', async () => {
    setCredentialVerifier(verifierReturning({ ok: true }));
    const { userId, cookie } = await signIn();
    const res = await post(cookie, { username: APPLE_USER, password: APPLE_PASS });
    expect(res.statusCode).toBe(200);
    expect(res.json().connection.auth_kind).toBe('basic');
    expect(res.json().connection.account_label).toBe(APPLE_USER);

    const conn = await storedApple(userId);
    expect(conn!.auth_kind).toBe('basic');
    // The whole record, serialized, must not contain the password anywhere.
    expect(JSON.stringify(conn)).not.toContain(APPLE_PASS);
    if (conn!.auth_kind !== 'basic') throw new Error('expected a basic connection');
    expect(await openValue(conn!.password_sealed)).toBe(APPLE_PASS);
    // The username is NOT a secret — it is the account label — and is stored in the clear.
    expect(conn!.username).toBe(APPLE_USER);
    // The response never carries the credential back.
    expect(JSON.stringify(res.json())).not.toContain(APPLE_PASS);
  });

  it('passes the password through byte-for-byte (never trimmed or normalised)', async () => {
    setCredentialVerifier(verifierReturning({ ok: true }));
    const { cookie } = await signIn();
    const padded = '  spaces-matter  ';
    await post(cookie, { username: `  ${APPLE_USER}  `, password: padded });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.password).toBe(padded); // untouched
    expect(seen[0]!.username).toBe(APPLE_USER); // trimmed — a stray space in an email is always a typo
  });

  // ⛔ THE WITHHOLD GUARD. With no verifier registered the flow must REFUSE, not assume success.
  // A permissive fallback would manufacture a verified-connected state out of an absent check — the
  // HAT-F-065 defect class (a default is not an observation).
  it('REFUSES to connect when no verifier is registered, and stores nothing', async () => {
    const { userId, cookie } = await signIn();
    const res = await post(cookie, { username: APPLE_USER, password: APPLE_PASS });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('dependency_unavailable');
    expect(await storedApple(userId)).toBeNull(); // ← nothing was written
  });

  it('a REJECTED credential is a 401 that names the app-specific-password trap, and stores nothing', async () => {
    setCredentialVerifier(verifierReturning({ ok: false, reason: 'invalid_credentials' }));
    const { userId, cookie } = await signIn();
    const res = await post(cookie, { username: APPLE_USER, password: 'my-real-apple-password' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('credential_rejected');
    // The guidance that actually resolves the common case must be in the message.
    expect(res.json().error.message.toLowerCase()).toContain('app-specific password');
    expect(res.json().error.message).toContain('support.apple.com');
    expect(await storedApple(userId)).toBeNull();
  });

  // "We asked and it said no" and "we could not ask" are different facts. Collapsing them sends a user
  // to reset a working primary password — which, on Apple, revokes every app-specific password held.
  it('an UNREACHABLE service is 503 verification_unavailable — never reported as a bad password', async () => {
    setCredentialVerifier(verifierReturning({ ok: false, reason: 'unreachable', detail: 'ETIMEDOUT' }));
    const { userId, cookie } = await signIn();
    const res = await post(cookie, { username: APPLE_USER, password: APPLE_PASS });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('verification_unavailable');
    expect(res.json().error.message.toLowerCase()).not.toContain('rejected');
    expect(await storedApple(userId)).toBeNull();
  });

  it('a verifier that THROWS is treated as unreachable, not as a rejection', async () => {
    setCredentialVerifier({
      verify: async () => {
        throw new Error('socket hang up');
      },
    });
    const { userId, cookie } = await signIn();
    const res = await post(cookie, { username: APPLE_USER, password: APPLE_PASS });
    expect(res.json().error.code).toBe('verification_unavailable');
    expect(await storedApple(userId)).toBeNull();
  });

  // ⛔ A password is set BY ITS OWNER. The service-token + owner channel exists so a backend can ACT ON
  // a grant the user already made; it must never CREATE one, or a token holder could plant a credential
  // against any user id and the card would render it as a healthy connection they never established.
  it('a SERVICE token cannot plant a credential for another user (session-only route)', async () => {
    setCredentialVerifier(verifierReturning({ ok: true }));
    await setSecret(APP_ID, 'FORGE_SERVICE_TOKEN', 'svc-token-value');
    const res = await server.inject({
      method: 'POST',
      url: '/connect/apple/credentials',
      headers: { authorization: 'Bearer svc-token-value' },
      payload: { username: APPLE_USER, password: APPLE_PASS, owner: 'someone-else' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('an OAUTH provider on the credentials path is wrong_auth_kind, not a config error', async () => {
    setCredentialVerifier(verifierReturning({ ok: true }));
    await configureGoogle();
    const { cookie } = await signIn();
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/credentials',
      headers: { cookie },
      payload: { username: 'a@b.c', password: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('wrong_auth_kind');
  });

  it('requires both fields', async () => {
    setCredentialVerifier(verifierReturning({ ok: true }));
    const { cookie } = await signIn();
    expect((await post(cookie, { username: APPLE_USER })).statusCode).toBe(422);
    expect((await post(cookie, { username: '', password: APPLE_PASS })).statusCode).toBe(422);
  });

  it('reconnecting with a new password replaces the credential and keeps connected_at', async () => {
    setCredentialVerifier(verifierReturning({ ok: true }));
    const { userId, cookie } = await signIn();
    await post(cookie, { username: APPLE_USER, password: APPLE_PASS });
    const first = await storedApple(userId);
    await post(cookie, { username: APPLE_USER, password: 'rotated-pass-value' });
    const second = await storedApple(userId);
    if (second!.auth_kind !== 'basic') throw new Error('expected basic');
    expect(await openValue(second!.password_sealed)).toBe('rotated-pass-value');
    expect(second!.connected_at).toBe(first!.connected_at); // first connect, preserved
  });
});
