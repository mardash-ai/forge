import type { FastifyRequest } from 'fastify';
import { SERVICE_TOKEN_HEADER } from './session';
import { resolveServiceToken, serviceTokenMatches } from '../plugins/auth-identity/index';

// Shared SERVICE-token gate for the administrative / trusted-internal operations that must NOT be
// end-user reachable (the C10 `AUTH_SERVICE_TOKEN` — the same principal the C2 scheduler / the C24 broker
// / the billing reconcile sweep authenticate with). A caller presents the token either as the
// `x-forge-service-token` header or as `Authorization: Bearer <token>`; it is compared to the app's
// configured token in CONSTANT time (see serviceTokenMatches). Factored out of the billing surface so the
// principal-teardown admin ops (identity delete / membership teardown) gate identically.

// The token a request presents, from the dedicated header (preferred) or a Bearer authorization header.
export function presentedServiceToken(req: FastifyRequest): string | undefined {
  const hdr = req.headers[SERVICE_TOKEN_HEADER];
  const fromHeader = (Array.isArray(hdr) ? hdr[0] : hdr)?.trim();
  if (fromHeader) return fromHeader;
  const auth = req.headers.authorization;
  const h = Array.isArray(auth) ? auth[0] : auth;
  const m = h ? /^Bearer\s+(.+)$/i.exec(h.trim()) : null;
  return m ? m[1]!.trim() : undefined;
}

// True iff the request presents the app's configured service token. False when no token is presented or
// the app has no service token configured (service auth stays DETECTABLY closed rather than silently open).
export async function hasValidServiceToken(req: FastifyRequest, appId: string): Promise<boolean> {
  const presented = presentedServiceToken(req);
  if (!presented) return false;
  return serviceTokenMatches(presented, await resolveServiceToken(appId));
}
