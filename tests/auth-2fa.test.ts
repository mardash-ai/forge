import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { setSecret } from '../src/plugins/secrets-local/index';
import { setEmailTransport, resetEmailTransport, type OutboundEmail } from '../src/plugins/email-smtp/index';
import { setOAuthProvider, resetOAuthProvider } from '../src/plugins/auth-identity/index';
import { registerAuthRoutes } from '../src/api/auth-routes';
import type { Application } from '../src/resources/types';
import { nowIso } from '../src/shared/time';

// C10 — account-security extensions (2026-07-15): password CHANGE + strictly-opt-in email 2FA.
// Driven through Fastify.inject; email is a capture SINK (no SMTP), OAuth is a deterministic STUB.
const APP = 'demo';
const SECRET_KEY = 'test-master-key-not-for-production';
const HDR = { host: 'app.test' };
const FORM = { host: 'app.test', 'content-type': 'application/x-www-form-urlencoded' };
const JSON_HDR = { host: 'app.test', 'content-type': 'application/json', accept: 'application/json' };

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
  return arr.find((c) => c.startsWith(`${name}=`));
}
function cookieValue(res: { cookies: Array<{ name: string; value: string }> }, name: string): string | undefined {
  return res.cookies.find((c) => c.name === name)?.value;
}
function linkToken(kind: 'verify' | 'reset'): string {
  const text = emails.map((e) => `${e.text ?? ''} ${e.html ?? ''}`).join('\n');
  const m = text.match(new RegExp(`/auth/${kind}\\?token=([A-Za-z0-9_-]+)`));
  if (!m) throw new Error(`no ${kind} link in captured email`);
  return m[1]!;
}
// The 6-digit one-time code from the MOST RECENT captured 2FA email.
function lastCode(): string {
  const last = emails[emails.length - 1];
  if (!last) throw new Error('no captured email');
  const m = `${last.text ?? ''} ${last.html ?? ''}`.match(/\b(\d{6})\b/);
  if (!m) throw new Error(`no 6-digit code in last email: ${last.subject}`);
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

// Full email/password onboarding → a logged-in response carrying the session cookies.
async function signupVerifyLogin(email = 'jane@example.com', password = 'correct horse battery') {
  await server.inject({ method: 'POST', url: '/auth/signup', headers: FORM, payload: form({ email, password }) });
  await server.inject({ method: 'GET', url: `/auth/verify?token=${linkToken('verify')}`, headers: HDR });
  return server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email, password }) });
}
// Session cookie header string usable on subsequent requests.
function sessionCookieHeader(res: { cookies: Array<{ name: string; value: string }> }): string {
  const s = cookieValue(res, 'forge_session')!;
  const r = cookieValue(res, 'forge_refresh');
  return r ? `forge_session=${s}; forge_refresh=${r}` : `forge_session=${s}`;
}
// Enable 2FA for an already-authenticated session (returns nothing; asserts success).
async function enable2fa(cookie: string) {
  const start = await server.inject({ method: 'POST', url: '/auth/2fa/enable', headers: { ...JSON_HDR, cookie }, payload: '{}' });
  expect(start.statusCode).toBe(200);
  expect(start.json()).toMatchObject({ pending: true, delivery: 'email' });
  const confirm = await server.inject({ method: 'POST', url: '/auth/2fa/enable', headers: { ...JSON_HDR, cookie }, payload: JSON.stringify({ code: lastCode() }) });
  expect(confirm.statusCode).toBe(200);
  expect(confirm.json()).toMatchObject({ twofa_enabled: true });
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
  dir = await mkdtemp(path.join(tmpdir(), 'forge-auth2fa-'));
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

// ================================================================================
// THE non-negotiable safety property: a user who has NOT enabled 2FA logs in EXACTLY
// as before — no challenge, no emailed code, an immediate session — and the session
// payload reports twofa_enabled:false.
// ================================================================================
describe('opt-in safety — a non-2FA login is byte-for-byte unchanged', () => {
  it('logs in with an immediate session, sends NO code, and reports twofa_enabled:false', async () => {
    await configureSessionAndEmail();
    await server.inject({ method: 'POST', url: '/auth/signup', headers: FORM, payload: form({ email: 'jane@example.com', password: 'correct horse battery' }) });
    await server.inject({ method: 'GET', url: `/auth/verify?token=${linkToken('verify')}`, headers: HDR });

    emails = []; // watch: a non-2FA login must email NOTHING
    const login = await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'jane@example.com', password: 'correct horse battery' }) });

    // Unchanged: 303 redirect + BOTH session cookies issued immediately (no challenge).
    expect(login.statusCode).toBe(303);
    expect(cookieValue(login, 'forge_session')).toBeTruthy();
    expect(cookieValue(login, 'forge_refresh')).toBeTruthy();
    expect(login.body).not.toContain('Enter your code');
    // Not a single 2FA email was sent.
    expect(emails.length).toBe(0);

    // The session payload carries the new fields; 2FA is OFF, and this is a password account.
    const me = await server.inject({ method: 'GET', url: '/auth/session', headers: { ...HDR, cookie: `forge_session=${cookieValue(login, 'forge_session')}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'jane@example.com', has_password: true, twofa_enabled: false });
  });

  it('a JSON login for a non-2FA user is NOT diverted to a challenge', async () => {
    await configureSessionAndEmail();
    await server.inject({ method: 'POST', url: '/auth/signup', headers: FORM, payload: form({ email: 'jane@example.com', password: 'correct horse battery' }) });
    await server.inject({ method: 'GET', url: `/auth/verify?token=${linkToken('verify')}`, headers: HDR });
    emails = [];
    const login = await server.inject({ method: 'POST', url: '/auth/login', headers: JSON_HDR, payload: JSON.stringify({ email: 'jane@example.com', password: 'correct horse battery' }) });
    // Never a 2fa_required challenge; still the normal 303 + immediate session.
    expect(login.statusCode).toBe(303);
    expect(cookieValue(login, 'forge_session')).toBeTruthy();
    expect(emails.length).toBe(0);
  });
});

describe('change password (authenticated)', () => {
  it('changes the password, signs out other devices, keeps THIS device, and enforces the policy', async () => {
    await configureSessionAndEmail();
    const login = await signupVerifyLogin('jane@example.com', 'original-pass-1');
    const cookie = sessionCookieHeader(login);
    const otherRefresh = cookieValue(login, 'forge_refresh')!;

    // A second device (independent login) — proves "sign out everywhere else".
    const login2 = await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'jane@example.com', password: 'original-pass-1' }) });
    const device2Refresh = cookieValue(login2, 'forge_refresh')!;

    // Wrong current password → 403.
    const wrong = await server.inject({ method: 'POST', url: '/auth/password', headers: { ...JSON_HDR, cookie }, payload: JSON.stringify({ current_password: 'nope', new_password: 'brand-new-pass-2' }) });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('current_password_incorrect');

    // Too-short new password → 422.
    const weak = await server.inject({ method: 'POST', url: '/auth/password', headers: { ...JSON_HDR, cookie }, payload: JSON.stringify({ current_password: 'original-pass-1', new_password: 'short' }) });
    expect(weak.statusCode).toBe(422);
    expect(weak.json().error.code).toBe('weak_password');

    // Correct change → 200, fresh cookies for THIS device.
    const ok = await server.inject({ method: 'POST', url: '/auth/password', headers: { ...JSON_HDR, cookie }, payload: JSON.stringify({ current_password: 'original-pass-1', new_password: 'brand-new-pass-2' }) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, has_password: true });
    const freshSession = cookieValue(ok, 'forge_session')!;

    // This device is still authenticated (fresh session works).
    expect((await server.inject({ method: 'GET', url: '/auth/session', headers: { ...HDR, cookie: `forge_session=${freshSession}` } })).statusCode).toBe(200);
    // The OTHER device's refresh token is dead (signed out everywhere else).
    expect((await server.inject({ method: 'POST', url: '/auth/refresh', headers: { ...HDR, cookie: `forge_refresh=${device2Refresh}` } })).statusCode).toBe(401);
    // The pre-change refresh token that came with the changed device is also rotated out.
    expect((await server.inject({ method: 'POST', url: '/auth/refresh', headers: { ...HDR, cookie: `forge_refresh=${otherRefresh}` } })).statusCode).toBe(401);

    // New password logs in; old fails.
    expect((await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'jane@example.com', password: 'brand-new-pass-2' }) })).statusCode).toBe(303);
    expect((await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'jane@example.com', password: 'original-pass-1' }) })).statusCode).toBe(401);
  });

  it('rejects an unauthenticated change with 401', async () => {
    await configureSessionAndEmail();
    const res = await server.inject({ method: 'POST', url: '/auth/password', headers: JSON_HDR, payload: JSON.stringify({ current_password: 'x', new_password: 'yyyyyyyy' }) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  it('a Google-only account (no password) is a clean 409 no_password', async () => {
    // Session secret + Google creds; create an OAuth-only account via the stubbed provider.
    await setSecret(appId, 'AUTH_SESSION_SECRET', 'the-session-signing-secret');
    await setSecret(appId, 'GOOGLE_CLIENT_ID', 'client-id');
    await setSecret(appId, 'GOOGLE_CLIENT_SECRET', 'client-secret');
    setOAuthProvider({
      authorizeUrl: ({ state, redirectUri, clientId }) => `https://accounts.google.test/auth?client_id=${clientId}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      exchangeCode: async () => ({ providerUserId: 'g-sub-1', email: 'oauth@example.com', emailVerified: true, name: 'OAuth User' }),
    });
    const authorize = await server.inject({ method: 'GET', url: '/auth/google', headers: HDR });
    const state = new URL(String(authorize.headers.location)).searchParams.get('state')!;
    const cb = await server.inject({ method: 'GET', url: `/auth/google/callback?code=c&state=${encodeURIComponent(state)}`, headers: HDR });
    const cookie = `forge_session=${cookieValue(cb, 'forge_session')}`;
    const res = await server.inject({ method: 'POST', url: '/auth/password', headers: { ...JSON_HDR, cookie }, payload: JSON.stringify({ current_password: '', new_password: 'brand-new-pass-2' }) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('no_password');
  });
});

describe('email 2FA — enroll, challenge, verify, resend, disable', () => {
  it('enable is two-phase and requires the correct emailed code', async () => {
    await configureSessionAndEmail();
    const cookie = sessionCookieHeader(await signupVerifyLogin());

    const start = await server.inject({ method: 'POST', url: '/auth/2fa/enable', headers: { ...JSON_HDR, cookie }, payload: '{}' });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ pending: true, delivery: 'email', sent_to: 'j***@example.com' });
    expect(emails[emails.length - 1]!.subject).toBe('Your verification code');

    // Wrong code → 401 with attempts_remaining; still not enabled.
    const wrong = await server.inject({ method: 'POST', url: '/auth/2fa/enable', headers: { ...JSON_HDR, cookie }, payload: JSON.stringify({ code: '000000' }) });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('code_incorrect');
    expect(typeof wrong.json().error.attempts_remaining).toBe('number');

    // Correct code → enabled.
    const confirm = await server.inject({ method: 'POST', url: '/auth/2fa/enable', headers: { ...JSON_HDR, cookie }, payload: JSON.stringify({ code: lastCode() }) });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toMatchObject({ twofa_enabled: true });

    // Session payload now reports it on.
    const me = await server.inject({ method: 'GET', url: '/auth/session', headers: { ...HDR, cookie } });
    expect(me.json()).toMatchObject({ twofa_enabled: true, has_password: true });
  });

  it('a 2FA-enabled login returns a challenge (no session) and completes only via /auth/2fa/verify', async () => {
    await configureSessionAndEmail();
    const first = await signupVerifyLogin();
    await enable2fa(sessionCookieHeader(first));

    // JSON login → 2fa_required challenge, NO session cookie issued.
    emails = [];
    const login = await server.inject({ method: 'POST', url: '/auth/login', headers: JSON_HDR, payload: JSON.stringify({ email: 'jane@example.com', password: 'correct horse battery' }) });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ status: '2fa_required', delivery: 'email' });
    const challenge = login.json().challenge as string;
    expect(challenge).toBeTruthy();
    expect(cookieValue(login, 'forge_session')).toBeUndefined();
    expect(emails.length).toBe(1); // the code was emailed

    // A wrong code does NOT complete login.
    const bad = await server.inject({ method: 'POST', url: '/auth/2fa/verify', headers: JSON_HDR, payload: JSON.stringify({ challenge, code: '000000' }) });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('code_incorrect');
    expect(cookieValue(bad, 'forge_session')).toBeUndefined();

    // The correct code completes login → real session.
    const done = await server.inject({ method: 'POST', url: '/auth/2fa/verify', headers: JSON_HDR, payload: JSON.stringify({ challenge, code: lastCode() }) });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ email: 'jane@example.com', twofa_enabled: true });
    const sess = cookieValue(done, 'forge_session')!;
    expect(sess).toBeTruthy();
    expect((await server.inject({ method: 'GET', url: '/auth/session', headers: { ...HDR, cookie: `forge_session=${sess}` } })).statusCode).toBe(200);
  });

  it('the hosted HTML login renders an enter-code page and the form completes login', async () => {
    await configureSessionAndEmail();
    await enable2fa(sessionCookieHeader(await signupVerifyLogin()));

    emails = [];
    // The post-login destination is decided AT LOGIN and carried through the challenge.
    const login = await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'jane@example.com', password: 'correct horse battery', next: '/dashboard' }) });
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain('Enter your code');
    expect(login.body).toContain('name="next" value="/dashboard"');
    expect(cookieValue(login, 'forge_session')).toBeUndefined();
    const challenge = login.body.match(/name="challenge" value="([^"]+)"/)![1]!;

    const done = await server.inject({ method: 'POST', url: '/auth/2fa/verify', headers: FORM, payload: form({ challenge, code: lastCode(), next: '/dashboard' }) });
    expect(done.statusCode).toBe(303);
    expect(done.headers.location).toBe('/dashboard');
    expect(cookieValue(done, 'forge_session')).toBeTruthy();
  });

  it('resend issues a NEW code (old one invalid) that completes login', async () => {
    await configureSessionAndEmail();
    await enable2fa(sessionCookieHeader(await signupVerifyLogin()));
    emails = [];
    const login = await server.inject({ method: 'POST', url: '/auth/login', headers: JSON_HDR, payload: JSON.stringify({ email: 'jane@example.com', password: 'correct horse battery' }) });
    const challenge = login.json().challenge as string;
    const firstCode = lastCode();

    const resend = await server.inject({ method: 'POST', url: '/auth/2fa/resend', headers: JSON_HDR, payload: JSON.stringify({ challenge }) });
    expect(resend.statusCode).toBe(200);
    expect(resend.json()).toMatchObject({ resent: true });
    const secondCode = lastCode();

    // If the codes happen to collide (1-in-a-million), skip the "old invalid" assertion.
    if (firstCode !== secondCode) {
      const stale = await server.inject({ method: 'POST', url: '/auth/2fa/verify', headers: JSON_HDR, payload: JSON.stringify({ challenge, code: firstCode }) });
      expect(stale.statusCode).toBe(401);
    }
    const done = await server.inject({ method: 'POST', url: '/auth/2fa/verify', headers: JSON_HDR, payload: JSON.stringify({ challenge, code: secondCode }) });
    expect(done.statusCode).toBe(200);
    expect(cookieValue(done, 'forge_session')).toBeTruthy();
  });

  it('disable via current password turns 2FA off — login returns to an immediate session', async () => {
    await configureSessionAndEmail();
    const cookie = sessionCookieHeader(await signupVerifyLogin());
    await enable2fa(cookie);

    const off = await server.inject({ method: 'POST', url: '/auth/2fa/disable', headers: { ...JSON_HDR, cookie }, payload: JSON.stringify({ password: 'correct horse battery' }) });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ twofa_enabled: false });

    // Wrong password → 403.
    // (Re-enable first to have something to disable.)
    await enable2fa(cookie);
    const wrong = await server.inject({ method: 'POST', url: '/auth/2fa/disable', headers: { ...JSON_HDR, cookie }, payload: JSON.stringify({ password: 'WRONG' }) });
    expect(wrong.statusCode).toBe(403);
    // Turn it back off with the emailed code path.
    const startCode = await server.inject({ method: 'POST', url: '/auth/2fa/disable', headers: { ...JSON_HDR, cookie }, payload: '{}' });
    expect(startCode.json()).toMatchObject({ pending: true });
    const viaCode = await server.inject({ method: 'POST', url: '/auth/2fa/disable', headers: { ...JSON_HDR, cookie }, payload: JSON.stringify({ code: lastCode() }) });
    expect(viaCode.json()).toMatchObject({ twofa_enabled: false });

    // Login is back to the unchanged immediate-session flow, no code emailed.
    emails = [];
    const login = await server.inject({ method: 'POST', url: '/auth/login', headers: FORM, payload: form({ email: 'jane@example.com', password: 'correct horse battery' }) });
    expect(login.statusCode).toBe(303);
    expect(cookieValue(login, 'forge_session')).toBeTruthy();
    expect(emails.length).toBe(0);
  });

  it('enable never leaks the code into the response or event log', async () => {
    await configureSessionAndEmail();
    const cookie = sessionCookieHeader(await signupVerifyLogin());
    const start = await server.inject({ method: 'POST', url: '/auth/2fa/enable', headers: { ...JSON_HDR, cookie }, payload: '{}' });
    const code = lastCode();
    expect(start.body).not.toContain(code);
    await server.inject({ method: 'POST', url: '/auth/2fa/enable', headers: { ...JSON_HDR, cookie }, payload: JSON.stringify({ code }) });
    const events = await store.listEvents({ app_id: appId });
    const json = JSON.stringify(events);
    expect(events.some((e) => e.type === 'TwofaEnabled')).toBe(true);
    expect(events.some((e) => e.type === 'TwofaChallengeIssued')).toBe(true);
    expect(json).not.toContain(code);
    expect(json).toContain('j***@example.com'); // redacted email only
  });
});

describe('Google OAuth honors 2FA', () => {
  it('a 2FA-enabled OAuth callback returns the challenge page, not a session', async () => {
    await configureSessionAndEmail();
    await setSecret(appId, 'GOOGLE_CLIENT_ID', 'client-id');
    await setSecret(appId, 'GOOGLE_CLIENT_SECRET', 'client-secret');
    setOAuthProvider({
      authorizeUrl: ({ state, redirectUri, clientId }) => `https://accounts.google.test/auth?client_id=${clientId}&state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      exchangeCode: async () => ({ providerUserId: 'g-sub-9', email: 'jane@example.com', emailVerified: true, name: 'Jane' }),
    });
    // Onboard jane as a password account, enable 2FA, then have Google link to the same email.
    const cookie = sessionCookieHeader(await signupVerifyLogin('jane@example.com', 'correct horse battery'));
    await enable2fa(cookie);

    emails = [];
    const authorize = await server.inject({ method: 'GET', url: '/auth/google', headers: HDR });
    const state = new URL(String(authorize.headers.location)).searchParams.get('state')!;
    const cb = await server.inject({ method: 'GET', url: `/auth/google/callback?code=c&state=${encodeURIComponent(state)}`, headers: HDR });
    // No session — the OAuth sign-in is gated by the emailed second factor.
    expect(cb.statusCode).toBe(200);
    expect(cb.body).toContain('Enter your code');
    expect(cookieValue(cb, 'forge_session')).toBeUndefined();
    expect(emails.length).toBe(1);
    const challenge = cb.body.match(/name="challenge" value="([^"]+)"/)![1]!;
    const done = await server.inject({ method: 'POST', url: '/auth/2fa/verify', headers: FORM, payload: form({ challenge, code: lastCode() }) });
    expect(done.statusCode).toBe(303);
    expect(cookieValue(done, 'forge_session')).toBeTruthy();
  });
});
