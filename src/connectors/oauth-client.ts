import { randomBytes } from 'node:crypto';
import { pkceChallenge } from '../mcp/oauth';
import type { ProviderDescriptor } from './providers';

// C24 — the OUTBOUND OAuth client: the deterministic authorize-URL builder + the three server-to-server
// exchanges (code → tokens, refresh → tokens, revoke). This is the genuine technology boundary (a live
// third-party OAuth provider), so it is SWAPPABLE — tests inject a deterministic in-memory provider (no
// network), exactly like C10's getOAuthProvider(). The routes/service never touch the network directly;
// they go through the installed client. Dependency-clean: Node's built-in fetch + crypto only (keeps the
// slim multi-arch data-plane image clean), like auth-identity / email-smtp.

export interface TokenSet {
  access_token: string;
  refresh_token?: string; // absent on a refresh that doesn't rotate, or a provider that gives none
  expires_in: number; // seconds
  scope?: string; // space-delimited granted scopes (may differ from requested)
  account_label?: string; // derived from an OIDC id_token (email claim), if present
}

export interface OutboundOAuthClient {
  // Build the provider consent URL (PKCE S256, state, offline access → refresh token).
  authorizeUrl(opts: {
    provider: ProviderDescriptor;
    clientId: string;
    redirectUri: string;
    state: string;
    scopes: string[];
    codeChallenge: string;
  }): string;
  // Exchange an authorization code (+ PKCE verifier) for the token set.
  exchangeCode(opts: {
    provider: ProviderDescriptor;
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<TokenSet>;
  // Exchange a refresh token for a fresh access token (the provider may rotate the refresh token).
  refresh(opts: {
    provider: ProviderDescriptor;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<TokenSet>;
  // Best-effort revoke at the provider (when it exposes an endpoint). Never throws.
  revoke(opts: { provider: ProviderDescriptor; token: string }): Promise<void>;
}

// Decode a JWT payload WITHOUT signature verification. Safe here for the SAME reason C10 does it: the
// id_token is fetched directly from the provider's token endpoint over TLS in a server-to-server exchange,
// so it needs no local signature check (per OIDC guidance). Used only to read a display label.
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const json = Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function accountLabelFrom(provider: ProviderDescriptor, idToken: string | undefined): string | undefined {
  if (!idToken || !provider.account_label_claim) return undefined;
  const claims = decodeJwtPayload(idToken);
  const v = claims?.[provider.account_label_claim];
  return typeof v === 'string' && v ? v : undefined;
}

// The real HTTP client. Every exchange is a form-encoded POST to the provider's token endpoint over TLS,
// bounded by a timeout so a hung provider never wedges a request.
export const httpOAuthClient: OutboundOAuthClient = {
  authorizeUrl({ provider, clientId, redirectUri, state, scopes, codeChallenge }) {
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      ...(provider.authorize_params ?? {}),
    });
    if (provider.pkce) {
      q.set('code_challenge', codeChallenge);
      q.set('code_challenge_method', 'S256');
    }
    return `${provider.authorization_endpoint}?${q.toString()}`;
  },

  async exchangeCode({ provider, clientId, clientSecret, code, redirectUri, codeVerifier }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      ...(provider.pkce ? { code_verifier: codeVerifier } : {}),
    });
    return tokenRequest(provider, body);
  },

  async refresh({ provider, clientId, clientSecret, refreshToken }) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    return tokenRequest(provider, body);
  },

  async revoke({ provider, token }) {
    if (!provider.revoke_endpoint) return;
    try {
      await fetch(provider.revoke_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Best-effort — a failed provider revoke must not block dropping the local tokens.
    }
  },
};

async function tokenRequest(provider: ProviderDescriptor, body: URLSearchParams): Promise<TokenSet> {
  const res = await fetch(provider.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${provider.id} token endpoint failed: ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
  }
  const tok = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
  };
  if (!tok.access_token) throw new Error(`${provider.id} token response missing access_token`);
  const label = accountLabelFrom(provider, tok.id_token);
  return {
    access_token: tok.access_token,
    ...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}),
    expires_in: typeof tok.expires_in === 'number' && tok.expires_in > 0 ? tok.expires_in : 3600,
    ...(tok.scope ? { scope: tok.scope } : {}),
    ...(label ? { account_label: label } : {}),
  };
}

// --- installable client (swappable for tests) -----------------------------------
let client: OutboundOAuthClient = httpOAuthClient;
export function getOutboundOAuthClient(): OutboundOAuthClient {
  return client;
}
export function setOutboundOAuthClient(c: OutboundOAuthClient): void {
  client = c;
}
export function resetOutboundOAuthClient(): void {
  client = httpOAuthClient;
}

// A high-entropy PKCE verifier + its S256 challenge (reuses the C23 pkce helper).
export function newPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier, 'S256') };
}
