import type { Sealed } from '../storage/backends/secrets/types';

// C24 — the durable records of the connector vault. Kept in a PRIVATE store domain (P26 `connections`),
// under the gitignored state dir like the C10 identity / C5 secrets vaults, and NEVER surfaced through the
// inspectable `/resources` API. Tokens live ENCRYPTED at rest (AES-256-GCM under the C5 master key,
// FORGE_SECRETS_KEY) — the store only ever holds ciphertext, exactly like C5.

// A user's live connection to one provider — keyed by (app, owner, provider). Holds the SEALED access +
// refresh tokens, when the access token expires, the scopes actually granted, and a display label — never
// a plaintext token.
export interface Connection {
  owner: string; // the C10/C11 user id (from the session; never client-passed)
  provider: string; // provider descriptor id, e.g. "google"
  access_sealed: Sealed; // AES-256-GCM ciphertext of the access token
  refresh_sealed?: Sealed; // AES-256-GCM ciphertext of the refresh token (absent if the provider gave none)
  access_expires_at: string; // ISO — when the access token expires (drives auto-refresh)
  scopes: string[]; // scopes the provider actually granted
  status: 'connected' | 'expired' | 'revoked';
  account_label?: string; // e.g. the connected Gmail address (from the id_token) — display only
  connected_at: string; // ISO — first successful connect
  updated_at: string; // ISO — last token refresh / re-consent
}

// The connection as it is safe to RETURN to a caller — the sealed tokens and their expiry are stripped.
// (`GET /connect` returns this shape; it never leaks a token or ciphertext.)
export interface ConnectionView {
  provider: string;
  scopes: string[];
  status: Connection['status'];
  account_label?: string;
  connected_at: string;
  updated_at: string;
}

export function toConnectionView(c: Connection): ConnectionView {
  return {
    provider: c.provider,
    scopes: c.scopes,
    status: c.status,
    ...(c.account_label ? { account_label: c.account_label } : {}),
    connected_at: c.connected_at,
    updated_at: c.updated_at,
  };
}

// A PENDING connect request — created at `/connect/:provider/start`, consumed one-shot at the callback.
// Short-lived (TTL). Keyed by the opaque `state`. Holds the PKCE verifier + the owner captured from the
// session at start (so the callback, which returns from the provider, authorizes as the same user) + the
// exact redirect_uri + where to send the browser afterwards. Server-side only — never leaves the sidecar.
export interface ConnectRequest {
  state: string; // opaque CSRF/lookup key echoed back by the provider
  owner: string; // the user who initiated (from the C10 session)
  provider: string;
  code_verifier: string; // PKCE verifier (paired with the code_challenge sent to the provider)
  redirect_uri: string; // the exact callback URI registered with the provider
  scopes: string[]; // requested scopes
  return_to?: string; // same-origin path to bounce the browser to after connect (default "/")
  created_at: string;
  expires_at: string; // ISO — a stale request is rejected
}

// A fresh, valid access token the broker hands back — the app makes the actual provider API call itself.
// The raw token is returned but NEVER persisted in the clear or logged.
export interface FreshToken {
  access_token: string;
  provider: string;
  scopes: string[];
  expires_at: string; // ISO
  account_label?: string;
}
