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
} from '../shared/session';
import {
  IMPLEMENTATION,
  hashPassword,
  verifyPassword,
  newToken,
  hashToken,
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
//   GET  /auth/session                                             -> { userId, email } | 401 (accessor)
//   GET  /auth/config                                             -> which methods are enabled
//   POST /auth/admin/seed-owner  { app?, email, password? }        -> owner migration hook (§8)
//   DELETE /auth/admin/identity/:userId                            -> delete identity + creds (SERVICE token; idempotent)

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

  // Issue a session (server record + signed cookie) and 303-redirect. Shared by
  // every successful sign-in path (password login, OAuth callback).
  async function establishSession(
    req: FastifyRequest,
    reply: FastifyReply,
    appId: string,
    cfg: AuthConfig,
    user: authStore.StoredUser,
    location: string,
    extraCookies: string[] = [],
  ) {
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
    reply.header('set-cookie', [accessC, refreshC, ...extraCookies]).code(303).header('location', location).send();
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
    if (!cfg.google) {
      return reply.code(303).header('location', `/auth/login?error=${encodeURIComponent('Google sign-in is not available.')}`).send();
    }
    const next = safeNext((req.query as { next?: string }).next);
    // CSRF: a random state echoed back on callback, bound to a short-lived cookie.
    const state = newToken().token;
    const redirectUri = `${publicBase(req)}/auth/google/callback`;
    const url = getOAuthProvider().authorizeUrl({ clientId: cfg.google.clientId, redirectUri, state });
    const stateCookie = `${OAUTH_STATE_COOKIE}=${encodeURIComponent(`${state}|${next}|${app_.name}`)}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${requestIsSecure(req) ? '; Secure' : ''}`;
    reply.header('set-cookie', stateCookie).code(303).header('location', url).send();
  });

  app.get('/auth/google/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const raw = cookieVal(req, OAUTH_STATE_COOKIE);
    const [savedState, savedNext, savedApp] = decodeURIComponent(raw ?? '').split('|');
    const clearState = `${OAUTH_STATE_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${requestIsSecure(req) ? '; Secure' : ''}`;
    const bail = (msg: string) =>
      reply.header('set-cookie', clearState).code(303).header('location', `/auth/login?error=${encodeURIComponent(msg)}`).send();

    if (q.error) return bail('Google sign-in was cancelled.');
    if (!q.code || !q.state || !savedState || q.state !== savedState) return bail('Google sign-in failed (state mismatch). Please try again.');
    const app_ = await resolveAppId(req, savedApp);
    if (!app_) return bail('Unknown app.');
    const cfg = await resolveAuthConfig(app_.id);
    if (!cfg.google || !cfg.sessionSecret) return bail('Google sign-in is not available.');

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
    return reply.code(200).send(r);
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
      return { userId: live.claims.userId, email: live.claims.email, exp: now + ttl };
    }
    // Access expired/absent — for apps using this accessor (a round-trip pattern) rather
    // than the local-verify gate, transparently rotate the refresh so their effective
    // session length stays ~30d (as before P8), not capped at the 15-min access window.
    const r = await performRefresh(req, reply, app_.id, cfg);
    if (r && r !== 'reuse') return { userId: r.userId, email: r.email, exp: r.exp };
    if (r === 'reuse') reply.header('set-cookie', [clearSessionCookie({ secure }), clearRefreshCookie({ secure })]);
    return reply.code(401).send({ error: { code: 'unauthenticated', message: 'no active session', retry: 'no' } });
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
input[type=email],input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--forge-color-border);border-radius:var(--forge-radius);font-size:15px;background:var(--forge-color-surface);color:var(--forge-color-text)}
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
