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

// ⛔ A provider is a DISCRIMINATED UNION on `auth_kind`, not one shape with optional fields.
//
// Until 2026-08-24 this was a single interface that REQUIRED the OAuth quartet
// (authorization_endpoint / token_endpoint / pkce / client_id_secret / client_secret_secret). That
// silently encoded "every provider is an OAuth provider", and the encoding was load-bearing in the
// worst way: `config.resolveProvider` treats a provider as configured only when BOTH operator client
// creds resolve, so a username+password provider would have reported `configured: false` FOREVER and
// its connect endpoint would have answered 503 for all time — the exact failure Microsoft's connector
// hit on 2026-08-21 before its creds were wired, except unfixable, because there are no creds to wire.
//
// Apple/iCloud has no OAuth for calendar data at all: CalDAV over Basic auth with a per-user
// app-specific password is the only route. Optional fields would have "worked" and told a lie the
// type system could not catch — an Apple descriptor would still typecheck against every OAuth
// consumer, and the failure would surface as a runtime `undefined` inside a fetch. The union makes
// the two kinds structurally non-interchangeable, so `tsc` — not production — finds the mistake.
export type ProviderDescriptor = OAuthProviderDescriptor | BasicProviderDescriptor;

interface ProviderDescriptorBase {
  // Stable provider id used in URLs + the connection key, e.g. "google" (a-z0-9_-).
  id: string;
  // Human label for consent/management UIs.
  label: string;
}

// A provider the platform connects to as an OAuth 2.x CLIENT (Google, Microsoft). The operator
// provisions a client id/secret; the user consents in a browser redirect.
export interface OAuthProviderDescriptor extends ProviderDescriptorBase {
  auth_kind: 'oauth2';
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
  // (e.g. the Gmail address or Microsoft UPN) by trying each claim in order and taking the first
  // non-empty string. Supports a fallback chain: Microsoft personal accounts may lack the `email`
  // claim but always have `preferred_username`, so ['email', 'preferred_username'] handles both
  // work/school and personal MSA accounts.
  account_label_claims?: string[];
}

// A provider authenticated with a per-user USERNAME + PASSWORD (Apple/iCloud CalDAV, and any future
// app-specific-password service). There is no operator client credential, no redirect, no consent
// screen and no token: the user pastes a credential the provider minted for them.
//
// Consequences that differ from OAuth, each of which broke an assumption somewhere:
//   • ALWAYS configured. There is nothing for an operator to provision, so gating availability on
//     resolved secrets (as the OAuth path does) would disable it permanently. See config.ts.
//   • No expiry. An app-specific password does not expire, so the broker must NOT synthesise a
//     far-future `expires_at` to fit the OAuth shape — that is a lie the credential union avoids by
//     discriminating on `kind` instead.
//   • Nothing to revoke remotely. Disconnect deletes the sealed credential locally; the user revokes
//     the app-specific password at the provider if they want it dead everywhere.
export interface BasicProviderDescriptor extends ProviderDescriptorBase {
  auth_kind: 'basic';
  // The service root the credential authenticates against — for iCloud, the CalDAV discovery host.
  // Kept on the descriptor (not hardcoded in the capability) so a provider swap is config, not code.
  service_endpoint: string;
  // Where the user goes to MINT the credential, surfaced verbatim by the connect wizard. The wizard's
  // copy is the riskiest part of a basic-auth connect flow (the user is pasting a password), so the
  // canonical URL lives with the descriptor rather than being retyped in the web tier.
  credential_help_url: string;
  // Field labels for the wizard. Apple calls the username an "Apple Account" and the credential an
  // "app-specific password"; saying "username"/"password" would invite the PRIMARY password, which
  // fails with a bare 401 and is the single most likely user error (§8 of the Apple plan).
  username_label: string;
  password_label: string;
}

const GOOGLE: OAuthProviderDescriptor = {
  auth_kind: 'oauth2',
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
  account_label_claims: ['email'],
};

// Microsoft is registered to PROVE the architecture is config-driven (endpoints known); it lights up the
// moment an operator provisions MICROSOFT_CONNECT_CLIENT_ID/SECRET. `offline_access` drives the refresh
// token; Graph has no simple RFC-7009 revoke, so disconnect drops the stored tokens.
//
// Scopes use the short (non-URL) form that Microsoft's v2.0 endpoint returns in token responses — the
// same short form is stored on the Connection and checked by the C24 broker, so they must match.
// `Mail.Read` + `Mail.Send` enables send-as-user (C25); `Calendars.ReadWrite` enables calendar access.
//
// IMPORTANT — Microsoft has NO `include_granted_scopes` equivalent: if a user re-consents to a SUBSET
// of scopes, the callback's granted-scope list is narrower than the stored set. The C24 completeConnect
// implementation MUST union the old and new scope sets (superset preserved) rather than overwriting —
// a bug here silently revokes already-granted capabilities. See the scope-narrowing fix in service.ts.
const MICROSOFT: OAuthProviderDescriptor = {
  auth_kind: 'oauth2',
  id: 'microsoft',
  label: 'Microsoft',
  authorization_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  // MVP scopes (short form): openid + OIDC identity; offline_access → refresh token; Mail.Read +
  // Mail.Send → C25 email send-as-user; Calendars.ReadWrite → calendar access.
  default_scopes: ['openid', 'email', 'offline_access', 'Mail.Read', 'Mail.Send', 'Calendars.ReadWrite'],
  authorize_params: { prompt: 'consent' },
  pkce: true,
  client_id_secret: 'MICROSOFT_CONNECT_CLIENT_ID',
  client_secret_secret: 'MICROSOFT_CONNECT_CLIENT_SECRET',
  // Work/school accounts include `email` in the id_token; personal MSA accounts use `preferred_username`
  // instead. Trying both in order means the label resolves for ALL Microsoft account types.
  account_label_claims: ['email', 'preferred_username'],
};

// Apple/iCloud — CalDAV over Basic auth. No OAuth exists for iCloud calendar data (see the Apple
// plan §2.1 and the OneCal/Nylas sources), so this is the first `basic` provider in the estate.
// The id is `apple` while the LABEL is "Apple Calendar": users say Apple, the protocol says iCloud,
// and the card must speak the user's language (Apple plan §13 Q6).
const APPLE: BasicProviderDescriptor = {
  auth_kind: 'basic',
  id: 'apple',
  label: 'Apple Calendar',
  // Discovery starts here; iCloud then redirects the principal to a PARTITION host (pNN-caldav…),
  // which the CalDAV client follows. Do not pin a partition host — it differs per account.
  service_endpoint: 'https://caldav.icloud.com',
  credential_help_url: 'https://support.apple.com/en-us/102654',
  username_label: 'Apple Account email',
  password_label: 'App-specific password',
};

const PROVIDERS: Record<string, ProviderDescriptor> = {
  [GOOGLE.id]: GOOGLE,
  [MICROSOFT.id]: MICROSOFT,
  [APPLE.id]: APPLE,
};

// The descriptor for a provider id, or null when unknown. Pure lookup — availability (creds resolved) is a
// separate check in ./config.ts.
export function providerDescriptor(id: string): ProviderDescriptor | null {
  return PROVIDERS[id] ?? null;
}

// The descriptor for a provider that authenticates with OAuth, or null when the id is unknown OR the
// provider uses a different auth kind. Call sites that can only handle the OAuth handshake use this
// instead of narrowing by hand, so "is this an OAuth provider?" is answered in ONE place.
export function oauthProviderDescriptor(id: string): OAuthProviderDescriptor | null {
  const d = providerDescriptor(id);
  return d && d.auth_kind === 'oauth2' ? d : null;
}

// Every registered provider id (for discovery / the management surface).
export function providerIds(): string[] {
  return Object.keys(PROVIDERS).sort();
}
