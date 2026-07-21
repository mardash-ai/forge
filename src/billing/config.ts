import { readSecrets } from '../plugins/secrets-local/index';

// C33 — resolve the Stripe billing config from the C5 vault (then the process env, the same resolution
// order as model-anthropic / email-smtp / auth-identity / connectors). Secrets are NEVER hardcoded — the
// operator provisions them per app. When the key/webhook-secret aren't present the surface degrades
// DETECTABLY (configured:false → checkout/portal 503, the subscription read still 200 `none`, the webhook
// no-ops) — never a crash. This lets an app ADOPT billing before the Stripe account is live.

export const STRIPE_SECRET_KEY = 'STRIPE_SECRET_KEY';
export const STRIPE_WEBHOOK_SECRET = 'STRIPE_WEBHOOK_SECRET';
export const STRIPE_TAX_ENABLED = 'STRIPE_TAX_ENABLED';

// §1C — single source of trial length. Every trialing subscription is created with this value;
// changing the trial is a one-line edit here with NO other code changes needed.
export const TRIAL_DAYS = 14;

export interface BillingConfig {
  // Fully operational (checkout/portal can run) only when the secret key is present.
  configured: boolean;
  secretKey: string | null;
  // The webhook can be verified only when the signing secret is present (independent of the API key).
  webhookSecret: string | null;
  // Stripe Tax (automatic_tax) — defaults ON; the operator can disable with STRIPE_TAX_ENABLED=false.
  taxEnabled: boolean;
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

function parseTaxEnabled(raw: string | null): boolean {
  if (raw === null) return true; // default ON
  const v = raw.toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}

export async function resolveBillingConfig(appId: string): Promise<BillingConfig> {
  const [secretKey, webhookSecret, taxRaw] = await Promise.all([
    resolveSecret(appId, STRIPE_SECRET_KEY),
    resolveSecret(appId, STRIPE_WEBHOOK_SECRET),
    resolveSecret(appId, STRIPE_TAX_ENABLED),
  ]);
  return {
    configured: Boolean(secretKey),
    secretKey,
    webhookSecret,
    taxEnabled: parseTaxEnabled(taxRaw),
  };
}
