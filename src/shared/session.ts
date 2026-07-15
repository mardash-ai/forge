import { createHmac, timingSafeEqual } from 'node:crypto';

// C10 — the session-token + cookie contract shared by the platform (which SIGNS
// sessions in the hosted auth routes) and the consuming app (whose middleware
// VERIFIES them locally, with no per-request round-trip). This module is pure and
// framework-agnostic on purpose: it is the CANONICAL reference an app mirrors in
// its own `lib/auth.ts` / `middleware.ts` (exactly like `shared/health.ts` is the
// canonical health schema). The signing secret is a C5 secret (AUTH_SESSION_SECRET)
// injected into BOTH the data-plane (to sign) and the app (to verify) as env.
//
// Token format: a compact HS256 JWS — `base64url(header).base64url(payload).base64url(sig)`
// where sig = HMAC-SHA256(header + '.' + payload, secret). No dependency (Node crypto),
// so both the slim data-plane image and the app stay clean.

// The ACCESS-token cookie name (P8). A short-lived HS256 JWS the app verifies
// LOCALLY with no round-trip. httpOnly + Secure + SameSite=Lax. Its JWS `exp` is
// short (~15m) — that short window is what bounds exposure after a logout/reset,
// because a revoked session can mint no new access token. (The cookie's Max-Age is
// set to the session lifetime so the browser keeps presenting the — soon-expired —
// token, which is what drives the middleware's decision to refresh; see below.)
export const SESSION_COOKIE = 'forge_session';

// The REFRESH-token cookie name (P8). OPAQUE (a high-entropy random id, NOT a JWS):
// the app never inspects it, only forwards it to POST /auth/refresh. httpOnly +
// Secure + SameSite=Lax, long-lived (~30d). Path=/ (NOT /auth) on purpose: the app's
// gate runs on EVERY path and must be able to read this cookie to decide whether to
// refresh an expired access token — a Path=/auth cookie would not be sent to the
// browser on `/dashboard` etc., so the middleware could never see it. Security is
// preserved by opacity + httpOnly + Secure + SameSite=Lax + single-use server-side
// rotation + hashed-at-rest storage; it only ever travels same-origin over TLS.
export const REFRESH_COOKIE = 'forge_refresh';

// How a service (the C2 scheduler / cron) authenticates as a NON-user principal.
// The scheduler sends BOTH so an app can check whichever it prefers.
export const SERVICE_TOKEN_HEADER = 'x-forge-service-token';

// The app-scoping request header (P9). A multi-app control plane (dev) serves /auth
// for many apps and cannot infer which from a pure same-origin proxy; a dev proxy
// sets this header so the routes resolve the app WITHOUT a per-app path mount. In
// production the single-app data-plane sidecar defaults the app from FORGE_APP_NAME,
// so this header is unused there (prod path un-regressed).
export const APP_HEADER = 'x-forge-app';

// Long/sliding session lifetime (30 days) — the REFRESH token + the server-side
// session record live this long (sliding: rotation/activity re-extends them).
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

// Refresh-token lifetime is the session lifetime (kept as its own name for clarity
// at the call sites that mint/rotate refresh tokens).
export const DEFAULT_REFRESH_TTL_SECONDS = DEFAULT_SESSION_TTL_SECONDS;

// Default SHORT access-token lifetime (15 min). The gate verifies this locally; a
// revoked session can mint no new access, so exposure after logout/reset is bounded
// to at most this window. Overridable per-deploy via FORGE_AUTH_ACCESS_TTL_SECONDS.
export const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;

// Grace window (seconds) in which re-presenting an already-rotated refresh token is
// treated as a BENIGN concurrent retry (parallel gated subrequests firing one refresh
// each), not a stolen-token replay. Outside it, a reused rotated token is a breach →
// the whole session's refresh chain is revoked. Overridable for ops/tests.
export const DEFAULT_REFRESH_REUSE_GRACE_SECONDS = 15;

function intFromEnv(name: string, dflt: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// Resolved TTL knobs (env-overridable, clamped to sane bounds).
export function accessTtlSeconds(): number {
  return intFromEnv('FORGE_AUTH_ACCESS_TTL_SECONDS', DEFAULT_ACCESS_TTL_SECONDS, 30, DEFAULT_SESSION_TTL_SECONDS);
}
export function refreshTtlSeconds(): number {
  return intFromEnv('FORGE_AUTH_REFRESH_TTL_SECONDS', DEFAULT_REFRESH_TTL_SECONDS, 60, 60 * 60 * 24 * 365);
}
export function refreshReuseGraceSeconds(): number {
  return intFromEnv('FORGE_AUTH_REFRESH_REUSE_GRACE_SECONDS', DEFAULT_REFRESH_REUSE_GRACE_SECONDS, 0, 300);
}

export interface SessionClaims {
  // The platform user id.
  userId: string;
  email: string;
  // The server-side session id (revocable via sign-out).
  sessionId: string;
  // Issued-at / expires-at, epoch seconds.
  iat: number;
  exp: number;
}

// --- base64url ------------------------------------------------------------------

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// --- sign / verify --------------------------------------------------------------

const HEADER = b64urlJson({ alg: 'HS256', typ: 'JWT' });

// Sign a session token. `now` is injectable for deterministic tests.
export function signSessionToken(
  input: { userId: string; email: string; sessionId: string },
  secret: string,
  ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const payload: SessionClaims = {
    userId: input.userId,
    email: input.email,
    sessionId: input.sessionId,
    iat: now,
    exp: now + ttlSeconds,
  };
  const body = `${HEADER}.${b64urlJson(payload)}`;
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

// Verify a session token against the shared secret. Returns the claims when the
// signature is valid (constant-time compare) AND unexpired; otherwise null. Never
// throws — an app's middleware treats null as "no valid session".
export function verifySessionToken(
  token: string | undefined | null,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): SessionClaims | null {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  let provided: Buffer;
  try {
    provided = fromB64url(sig);
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let claims: SessionClaims;
  try {
    claims = JSON.parse(fromB64url(payload).toString('utf8')) as SessionClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
  if (!claims.userId || !claims.sessionId) return null;
  return claims;
}

// --- OAuth CSRF `state` token (P37) ---------------------------------------------
// The Google-sign-in `state` used to be a random nonce stashed in a HOST-ONLY cookie
// (`forge_oauth_state`, Path=/auth) and compared on the callback. That breaks the
// NESTED MCP-connect flow: when Claude drives OAuth against `api.<host>/mcp`, the
// `/oauth/authorize` bounce runs `/auth/google` on `api.<host>` (setting the cookie
// there), but Google's registered redirect_uri returns the callback to `app.<host>`
// (FORGE_AUTH_PUBLIC_URL) — a cookie set on `api.<host>` is NOT sent to `app.<host>`,
// so the state was absent → "state mismatch". The fix makes `state` a SIGNED,
// self-contained token (HMAC-SHA256 with the app's session secret) that carries its
// own `next` + `app` + expiry: it round-trips through Google in the URL and is verified
// by SIGNATURE on the callback, with NO host-bound cookie required. This mirrors the
// C24 connector flow (server-authoritative, unguessable state; no host-only cookie).
// A same-host cookie is still set as optional defense-in-depth (see auth-routes).
export const DEFAULT_OAUTH_STATE_TTL_SECONDS = 600;

export interface OAuthStateClaims {
  n: string; // nonce — makes each state unique even for parallel sign-ins
  next: string; // the post-login destination (same-site path; re-validated by safeNext at use)
  app: string; // the app the sign-in targets (a routing hint; the signature is the trust anchor)
  iat: number;
  exp: number;
}

// Sign a compact `state` token: base64url(payload).base64url(HMAC-SHA256(payload,secret)).
export function signOAuthState(
  input: { next: string; app: string; nonce: string },
  secret: string,
  ttlSeconds: number = DEFAULT_OAUTH_STATE_TTL_SECONDS,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const payload: OAuthStateClaims = { n: input.nonce, next: input.next, app: input.app, iat: now, exp: now + ttlSeconds };
  const body = b64urlJson(payload);
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

// Verify a `state` token: valid signature (constant-time) AND unexpired. Returns the claims or null.
// Never throws — the callback treats null as "state mismatch".
export function verifyOAuthState(
  token: string | undefined | null,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): OAuthStateClaims | null {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(body).digest();
  let provided: Buffer;
  try {
    provided = fromB64url(sig);
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let claims: OAuthStateClaims;
  try {
    claims = JSON.parse(fromB64url(body).toString('utf8')) as OAuthStateClaims;
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
  if (typeof claims.next !== 'string' || typeof claims.app !== 'string') return null;
  return claims;
}

// Read the (UNVERIFIED) `app` hint from a state token, WITHOUT checking the signature — used only to route
// the callback to the right app so its secret can then VERIFY the signature. The signature (not this hint)
// is the trust check, so a forged app here cannot pass verifyOAuthState against that app's real secret.
export function readOAuthStateApp(token: string | undefined | null): string | undefined {
  if (!token) return undefined;
  const body = token.split('.')[0];
  if (!body) return undefined;
  try {
    const p = JSON.parse(fromB64url(body).toString('utf8')) as { app?: unknown };
    return typeof p.app === 'string' ? p.app : undefined;
  } catch {
    return undefined;
  }
}

// --- cookie ---------------------------------------------------------------------

// The Set-Cookie value for a session. Always httpOnly + SameSite=Lax; `secure` is
// on in production (https behind the proxy) — the app is served over TLS, so the
// cookie must not travel over plaintext. Lax (not Strict) so the OAuth callback's
// top-level redirect carries the freshly-set cookie.
export function sessionCookie(
  token: string,
  opts: { secure?: boolean; maxAgeSeconds?: number } = {},
): string {
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  return cookie(SESSION_COOKIE, token, { secure: opts.secure ?? true, maxAgeSeconds: maxAge });
}

// The Set-Cookie value that CLEARS the session (sign-out): empty value, Max-Age 0.
export function clearSessionCookie(opts: { secure?: boolean } = {}): string {
  return cookie(SESSION_COOKIE, '', { secure: opts.secure ?? true, maxAgeSeconds: 0 });
}

// The Set-Cookie value for the opaque REFRESH token (P8). Same attributes as the
// session cookie (httpOnly + SameSite=Lax + Secure in prod) and Path=/ (see the
// REFRESH_COOKIE note), long-lived by default (~30d).
export function refreshCookie(
  token: string,
  opts: { secure?: boolean; maxAgeSeconds?: number } = {},
): string {
  return cookie(REFRESH_COOKIE, token, {
    secure: opts.secure ?? true,
    maxAgeSeconds: opts.maxAgeSeconds ?? DEFAULT_REFRESH_TTL_SECONDS,
  });
}

// The Set-Cookie value that CLEARS the refresh token (sign-out / reset / 401 on a
// dead refresh): empty value, Max-Age 0.
export function clearRefreshCookie(opts: { secure?: boolean } = {}): string {
  return cookie(REFRESH_COOKIE, '', { secure: opts.secure ?? true, maxAgeSeconds: 0 });
}

function cookie(name: string, value: string, opts: { secure: boolean; maxAgeSeconds: number }): string {
  const attrs = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) attrs.push('Secure');
  return attrs.join('; ');
}

// Parse a Cookie request header into a map. Tolerant of spacing; ignores malformed pairs.
export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

// --- public-path matcher --------------------------------------------------------

// The endpoints the app's session gate must let through WITHOUT a user session.
// `/auth/*` are the hosted auth pages (proxied to the platform); `/api/health` is
// the public C6 readiness probe; `/api/cron/*` is service-authenticated (below),
// NOT user-authenticated. An app extends this list, never shortens the auth entry.
export const DEFAULT_PUBLIC_PATHS = ['/auth', '/api/health', '/api/cron'] as const;

// Match a request pathname against a public list. An entry matches the exact path
// or any sub-path (`/auth` matches `/auth` and `/auth/login`). Trailing `/*` is
// accepted and treated as a prefix, so both `/api/cron` and `/api/cron/*` work.
export function isPublicPath(pathname: string, publicList: readonly string[] = DEFAULT_PUBLIC_PATHS): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  for (const raw of publicList) {
    const base = raw.replace(/\/\*$/, '').replace(/\/+$/, '') || '/';
    if (p === base || p.startsWith(base + '/')) return true;
  }
  return false;
}

// Whether a pathname is a service-authenticated cron endpoint (checked against the
// service token, not a user session).
export function isServicePath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  return p === '/api/cron' || p.startsWith('/api/cron/');
}
