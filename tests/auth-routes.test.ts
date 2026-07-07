import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { setSecret } from '../src/plugins/secrets-local/index';
import { setEmailTransport, resetEmailTransport, type OutboundEmail } from '../src/plugins/email-smtp/index';
import { setOAuthProvider, resetOAuthProvider } from '../src/plugins/auth-identity/index';
import { registerAuthRoutes } from '../src/api/auth-routes';
import { authFile } from '../src/shared/paths';
import type { Application } from '../src/resources/types';
import { nowIso } from '../src/shared/time';

// C10 — hosted identity/auth end-to-end, driven through Fastify.inject (no sockets).
// Email is a capture SINK (no SMTP), OAuth is a deterministic STUB (no Google), so
// nothing here touches a real external provider.
const APP = 'demo';
const SECRET_KEY = 'test-master-key-not-for-production';
const HDR = { host: 'app.test' };
const FORM = { host: 'app.test', 'content-type': 'application/x-www-form-urlencoded' };

const prevKey = process.env.FORGE_SECRETS_KEY;
let dir: string;
let prevState: string | undefined;
let appId: string;
let server: FastifyInstance;
let emails: OutboundEmail[] = [];

function form(obj: Record<string, string>): string {
  return new URLSearchParams(obj).toString();
}
function setCookie(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const line = arr.find((c) => c.startsWith(`${name}=`));
  return line;
}
function cookieValue(res: { cookies: Array<{ name: string; value: string }> }, name: string): string | undefined {
  return res.cookies.find((c) => c.name === name)?.value;
}
function linkToken(kind: 'verify' | 'reset'): string {
  const text = emails.map((e) => `${e.text ?? ''} ${e.html ?? ''}`).join('\n');
  const m = text.match(new RegExp(`/auth/${kind}\\?token=([A-Za-z0-9_-]+)`));
  if (!m) throw new Error(`no ${kind} link in captured email; got: ${text.slice(0, 200)}`);
  return m[1]!;
}

async function seedApp(): Promise<Application> {
  const now = nowIso();
  const a: Application = {
    id: `app_${APP}`, type: 'Application', app_id: `app_${APP}`, created_at: now, updated_at: now,
    name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web',
    language: 'typescript', package_manager: 'npm',
  };
  await store.saveResource(a);
  return a;
}
async function configureSessionAndEmail() {
  await setSecret(appId, 'AUTH_SESSION_SECRET', 'the-session-signing-secret');
  await setSecret(appId, 'SMTP_URL', 'smtp://u:p@mail.test:587');
  await setSecret(appId, 'EMAIL_FROM', 'Demo <no-reply@demo.test>');
}

beforeAll(() => {
  process.env.FORGE_SECRETS_KEY = SECRET_KEY;
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
});

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-authroutes-'));
  process.env.FORGE_STATE_DIR = dir;
  delete process.env.FORGE_APP_NAME;
  for (const n of ['AUTH_SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'AUTH_SERVICE_TOKEN', 'SMTP_URL', 'EMAIL_FROM', 'FORGE_AUTH_PUBLIC_URL', 'FORGE_AUTH_INSECURE_COOKIES']) {
    delete process.env[n];
  }
  await store.init();
  const a = await seedApp();
  appId = a.id;
  emails = [];
  setEmailTransport(async (msg) => {
    emails.push(msg);
    return { id: `<captured-${emails.length}@demo.test>` };
  });
  server = Fastify({ logger: false });
  registerAuthRoutes(server, { defaultApp: () => APP });
  await server.ready();
});
afterEach(async () => {
  await server.close();
  resetEmailTransport();
  resetOAuthProvider();
  if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevState;
  await rm(dir, { recursive: true, force: true });
});

describe('email/password: signup → verify → login → session (cross-request) → sign-out', () => {
  it('runs the full flow and issues a secure session cookie', async () => {
    await configureSessionAndEmail();

    // Sign up.
    const signup = await server.inject({ method: 'POST', url: '/auth/signup', headers: FORM, payload: form({ email: 'jane@example.com', password: 'correct horse battery' }) });
    expect(signup.statusCode).toBe(200);
    expect(signup.body).toContain('Check your email');
    expect(emails.length).toBe(1);
    expect(emails[0]!.subject).toBe('Verify your email address');

    // Cannot log in before verifying.
    const early = await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'jane@example.com', password: 'correct horse battery' }) });
    expect(early.statusCode).toBe(403);
    expect(early.body).toContain('verify your email');

    // Verify via the emailed link.
    const token = linkToken('verify');
    const verify = await server.inject({ method: 'GET', url: `/auth/verify?token=${token}`, headers: HDR });
    expect(verify.statusCode).toBe(303);
    expect(verify.headers.location).toContain('/auth/login');

    // A used verify link is rejected (single-use).
    const reused = await server.inject({ method: 'GET', url: `/auth/verify?token=${token}`, headers: HDR });
    expect(reused.statusCode).toBe(400);

    // Log in → session cookie with httpOnly + Secure + SameSite.
    const login = await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'jane@example.com', password: 'correct horse battery' }) });
    expect(login.statusCode).toBe(303);
    const cookieLine = setCookie(login, 'forge_session')!;
    expect(cookieLine).toContain('HttpOnly');
    expect(cookieLine).toContain('Secure');
    expect(cookieLine).toContain('SameSite=Lax');
    const sessionToken = cookieValue(login, 'forge_session')!;
    expect(sessionToken.length).toBeGreaterThan(20);

    // Cross-request: the accessor returns the identity for the cookie.
    const me = await server.inject({ method: 'GET', url: '/auth/session', headers: { ...HDR, cookie: `forge_session=${sessionToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'jane@example.com' });
    expect(me.json().userId).toBeTruthy();

    // No cookie → 401 (this is what the app's /api gate relies on).
    const anon = await server.inject({ method: 'GET', url: '/auth/session', headers: HDR });
    expect(anon.statusCode).toBe(401);

    // Sign out revokes the server session; the SAME cookie is now dead.
    const out = await server.inject({ method: 'POST', url: '/auth/logout', headers: { ...FORM, cookie: `forge_session=${sessionToken}` }, payload: '' });
    expect(out.statusCode).toBe(303);
    expect(setCookie(out, 'forge_session')).toContain('Max-Age=0');
    const afterOut = await server.inject({ method: 'GET', url: '/auth/session', headers: { ...HDR, cookie: `forge_session=${sessionToken}` } });
    expect(afterOut.statusCode).toBe(401);
  });

  it('sanitizes the post-login `next` target (no open redirect)', async () => {
    await configureSessionAndEmail();
    // A protocol-relative / backslash target is neutralized to "/".
    for (const evil of ['//evil.com', '/\\evil.com', 'https://evil.com']) {
      const pg = await server.inject({ method: 'GET', url: `/auth/login?next=${encodeURIComponent(evil)}`, headers: HDR });
      expect(pg.body).toContain('name="next" value="/"');
      expect(pg.body).not.toContain(evil.replace(/&/g, '&amp;'));
    }
  });

  it('rejects a wrong password with 401 and never reveals the account', async () => {
    await configureSessionAndEmail();
    await server.inject({ method: 'POST', url: '/auth/signup', headers: FORM, payload: form({ email: 'jane@example.com', password: 'correct horse battery' }) });
    const token = linkToken('verify');
    await server.inject({ method: 'GET', url: `/auth/verify?token=${token}`, headers: HDR });
    const bad = await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'jane@example.com', password: 'WRONG' }) });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).toContain('Incorrect email or password');
    // An unknown email gives the same 401 (no user enumeration).
    const unknown = await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'nobody@example.com', password: 'whatever12' }) });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.body).toContain('Incorrect email or password');
  });
});

describe('password reset (self-service, single-use, revokes sessions)', () => {
  it('request → reset link → new password works, old fails, old sessions killed', async () => {
    await configureSessionAndEmail();
    await server.inject({ method: 'POST', url: '/auth/signup', headers: FORM, payload: form({ email: 'jane@example.com', password: 'original-pass-1' }) });
    await server.inject({ method: 'GET', url: `/auth/verify?token=${linkToken('verify')}`, headers: HDR });
    const login = await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'jane@example.com', password: 'original-pass-1' }) });
    const oldCookie = cookieValue(login, 'forge_session')!;

    // Request reset (identical response regardless of existence).
    emails = [];
    const forgot = await server.inject({ method: 'POST', url: '/auth/forgot', headers: FORM, payload: form({ email: 'jane@example.com' }) });
    expect(forgot.statusCode).toBe(200);
    expect(forgot.body).toContain('If an account exists');
    expect(emails[0]!.subject).toBe('Reset your password');

    // Set a new password.
    const rtoken = linkToken('reset');
    const reset = await server.inject({ method: 'POST', url: '/auth/reset', headers: FORM, payload: form({ token: rtoken, password: 'brand-new-pass-2' }) });
    expect(reset.statusCode).toBe(303);

    // A used reset token is rejected.
    const reuse = await server.inject({ method: 'POST', url: '/auth/reset', headers: FORM, payload: form({ token: rtoken, password: 'yet-another-3' }) });
    expect(reuse.statusCode).toBe(400);

    // New password logs in; old password fails.
    expect((await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'jane@example.com', password: 'brand-new-pass-2' }) })).statusCode).toBe(303);
    expect((await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'jane@example.com', password: 'original-pass-1' }) })).statusCode).toBe(401);

    // The pre-reset session was revoked.
    const me = await server.inject({ method: 'GET', url: '/auth/session', headers: { ...HDR, cookie: `forge_session=${oldCookie}` } });
    expect(me.statusCode).toBe(401);
  });

  it('forgot for an unknown email still returns the neutral page and sends nothing', async () => {
    await configureSessionAndEmail();
    emails = [];
    const forgot = await server.inject({ method: 'POST', url: '/auth/forgot', headers: FORM, payload: form({ email: 'ghost@example.com' }) });
    expect(forgot.statusCode).toBe(200);
    expect(forgot.body).toContain('If an account exists');
    expect(emails.length).toBe(0);
  });
});

describe('Google OAuth (stubbed provider)', () => {
  beforeEach(async () => {
    await setSecret(appId, 'AUTH_SESSION_SECRET', 'the-session-signing-secret');
    await setSecret(appId, 'GOOGLE_CLIENT_ID', 'client-id');
    await setSecret(appId, 'GOOGLE_CLIENT_SECRET', 'client-secret');
    setOAuthProvider({
      authorizeUrl: ({ state, redirectUri, clientId }) =>
        `https://accounts.google.test/auth?client_id=${clientId}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      exchangeCode: async () => ({ providerUserId: 'g-sub-123', email: 'oauth@example.com', emailVerified: true, name: 'OAuth User' }),
    });
  });

  it('authorize → callback creates a verified user and a session', async () => {
    const authorize = await server.inject({ method: 'GET', url: '/auth/google', headers: HDR });
    expect(authorize.statusCode).toBe(303);
    const loc = String(authorize.headers.location);
    expect(loc).toContain('accounts.google.test');
    const state = new URL(loc).searchParams.get('state')!;
    const stateCookie = cookieValue(authorize, 'forge_oauth_state')!;

    const cb = await server.inject({
      method: 'GET',
      url: `/auth/google/callback?code=auth-code&state=${state}`,
      headers: { ...HDR, cookie: `forge_oauth_state=${stateCookie}` },
    });
    expect(cb.statusCode).toBe(303);
    const sessionToken = cookieValue(cb, 'forge_session')!;
    expect(sessionToken).toBeTruthy();
    const me = await server.inject({ method: 'GET', url: '/auth/session', headers: { ...HDR, cookie: `forge_session=${sessionToken}` } });
    expect(me.json()).toMatchObject({ email: 'oauth@example.com' });
  });

  it('rejects a state mismatch (CSRF) and does not sign in', async () => {
    const authorize = await server.inject({ method: 'GET', url: '/auth/google', headers: HDR });
    const stateCookie = cookieValue(authorize, 'forge_oauth_state')!;
    const cb = await server.inject({
      method: 'GET',
      url: `/auth/google/callback?code=auth-code&state=TAMPERED`,
      headers: { ...HDR, cookie: `forge_oauth_state=${stateCookie}` },
    });
    expect(cb.statusCode).toBe(303);
    expect(String(cb.headers.location)).toContain('/auth/login?error=');
    expect(setCookie(cb, 'forge_session')).toBeUndefined();
  });
});

describe('graceful degradation (§7) — unconfigured pieces are detectable, never a crash', () => {
  it('no session key → login is cleanly unavailable (503), not a crash', async () => {
    // Email configured but NO AUTH_SESSION_SECRET.
    await setSecret(appId, 'SMTP_URL', 'smtp://u:p@mail.test:587');
    await setSecret(appId, 'EMAIL_FROM', 'Demo <no-reply@demo.test>');
    const login = await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'a@b.com', password: 'whatever12' }) });
    expect(login.statusCode).toBe(503);
    expect(login.body).toContain('unavailable');
  });

  it('no Google creds → OAuth disabled but reported; email/pw path unaffected', async () => {
    await configureSessionAndEmail(); // session + email, but no Google
    const cfg = await server.inject({ method: 'GET', url: '/auth/config', headers: HDR });
    expect(cfg.json().methods.google).toBe(false);
    expect(cfg.json().methods.password_signup).toBe(true);
    const g = await server.inject({ method: 'GET', url: '/auth/google', headers: HDR });
    expect(g.statusCode).toBe(303);
    expect(String(g.headers.location)).toContain('/auth/login?error=');
  });

  it('no email configured → email/pw signup is blocked cleanly (503), no user created', async () => {
    await setSecret(appId, 'AUTH_SESSION_SECRET', 'the-session-signing-secret'); // session yes, email NO
    const signup = await server.inject({ method: 'POST', url: '/auth/signup', headers: FORM, payload: form({ email: 'jane@example.com', password: 'correct horse battery' }) });
    expect(signup.statusCode).toBe(503);
    expect(signup.body).toContain('unavailable');
    // No account was persisted.
    let onDisk = '';
    try {
      onDisk = await readFile(authFile(appId), 'utf8');
    } catch {
      onDisk = '{}';
    }
    expect(onDisk).not.toContain('jane@example.com');
    const cfg = await server.inject({ method: 'GET', url: '/auth/config', headers: HDR });
    expect(cfg.json().methods.password_signup).toBe(false);
  });
});

describe('secret hygiene — the password is never returned, stored in plaintext, or logged', () => {
  it('keeps the plaintext out of responses, the store, and the event log', async () => {
    await configureSessionAndEmail();
    const PW = 'Sup3rS3cretPlaintext!';
    const signup = await server.inject({ method: 'POST', url: '/auth/signup', headers: FORM, payload: form({ email: 'jane@example.com', password: PW }) });
    expect(signup.body).not.toContain(PW);
    await server.inject({ method: 'GET', url: `/auth/verify?token=${linkToken('verify')}`, headers: HDR });
    const login = await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'jane@example.com', password: PW }) });
    expect(login.body).not.toContain(PW);
    // The stored session token in the cookie is not the password, and the account
    // record on disk holds only a scrypt hash — never the plaintext.
    const onDisk = await readFile(authFile(appId), 'utf8');
    expect(onDisk).toContain('scrypt$');
    expect(onDisk).not.toContain(PW);
    // The auth events carry only a REDACTED email, no password/hash.
    const events = await store.listEvents({ app_id: appId });
    const json = JSON.stringify(events);
    expect(events.some((e) => e.type === 'UserSignedUp')).toBe(true);
    expect(events.some((e) => e.type === 'UserAuthenticated')).toBe(true);
    expect(json).not.toContain(PW);
    expect(json).not.toContain('scrypt$');
    expect(json).toContain('j***@example.com'); // redacted recipient only
    expect(json).not.toContain('jane@example.com');
  });
});

describe('owner migration hook (§8)', () => {
  it('seeds an owner (verified) who can immediately sign in; response is redacted', async () => {
    await configureSessionAndEmail();
    const seed = await server.inject({ method: 'POST', url: '/auth/admin/seed-owner', headers: FORM, payload: form({ email: 'owner@example.com', password: 'owner-pass-123' }) });
    expect(seed.statusCode).toBe(200);
    const body = seed.json();
    expect(body.owner).toMatchObject({ is_owner: true, email_verified: true, has_password: true });
    expect(body.owner.email).toBe('o***@example.com'); // redacted
    expect(JSON.stringify(body)).not.toContain('owner-pass-123');
    // Owner logs in immediately (already verified — no email step).
    const login = await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'owner@example.com', password: 'owner-pass-123' }) });
    expect(login.statusCode).toBe(303);
    expect(cookieValue(login, 'forge_session')).toBeTruthy();
  });
});
