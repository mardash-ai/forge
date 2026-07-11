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
}

// Extract a Bearer token from an Authorization header value. Returns null when absent/malformed.
export function bearerFrom(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

// Verify a raw access token for an app. Returns the identity + granted scopes, or null when the token is
// unknown, of the wrong kind, or expired.
export async function verifyAccessToken(appId: string, rawToken: string | null): Promise<VerifiedToken | null> {
  if (!rawToken) return null;
  const mcp = (await getBackends()).mcp;
  const grant = await mcp.getGrant(appId, 'access', hashToken(rawToken));
  if (!grant) return null;
  if (isExpired(grant.expires_at)) return null;
  return { userId: grant.owner, scopes: grant.scopes, clientId: grant.client_id };
}
