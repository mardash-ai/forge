import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SESSION_COOKIE,
  signSessionToken,
  verifySessionToken,
  sessionCookie,
  clearSessionCookie,
  parseCookies,
  isPublicPath,
  isServicePath,
  DEFAULT_PUBLIC_PATHS,
} from '../src/shared/session';
import {
  hashPassword,
  verifyPassword,
  newToken,
  hashToken,
  serviceTokenMatches,
  resolveAuthConfig,
} from '../src/plugins/auth-identity/index';
import * as authStore from '../src/plugins/auth-identity/store';
import { setSecret } from '../src/plugins/secrets-local/index';

const prevKey = process.env.FORGE_SECRETS_KEY;
let dir: string;
let prevState: string | undefined;

beforeAll(() => {
  process.env.FORGE_SECRETS_KEY = 'test-master-key-not-for-production';
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
});

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-auth-'));
  process.env.FORGE_STATE_DIR = dir;
  delete process.env.AUTH_SESSION_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.AUTH_SERVICE_TOKEN;
});
afterEach(async () => {
  if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevState;
  await rm(dir, { recursive: true, force: true });
});

describe('session token (shared/session — the app mirrors this)', () => {
  const SECRET = 'super-secret-signing-key';

  it('signs and verifies a session, returning the claims', () => {
    const token = signSessionToken({ userId: 'user_1', email: 'a@b.com', sessionId: 'sess_1' }, SECRET);
    const claims = verifySessionToken(token, SECRET);
    expect(claims?.userId).toBe('user_1');
    expect(claims?.email).toBe('a@b.com');
    expect(claims?.sessionId).toBe('sess_1');
    expect(claims!.exp).toBeGreaterThan(claims!.iat);
  });

  it('rejects a tampered payload (signature mismatch)', () => {
    const token = signSessionToken({ userId: 'user_1', email: 'a@b.com', sessionId: 'sess_1' }, SECRET);
    const [h, , s] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ userId: 'admin', email: 'x@y.com', sessionId: 'sess_1', iat: 1, exp: 9999999999 }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(verifySessionToken(`${h}.${forgedPayload}.${s}`, SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signSessionToken({ userId: 'user_1', email: 'a@b.com', sessionId: 'sess_1' }, SECRET);
    expect(verifySessionToken(token, 'other-secret')).toBeNull();
  });

  it('rejects an expired token', () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = signSessionToken({ userId: 'u', email: 'a@b.com', sessionId: 's' }, SECRET, 5, past); // exp = past+5, already gone
    expect(verifySessionToken(token, SECRET)).toBeNull();
  });

  it('rejects garbage / empty / missing-secret', () => {
    expect(verifySessionToken('not-a-token', SECRET)).toBeNull();
    expect(verifySessionToken('', SECRET)).toBeNull();
    expect(verifySessionToken(undefined, SECRET)).toBeNull();
    expect(verifySessionToken(signSessionToken({ userId: 'u', email: 'a@b', sessionId: 's' }, SECRET), '')).toBeNull();
  });
});

describe('session cookie attributes', () => {
  it('sets httpOnly + Secure + SameSite=Lax + Path + Max-Age', () => {
    const c = sessionCookie('tok', { secure: true, maxAgeSeconds: 100 });
    expect(c).toContain(`${SESSION_COOKIE}=tok`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=100');
  });

  it('omits Secure only when explicitly insecure (local http dev)', () => {
    expect(sessionCookie('tok', { secure: false })).not.toContain('Secure');
    expect(sessionCookie('tok', { secure: false })).toContain('HttpOnly');
  });

  it('clear cookie is Max-Age=0 and still httpOnly', () => {
    const c = clearSessionCookie({ secure: true });
    expect(c).toContain('Max-Age=0');
    expect(c).toContain('HttpOnly');
    expect(c).toContain(`${SESSION_COOKIE}=;`);
  });

  it('parseCookies reads a request cookie header', () => {
    expect(parseCookies('a=1; forge_session=xyz; b=2')).toMatchObject({ a: '1', forge_session: 'xyz', b: '2' });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('public-path + service-path matcher (the app gate uses these)', () => {
  it('lets /auth/*, /api/health, /api/cron/* through; gates everything else', () => {
    expect(isPublicPath('/auth/login')).toBe(true);
    expect(isPublicPath('/auth')).toBe(true);
    expect(isPublicPath('/api/health')).toBe(true);
    expect(isPublicPath('/api/cron/reminders')).toBe(true);
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/dashboard')).toBe(false);
    expect(isPublicPath('/api/goals')).toBe(false);
    // Not fooled by a lookalike prefix.
    expect(isPublicPath('/authorize')).toBe(false);
    expect(isPublicPath('/api/healthz')).toBe(false);
  });

  it('accepts trailing /* forms in the list', () => {
    expect(DEFAULT_PUBLIC_PATHS).toContain('/api/cron');
    expect(isPublicPath('/api/cron/x', ['/api/cron/*'])).toBe(true);
  });

  it('isServicePath matches only cron', () => {
    expect(isServicePath('/api/cron')).toBe(true);
    expect(isServicePath('/api/cron/reminders')).toBe(true);
    expect(isServicePath('/api/goals')).toBe(false);
  });
});

describe('password hashing (scrypt KDF)', () => {
  it('hashes then verifies the correct password; rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('never stores the plaintext in the hash string', async () => {
    const hash = await hashPassword('S3cretP@ss!');
    expect(hash).not.toContain('S3cretP@ss!');
  });

  it('salts: two hashes of the same password differ', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('verify is safe against malformed/empty stored hashes', async () => {
    expect(await verifyPassword('x', undefined)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$bad')).toBe(false);
  });
});

describe('single-use tokens + service token', () => {
  it('newToken returns a raw token and its sha256 hash; hashToken is stable', () => {
    const { token, hash } = newToken();
    expect(token.length).toBeGreaterThan(20);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toBe(token);
  });

  it('serviceTokenMatches is a constant-time equality that rejects mismatch/absent', () => {
    expect(serviceTokenMatches('abc123', 'abc123')).toBe(true);
    expect(serviceTokenMatches('abc123', 'abc124')).toBe(false);
    expect(serviceTokenMatches('abc', 'abc123')).toBe(false);
    expect(serviceTokenMatches(undefined, 'abc')).toBe(false);
    expect(serviceTokenMatches('abc', null)).toBe(false);
  });
});

describe('resolveAuthConfig — detectable absence (§7)', () => {
  it('reports each piece independently', async () => {
    const appId = 'app_x';
    expect(await resolveAuthConfig(appId)).toEqual({ sessionSecret: null, google: null, serviceToken: null });

    await setSecret(appId, 'AUTH_SESSION_SECRET', 'sess-key');
    let cfg = await resolveAuthConfig(appId);
    expect(cfg.sessionSecret).toBe('sess-key');
    expect(cfg.google).toBeNull(); // email/pw works, OAuth disabled

    // Only one of the two Google creds present -> still disabled.
    await setSecret(appId, 'GOOGLE_CLIENT_ID', 'cid');
    expect((await resolveAuthConfig(appId)).google).toBeNull();
    await setSecret(appId, 'GOOGLE_CLIENT_SECRET', 'csecret');
    expect((await resolveAuthConfig(appId)).google).toEqual({ clientId: 'cid', clientSecret: 'csecret' });

    await setSecret(appId, 'AUTH_SERVICE_TOKEN', 'svc');
    expect((await resolveAuthConfig(appId)).serviceToken).toBe('svc');
  });
});

describe('identity store — durable, multi-user, unique email', () => {
  const APP = 'app_store';

  it('creates distinct users, enforces email uniqueness, canonicalizes email', async () => {
    const u1 = await authStore.createUser(APP, { email: 'Jane@Example.com', password_hash: 'h1' });
    expect(u1.email).toBe('jane@example.com');
    const u2 = await authStore.createUser(APP, { email: 'bob@example.com', password_hash: 'h2' });
    expect(u2.id).not.toBe(u1.id);
    await expect(authStore.createUser(APP, { email: 'JANE@example.com', password_hash: 'h3' })).rejects.toBeInstanceOf(
      authStore.EmailTakenError,
    );
    expect(await authStore.countUsers(APP)).toBe(2);
    expect((await authStore.findByEmail(APP, 'jane@example.com'))?.id).toBe(u1.id);
  });

  it('links OAuth users by provider id', async () => {
    const u = await authStore.createUser(APP, { email: 'g@example.com', provider: 'google', provider_user_id: 'google-123', email_verified: true });
    expect((await authStore.findByProvider(APP, 'google', 'google-123'))?.id).toBe(u.id);
  });

  it('survives a re-read from disk (durable)', async () => {
    const u = await authStore.createUser('app_persist', { email: 'p@example.com', password_hash: 'h' });
    // A fresh read (new call) reads the file the store wrote.
    expect((await authStore.getUser('app_persist', u.id))?.email).toBe('p@example.com');
  });

  it('sessions: create, revoke, revoke-all, active count', async () => {
    const u = await authStore.createUser('app_sess', { email: 's@example.com', password_hash: 'h' });
    const s1 = await authStore.createSession('app_sess', u.id, 3600);
    const s2 = await authStore.createSession('app_sess', u.id, 3600);
    expect(await authStore.activeSessionCount('app_sess')).toBe(2);
    await authStore.revokeSession('app_sess', s1.id);
    expect((await authStore.getSession('app_sess', s1.id))?.revoked).toBe(true);
    expect(await authStore.activeSessionCount('app_sess')).toBe(1);
    await authStore.revokeAllUserSessions('app_sess', u.id);
    expect(await authStore.activeSessionCount('app_sess')).toBe(0);
    expect((await authStore.getSession('app_sess', s2.id))?.revoked).toBe(true);
  });

  it('refresh tokens (P8): rotate, reuse-detect, revoke by session/user', async () => {
    const APP = 'app_refresh';
    const OPTS = { refreshTtlSeconds: 3600, sessionTtlSeconds: 3600, graceSeconds: 0 };
    async function seed() {
      const u = await authStore.createUser(APP, { email: `r-${Math.random().toString(36).slice(2)}@ex.com`, password_hash: 'h', email_verified: true });
      const s = await authStore.createSession(APP, u.id, 3600);
      await authStore.putRefreshToken(APP, { tokenHash: 'rt_1', userId: u.id, sessionId: s.id, ttlSeconds: 3600 });
      return { u, s };
    }

    // Rotate a live token: old revoked + linked, successor live, session slid.
    const a = await seed();
    const rot = await authStore.redeemRefreshToken(APP, 'rt_1', 'rt_2', OPTS);
    expect(rot).toEqual({ outcome: 'rotated', userId: a.u.id, sessionId: a.s.id });
    expect((await authStore.getRefreshToken(APP, 'rt_1'))?.rotated_to).toBe('rt_2');
    expect((await authStore.getRefreshToken(APP, 'rt_1'))?.revoked_at).toBeTruthy();
    expect((await authStore.getRefreshToken(APP, 'rt_2'))?.rotated_from).toBe('rt_1');
    expect((await authStore.getRefreshToken(APP, 'rt_2'))?.revoked_at).toBeNull();
    expect(await authStore.activeRefreshTokenCount(APP)).toBe(1);

    // Reuse of the already-rotated rt_1 (grace 0) → breach: whole chain + session dead.
    const reuse = await authStore.redeemRefreshToken(APP, 'rt_1', 'rt_3', OPTS);
    expect(reuse).toEqual({ outcome: 'reuse', userId: a.u.id, sessionId: a.s.id });
    expect(await authStore.activeRefreshTokenCount(APP)).toBe(0);
    expect((await authStore.getSession(APP, a.s.id))?.revoked).toBe(true);
    expect((await authStore.redeemRefreshToken(APP, 'rt_2', 'rt_4', OPTS)).outcome).toBe('invalid');

    // Unknown / expired / logout-revoked all read as 'invalid'.
    const b = await seed();
    expect((await authStore.redeemRefreshToken(APP, 'nope', 'x', OPTS)).outcome).toBe('invalid');
    await authStore.putRefreshToken(APP, { tokenHash: 'rt_exp', userId: b.u.id, sessionId: b.s.id, ttlSeconds: -1 });
    expect((await authStore.redeemRefreshToken(APP, 'rt_exp', 'x', OPTS)).outcome).toBe('invalid');
    await authStore.revokeSessionRefreshTokens(APP, b.s.id);
    expect((await authStore.redeemRefreshToken(APP, 'rt_1', 'x', OPTS)).outcome).toBe('invalid');

    // Benign concurrent retry within a generous grace → rotated, session stays live.
    const c = await seed();
    await authStore.redeemRefreshToken(APP, 'rt_1', 'rt_2', OPTS);
    const benign = await authStore.redeemRefreshToken(APP, 'rt_1', 'rt_2b', { ...OPTS, graceSeconds: 300 });
    expect(benign.outcome).toBe('rotated');
    expect((await authStore.getSession(APP, c.s.id))?.revoked).toBe(false);
    expect((await authStore.getRefreshToken(APP, 'rt_2b'))?.revoked_at).toBeNull();

    // A live token against a revoked session is invalid (defense in depth).
    const d = await seed();
    await authStore.revokeSession(APP, d.s.id);
    expect((await authStore.redeemRefreshToken(APP, 'rt_1', 'rt_2', OPTS)).outcome).toBe('invalid');

    // revokeAllUserRefreshTokens kills every token a user holds.
    const e = await seed();
    await authStore.putRefreshToken(APP, { tokenHash: 'rt_other', userId: e.u.id, sessionId: e.s.id, ttlSeconds: 3600 });
    expect(await authStore.revokeAllUserRefreshTokens(APP, e.u.id)).toBeGreaterThanOrEqual(2);
    expect((await authStore.redeemRefreshToken(APP, 'rt_1', 'z', OPTS)).outcome).toBe('invalid');
  });

  it('verify/reset tokens are single-use + expiring, stored only as a hash', async () => {
    const u = await authStore.createUser('app_tok', { email: 't@example.com', password_hash: 'h' });
    const { hash } = newToken();
    await authStore.putVerifyToken('app_tok', hash, u.id, 3600);
    // First consume works; second is rejected (single-use).
    expect(await authStore.consumeVerifyToken('app_tok', hash)).toBe(u.id);
    expect(await authStore.consumeVerifyToken('app_tok', hash)).toBeNull();
    // Expired token is rejected.
    const { hash: h2 } = newToken();
    await authStore.putResetToken('app_tok', h2, u.id, -1); // already expired
    expect(await authStore.consumeResetToken('app_tok', h2)).toBeNull();
    // The raw token is never written to disk (only its hash).
    const { token: raw, hash: h3 } = newToken();
    await authStore.putVerifyToken('app_tok', h3, u.id, 3600);
    const fs = await import('node:fs/promises');
    const { authFile } = await import('../src/shared/paths');
    const onDisk = await fs.readFile(authFile('app_tok'), 'utf8');
    expect(onDisk).toContain(h3);
    expect(onDisk).not.toContain(raw);
  });
});
