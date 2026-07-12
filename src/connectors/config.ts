import { readSecrets } from '../plugins/secrets-local/index';
import { providerDescriptor, providerIds, type ProviderDescriptor } from './providers';

// C24 — resolve a provider's OAuth CLIENT CREDENTIALS from the C5 vault (then the process env, same
// resolution order as model-anthropic / email-smtp / auth-identity). Client creds are NEVER hardcoded —
// the operator provisions `<PROVIDER>_CONNECT_CLIENT_ID/SECRET` per provider. A provider is "available"
// only when BOTH its id and secret resolve; otherwise the connect flow degrades detectably (a clean 503),
// never a crash — exactly like C10 Google sign-in.

export interface ResolvedProvider {
  descriptor: ProviderDescriptor;
  clientId: string;
  clientSecret: string;
}

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
  const [clientId, clientSecret] = await Promise.all([
    resolveSecret(appId, descriptor.client_id_secret),
    resolveSecret(appId, descriptor.client_secret_secret),
  ]);
  if (!clientId || !clientSecret) return null;
  return { descriptor, clientId, clientSecret };
}

// Which registered providers are CONFIGURED (creds present) for this app — for a discovery/management
// surface that shows the user only the providers they can actually connect.
export async function availableProviders(appId: string): Promise<string[]> {
  const ids = providerIds();
  const checks = await Promise.all(ids.map((id) => resolveProvider(appId, id).then((r) => (r ? id : null))));
  return checks.filter((id): id is string => id !== null);
}
