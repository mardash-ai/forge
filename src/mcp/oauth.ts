import { createHash } from 'node:crypto';

// C23 — the PURE OAuth 2.1 helpers: scope algebra, PKCE verification, TTLs, and the authorization-server
// metadata document. No I/O — these are the deterministic, mirrorable core the routes build on (the store
// lookups + HTTP live in api/oauth-routes.ts + api/mcp-routes.ts).

// --- scopes ---------------------------------------------------------------------

// Parse a space-delimited scope string into a deduped, ordered list. Tolerant of extra whitespace.
export function parseScopes(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/\s+/).filter(Boolean))];
}

export function scopeString(scopes: string[]): string {
  return [...new Set(scopes)].join(' ');
}

// Does the GRANTED set satisfy EVERY required scope? (The resource-server check for a tool call.)
export function scopesSatisfy(granted: string[], required: string[]): boolean {
  const set = new Set(granted);
  return required.every((s) => set.has(s));
}

// Is every REQUESTED scope within the ALLOWED set? (A refresh may narrow, never widen, scope.)
export function scopesSubset(requested: string[], allowed: string[]): boolean {
  const set = new Set(allowed);
  return requested.every((s) => set.has(s));
}

// --- PKCE (RFC 7636) ------------------------------------------------------------

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The challenge derived from a verifier: S256 = base64url(sha256(verifier)); plain = the verifier itself.
export function pkceChallenge(verifier: string, method: 'S256' | 'plain' = 'S256'): string {
  if (method === 'plain') return verifier;
  return b64url(createHash('sha256').update(verifier).digest());
}

// Verify a presented code_verifier against the stored challenge. Constant-time-ish via length+equality on
// the derived value. `S256` is required by OAuth 2.1; `plain` is accepted only when the client registered it.
export function verifyPkce(verifier: string | undefined, challenge: string | undefined, method: 'S256' | 'plain' | undefined): boolean {
  if (!challenge) return false; // PKCE is mandatory in OAuth 2.1 — no challenge ⇒ reject
  if (!verifier) return false;
  const m = method ?? 'S256';
  return pkceChallenge(verifier, m) === challenge;
}

// --- lifetimes (env-overridable, clamped) ---------------------------------------

function intFromEnv(name: string, dflt: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export const DEFAULT_CODE_TTL_SECONDS = 60; // authorization code — very short, one-shot
export const DEFAULT_ACCESS_TTL_SECONDS = 60 * 60; // access token — 1h
export const DEFAULT_REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30; // refresh token — 30d

export const codeTtlSeconds = (): number => intFromEnv('FORGE_OAUTH_CODE_TTL_SECONDS', DEFAULT_CODE_TTL_SECONDS, 10, 600);
export const accessTtlSeconds = (): number => intFromEnv('FORGE_OAUTH_ACCESS_TTL_SECONDS', DEFAULT_ACCESS_TTL_SECONDS, 60, 60 * 60 * 24);
export const refreshTtlSeconds = (): number => intFromEnv('FORGE_OAUTH_REFRESH_TTL_SECONDS', DEFAULT_REFRESH_TTL_SECONDS, 60, 60 * 60 * 24 * 365);

export function expiresAtIso(ttlSeconds: number, now: Date = new Date()): string {
  return new Date(now.getTime() + ttlSeconds * 1000).toISOString();
}

export function isExpired(expiresAtIso: string | undefined, now: Date = new Date()): boolean {
  if (!expiresAtIso) return true;
  const t = new Date(expiresAtIso).getTime();
  return Number.isNaN(t) || t <= now.getTime();
}

// --- authorization-server metadata (RFC 8414) -----------------------------------

// The discovery document the MCP connector / Apps SDK reads to find the endpoints. `issuer` is the public
// base URL the MCP server + this AS are reached on (the machine-facing api host — derived from forwarded
// headers, or pinned by FORGE_MCP_PUBLIC_URL, falling back to FORGE_OAUTH_PUBLIC_URL for back-compat), so
// the whole surface can relocate to a dedicated public edge later WITHOUT changing tool contracts.
export function authServerMetadata(issuer: string, scopesSupported: string[] = []): Record<string, unknown> {
  const base = issuer.replace(/\/+$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    ...(scopesSupported.length ? { scopes_supported: scopesSupported } : {}),
  };
}
