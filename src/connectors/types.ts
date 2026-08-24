import type { Sealed } from '../storage/backends/secrets/types';

// C24 — the durable records of the connector vault. Kept in a PRIVATE store domain (P26 `connections`),
// under the gitignored state dir like the C10 identity / C5 secrets vaults, and NEVER surfaced through the
// inspectable `/resources` API. Tokens live ENCRYPTED at rest (AES-256-GCM under the C5 master key,
// FORGE_SECRETS_KEY) — the store only ever holds ciphertext, exactly like C5.

// A user's live connection to one provider — keyed by (app, owner, provider). Holds the SEALED access +
// refresh tokens, when the access token expires, the scopes actually granted, and a display label — never
// a plaintext token.
export type Connection = OAuthConnection | BasicConnection;

interface ConnectionBase {
  owner: string; // the C10/C11 user id (from the session; never client-passed)
  provider: string; // provider descriptor id, e.g. "google"
  scopes: string[]; // scopes the provider actually granted (empty for basic auth — see below)
  status: 'connected' | 'expired' | 'revoked';
  account_label?: string; // e.g. the connected Gmail address — display only
  connected_at: string; // ISO — first successful connect
  updated_at: string; // ISO — last token refresh / re-consent
}

export interface OAuthConnection extends ConnectionBase {
  auth_kind: 'oauth2';
  access_sealed: Sealed; // AES-256-GCM ciphertext of the access token
  refresh_sealed?: Sealed; // AES-256-GCM ciphertext of the refresh token (absent if the provider gave none)
  access_expires_at: string; // ISO — when the access token expires (drives auto-refresh)
}

// A connection authenticated with a per-user username + password (Apple/iCloud CalDAV).
//
// ⛔ Deliberately has NO `access_expires_at`. An app-specific password does not expire, and the
// tempting shortcut — storing a far-future expiry so the OAuth refresh path "just works" — encodes a
// falsehood the refresh machinery would eventually act on. The union means the broker cannot reach
// this record with a refresh at all; it is a compile error, not a runtime surprise.
//
// The username is stored in the CLEAR: it is the Apple Account email, it is not a secret, and it is
// what the card shows as the account label. Only the password is sealed.
export interface BasicConnection extends ConnectionBase {
  auth_kind: 'basic';
  username: string;
  password_sealed: Sealed; // AES-256-GCM ciphertext of the app-specific password
}

// ⛔ Records written BEFORE the auth_kind union have no discriminant. Reading one raw would produce an
// object that satisfies neither arm, and every `switch (c.auth_kind)` would silently fall through —
// in PRODUCTION, against real user connections, while every local test (which writes fresh records)
// stayed green. Every backend read path funnels through here so a legacy row is an OAuth connection,
// which is what it always was. `tests/connection-hydration.test.ts` asserts each read path calls it.
export function hydrateConnection(raw: Connection | (ConnectionBase & Record<string, unknown>)): Connection {
  const c = raw as Connection & Record<string, unknown>;
  if (c.auth_kind === 'basic' || c.auth_kind === 'oauth2') return c;
  return { ...(c as object), auth_kind: 'oauth2' } as OAuthConnection;
}

// The connection as it is safe to RETURN to a caller — the sealed tokens and their expiry are stripped.
// (`GET /connect` returns this shape; it never leaks a token or ciphertext.)
export interface ConnectionView {
  provider: string;
  // Surfaced so a management UI can render the right affordance — "Reconnect" (re-consent) for OAuth
  // vs "Update password" for basic. Without it the card would have to infer from the provider id.
  auth_kind: Connection['auth_kind'];
  scopes: string[];
  status: Connection['status'];
  account_label?: string;
  connected_at: string;
  updated_at: string;
}

export function toConnectionView(c: Connection): ConnectionView {
  return {
    provider: c.provider,
    auth_kind: c.auth_kind,
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
