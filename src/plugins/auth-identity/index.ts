import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, createHash, type ScryptOptions } from 'node:crypto';
import { readSecrets } from '../secrets-local/index';
import { redactRecipient } from '../email-smtp/index';

// Plugin: auth-identity.
//
// The first Implementation of Forge's identity/auth capability (C10) — a real
// technology boundary (an identity backend + OAuth provider) that a future
// auth-oidc / auth-saml Implementation could replace WITHOUT touching the hosted
// auth routes or the session contract. It owns exactly the provider-specific,
// security-critical primitives: password hashing (a strong KDF), verify/reset
// token minting + hashing, the C5-configured secrets, and the Google OAuth flow.
//
// Dependency-clean by design (like model-anthropic / email-smtp): everything here
// is Node's built-in crypto — no argon2/bcrypt native module (which would break the
// slim, multi-arch data-plane image), no OAuth SDK. Password hashing uses scrypt, a
// memory-hard KDF OWASP lists alongside argon2id/bcrypt for password storage.

export const IMPLEMENTATION = 'auth-identity';

// The C5 secret names this Implementation reads (vault -> env, same pattern as
// ANTHROPIC_API_KEY / SMTP_URL). Nothing is ever hardcoded.
export const SESSION_SECRET = 'AUTH_SESSION_SECRET'; // HMAC key that signs sessions
export const GOOGLE_CLIENT_ID = 'GOOGLE_CLIENT_ID';
export const GOOGLE_CLIENT_SECRET = 'GOOGLE_CLIENT_SECRET';
export const SERVICE_TOKEN = 'AUTH_SERVICE_TOKEN'; // service/cron principal (§5)

// Token lifetimes.
export const VERIFY_TOKEN_TTL_SECONDS = 60 * 60 * 24; // 24h to confirm an email
export const RESET_TOKEN_TTL_SECONDS = 60 * 60; // 1h to reset a password

// Email-2FA one-time code parameters. A short-lived, single-use, attempt-capped 6-digit code emailed as
// the second factor. Low code entropy (10^6) is deliberately compensated by the SHORT expiry + the hard
// per-code attempt cap + single-use consumption (an offline guess of the stored SHA-256 hash is moot for
// a code that dies in minutes). Env-overridable for ops/tests.
export const DEFAULT_TWOFA_CODE_TTL_SECONDS = 60 * 10; // 10 minutes
export const DEFAULT_TWOFA_MAX_ATTEMPTS = 5;
export function twofaCodeTtlSeconds(): number {
  const raw = Number(process.env.FORGE_AUTH_TWOFA_CODE_TTL_SECONDS);
  return Number.isFinite(raw) && raw >= 30 && raw <= 3600 ? Math.floor(raw) : DEFAULT_TWOFA_CODE_TTL_SECONDS;
}
export function twofaMaxAttempts(): number {
  const raw = Number(process.env.FORGE_AUTH_TWOFA_MAX_ATTEMPTS);
  return Number.isFinite(raw) && raw >= 1 && raw <= 20 ? Math.floor(raw) : DEFAULT_TWOFA_MAX_ATTEMPTS;
}

// Mint a fresh email-2FA one-time code: a uniformly-random 6-digit numeric string (crypto.randomInt, no
// modulo bias). Only its SHA-256 HASH is persisted — the raw code is emailed and never stored, exactly
// like the verify/reset tokens above.
export function newTwofaCode(): { code: string; hash: string } {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  return { code, hash: hashToken(code) };
}

export const redactEmail = redactRecipient;

// --- password hashing (scrypt) --------------------------------------------------

// Promise wrapper around the options-taking scrypt overload (Node's promisify
// typing drops the options arg). Runs on the libuv threadpool — non-blocking.
function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}
// Strong, memory-hard params. N=2^15, r=8, p=1 → ~33.5 MiB per hash; maxmem lifts
// Node's 32 MiB default ceiling so that N is allowed.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

// Hash a plaintext password to a self-describing `scrypt$N$r$p$salt$hash` string
// (a random per-user salt). The plaintext is NEVER stored or logged.
export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(plaintext, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

// Verify a plaintext against a stored hash in constant time. Returns false on any
// malformed hash rather than throwing — a bad record must not crash a login.
export async function verifyPassword(plaintext: string, stored: string | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  let derived: Buffer;
  try {
    derived = await scrypt(plaintext, Buffer.from(saltB64, 'base64'), expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// --- verify / reset tokens ------------------------------------------------------

// A URL-safe, high-entropy token the caller emails as a link. The RAW value is
// returned to the caller (to put in the link) but only its HASH is persisted, so a
// leak of the store can't be replayed.
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// --- constant-time service-token comparison -------------------------------------

// Compare a presented service token to the configured one in constant time.
export function serviceTokenMatches(presented: string | undefined | null, configured: string | undefined | null): boolean {
  if (!presented || !configured) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// --- configuration resolution (C5) ----------------------------------------------

// Resolve one secret for an app: prefer the C5 encrypted vault, then the process
// env fallback (an operator may inject it into the container directly) — the same
// resolution order model-anthropic / email-smtp use. Never logs the value.
async function resolveSecret(appId: string, name: string): Promise<string | null> {
  try {
    const secrets = await readSecrets(appId);
    const v = secrets[name];
    if (v && v.trim()) return v.trim();
  } catch {
    // Vault unreadable (no master key, corrupt file) -> treat as absent, never fatal.
  }
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return null;
}

export interface AuthConfig {
  // The HMAC session-signing secret. When null, sessions can't be issued/verified —
  // the routes surface a clean "auth not configured", never a crash.
  sessionSecret: string | null;
  // Google OAuth creds — null unless BOTH id and secret are present (OAuth disabled,
  // email/pw still works).
  google: { clientId: string; clientSecret: string } | null;
  // The service/cron principal token — null disables service auth (cron stays gated
  // and returns 401, detectably, rather than silently reopening).
  serviceToken: string | null;
}

// Resolve the full auth configuration for an app. Each piece is independently
// detectable so the routes can degrade gracefully (no session key, no Google, etc.).
export async function resolveAuthConfig(appId: string): Promise<AuthConfig> {
  const [sessionSecret, clientId, clientSecret, serviceToken] = await Promise.all([
    resolveSecret(appId, SESSION_SECRET),
    resolveSecret(appId, GOOGLE_CLIENT_ID),
    resolveSecret(appId, GOOGLE_CLIENT_SECRET),
    resolveSecret(appId, SERVICE_TOKEN),
  ]);
  return {
    sessionSecret,
    google: clientId && clientSecret ? { clientId, clientSecret } : null,
    serviceToken,
  };
}

// Resolve just the service token (used by the C2 scheduler when it calls cron back).
export async function resolveServiceToken(appId: string): Promise<string | null> {
  return resolveSecret(appId, SERVICE_TOKEN);
}

// --- OAuth provider (swappable) -------------------------------------------------

export interface OAuthUserInfo {
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

// The provider contract: build an authorize URL, and exchange an auth code for the
// user's identity. Swappable so tests inject a deterministic stub (no network) and
// a future provider (GitHub, generic OIDC) can slot in without touching the routes.
export interface OAuthProvider {
  authorizeUrl(opts: { clientId: string; redirectUri: string; state: string }): string;
  exchangeCode(opts: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<OAuthUserInfo>;
}

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

// Decode a JWT payload WITHOUT signature verification. Safe here because the
// id_token is fetched directly from Google's token endpoint over TLS in a
// server-to-server exchange (per Google's OIDC guidance, tokens received directly
// from the token endpoint need no local signature check).
function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.');
  if (parts.length < 2) throw new Error('malformed id_token');
  const json = Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}

// The real Google OAuth provider (Authorization Code flow, OIDC id_token).
export const googleProvider: OAuthProvider = {
  authorizeUrl({ clientId, redirectUri, state }) {
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return `${GOOGLE_AUTH}?${q.toString()}`;
  },
  async exchangeCode({ code, redirectUri, clientId, clientSecret }) {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const res = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`google token exchange failed: ${res.status}`);
    const tok = (await res.json()) as { id_token?: string };
    if (!tok.id_token) throw new Error('google token response missing id_token');
    const claims = decodeJwtPayload(tok.id_token);
    const email = typeof claims.email === 'string' ? claims.email : '';
    const sub = typeof claims.sub === 'string' ? claims.sub : '';
    if (!email || !sub) throw new Error('google id_token missing sub/email');
    return {
      providerUserId: sub,
      email,
      emailVerified: claims.email_verified === true || claims.email_verified === 'true',
      ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
    };
  },
};

let provider: OAuthProvider = googleProvider;
export function getOAuthProvider(): OAuthProvider {
  return provider;
}
export function setOAuthProvider(p: OAuthProvider): void {
  provider = p;
}
export function resetOAuthProvider(): void {
  provider = googleProvider;
}
