import { hashToken } from '../plugins/auth-identity/index';
import { getBackends } from '../storage/backends';
import { isExpired } from './oauth';

// C23 — the token → { user, scopes } verifier the resource server (the hosted /mcp endpoint) uses on every
// call. The bearer is the OPAQUE access token the OAuth AS issued; we look up its HASH in the store (so a
// leak of the store can't be replayed), and reject an expired one. This is the mirrorable seam an app (or a
// future dedicated edge) can reimplement against the same store — the shape is stable.

export interface VerifiedToken {
  userId: string;
  scopes: string[];
  clientId: string;
  resource?: string; // RFC 8707 — the resource/audience the token is bound to (undefined = unbound)
}

// Extract a Bearer token from an Authorization header value. Returns null when absent/malformed.
export function bearerFrom(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

// Why a verification failed — for the C36 `mcp.auth_reject` span, never for the wire response (the
// endpoint keeps answering a uniform `invalid_token` 401 so a probe can't distinguish the cases).
//   invalid_token     — absent/unknown/expired token.
//   resource_mismatch — a valid token bound (RFC 8707) to a DIFFERENT resource than this host.
export type TokenRejectReason = 'invalid_token' | 'resource_mismatch';

// Verify a raw access token for an app. Returns the identity + granted scopes, or null when the token is
// unknown, of the wrong kind, or expired.
//
// RFC 8707 audience binding (optional `expectedResource`): when the caller passes the resource it is (e.g.
// the `${issuer}/mcp` id the /mcp endpoint serves) AND the token carries a bound `resource`, the two must
// match — a token minted for a DIFFERENT resource is rejected. A token with NO bound resource still
// verifies (BACK-COMPAT: tokens issued before aud-binding, and clients that never sent `resource`, keep
// working); and when the caller passes no expected resource, no audience check is applied.
export async function verifyAccessToken(appId: string, rawToken: string | null, expectedResource?: string): Promise<VerifiedToken | null> {
  return (await verifyAccessTokenDetailed(appId, rawToken, expectedResource)).verified;
}

// The same verification with the failure REASON attached (C36 observability). The plain
// `verifyAccessToken` above delegates here — one evaluation path, two shapes.
export async function verifyAccessTokenDetailed(
  appId: string,
  rawToken: string | null,
  expectedResource?: string,
): Promise<{ verified: VerifiedToken | null; reason?: TokenRejectReason }> {
  if (!rawToken) return { verified: null, reason: 'invalid_token' };
  const mcp = (await getBackends()).mcp;
  const grant = await mcp.getGrant(appId, 'access', hashToken(rawToken));
  if (!grant) return { verified: null, reason: 'invalid_token' };
  if (isExpired(grant.expires_at)) return { verified: null, reason: 'invalid_token' };
  if (expectedResource && grant.resource && grant.resource !== expectedResource) return { verified: null, reason: 'resource_mismatch' };
  return { verified: { userId: grant.owner, scopes: grant.scopes, clientId: grant.client_id, ...(grant.resource ? { resource: grant.resource } : {}) } };
}
