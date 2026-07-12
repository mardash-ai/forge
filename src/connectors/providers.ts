// C24 — the third-party connector PROVIDER REGISTRY (pure, config-driven, product-agnostic). Each entry
// describes ONE outbound OAuth provider the platform can connect a consuming app's users to: its OAuth
// endpoints, the default scopes, the authorize-URL quirks needed to obtain a refresh token, and — crucially
// — the NAMES of the C5 secrets the operator provisions the client credentials under (never the values,
// never hardcoded). This is the app-as-OAuth-CLIENT-to-providers direction (distinct from C23, where the
// app is an OAuth SERVER to AI hosts).
//
// A provider is a DESCRIPTOR (endpoints/scopes/params — static, mirrorable) + resolved CREDENTIALS (the
// client id/secret, read from the C5 vault/env at request time; see ./config.ts). To add Microsoft/others,
// add a descriptor here and provision its `<ID>_CONNECT_CLIENT_ID/SECRET` secrets — no route/store change.

export interface ProviderDescriptor {
  // Stable provider id used in URLs + the connection key, e.g. "google" (a-z0-9_-).
  id: string;
  // Human label for consent/management UIs.
  label: string;
  // OAuth 2.0 authorization + token endpoints.
  authorization_endpoint: string;
  token_endpoint: string;
  // Optional RFC 7009-style token revocation endpoint (Google has one; Microsoft does not — disconnect
  // then just drops the stored tokens).
  revoke_endpoint?: string;
  // The scopes requested by default (Gmail send + Calendar read for Google's MVP). The connect flow may
  // narrow/override per request, but this is the sensible default the app gets without asking.
  default_scopes: string[];
  // Extra authorize-URL params required to get a durable REFRESH token + offline access. For Google:
  // access_type=offline + prompt=consent (Google only returns a refresh_token on the FIRST consent unless
  // prompt=consent forces re-issue). For Microsoft the `offline_access` scope drives it.
  authorize_params?: Record<string, string>;
  // PKCE (RFC 7636) — always on for these providers (OAuth 2.1 posture). S256 only.
  pkce: boolean;
  // The C5 secret names the operator provisions the per-provider OAuth client under. Convention:
  // <ID_UPPER>_CONNECT_CLIENT_ID / _CLIENT_SECRET — distinct from C10's GOOGLE_CLIENT_ID (sign-in) so an
  // app can run sign-in and outbound connectors as different OAuth clients.
  client_id_secret: string;
  client_secret_secret: string;
  // When the token response carries an OIDC id_token (openid scope), derive the connected-account label
  // (e.g. the Gmail address) from this claim — shown in the connections list, never a token.
  account_label_claim?: string;
}

const GOOGLE: ProviderDescriptor = {
  id: 'google',
  label: 'Google',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  revoke_endpoint: 'https://oauth2.googleapis.com/revoke',
  // MVP: send mail as the user + read their calendar. `openid email` yields the id_token we read the
  // account label (the Gmail address) from.
  default_scopes: [
    'openid',
    'email',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/calendar.readonly',
  ],
  authorize_params: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  pkce: true,
  client_id_secret: 'GOOGLE_CONNECT_CLIENT_ID',
  client_secret_secret: 'GOOGLE_CONNECT_CLIENT_SECRET',
  account_label_claim: 'email',
};

// Microsoft is registered to PROVE the architecture is config-driven (endpoints known); it lights up the
// moment an operator provisions MICROSOFT_CONNECT_CLIENT_ID/SECRET. `offline_access` drives the refresh
// token; Graph has no simple RFC-7009 revoke, so disconnect drops the stored tokens.
const MICROSOFT: ProviderDescriptor = {
  id: 'microsoft',
  label: 'Microsoft',
  authorization_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  default_scopes: [
    'openid',
    'email',
    'offline_access',
    'https://graph.microsoft.com/Mail.Send',
    'https://graph.microsoft.com/Calendars.Read',
  ],
  authorize_params: { prompt: 'consent' },
  pkce: true,
  client_id_secret: 'MICROSOFT_CONNECT_CLIENT_ID',
  client_secret_secret: 'MICROSOFT_CONNECT_CLIENT_SECRET',
  account_label_claim: 'email',
};

const PROVIDERS: Record<string, ProviderDescriptor> = {
  [GOOGLE.id]: GOOGLE,
  [MICROSOFT.id]: MICROSOFT,
};

// The descriptor for a provider id, or null when unknown. Pure lookup — availability (creds resolved) is a
// separate check in ./config.ts.
export function providerDescriptor(id: string): ProviderDescriptor | null {
  return PROVIDERS[id] ?? null;
}

// Every registered provider id (for discovery / the management surface).
export function providerIds(): string[] {
  return Object.keys(PROVIDERS).sort();
}
