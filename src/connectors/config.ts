import { readSecrets } from '../plugins/secrets-local/index';
import {
  providerDescriptor,
  providerIds,
  type BasicProviderDescriptor,
  type OAuthProviderDescriptor,
} from './providers';

// C24 — resolve a provider's OAuth CLIENT CREDENTIALS from the C5 vault (then the process env, same
// resolution order as model-anthropic / email-smtp / auth-identity). Client creds are NEVER hardcoded —
// the operator provisions `<PROVIDER>_CONNECT_CLIENT_ID/SECRET` per provider. A provider is "available"
// only when BOTH its id and secret resolve; otherwise the connect flow degrades detectably (a clean 503),
// never a crash — exactly like C10 Google sign-in.

// A resolved provider is a DISCRIMINATED UNION, mirroring the descriptor's. The OAuth arm carries the
// operator's client credentials; the basic arm carries none, because none exist. Keeping `clientId` as
// an optional string on one shape would have let an OAuth call site read `undefined` and send it to a
// token endpoint — the union makes that a compile error instead.
export type ResolvedProvider =
  | { auth_kind: 'oauth2'; descriptor: OAuthProviderDescriptor; clientId: string; clientSecret: string }
  | { auth_kind: 'basic'; descriptor: BasicProviderDescriptor };

async function resolveSecret(appId: string, name: string): Promise<string | null> {
  try {
    const secrets = await readSecrets(appId);
    const v = secrets[name];
    if (v && v.trim()) return v.trim();
  } catch {
    // Vault unreadable (no master key / corrupt) -> treat as absent, never fatal.
  }
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return null;
}

// The resolved provider (descriptor + creds), or null when the provider is unknown OR its creds aren't
// provisioned. The caller turns null into a typed "connector not configured" response.
export async function resolveProvider(appId: string, providerId: string): Promise<ResolvedProvider | null> {
  const descriptor = providerDescriptor(providerId);
  if (!descriptor) return null;

  // ⛔ A `basic` provider is ALWAYS configured, and this branch must come first.
  //
  // There is no operator-provisioned client credential for Apple/iCloud — the credential is per-user
  // and arrives at connect time. Falling through to the OAuth check below would look for
  // `APPLE_CONNECT_CLIENT_ID`, find nothing (there is nothing to find, ever), return null, and the
  // connect endpoint would answer 503 permanently. That is not a degraded state waiting on an
  // operator; it is a provider that can never be enabled. Availability for basic auth is decided at
  // CONNECT time, when the user's credential is verified against the service — not here.
  if (descriptor.auth_kind === 'basic') {
    return { auth_kind: 'basic', descriptor };
  }

  const [clientId, clientSecret] = await Promise.all([
    resolveSecret(appId, descriptor.client_id_secret),
    resolveSecret(appId, descriptor.client_secret_secret),
  ]);
  if (!clientId || !clientSecret) return null;
  return { auth_kind: 'oauth2', descriptor, clientId, clientSecret };
}

// Which registered providers are CONFIGURED (creds present) for this app — for a discovery/management
// surface that shows the user only the providers they can actually connect.
export async function availableProviders(appId: string): Promise<string[]> {
  const ids = providerIds();
  const checks = await Promise.all(ids.map((id) => resolveProvider(appId, id).then((r) => (r ? id : null))));
  return checks.filter((id): id is string => id !== null);
}
