import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { store } from '../storage/store';
import { executeCapability } from '../core/runtime';
import { ForgeError } from '../shared/errors';
import { SYSTEM_ACTOR } from '../shared/domain';
import {
  SESSION_COOKIE,
  REFRESH_COOKIE,
  APP_HEADER,
  DEFAULT_SESSION_TTL_SECONDS,
  signSessionToken,
  verifySessionToken,
  sessionCookie,
  clearSessionCookie,
  refreshCookie,
  clearRefreshCookie,
  parseCookies,
  accessTtlSeconds,
  refreshTtlSeconds,
  refreshReuseGraceSeconds,
  signOAuthState,
  verifyOAuthState,
  readOAuthStateApp,
  DEFAULT_OAUTH_STATE_TTL_SECONDS,
} from '../shared/session';
import {
  IMPLEMENTATION,
  hashPassword,
  verifyPassword,
  newToken,
  hashToken,
  newTwofaCode,
  twofaCodeTtlSeconds,
  twofaMaxAttempts,
  resolveAuthConfig,
  getOAuthProvider,
  redactEmail,
  VERIFY_TOKEN_TTL_SECONDS,
  RESET_TOKEN_TTL_SECONDS,
  type AuthConfig,
} from '../plugins/auth-identity/index';
import { resolveEmailConfig } from '../plugins/email-smtp/index';
import { hasValidServiceToken } from '../shared/service-auth';
import * as authStore from '../plugins/auth-identity/store';
import { resolveThemeForApp } from './theme-context';
import {
  DEFAULT_THEME,
  themeMetaHead,
  themeCustomStyleTag,
  themeTitle,
  themeLogoImg,
  type Theme,
} from '../shared/theme';

// C10 — the HOSTED identity/auth surface (platform-rendered pages + routes). The
// consuming app ships NO auth UI and NO auth tables: it proxies `/auth/*` to this
// surface (same-origin, so the session cookie is set on the app's domain) and gates
// the rest of itself with a tiny middleware that verifies the signed session cookie
// locally (see `shared/session.ts`, the reference the app mirrors).
//
// Registered on BOTH the control-plane API (dev) and the data-plane server (prod
// sidecar), like the C3/C4 routes — the data plane is where these run in production.
// `app` defaults to the server's own app (data-plane: FORGE_APP_NAME).
//
//   GET  /auth/login | /auth/signup | /auth/forgot | /auth/reset   -> hosted HTML pages
//   POST /auth/login | /auth/signup | /auth/forgot | /auth/reset   -> form handlers
//   GET  /auth/verify?token=                                       -> confirm email
//   GET  /auth/google | /auth/google/callback                     -> OAuth
//   GET|POST /auth/logout                                          -> clear session
//   GET  /auth/session                                             -> { userId, email, has_password, twofa_enabled } | 401
//   GET  /auth/config                                             -> which methods are enabled
//   POST /auth/password        { current_password, new_password }  -> change password (authenticated; JSON)
//   POST /auth/2fa/enable      { code? }                           -> enable email-2FA (send code, then confirm; JSON)
//   POST /auth/2fa/disable     { password? | code? }               -> disable email-2FA (re-verify; JSON)
//   POST /auth/2fa/verify      { challenge, code, next? }          -> complete a 2FA-gated login (challenge)
//   POST /auth/2fa/resend      { challenge }                       -> re-email a login-challenge code
//   POST /auth/admin/seed-owner  { app?, email, password? }        -> owner migration hook (§8)
//   DELETE /auth/admin/identity/:userId                            -> delete identity + creds (SERVICE token; idempotent)
//
// The two account-security features (2026-07-15, additive): (A) password CHANGE for password accounts,
// gated on the current session + current password; (B) STRICTLY OPT-IN email 2FA — a user who never
// enables it logs in exactly as before (zero behavior change). A 2FA-enabled login (password OR Google)
// does NOT issue a session immediately: it returns a "2fa_required" challenge (short-lived pending token
// + an emailed one-time code) that the client completes at POST /auth/2fa/verify. `has_password` +
// `twofa_enabled` on GET /auth/session tell a consumer which forms to offer.

const OAUTH_STATE_COOKIE = 'forge_oauth_state';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export function registerAuthRoutes(
  app: FastifyInstance,
  opts: { defaultApp?: () => string | undefined } = {},
): void {
  // HTML forms POST application/x-www-form-urlencoded, which Fastify doesn't parse
  // by default. Add a dependency-free parser (URLSearchParams) so we don't pull in
  // @fastify/formbody. JSON still parses via the built-in parser.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (e) {
          done(e as Error, undefined);
        }
      },
    );
  }

  // Resolve which app a /auth request targets. Precedence (P9): an explicit `app`
  // (query on GET, body on POST) → the `X-Forge-App` header a dev proxy sets so a
  // MULTI-app control plane can scope /auth without a per-app path mount → the
  // server's default (the single-app data-plane sidecar's FORGE_APP_NAME). Prod is
  // un-regressed: with no explicit app and no header, it falls through to the default.
  const trimmed = (v: unknown): string | undefined => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s || undefined;
  };
  const resolveAppName = (req: FastifyRequest, explicit?: string): string | undefined => {
    const fromExplicit = trimmed(explicit);
    if (fromExplicit) return fromExplicit;
    const fromQuery = trimmed((req.query as { app?: string } | undefined)?.app);
    if (fromQuery) return fromQuery;
    const fromBody = trimmed((req.body as { app?: string } | undefined)?.app);
    if (fromBody) return fromBody;
    const hdr = req.headers[APP_HEADER];
    const fromHeader = trimmed(Array.isArray(hdr) ? hdr[0] : hdr);
    if (fromHeader) return fromHeader;
    return opts.defaultApp?.();
  };
  const resolveAppId = async (req: FastifyRequest, explicit?: string): Promise<{ id: string; name: string } | null> => {
    const n = resolveAppName(req, explicit);
    if (!n) return null;
    const a = await store.findAppByName(n);
    return a && a.type === 'Application' ? { id: a.id, name: n } : null;
  };

  async function emit(appId: string, type: Parameters<typeof store.appendEvent>[0]['type'], resourceId: string, email?: string, extra?: Record<string, unknown>) {
    await store.appendEvent({
      type,
      resource_type: 'AuthUser',
      resource_id: resourceId,
      app_id: appId,
      actor: SYSTEM_ACTOR,
      data: { ...(email ? { email: redactEmail(email) } : {}), implementation: IMPLEMENTATION, ...(extra ?? {}) },
    });
  }

  // ---- request helpers ---------------------------------------------------------

  function insecureCookies(): boolean {
    return process.env.FORGE_AUTH_INSECURE_COOKIES === '1' || process.env.FORGE_AUTH_INSECURE_COOKIES === 'true';
  }
  function requestIsSecure(req: FastifyRequest): boolean {
    if (insecureCookies()) return false;
    const xf = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim();
    if (xf) return xf === 'https';
    return true; // production is behind TLS; local http dev sets FORGE_AUTH_INSECURE_COOKIES
  }
  function publicBase(req: FastifyRequest): string {
    const explicit = process.env.FORGE_AUTH_PUBLIC_URL;
    if (explicit) return explicit.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() || (requestIsSecure(req) ? 'https' : 'http');
    const host = String(req.headers['x-forwarded-host'] ?? req.headers['host'] ?? 'localhost');
    return `${proto}://${host}`;
  }
  // Only allow a same-site absolute PATH as a post-login destination (no open
  // redirect): must start with a single `/` not followed by `/` or `\` (a leading
  // `//` or `/\` can be read by browsers as a protocol-relative external URL).
  function safeNext(raw: unknown): string {
    const s = typeof raw === 'string' ? raw : '';
    return /^\/(?![/\\])/.test(s) ? s : '/';
  }
  function body(req: FastifyRequest): Record<string, string> {
    return (req.body ?? {}) as Record<string, string>;
  }
  function cookieVal(req: FastifyRequest, name: string): string | undefined {
    return parseCookies(req.headers.cookie)[name];
  }

  // A live session from the request cookie: token signature + expiry valid AND the
  // server-side session record is neither revoked nor expired (so sign-out and
  // password-reset truly kill it). Returns null otherwise.
  async function liveSession(req: FastifyRequest, appId: string, cfg: AuthConfig) {
    if (!cfg.sessionSecret) return null;
    const claims = verifySessionToken(cookieVal(req, SESSION_COOKIE), cfg.sessionSecret);
    if (!claims) return null;
    const s = await authStore.getSession(appId, claims.sessionId);
    if (!s || s.revoked || new Date(s.expires_at).getTime() <= Date.now()) return null;
    return { claims, session: s };
  }

  // Mint a real session for `user`: a server-side session record + a signed short access cookie + an
  // opaque revocable refresh cookie, emitting UserAuthenticated. Returns the two Set-Cookie lines WITHOUT
  // sending — so both the redirecting sign-in paths and the JSON completions (2FA verify, password change)
  // share the exact same session issuance. This is the seam a 2FA challenge sits in front of: nothing here
  // runs until the second factor is proven.
  async function mintSessionCookies(
    req: FastifyRequest,
    appId: string,
    cfg: AuthConfig,
    user: authStore.StoredUser,
  ): Promise<string[]> {
    const secure = requestIsSecure(req);
    const session = await authStore.createSession(appId, user.id, DEFAULT_SESSION_TTL_SECONDS);
    const now = Math.floor(Date.now() / 1000);
    // SHORT-lived access token (~15m JWS exp) — locally verifiable, no round-trip.
    const access = signSessionToken({ userId: user.id, email: user.email, sessionId: session.id }, cfg.sessionSecret!, accessTtlSeconds(), now);
    // The access cookie's Max-Age is the (long) session lifetime, so the browser keeps
    // presenting the token even after its short JWS `exp`; the gate then sees it's
    // expired and refreshes. The short-lived part is the JWS `exp`, not the cookie.
    const accessC = sessionCookie(access, { secure, maxAgeSeconds: refreshTtlSeconds() });
    // Opaque, revocable refresh token (~30d) — a new record persists its HASH only.
    const refreshRaw = newToken().token;
    await authStore.putRefreshToken(appId, { tokenHash: hashToken(refreshRaw), userId: user.id, sessionId: session.id, ttlSeconds: refreshTtlSeconds() });
    const refreshC = refreshCookie(refreshRaw, { secure, maxAgeSeconds: refreshTtlSeconds() });
    await emit(appId, 'UserAuthenticated', user.id, user.email, { method: user.provider ?? 'password' });
    return [accessC, refreshC];
  }

  // Issue a session and 303-redirect. Shared by every successful sign-in path (password login, OAuth
  // callback) whose user does NOT have 2FA enabled — a 2FA user is diverted to a challenge first.
  async function establishSession(
    req: FastifyRequest,
    reply: FastifyReply,
    appId: string,
    cfg: AuthConfig,
    user: authStore.StoredUser,
    location: string,
    extraCookies: string[] = [],
  ) {
    const cookies = await mintSessionCookies(req, appId, cfg, user);
    reply.header('set-cookie', [...cookies, ...extraCookies]).code(303).header('location', location).send();
  }

  // Whether the client wants a JSON response (a programmatic caller) vs. the hosted HTML flow (a browser
  // form). Used by the login + 2FA-verify paths to content-negotiate: an HTML form gets a rendered page /
  // 303 redirect (unchanged hosted UX), a JSON client gets a structured challenge / identity.
  function wantsJson(req: FastifyRequest): boolean {
    const ctype = String(req.headers['content-type'] ?? '');
    if (ctype.includes('application/json')) return true;
    const accept = String(req.headers['accept'] ?? '');
    return accept.includes('application/json') && !accept.includes('text/html');
  }

  // The identity flags a consumer needs to decide which account-security forms to offer:
  //   has_password  — the account can change its password (false for a Google-only account)
  //   twofa_enabled — email 2FA is on for this account
  async function identityFields(appId: string, userId: string): Promise<{ has_password: boolean; twofa_enabled: boolean }> {
    const u = await authStore.getUser(appId, userId);
    return { has_password: Boolean(u?.password_hash), twofa_enabled: Boolean(u?.twofa_enabled) };
  }

  // The authenticated user behind a live session, or null (used by the session-gated account-security
  // endpoints: password change, 2FA enable/disable).
  async function authedUser(req: FastifyRequest, appId: string, cfg: AuthConfig): Promise<authStore.StoredUser | null> {
    const live = await liveSession(req, appId, cfg);
    if (!live) return null;
    return authStore.getUser(appId, live.claims.userId);
  }

  // Deterministic 2FA-code keys. Login is keyed by the opaque challenge token (the only thing the
  // unauthenticated verify endpoint holds); enroll/disable are session-authenticated, so keyed by user.
  const twofaLoginId = (challengeRaw: string) => `2fa:login:${hashToken(challengeRaw)}`;
  const twofaEnableId = (userId: string) => `2fa:enable:${userId}`;
  const twofaDisableId = (userId: string) => `2fa:disable:${userId}`;

  // Mint + email a one-time 2FA code, storing only its hash. Returns true when the app has email
  // configured (the code was handed to C12 for delivery), false when email is unconfigured (the caller
  // surfaces a clean "can't deliver" rather than a crash). A transient transport failure still returns
  // true — the code is live and the client can resend.
  async function issueTwofaCode(
    appName: string,
    appId: string,
    user: authStore.StoredUser,
    id: string,
    purpose: 'login' | 'enable' | 'disable',
    next?: string,
  ): Promise<boolean> {
    const emailCfg = await resolveEmailConfig(appId);
    if (!emailCfg.ok) return false;
    const otp = newTwofaCode();
    await authStore.putTwofaCode(appId, {
      id,
      userId: user.id,
      purpose,
      codeHash: otp.hash,
      ttlSeconds: twofaCodeTtlSeconds(),
      ...(next ? { next } : {}),
    });
    // Fact only — never the code or its hash (emit redacts the email).
    await emit(appId, 'TwofaChallengeIssued', user.id, user.email, { purpose });
    try {
      await executeCapability('send-email', { app: appName, to: user.email, template: 'twofa-code', data: { code: otp.code } }, SYSTEM_ACTOR);
    } catch {
      // C12 unconfigured mid-flight (shouldn't happen — we checked ok above) — the stored code simply
      // expires. The client can resend. Never crash the auth flow.
    }
    return true;
  }

  // A structured JSON error, in the same `{ error: { code, message, retry } }` envelope the rest of the
  // auth surface uses (retry ∈ change-input | no | needs-human).
  function jerr(
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
    retry: 'change-input' | 'no' | 'needs-human',
    extra: Record<string, unknown> = {},
  ) {
    return reply.code(status).send({ error: { code, message, retry, ...extra } });
  }

  // Divert a would-be login (password OR Google) whose user has 2FA enabled: mint a short-lived pending
  // challenge, email a one-time code, and return a "2fa_required" response (JSON challenge, or the hosted
  // enter-code page). The real session is issued ONLY after POST /auth/2fa/verify succeeds. No session,
  // access token, or refresh token exists until then — the second factor strictly gates issuance.
  async function startLoginChallenge(
    req: FastifyRequest,
    reply: FastifyReply,
    app_: { id: string; name: string },
    cfg: AuthConfig,
    user: authStore.StoredUser,
    next: string,
  ) {
    const json = wantsJson(req);
    const challengeRaw = newToken().token;
    const delivered = await issueTwofaCode(app_.name, app_.id, user, twofaLoginId(challengeRaw), 'login', next);
    if (!delivered) {
      // 2FA is on but the code can't be delivered (email unconfigured). Fail CLOSED — never fall back to a
      // password-only session, which would silently bypass the second factor.
      if (json) return jerr(reply, 503, 'twofa_undeliverable', 'Two-factor codes cannot be delivered right now. Contact support.', 'needs-human');
      const theme = await themeFor(app_.id);
      return htmlReply(reply, 503, loginPage({ next, google: Boolean(cfg.google), error: 'We could not send your verification code. Please try again later.', email: user.email, theme }));
    }
    if (json) {
      return reply.code(200).send({
        status: '2fa_required',
        challenge: challengeRaw,
        delivery: 'email',
        sent_to: redactEmail(user.email),
        expires_in: twofaCodeTtlSeconds(),
        methods: ['email'],
      });
    }
    const theme = await themeFor(app_.id);
    return htmlReply(reply, 200, twofaChallengePage({ challenge: challengeRaw, next, app: app_.name, sent_to: redactEmail(user.email), theme }));
  }

  // Rotate the opaque refresh cookie into a fresh access+refresh pair, setting both
  // Set-Cookie headers on `reply` on success. Returns the identity on success, 'reuse'
  // on a detected stolen-token replay (breach — the caller 401s + clears cookies), or
  // null when there's nothing valid to refresh. Never calls reply.send() itself.
  async function performRefresh(
    req: FastifyRequest,
    reply: FastifyReply,
    appId: string,
    cfg: AuthConfig,
  ): Promise<{ userId: string; email: string; exp: number } | 'reuse' | null> {
    if (!cfg.sessionSecret) return null;
    const raw = cookieVal(req, REFRESH_COOKIE);
    if (!raw) return null;
    const successorRaw = newToken().token;
    const res = await authStore.redeemRefreshToken(appId, hashToken(raw), hashToken(successorRaw), {
      refreshTtlSeconds: refreshTtlSeconds(),
      sessionTtlSeconds: DEFAULT_SESSION_TTL_SECONDS,
      graceSeconds: refreshReuseGraceSeconds(),
    });
    if (res.outcome === 'reuse') {
      await emit(appId, 'SessionRevoked', res.userId, undefined, { reason: 'refresh_reuse_detected', session_id: res.sessionId });
      return 'reuse';
    }
    if (res.outcome !== 'rotated') return null;
    const user = await authStore.getUser(appId, res.userId);
    if (!user) return null;
    const secure = requestIsSecure(req);
    const now = Math.floor(Date.now() / 1000);
    const ttl = accessTtlSeconds();
    const access = signSessionToken({ userId: user.id, email: user.email, sessionId: res.sessionId }, cfg.sessionSecret, ttl, now);
    reply.header('set-cookie', [
      sessionCookie(access, { secure, maxAgeSeconds: refreshTtlSeconds() }),
      refreshCookie(successorRaw, { secure, maxAgeSeconds: refreshTtlSeconds() }),
    ]);
    await emit(appId, 'SessionRefreshed', user.id, user.email);
    return { userId: user.id, email: user.email, exp: now + ttl };
  }

  function htmlReply(reply: FastifyReply, status: number, htmlStr: string) {
    reply.code(status).type('text/html; charset=utf-8').send(htmlStr);
  }

  // Resolve the app's C16 theme so the hosted pages render branded (auth is themeable
  // via the SAME token set as the status page). Unknown app → the neutral default.
  const themeFor = async (appId?: string): Promise<Theme> =>
    appId ? resolveThemeForApp(appId) : DEFAULT_THEME;

  // ---- config (which methods are enabled) --------------------------------------

  app.get('/auth/config', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.code(404).send(unknownApp);
    const cfg = await resolveAuthConfig(app_.id);
    const email = await resolveEmailConfig(app_.id);
    return {
      methods: {
        // Password signup needs email delivery (verification); login works regardless.
        password: true,
        password_signup: email.ok,
        google: Boolean(cfg.google),
      },
      configured: {
        session_key: Boolean(cfg.sessionSecret),
        google: Boolean(cfg.google),
        email: email.ok,
        service_token: Boolean(cfg.serviceToken),
      },
    };
  });

  // ---- login -------------------------------------------------------------------

  app.get('/auth/login', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return htmlReply(reply, 404, page({ title: 'Sign in', bodyHtml: `<p class="err">Unknown app.</p>` }));
    const cfg = await resolveAuthConfig(app_.id);
    const theme = await themeFor(app_.id);
    const q = req.query as { next?: string; error?: string; notice?: string };
    htmlReply(reply, 200, loginPage({ next: safeNext(q.next), google: Boolean(cfg.google), error: q.error, notice: q.notice, theme }));
  });

  app.post('/auth/login', async (req, reply) => {
    const b = body(req);
    const app_ = await resolveAppId(req);
    if (!app_) return htmlReply(reply, 404, page({ title: 'Sign in', bodyHtml: `<p class="err">Unknown app.</p>` }));
    const cfg = await resolveAuthConfig(app_.id);
    const theme = await themeFor(app_.id);
    const next = safeNext(b.next);
    const fail = (msg: string) =>
      htmlReply(reply, 401, loginPage({ next, google: Boolean(cfg.google), error: msg, email: b.email, theme }));
    if (!cfg.sessionSecret) return htmlReply(reply, 503, notConfiguredPage(theme));

    const email = String(b.email ?? '');
    const password = String(b.password ?? '');
    const user = await authStore.findByEmail(app_.id, email);
    // Constant-ish message: never reveal whether the email exists.
    const ok = user ? await verifyPassword(password, user.password_hash) : await verifyPassword(password, undefined);
    if (!user || !ok) return fail('Incorrect email or password.');
    if (!user.email_verified) {
      return htmlReply(reply, 403, loginPage({ next, google: Boolean(cfg.google), error: 'Please verify your email before signing in. Check your inbox for the verification link.', email: user.email, theme }));
    }
    // OPT-IN 2FA gate: only a user who explicitly enabled it is diverted to a second-factor challenge —
    // a non-2FA account falls straight through to establishSession, byte-for-byte as before.
    if (user.twofa_enabled) {
      return startLoginChallenge(req, reply, app_, cfg, user, next);
    }
    await establishSession(req, reply, app_.id, cfg, user, next);
  });

  // ---- signup ------------------------------------------------------------------

  app.get('/auth/signup', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return htmlReply(reply, 404, page({ title: 'Sign up', bodyHtml: `<p class="err">Unknown app.</p>` }));
    const cfg = await resolveAuthConfig(app_.id);
    const email = await resolveEmailConfig(app_.id);
    const theme = await themeFor(app_.id);
    const q = req.query as { next?: string; error?: string };
    htmlReply(reply, 200, signupPage({ next: safeNext(q.next), google: Boolean(cfg.google), emailEnabled: email.ok, error: q.error, theme }));
  });

  app.post('/auth/signup', async (req, reply) => {
    const b = body(req);
    const app_ = await resolveAppId(req);
    if (!app_) return htmlReply(reply, 404, page({ title: 'Sign up', bodyHtml: `<p class="err">Unknown app.</p>` }));
    const cfg = await resolveAuthConfig(app_.id);
    const theme = await themeFor(app_.id);
    const next = safeNext(b.next);
    const emailCfg = await resolveEmailConfig(app_.id);
    const fail = (msg: string, status = 400) =>
      htmlReply(reply, status, signupPage({ next, google: Boolean(cfg.google), emailEnabled: emailCfg.ok, error: msg, email: b.email, theme }));

    if (!cfg.sessionSecret) return htmlReply(reply, 503, notConfiguredPage(theme));
    const email = String(b.email ?? '').trim();
    const password = String(b.password ?? '');
    if (!EMAIL_RE.test(email)) return fail('Enter a valid email address.');
    if (password.length < MIN_PASSWORD) return fail(`Password must be at least ${MIN_PASSWORD} characters.`);
    // Detectable absence (§7): email/pw signup needs C12. If email isn't configured,
    // BLOCK this path cleanly (Google still works) — never crash, never a half-account.
    if (!emailCfg.ok) {
      return fail('Email/password sign-up is unavailable right now (email delivery is not configured). Try continuing with Google.', 503);
    }

    const password_hash = await hashPassword(password);
    let user: authStore.StoredUser;
    try {
      user = await authStore.createUser(app_.id, { email, password_hash, email_verified: false });
    } catch (e) {
      if (e instanceof authStore.EmailTakenError) {
        // Don't leak existence via a hard error — send to login with a neutral notice.
        return reply
          .code(303)
          .header('location', `/auth/login?notice=${encodeURIComponent('If that email is registered, sign in or reset your password.')}`)
          .send();
      }
      throw e;
    }
    await emit(app_.id, 'UserSignedUp', user.id, user.email, { method: 'password' });

    // Generate the verify link (C10 owns token/link generation) and deliver it via C12.
    const { token, hash } = newToken();
    await authStore.putVerifyToken(app_.id, hash, user.id, VERIFY_TOKEN_TTL_SECONDS);
    const url = `${publicBase(req)}/auth/verify?token=${token}`;
    try {
      await executeCapability('send-email', { app: app_.name, to: user.email, template: 'verify-email', data: { url } }, SYSTEM_ACTOR);
    } catch (e) {
      // C12 unconfigured/failed — surface cleanly; the account exists but stays
      // unverified until a (future) resend succeeds. Never crash.
      const detail = e instanceof ForgeError && e.code === 'dependency_unavailable' ? ' (email delivery is not configured)' : '';
      return htmlReply(reply, 200, page({ theme, title: 'Almost there', bodyHtml: `<h1>Check your email</h1><p>We tried to send a verification link to <b>${escapeHtml(redactEmail(user.email))}</b> but delivery didn't go through${escapeHtml(detail)}. Please try again later.</p>` }));
    }
    htmlReply(reply, 200, checkEmailPage(user.email, theme));
  });

  // ---- verify email ------------------------------------------------------------

  app.get('/auth/verify', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return htmlReply(reply, 404, page({ title: 'Verify', bodyHtml: `<p class="err">Unknown app.</p>` }));
    const token = String((req.query as { token?: string }).token ?? '');
    const userId = token ? await authStore.consumeVerifyToken(app_.id, hashToken(token)) : null;
    if (!userId) {
      const theme = await themeFor(app_.id);
      return htmlReply(reply, 400, page({ theme, title: 'Verify', bodyHtml: `<h1>Link expired</h1><p>This verification link is invalid or has already been used. Sign in to request a new one.</p><p><a href="/auth/login">Go to sign in</a></p>` }));
    }
    await authStore.updateUser(app_.id, userId, { email_verified: true });
    const u = await authStore.getUser(app_.id, userId);
    await emit(app_.id, 'UserVerified', userId, u?.email);
    reply.code(303).header('location', `/auth/login?notice=${encodeURIComponent('Email verified — you can sign in now.')}`).send();
  });

  // ---- password reset ----------------------------------------------------------

  app.get('/auth/forgot', async (req, reply) => {
    const app_ = await resolveAppId(req);
    const theme = await themeFor(app_?.id);
    const q = req.query as { error?: string; notice?: string };
    htmlReply(reply, 200, forgotPage({ error: q.error, notice: q.notice, theme }));
  });

  app.post('/auth/forgot', async (req, reply) => {
    const b = body(req);
    const app_ = await resolveAppId(req);
    const theme = await themeFor(app_?.id);
    if (!app_) return htmlReply(reply, 404, forgotPage({ error: 'Unknown app.', theme }));
    const email = String(b.email ?? '').trim();
    const emailCfg = await resolveEmailConfig(app_.id);
    // Always respond identically — never reveal whether an account exists (§ no enumeration).
    const done = () =>
      htmlReply(reply, 200, page({ theme, title: 'Check your email', bodyHtml: `<h1>Check your email</h1><p>If an account exists for that address, we've sent a link to reset its password.</p>` }));
    if (!emailCfg.ok || !EMAIL_RE.test(email)) return done();
    const user = await authStore.findByEmail(app_.id, email);
    if (user) {
      const { token, hash } = newToken();
      await authStore.putResetToken(app_.id, hash, user.id, RESET_TOKEN_TTL_SECONDS);
      const url = `${publicBase(req)}/auth/reset?token=${token}`;
      await emit(app_.id, 'PasswordResetRequested', user.id, user.email);
      try {
        await executeCapability('send-email', { app: app_.name, to: user.email, template: 'reset-password', data: { url } }, SYSTEM_ACTOR);
      } catch {
        // Swallow — a delivery failure must not reveal the account exists.
      }
    }
    done();
  });

  app.get('/auth/reset', async (req, reply) => {
    const token = String((req.query as { token?: string }).token ?? '');
    const q = req.query as { error?: string; app?: string };
    const app_ = await resolveAppId(req);
    const theme = await themeFor(app_?.id);
    htmlReply(reply, 200, resetPage({ token, app: q.app, error: q.error, theme }));
  });

  app.post('/auth/reset', async (req, reply) => {
    const b = body(req);
    const app_ = await resolveAppId(req);
    const theme = await themeFor(app_?.id);
    if (!app_) return htmlReply(reply, 404, resetPage({ token: '', error: 'Unknown app.', theme }));
    const token = String(b.token ?? '');
    const password = String(b.password ?? '');
    if (password.length < MIN_PASSWORD) {
      return htmlReply(reply, 400, resetPage({ token, app: b.app, error: `Password must be at least ${MIN_PASSWORD} characters.`, theme }));
    }
    const userId = token ? await authStore.consumeResetToken(app_.id, hashToken(token)) : null;
    if (!userId) {
      return htmlReply(reply, 400, page({ theme, title: 'Reset password', bodyHtml: `<h1>Link expired</h1><p>This reset link is invalid or has already been used. <a href="/auth/forgot">Request a new one</a>.</p>` }));
    }
    const password_hash = await hashPassword(password);
    // A reset also VERIFIES the email (they proved control of it) and REVOKES all
    // existing sessions AND refresh tokens — "sign out everywhere": every device is
    // logged out and no revoked session can mint a new access token.
    await authStore.updateUser(app_.id, userId, { password_hash, email_verified: true });
    await authStore.revokeAllUserSessions(app_.id, userId);
    await authStore.revokeAllUserRefreshTokens(app_.id, userId);
    const u = await authStore.getUser(app_.id, userId);
    await emit(app_.id, 'PasswordChanged', userId, u?.email);
    reply
      .header('set-cookie', [clearSessionCookie({ secure: requestIsSecure(req) }), clearRefreshCookie({ secure: requestIsSecure(req) })])
      .code(303)
      .header('location', `/auth/login?notice=${encodeURIComponent('Password updated — sign in with your new password.')}`)
      .send();
  });

  // ---- Google OAuth ------------------------------------------------------------

  app.get('/auth/google', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return htmlReply(reply, 404, page({ title: 'Sign in', bodyHtml: `<p class="err">Unknown app.</p>` }));
    const cfg = await resolveAuthConfig(app_.id);
    // Google sign-in needs BOTH the OAuth client AND the session secret — the callback signs a session, and
    // (P37) the CSRF `state` is now an HMAC-signed token keyed by this secret (so it survives a cross-host
    // return with NO host-bound cookie). Without the secret we can't sign state → treat as unavailable.
    if (!cfg.google || !cfg.sessionSecret) {
      return reply.code(303).header('location', `/auth/login?error=${encodeURIComponent('Google sign-in is not available.')}`).send();
    }
    const next = safeNext((req.query as { next?: string }).next);
    // CSRF: a SIGNED, self-contained state (nonce + next + app + exp), HMAC'd with the app session secret.
    // It is verified on the callback by SIGNATURE — not by a cookie — so it survives the nested MCP-connect
    // flow where `/auth/google` runs on `api.<host>` but Google returns the callback to `app.<host>` (a
    // host-only cookie set on `api.<host>` would never be sent to `app.<host>`). See the callback below.
    const state = signOAuthState({ next, app: app_.name, nonce: newToken().token }, cfg.sessionSecret);
    const redirectUri = `${publicBase(req)}/auth/google/callback`;
    const url = getOAuthProvider().authorizeUrl({ clientId: cfg.google.clientId, redirectUri, state });
    // ALSO set a same-host binding cookie (defense in depth): when the whole flow stays on one host it adds
    // browser binding; its ABSENCE on the cross-host return is tolerated (the signature is authoritative),
    // its PRESENCE-but-mismatch is rejected on the callback.
    const stateCookie = `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${DEFAULT_OAUTH_STATE_TTL_SECONDS}${requestIsSecure(req) ? '; Secure' : ''}`;
    reply.header('set-cookie', stateCookie).code(303).header('location', url).send();
  });

  app.get('/auth/google/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    // Optional same-host binding cookie — may be ABSENT on the cross-host MCP-connect return (that's fine).
    const cookieState = cookieVal(req, OAUTH_STATE_COOKIE);
    const clearState = `${OAUTH_STATE_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${requestIsSecure(req) ? '; Secure' : ''}`;
    const bail = (msg: string) =>
      reply.header('set-cookie', clearState).code(303).header('location', `/auth/login?error=${encodeURIComponent(msg)}`).send();

    if (q.error) return bail('Google sign-in was cancelled.');
    if (!q.code || !q.state) return bail('Google sign-in failed (state mismatch). Please try again.');
    // Resolve the app to get its session secret. Prod (single-app data-plane) uses FORGE_APP_NAME; the
    // signed state also carries an app hint for the multi-app dev control plane — a routing key only, since
    // the SIGNATURE (verified next against that app's real secret) is the actual trust check.
    const app_ = await resolveAppId(req, readOAuthStateApp(q.state));
    if (!app_) return bail('Unknown app.');
    const cfg = await resolveAuthConfig(app_.id);
    if (!cfg.google || !cfg.sessionSecret) return bail('Google sign-in is not available.');
    // CSRF: the state must carry a VALID, UNEXPIRED signature from THIS app's secret (host-independent —
    // this is what fixes the cross-host MCP-connect return). If the same-host binding cookie is present it
    // must ALSO equal the state (tamper check); its absence on the cross-host path is expected + tolerated.
    const verifiedState = verifyOAuthState(q.state, cfg.sessionSecret);
    if (!verifiedState || verifiedState.app !== app_.name) return bail('Google sign-in failed (state mismatch). Please try again.');
    if (cookieState !== undefined && cookieState !== q.state) return bail('Google sign-in failed (state mismatch). Please try again.');
    const savedNext = verifiedState.next;

    let info;
    try {
      info = await getOAuthProvider().exchangeCode({
        code: q.code,
        redirectUri: `${publicBase(req)}/auth/google/callback`,
        clientId: cfg.google.clientId,
        clientSecret: cfg.google.clientSecret,
      });
    } catch {
      return bail('Google sign-in failed. Please try again.');
    }

    // Link by provider id first, then by email (an existing password account adopts
    // the Google link), else create a fresh account. Google accounts are verified.
    let user = await authStore.findByProvider(app_.id, 'google', info.providerUserId);
    if (!user) {
      const byEmail = await authStore.findByEmail(app_.id, info.email);
      if (byEmail) {
        user = await authStore.updateUser(app_.id, byEmail.id, {
          provider: 'google',
          provider_user_id: info.providerUserId,
          email_verified: byEmail.email_verified || info.emailVerified,
          ...(info.name ? { name: info.name } : {}),
        });
      } else {
        user = await authStore.createUser(app_.id, {
          email: info.email,
          provider: 'google',
          provider_user_id: info.providerUserId,
          email_verified: info.emailVerified,
          ...(info.name ? { name: info.name } : {}),
        });
        await emit(app_.id, 'UserSignedUp', user.id, user.email, { method: 'google' });
      }
    }
    if (!user) return bail('Google sign-in failed. Please try again.');
    // OPT-IN 2FA also gates the OAuth path: a 2FA-enabled account gets the emailed second-factor challenge
    // instead of an immediate session. (The state cookie is cleared regardless; the challenge carries the
    // post-login `next`.) A non-2FA account signs in exactly as before.
    if (user.twofa_enabled) {
      reply.header('set-cookie', clearState);
      return startLoginChallenge(req, reply, app_, cfg, user, safeNext(savedNext));
    }
    await establishSession(req, reply, app_.id, cfg, user, safeNext(savedNext), [clearState]);
  });

  // ---- sign-out ----------------------------------------------------------------

  const logout = async (req: FastifyRequest, reply: FastifyReply) => {
    const secure = requestIsSecure(req);
    const app_ = await resolveAppId(req);
    if (app_) {
      const cfg = await resolveAuthConfig(app_.id);
      let sessionId: string | undefined;
      let userId: string | undefined;
      let email: string | undefined;
      // Prefer the (possibly still-valid) access token's claims...
      if (cfg.sessionSecret) {
        const claims = verifySessionToken(cookieVal(req, SESSION_COOKIE), cfg.sessionSecret);
        if (claims) {
          sessionId = claims.sessionId;
          userId = claims.userId;
          email = claims.email;
        }
      }
      // ...else fall back to the refresh cookie's record — the short access token may
      // have already expired, but logout must still kill the session.
      const rawRefresh = cookieVal(req, REFRESH_COOKIE);
      if (rawRefresh) {
        const rec = await authStore.getRefreshToken(app_.id, hashToken(rawRefresh));
        if (rec) {
          sessionId ??= rec.session_id;
          userId ??= rec.user_id;
        }
      }
      if (sessionId) {
        // Revoke the server session AND its whole refresh chain, so no new access can
        // be minted; the current access token dies within its short window.
        await authStore.revokeSession(app_.id, sessionId);
        await authStore.revokeSessionRefreshTokens(app_.id, sessionId);
        if (!email && userId) email = (await authStore.getUser(app_.id, userId))?.email;
        await emit(app_.id, 'SessionRevoked', userId ?? sessionId, email);
      }
    }
    reply
      .header('set-cookie', [clearSessionCookie({ secure }), clearRefreshCookie({ secure })])
      .code(303)
      .header('location', '/auth/login?notice=' + encodeURIComponent('Signed out.'))
      .send();
  };
  app.post('/auth/logout', logout);
  app.get('/auth/logout', logout);

  // ---- refresh (P8: short-lived access + rotating, revocable refresh) ----------

  // The consuming app's gate calls this SERVER-SIDE (same-origin) when it local-verifies
  // `forge_session` and finds it expired/absent but a `forge_refresh` cookie is present.
  // On success it sets a rotated `forge_session` + `forge_refresh` and returns the
  // identity; on any failure it 401s and clears BOTH cookies (so the app treats the
  // request as unauthenticated). Reuse of an already-rotated refresh → the whole chain
  // is revoked (see performRefresh / redeemRefreshToken).
  app.post('/auth/refresh', async (req, reply) => {
    const secure = requestIsSecure(req);
    const clear401 = () =>
      reply
        .header('set-cookie', [clearSessionCookie({ secure }), clearRefreshCookie({ secure })])
        .code(401)
        .send({ error: { code: 'unauthenticated', message: 'no valid session', retry: 'no' } });
    const app_ = await resolveAppId(req);
    if (!app_) return clear401();
    const cfg = await resolveAuthConfig(app_.id);
    const r = await performRefresh(req, reply, app_.id, cfg);
    if (r === null || r === 'reuse') return clear401();
    return reply.code(200).send({ ...r, ...(await identityFields(app_.id, r.userId)) });
  });

  // ---- session accessor (the verify-endpoint option) ---------------------------

  app.get('/auth/session', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.code(404).send(unknownApp);
    const cfg = await resolveAuthConfig(app_.id);
    const secure = requestIsSecure(req);
    const live = await liveSession(req, app_.id, cfg);
    if (live) {
      // Sliding expiry: extend the server session + re-issue a fresh SHORT access cookie.
      await authStore.touchSession(app_.id, live.session.id, DEFAULT_SESSION_TTL_SECONDS);
      const now = Math.floor(Date.now() / 1000);
      const ttl = accessTtlSeconds();
      const token = signSessionToken({ userId: live.claims.userId, email: live.claims.email, sessionId: live.session.id }, cfg.sessionSecret!, ttl, now);
      reply.header('set-cookie', sessionCookie(token, { secure, maxAgeSeconds: refreshTtlSeconds() }));
      return { userId: live.claims.userId, email: live.claims.email, exp: now + ttl, ...(await identityFields(app_.id, live.claims.userId)) };
    }
    // Access expired/absent — for apps using this accessor (a round-trip pattern) rather
    // than the local-verify gate, transparently rotate the refresh so their effective
    // session length stays ~30d (as before P8), not capped at the 15-min access window.
    const r = await performRefresh(req, reply, app_.id, cfg);
    if (r && r !== 'reuse') return { userId: r.userId, email: r.email, exp: r.exp, ...(await identityFields(app_.id, r.userId)) };
    if (r === 'reuse') reply.header('set-cookie', [clearSessionCookie({ secure }), clearRefreshCookie({ secure })]);
    return reply.code(401).send({ error: { code: 'unauthenticated', message: 'no active session', retry: 'no' } });
  });

  // ---- change password (authenticated; password accounts) ---------------------
  // Verifies the live session AND the supplied current password, enforces the password policy on the
  // new one, then updates it and signs the user out EVERYWHERE ELSE (revokes all sessions + refresh
  // tokens) while keeping THIS device signed in via a freshly-minted session. A Google-only account
  // (no password) is a clean 409 `no_password` (use password reset to set one).
  app.post('/auth/password', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.code(404).send(unknownApp);
    const cfg = await resolveAuthConfig(app_.id);
    if (!cfg.sessionSecret) return jerr(reply, 503, 'auth_not_configured', 'Authentication is not configured for this app.', 'needs-human');
    const user = await authedUser(req, app_.id, cfg);
    if (!user) return jerr(reply, 401, 'unauthenticated', 'A valid session is required.', 'no');
    if (!user.password_hash) return jerr(reply, 409, 'no_password', 'This account has no password (it signs in with Google). Use password reset to set one.', 'no');
    const b = body(req);
    const current = String(b.current_password ?? '');
    const next = String(b.new_password ?? '');
    if (next.length < MIN_PASSWORD) return jerr(reply, 422, 'weak_password', `New password must be at least ${MIN_PASSWORD} characters.`, 'change-input');
    if (!(await verifyPassword(current, user.password_hash))) {
      return jerr(reply, 403, 'current_password_incorrect', 'Your current password is incorrect.', 'change-input');
    }
    const password_hash = await hashPassword(next);
    await authStore.updateUser(app_.id, user.id, { password_hash });
    // Sign out everywhere, then re-establish THIS device so the caller isn't logged out of the session
    // they just used. (Mirrors the reset flow's "sign out everywhere" while keeping the current device.)
    await authStore.revokeAllUserSessions(app_.id, user.id);
    await authStore.revokeAllUserRefreshTokens(app_.id, user.id);
    const cookies = await mintSessionCookies(req, app_.id, cfg, user);
    await emit(app_.id, 'PasswordChanged', user.id, user.email, { via: 'change' });
    return reply.header('set-cookie', cookies).code(200).send({ ok: true, has_password: true });
  });

  // ---- 2FA enable (authenticated; two-phase, opt-in) ---------------------------
  // Phase 1 (no `code`): email a one-time code to the account email (proves the user controls it),
  // returns `{ pending: true, ... }`. Phase 2 (`code`): verify it, then flip `twofa_enabled` on. Email
  // delivery is required (it's the second factor's channel) — a clean 503 `email_unavailable` if not.
  app.post('/auth/2fa/enable', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.code(404).send(unknownApp);
    const cfg = await resolveAuthConfig(app_.id);
    if (!cfg.sessionSecret) return jerr(reply, 503, 'auth_not_configured', 'Authentication is not configured for this app.', 'needs-human');
    const user = await authedUser(req, app_.id, cfg);
    if (!user) return jerr(reply, 401, 'unauthenticated', 'A valid session is required.', 'no');
    if (user.twofa_enabled) return jerr(reply, 409, 'already_enabled', 'Two-factor authentication is already enabled.', 'no');
    const b = body(req);
    const code = typeof b.code === 'string' ? b.code.trim() : '';
    const id = twofaEnableId(user.id);
    if (!code) {
      const delivered = await issueTwofaCode(app_.name, app_.id, user, id, 'enable');
      if (!delivered) return jerr(reply, 503, 'email_unavailable', 'Email delivery is not configured, so a 2FA code cannot be sent.', 'needs-human');
      return reply.code(200).send({ pending: true, delivery: 'email', sent_to: redactEmail(user.email), expires_in: twofaCodeTtlSeconds() });
    }
    const res = await authStore.redeemTwofaCode(app_.id, id, hashToken(code), { maxAttempts: twofaMaxAttempts() });
    if (res.outcome === 'invalid') return jerr(reply, 400, 'code_expired', 'No active code — request a new one.', 'change-input');
    if (res.outcome === 'exhausted') return jerr(reply, 429, 'too_many_attempts', 'Too many incorrect attempts. Request a new code.', 'needs-human');
    if (res.outcome === 'mismatch') return jerr(reply, 401, 'code_incorrect', 'That code is incorrect.', 'change-input', { attempts_remaining: res.attemptsRemaining });
    await authStore.updateUser(app_.id, user.id, { twofa_enabled: true });
    await emit(app_.id, 'TwofaEnabled', user.id, user.email);
    return reply.code(200).send({ twofa_enabled: true });
  });

  // ---- 2FA disable (authenticated; re-verify) ----------------------------------
  // Requires re-verification: `password` (current password) OR `code` (an emailed code). With neither,
  // it starts re-verification by emailing a code (or asks for the password when email delivery is down).
  app.post('/auth/2fa/disable', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.code(404).send(unknownApp);
    const cfg = await resolveAuthConfig(app_.id);
    if (!cfg.sessionSecret) return jerr(reply, 503, 'auth_not_configured', 'Authentication is not configured for this app.', 'needs-human');
    const user = await authedUser(req, app_.id, cfg);
    if (!user) return jerr(reply, 401, 'unauthenticated', 'A valid session is required.', 'no');
    if (!user.twofa_enabled) return jerr(reply, 409, 'not_enabled', 'Two-factor authentication is not enabled.', 'no');
    const b = body(req);
    const password = typeof b.password === 'string' ? b.password : '';
    const code = typeof b.code === 'string' ? b.code.trim() : '';
    const id = twofaDisableId(user.id);
    const doDisable = async () => {
      await authStore.updateUser(app_.id, user.id, { twofa_enabled: false });
      await authStore.deleteTwofaCode(app_.id, id);
      await emit(app_.id, 'TwofaDisabled', user.id, user.email);
      return reply.code(200).send({ twofa_enabled: false });
    };
    if (password) {
      if (!user.password_hash) return jerr(reply, 400, 'no_password', 'This account has no password; verify with an emailed code instead.', 'change-input');
      if (!(await verifyPassword(password, user.password_hash))) return jerr(reply, 403, 'current_password_incorrect', 'Your current password is incorrect.', 'change-input');
      return doDisable();
    }
    if (code) {
      const res = await authStore.redeemTwofaCode(app_.id, id, hashToken(code), { maxAttempts: twofaMaxAttempts() });
      if (res.outcome === 'invalid') return jerr(reply, 400, 'code_expired', 'No active code — request a new one.', 'change-input');
      if (res.outcome === 'exhausted') return jerr(reply, 429, 'too_many_attempts', 'Too many incorrect attempts. Request a new code.', 'needs-human');
      if (res.outcome === 'mismatch') return jerr(reply, 401, 'code_incorrect', 'That code is incorrect.', 'change-input', { attempts_remaining: res.attemptsRemaining });
      return doDisable();
    }
    const delivered = await issueTwofaCode(app_.name, app_.id, user, id, 'disable');
    if (!delivered) {
      if (user.password_hash) return jerr(reply, 400, 'password_required', 'Provide current_password to disable 2FA (email delivery is unavailable).', 'change-input');
      return jerr(reply, 503, 'email_unavailable', 'Email delivery is not configured, so a 2FA code cannot be sent.', 'needs-human');
    }
    return reply.code(200).send({ pending: true, delivery: 'email', sent_to: redactEmail(user.email), expires_in: twofaCodeTtlSeconds() });
  });

  // ---- 2FA login-challenge verify (unauthenticated; completes a gated login) ---
  // The client submits the pending `challenge` (from the login/challenge response) + the emailed `code`.
  // On success the REAL session is issued here (this is the only place a 2FA user gets cookies).
  // Content-negotiated: a JSON caller gets `{ userId, email, has_password, twofa_enabled }`; a hosted
  // form gets a 303 redirect to `next`. Errors re-render the enter-code page (HTML) or a JSON error.
  app.post('/auth/2fa/verify', async (req, reply) => {
    const app_ = await resolveAppId(req);
    const json = wantsJson(req);
    const theme = await themeFor(app_?.id);
    if (!app_) return json ? reply.code(404).send(unknownApp) : htmlReply(reply, 404, page({ theme, title: 'Sign in', bodyHtml: `<p class="err">Unknown app.</p>` }));
    const cfg = await resolveAuthConfig(app_.id);
    if (!cfg.sessionSecret) return json ? jerr(reply, 503, 'auth_not_configured', 'Authentication is not configured for this app.', 'needs-human') : htmlReply(reply, 503, notConfiguredPage(theme));
    const b = body(req);
    const challenge = String(b.challenge ?? '');
    const code = String(b.code ?? '').trim();
    const next = safeNext(b.next);
    const id = twofaLoginId(challenge);
    const res = await authStore.redeemTwofaCode(app_.id, id, hashToken(code), { maxAttempts: twofaMaxAttempts() });
    if (res.outcome === 'invalid') {
      if (json) return jerr(reply, 400, 'challenge_invalid', 'This login challenge is invalid or has expired. Sign in again.', 'no');
      return htmlReply(reply, 400, page({ theme, title: 'Sign in', bodyHtml: `<h1>Challenge expired</h1><p>Your verification code expired. <a href="/auth/login">Sign in again</a>.</p>` }));
    }
    if (res.outcome === 'exhausted') {
      if (json) return jerr(reply, 429, 'too_many_attempts', 'Too many incorrect attempts. Sign in again.', 'no');
      return htmlReply(reply, 429, page({ theme, title: 'Sign in', bodyHtml: `<h1>Too many attempts</h1><p>Too many incorrect codes. <a href="/auth/login">Sign in again</a>.</p>` }));
    }
    if (res.outcome === 'mismatch') {
      const left = res.attemptsRemaining;
      if (json) return jerr(reply, 401, 'code_incorrect', 'That code is incorrect.', 'change-input', { attempts_remaining: left });
      return htmlReply(reply, 401, twofaChallengePage({ challenge, next, app: app_.name, error: `Incorrect code — ${left} attempt${left === 1 ? '' : 's'} left.`, theme }));
    }
    // outcome === 'ok' — second factor proven; issue the real session.
    const user = await authStore.getUser(app_.id, res.userId);
    if (!user) {
      if (json) return jerr(reply, 400, 'challenge_invalid', 'Account no longer exists.', 'no');
      return htmlReply(reply, 400, page({ theme, title: 'Sign in', bodyHtml: `<h1>Sign in failed</h1><p><a href="/auth/login">Try again</a>.</p>` }));
    }
    await emit(app_.id, 'TwofaChallengeVerified', user.id, user.email, { purpose: 'login' });
    const dest = safeNext(res.next ?? next);
    const cookies = await mintSessionCookies(req, app_.id, cfg, user);
    if (json) return reply.header('set-cookie', cookies).code(200).send({ userId: user.id, email: user.email, ...(await identityFields(app_.id, user.id)) });
    return reply.header('set-cookie', cookies).code(303).header('location', dest).send();
  });

  // ---- 2FA login-challenge resend (unauthenticated) ----------------------------
  // Re-email a fresh code for an in-flight login challenge (resets its attempt counter, preserves the
  // post-login destination). Never reveals more than the (already-known) redacted recipient.
  app.post('/auth/2fa/resend', async (req, reply) => {
    const app_ = await resolveAppId(req);
    const json = wantsJson(req);
    const theme = await themeFor(app_?.id);
    if (!app_) return json ? reply.code(404).send(unknownApp) : htmlReply(reply, 404, page({ theme, title: 'Sign in', bodyHtml: `<p class="err">Unknown app.</p>` }));
    const b = body(req);
    const challenge = String(b.challenge ?? '');
    const next = safeNext(b.next);
    const id = twofaLoginId(challenge);
    const rec = challenge ? await authStore.getTwofaCode(app_.id, id) : null;
    const invalid = () =>
      json
        ? jerr(reply, 400, 'challenge_invalid', 'This login challenge is invalid or has expired. Sign in again.', 'no')
        : htmlReply(reply, 400, page({ theme, title: 'Sign in', bodyHtml: `<h1>Challenge expired</h1><p><a href="/auth/login">Sign in again</a>.</p>` }));
    if (!rec || rec.purpose !== 'login') return invalid();
    const user = await authStore.getUser(app_.id, rec.user_id);
    if (!user) return invalid();
    const delivered = await issueTwofaCode(app_.name, app_.id, user, id, 'login', rec.next);
    if (!delivered) {
      if (json) return jerr(reply, 503, 'email_unavailable', 'Email delivery is not configured, so a code cannot be sent.', 'needs-human');
      return htmlReply(reply, 503, twofaChallengePage({ challenge, next: rec.next ?? next, app: app_.name, error: 'We could not send a new code. Try again later.', theme }));
    }
    if (json) return reply.code(200).send({ resent: true, delivery: 'email', sent_to: redactEmail(user.email), expires_in: twofaCodeTtlSeconds() });
    return htmlReply(reply, 200, twofaChallengePage({ challenge, next: rec.next ?? next, app: app_.name, sent_to: redactEmail(user.email), notice: 'We sent a new code.', theme }));
  });

  // ---- owner migration hook (§8) ----------------------------------------------

  app.post('/auth/admin/seed-owner', async (req, reply) => {
    const b = body(req);
    const app_ = await resolveAppId(req);
    if (!app_) return reply.code(404).send(unknownApp);
    const email = String(b.email ?? '').trim();
    if (!EMAIL_RE.test(email)) {
      return reply.code(422).send({ error: { code: 'invalid_input', message: 'a valid `email` is required', retry: 'change-input' } });
    }
    const password = typeof b.password === 'string' && b.password.length >= MIN_PASSWORD ? b.password : undefined;
    const password_hash = password ? await hashPassword(password) : undefined;

    let user = await authStore.findByEmail(app_.id, email);
    if (user) {
      user = await authStore.updateUser(app_.id, user.id, {
        is_owner: true,
        email_verified: true,
        ...(password_hash ? { password_hash } : {}),
      });
    } else {
      user = await authStore.createUser(app_.id, { email, is_owner: true, email_verified: true, ...(password_hash ? { password_hash } : {}) });
    }
    await emit(app_.id, 'OwnerSeeded', user!.id, user!.email);
    return {
      owner: { userId: user!.id, email: redactEmail(user!.email), is_owner: true, email_verified: true, has_password: Boolean(user!.password_hash) },
      note: password ? 'Owner can sign in with the given password.' : 'Owner has no password yet — use /auth/forgot to set one, or sign in with Google.',
    };
  });

  // ---- administrative identity enumeration ("list all accounts") ----------------------------------
  // List EVERY login identity for the app so an operator's admin tool can SEE + pick any account —
  // including "zombies" missing from the consumer's own app-domain index. SERVICE-token gated (NOT
  // end-user reachable), the SAME gate as the delete-by-id teardown below; read-only. The stored email
  // is returned IN FULL (an admin picking which account to purge must recognize it — this is a trusted
  // service-token caller, not a browser). `provider` is 'google' for an OAuth account, 'password' for a
  // password account, else null; `created_at` is the signup timestamp. Scoped to the resolved app
  // (`?app` / `X-Forge-App` / `FORGE_APP_NAME`) — the same app the delete-by-id route operates on.
  app.get('/auth/admin/identities', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.code(404).send(unknownApp);
    if (!(await hasValidServiceToken(req, app_.id))) return reply.code(401).send(needServiceToken);
    const users = await authStore.listUsers(app_.id);
    return reply.code(200).send({
      identities: users.map((u) => ({
        user_id: u.id,
        email: u.email ?? null,
        provider: u.provider ?? (u.password_hash ? 'password' : null),
        created_at: u.created_at ?? null,
      })),
    });
  });

  // ---- administrative identity teardown (account closure / right-to-be-forgotten) ----------------
  // Delete a login identity + ALL its credentials (password hash), sessions, refresh tokens, and
  // verify/reset tokens, so it can no longer authenticate and its email is FREED for re-registration.
  // SERVICE-token gated (NOT end-user reachable); a consumer calls this inside its own account-purge
  // cascade. Idempotent: an already-absent identity is a 200 no-op ({ deleted: false }), never a 404.
  // The platform NEVER touches the consumer's own domain rows.
  app.delete('/auth/admin/identity/:userId', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.code(404).send(unknownApp);
    if (!(await hasValidServiceToken(req, app_.id))) return reply.code(401).send(needServiceToken);
    const { userId } = req.params as { userId: string };
    const result = await authStore.deleteUser(app_.id, userId);
    if (result.deleted) await emit(app_.id, 'UserDeleted', userId, result.email ?? undefined);
    return reply.code(200).send({
      deleted: result.deleted,
      user_id: userId,
      ...(result.email ? { email: redactEmail(result.email) } : {}),
    });
  });
}

const needServiceToken = { error: { code: 'unauthorized', message: 'a valid service token is required for this administrative operation.', retry: 'needs-human' } };

const unknownApp = { error: { code: 'not_found', message: 'unknown app (pass `app` or set FORGE_APP_NAME).', retry: 'change-input' } };

// ================================================================================
// Hosted pages — minimal, neutral, self-contained (no app/goal specifics). All
// interpolated values are HTML-escaped (no injection). Kept intentionally plain.
// ================================================================================

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Auth-page component CSS — token-driven (C16). Every color/shape reads a `--forge-*`
// custom property, so an app's declared theme (and its dark @media variant) restyles
// these pages with no per-page knobs; light/dark switching happens at the token level.
const AUTH_CSS = `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--forge-color-bg);color:var(--forge-color-text);font:15px/1.5 var(--forge-font)}
.card{background:var(--forge-color-surface);width:100%;max-width:380px;margin:24px;padding:32px;border-radius:var(--forge-radius-lg);box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06);border:1px solid var(--forge-color-border)}
.brand-logo{display:block;height:34px;width:auto;max-width:200px;margin:0 0 18px}
h1{font-size:20px;margin:0 0 16px}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px;color:var(--forge-color-text)}
input[type=email],input[type=password],input[type=text]{width:100%;padding:10px 12px;border:1px solid var(--forge-color-border);border-radius:var(--forge-radius);font-size:15px;background:var(--forge-color-surface);color:var(--forge-color-text)}
input:focus{outline:2px solid color-mix(in srgb, var(--forge-color-primary) 55%, transparent);outline-offset:1px;border-color:var(--forge-color-primary)}
button{width:100%;margin-top:20px;padding:11px;border:0;border-radius:var(--forge-radius);background:var(--forge-color-primary);color:var(--forge-color-primary-contrast);font-size:15px;font-weight:600;cursor:pointer}
.oauth{display:block;text-align:center;margin-top:12px;padding:11px;border:1px solid var(--forge-color-border);border-radius:var(--forge-radius);background:var(--forge-color-surface);color:var(--forge-color-text);text-decoration:none;font-weight:600}
.muted{color:var(--forge-color-text-muted);font-size:13px}
.row{display:flex;justify-content:space-between;margin-top:14px}
a{color:var(--forge-color-primary);text-decoration:none}
.err{background:color-mix(in srgb, var(--forge-color-danger) 12%, var(--forge-color-surface));border:1px solid color-mix(in srgb, var(--forge-color-danger) 45%, var(--forge-color-border));color:var(--forge-color-danger);padding:10px 12px;border-radius:var(--forge-radius);font-size:13px;margin:0 0 4px}
.notice{background:color-mix(in srgb, var(--forge-color-success) 12%, var(--forge-color-surface));border:1px solid color-mix(in srgb, var(--forge-color-success) 45%, var(--forge-color-border));color:var(--forge-color-success);padding:10px 12px;border-radius:var(--forge-radius);font-size:13px;margin:0 0 4px}
.sep{display:flex;align-items:center;gap:10px;margin:18px 0;color:var(--forge-color-text-muted);font-size:12px}
.sep::before,.sep::after{content:"";flex:1;height:1px;background:var(--forge-color-border)}
`;

function page(opts: { title: string; bodyHtml: string; theme?: Theme }): string {
  const theme = opts.theme ?? DEFAULT_THEME;
  const brand = themeLogoImg(theme, 'brand-logo');
  return (
    `<!doctype html><html lang="en"><head>${themeMetaHead(theme, themeTitle(theme, opts.title))}` +
    `<style id="forge-base">${AUTH_CSS}</style></head><body>${themeCustomStyleTag(theme)}` +
    `<div class="card">${brand}${opts.bodyHtml}</div></body></html>`
  );
}

function alerts(error?: string, notice?: string): string {
  return (
    (notice ? `<p class="notice">${escapeHtml(notice)}</p>` : '') +
    (error ? `<p class="err">${escapeHtml(error)}</p>` : '')
  );
}

function loginPage(o: { next: string; google: boolean; error?: string; notice?: string; email?: string; theme?: Theme }): string {
  const nextField = `<input type="hidden" name="next" value="${escapeHtml(o.next)}">`;
  const googleBtn = o.google
    ? `<a class="oauth" href="/auth/google?next=${encodeURIComponent(o.next)}">Continue with Google</a><div class="sep">or</div>`
    : '';
  return page({
    theme: o.theme,
    title: 'Sign in',
    bodyHtml:
      `<h1>Sign in</h1>${alerts(o.error, o.notice)}${googleBtn}` +
      `<form method="post" action="/auth/login">${nextField}` +
      `<label>Email</label><input type="email" name="email" autocomplete="email" required value="${escapeHtml(o.email ?? '')}">` +
      `<label>Password</label><input type="password" name="password" autocomplete="current-password" required>` +
      `<button type="submit">Sign in</button></form>` +
      `<div class="row muted"><a href="/auth/forgot">Forgot password?</a><a href="/auth/signup?next=${encodeURIComponent(o.next)}">Create account</a></div>`,
  });
}

function signupPage(o: { next: string; google: boolean; emailEnabled: boolean; error?: string; email?: string; theme?: Theme }): string {
  const nextField = `<input type="hidden" name="next" value="${escapeHtml(o.next)}">`;
  const googleBtn = o.google
    ? `<a class="oauth" href="/auth/google?next=${encodeURIComponent(o.next)}">Continue with Google</a><div class="sep">or</div>`
    : '';
  const form = o.emailEnabled
    ? `<form method="post" action="/auth/signup">${nextField}` +
      `<label>Email</label><input type="email" name="email" autocomplete="email" required value="${escapeHtml(o.email ?? '')}">` +
      `<label>Password</label><input type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>` +
      `<button type="submit">Create account</button></form>`
    : `<p class="muted">Email/password sign-up is unavailable (email delivery isn't configured).${o.google ? ' Use Google above.' : ''}</p>`;
  return page({
    theme: o.theme,
    title: 'Sign up',
    bodyHtml:
      `<h1>Create account</h1>${alerts(o.error)}${googleBtn}${form}` +
      `<div class="row muted"><span>Have an account?</span><a href="/auth/login?next=${encodeURIComponent(o.next)}">Sign in</a></div>`,
  });
}

function forgotPage(o: { error?: string; notice?: string; theme?: Theme }): string {
  return page({
    theme: o.theme,
    title: 'Reset password',
    bodyHtml:
      `<h1>Reset password</h1>${alerts(o.error, o.notice)}<p class="muted">Enter your email and we'll send a reset link.</p>` +
      `<form method="post" action="/auth/forgot"><label>Email</label><input type="email" name="email" autocomplete="email" required>` +
      `<button type="submit">Send reset link</button></form><div class="row muted"><a href="/auth/login">Back to sign in</a></div>`,
  });
}

function resetPage(o: { token: string; app?: string; error?: string; theme?: Theme }): string {
  return page({
    theme: o.theme,
    title: 'Set a new password',
    bodyHtml:
      `<h1>Set a new password</h1>${alerts(o.error)}` +
      `<form method="post" action="/auth/reset"><input type="hidden" name="token" value="${escapeHtml(o.token)}">` +
      (o.app ? `<input type="hidden" name="app" value="${escapeHtml(o.app)}">` : '') +
      `<label>New password</label><input type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>` +
      `<button type="submit">Update password</button></form>`,
  });
}

function checkEmailPage(email: string, theme?: Theme): string {
  return page({
    theme,
    title: 'Check your email',
    bodyHtml: `<h1>Check your email</h1><p>We sent a verification link to <b>${escapeHtml(redactEmail(email))}</b>. Click it to activate your account, then sign in.</p><p class="muted"><a href="/auth/login">Back to sign in</a></p>`,
  });
}

function notConfiguredPage(theme?: Theme): string {
  return page({
    theme,
    title: 'Sign in unavailable',
    bodyHtml: `<h1>Sign in is unavailable</h1><p class="muted">Authentication isn't fully configured for this app yet (no session key). Please try again later.</p>`,
  });
}

// Hosted "enter your 2FA code" page — shown after a 2FA-enabled user's password/Google sign-in. Posts
// the emailed code + the pending challenge to /auth/2fa/verify (completing login), with a resend form.
function twofaChallengePage(o: { challenge: string; next: string; app?: string; error?: string; notice?: string; sent_to?: string; theme?: Theme }): string {
  const hidden =
    `<input type="hidden" name="challenge" value="${escapeHtml(o.challenge)}">` +
    `<input type="hidden" name="next" value="${escapeHtml(o.next)}">` +
    (o.app ? `<input type="hidden" name="app" value="${escapeHtml(o.app)}">` : '');
  const sent = o.sent_to
    ? `<p class="muted">We sent a 6-digit code to <b>${escapeHtml(o.sent_to)}</b>. Enter it below to finish signing in.</p>`
    : `<p class="muted">Enter the 6-digit code we emailed you to finish signing in.</p>`;
  return page({
    theme: o.theme,
    title: 'Two-factor verification',
    bodyHtml:
      `<h1>Enter your code</h1>${alerts(o.error, o.notice)}${sent}` +
      `<form method="post" action="/auth/2fa/verify">${hidden}` +
      `<label>Verification code</label>` +
      `<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" required autofocus>` +
      `<button type="submit">Verify</button></form>` +
      `<form method="post" action="/auth/2fa/resend">${hidden}` +
      `<button type="submit" class="oauth" style="margin-top:12px;">Resend code</button></form>` +
      `<div class="row muted"><a href="/auth/login">Back to sign in</a></div>`,
  });
}
