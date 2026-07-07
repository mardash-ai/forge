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

// The session cookie name. httpOnly + Secure + SameSite=Lax, long/sliding expiry.
export const SESSION_COOKIE = 'forge_session';

// How a service (the C2 scheduler / cron) authenticates as a NON-user principal.
// The scheduler sends BOTH so an app can check whichever it prefers.
export const SERVICE_TOKEN_HEADER = 'x-forge-service-token';

// Default long/sliding session lifetime (30 days). The hosted routes re-issue on
// activity (sliding); the app's local gate trusts `exp`.
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

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
