// C33 — Billing / subscriptions / entitlements. The payment-source-agnostic DOMAIN TYPES the platform
// owns. The web/Stripe surface is built now; the model carries the `apple | google` slots (source enum +
// provider_refs + reserved routes) from day one so a mobile adapter slots in later with NO rewrite. The
// platform stays IGNORANT of any app group model — a "household" is just an entitlement a plan unlocks;
// `scope_ref` is an ECHO-ONLY pointer the platform stores + returns but never interprets.

// The payment source of record. Only `stripe` is wired on the web surface; `apple` (App Store) and
// `google` (Play) are RESERVED — the enum + provider_refs slots exist so the adapters slot in with no
// schema change. `null` = the free/none default (no payment source yet).
export type BillingSource = 'stripe' | 'apple' | 'google';

// The canonical 6-state subscription vocabulary. EVERY source's native states map into these; consumers
// branch on this vocabulary, never a raw provider state. `none` is the explicit free/never-subscribed
// default — a subscription READ never 404s, it returns a `none` record.
export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'none';

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'active',
  'trialing',
  'past_due',
  'canceled',
  'incomplete',
  'none',
] as const;

// A typed entitlement value. Keys are APP-defined + namespaced; the platform copies values through and
// NEVER interprets them (it only knows boolean/number/string).
export type EntitlementValue = boolean | number | string;
export type EntitlementMap = Record<string, EntitlementValue>;

// Cross-source provider handles for the subscription-of-record. Stripe's are populated on the web surface;
// the apple/google handles are RESERVED (always null until their adapters ship).
export interface ProviderRefs {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  apple_original_transaction_id: string | null; // reserved
  google_purchase_token: string | null; // reserved
}

export function emptyProviderRefs(): ProviderRefs {
  return {
    stripe_customer_id: null,
    stripe_subscription_id: null,
    stripe_price_id: null,
    apple_original_transaction_id: null,
    google_purchase_token: null,
  };
}

// The ONE canonical subscription-of-record per (app, subscriber). Consumers read THIS, never a raw
// provider receipt. Written ONLY by reconciliation inputs (the webhook / the reconcile sweep / the
// checkout customer-remember) — there is no consumer write path. `version` is the monotonic guard that
// makes upserts idempotent under out-of-order / duplicate webhook delivery (a stale re-fetch never
// clobbers a newer one).
export interface SubscriptionRecord {
  subscriber: string; // the opaque id the consumer sets to the C10 owner (payer)
  app: string; // the app id this record belongs to
  plan_key: string | null; // the app catalog plan; null when never on a paid plan
  status: SubscriptionStatus;
  source: BillingSource | null; // null on the free/none default
  current_period_end: string | null; // ISO; the paid-through boundary (grace horizon)
  cancel_at_period_end: boolean;
  trial_end: string | null; // ISO
  currency: string | null; // lowercased ISO-4217, e.g. "usd"
  scope_ref: string | null; // ECHO-ONLY — stored + returned, never interpreted by the platform
  provider_refs: ProviderRefs;
  version: number; // monotonic reconciliation version (fetch recency); guards out-of-order upserts
  created_at: string;
  updated_at: string;
}

// The free/never-subscribed default record for a subscriber (status "none"). `plan_key` is the app's
// is_default plan when a catalog exists, else null.
export function noneRecord(
  app: string,
  subscriber: string,
  defaultPlanKey: string | null,
  now: string,
): SubscriptionRecord {
  return {
    subscriber,
    app,
    plan_key: defaultPlanKey,
    status: 'none',
    source: null,
    current_period_end: null,
    cancel_at_period_end: false,
    trial_end: null,
    currency: null,
    scope_ref: null,
    provider_refs: emptyProviderRefs(),
    version: 0,
    created_at: now,
    updated_at: now,
  };
}

// --- plans catalog (generic; the APP populates it) ------------------------------------------------
export type PlanInterval = 'month' | 'year';

// Per-source price handles for a plan. Only `stripe.price_id` is used on the web surface; a plan with no
// stripe price_id is catalog-VALID but NOT purchasable (checkout → price_unconfigured). apple/google
// product ids are RESERVED (null until their adapters ship).
export interface PlanPrices {
  stripe: { price_id: string | null; currency: string | null };
  apple: { product_id: string | null }; // reserved
  google: { product_id: string | null }; // reserved
}

export interface PlanDisplay {
  name: string;
  description?: string;
  order?: number;
}

// One plan in an app's catalog. Month vs. year are SEPARATE plan_keys that share an entitlement map.
export interface PlanDef {
  plan_key: string;
  display: PlanDisplay;
  interval: PlanInterval;
  prices: PlanPrices;
  entitlements: EntitlementMap;
  seat_limit?: number;
  is_default: boolean; // EXACTLY ONE plan in a catalog is the default (the free/none plan)
}

export interface Catalog {
  plans: PlanDef[];
  updated_at: string;
}

// --- webhook event dedupe -------------------------------------------------------------------------
// A processed provider event id, so a replayed/duplicate delivery is a no-op. Bounded (see the store).
export interface WebhookEventMark {
  id: string; // the provider event id (e.g. Stripe event.id)
  type: string;
  received_at: string;
}

// --- read-surface response shapes -----------------------------------------------------------------
export interface EntitlementsView {
  plan_key: string | null;
  source: BillingSource | null;
  status: SubscriptionStatus;
  entitlements: EntitlementMap;
}

export interface EntitlementView {
  key: string;
  value: EntitlementValue | null;
  source: 'plan' | 'default';
  plan_key: string | null;
}
