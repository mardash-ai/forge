import { getBackends } from '../storage/backends';
import { ForgeError } from '../shared/errors';
import { nowIso } from '../shared/time';
import { resolveBillingConfig, TRIAL_DAYS } from './config';
import {
  getStripeClient,
  mapStripeStatus,
  unixToIso,
  verifyStripeSignature,
  type StripeEvent,
  type StripeSubscription,
} from '../plugins/stripe-billing/index';
import {
  deriveEntitlement,
  deriveEntitlements,
  defaultPlan,
} from './entitlements';
import {
  emptyProviderRefs,
  noneRecord,
  type Catalog,
  type EntitlementValue,
  type EntitlementView,
  type EntitlementsView,
  type PlanDef,
  type SubscriptionRecord,
  type SubscriptionStatus,
} from './types';
import { pruneWebhookEvents, type BillingState } from './state';
import { notifyBillingTransition, billingTrialWillEndNotification } from './notify';
import { notify } from '../notifications/delivery';

// C33 — the billing SERVICE: the payment-source-agnostic core behavior the routes call. It owns the plans
// catalog (validate + replace), the entitlement derivation (delegated to ./entitlements), the Stripe web
// ops (checkout / portal — the platform holds the key, the app never imports a Stripe SDK), and the SINGLE
// internal reconciliation SEAM (verify a raw webhook → re-fetch the canonical Stripe subscription → upsert
// the subscription-of-record, idempotent under out-of-order / duplicate delivery via a monotonic version).
// apple/google are reserved: the enum + provider_refs slots exist, but no decoder is built here.

const backend = () => getBackends().then((b) => b.billing);

// --- typed failures (the consume-slice vocabulary) ------------------------------------------------
export const billingNotConfigured = () =>
  new ForgeError({
    code: 'billing_not_configured',
    message:
      'Billing is not configured for this app: the operator must provision STRIPE_SECRET_KEY (and ' +
      'STRIPE_WEBHOOK_SECRET for webhooks) in the C5 vault. Until then, checkout/portal are unavailable.',
    status: 503,
    retry: 'needs-human',
  });
export const unknownPlan = (planKey: string) =>
  new ForgeError({ code: 'unknown_plan', message: `No plan "${planKey}" in this app's catalog.`, status: 422, retry: 'change-input', details: { plan_key: planKey } });
export const priceUnconfigured = (planKey: string) =>
  new ForgeError({
    code: 'price_unconfigured',
    message: `Plan "${planKey}" has no Stripe price id yet, so it cannot be purchased. Set prices.stripe.price_id in the catalog.`,
    status: 422,
    retry: 'needs-human',
    details: { plan_key: planKey },
  });
export const notACustomer = () =>
  new ForgeError({ code: 'not_a_customer', message: 'This subscriber has no billing customer yet (no checkout has been started).', status: 404, retry: 'change-input' });
export const invalidCatalog = (message: string, details?: unknown) =>
  new ForgeError({ code: 'invalid_catalog', message, status: 422, retry: 'change-input', details });

// --- catalog ---------------------------------------------------------------------------------------
const VALID_INTERVALS = new Set(['month', 'year']);

function validatePlans(plans: unknown): PlanDef[] {
  if (!Array.isArray(plans) || plans.length === 0) {
    throw invalidCatalog('`plans` must be a non-empty array (with exactly one is_default plan).');
  }
  const keys = new Set<string>();
  let defaults = 0;
  const out: PlanDef[] = [];
  for (const raw of plans) {
    const p = raw as Partial<PlanDef>;
    if (!p || typeof p.plan_key !== 'string' || !p.plan_key.trim()) {
      throw invalidCatalog('every plan needs a non-empty `plan_key`.');
    }
    const plan_key = p.plan_key.trim();
    if (keys.has(plan_key)) throw invalidCatalog(`duplicate plan_key "${plan_key}".`, { plan_key });
    keys.add(plan_key);
    if (!p.display || typeof (p.display as { name?: string }).name !== 'string' || !(p.display as { name?: string }).name!.trim()) {
      throw invalidCatalog(`plan "${plan_key}" needs display.name.`, { plan_key });
    }
    if (typeof p.interval !== 'string' || !VALID_INTERVALS.has(p.interval)) {
      throw invalidCatalog(`plan "${plan_key}" interval must be "month" or "year".`, { plan_key });
    }
    const entitlements = (p.entitlements ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(entitlements)) {
      if (!(typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string')) {
        throw invalidCatalog(`entitlement "${k}" on plan "${plan_key}" must be boolean|number|string.`, { plan_key, key: k });
      }
    }
    const isDefault = Boolean(p.is_default);
    if (isDefault) defaults++;
    const prices = (p.prices ?? {}) as Partial<PlanDef['prices']>;
    out.push({
      plan_key,
      display: {
        name: (p.display as { name: string }).name.trim(),
        ...((p.display as { description?: string }).description !== undefined ? { description: (p.display as { description?: string }).description } : {}),
        ...((p.display as { order?: number }).order !== undefined ? { order: (p.display as { order?: number }).order } : {}),
      },
      interval: p.interval as PlanDef['interval'],
      prices: {
        stripe: {
          price_id: prices.stripe?.price_id ?? null,
          currency: prices.stripe?.currency ?? null,
        },
        apple: { product_id: prices.apple?.product_id ?? null },
        google: { product_id: prices.google?.product_id ?? null },
      },
      entitlements: entitlements as PlanDef['entitlements'],
      ...(typeof p.seat_limit === 'number' ? { seat_limit: p.seat_limit } : {}),
      is_default: isDefault,
    });
  }
  if (defaults !== 1) {
    throw invalidCatalog(`the catalog must contain EXACTLY ONE plan with is_default:true (found ${defaults}).`);
  }
  return out;
}

export async function putCatalog(appId: string, plans: unknown): Promise<{ plans: PlanDef[] }> {
  const validated = validatePlans(plans);
  const catalog: Catalog = { plans: validated, updated_at: nowIso() };
  await (await backend()).mutate(appId, (state) => ({ state: { ...state, catalog }, result: undefined }));
  return { plans: validated };
}

export async function getCatalog(appId: string): Promise<{ plans: PlanDef[] }> {
  const state = await (await backend()).read(appId);
  return { plans: state.catalog?.plans ?? [] };
}

// --- subscription-of-record read (never 404s — returns a `none` record when absent) ----------------
export async function getSubscription(appId: string, subscriber: string): Promise<SubscriptionRecord> {
  const state = await (await backend()).read(appId);
  const existing = state.subscriptions[subscriber];
  if (existing) return existing;
  const defaultKey = defaultPlan(state.catalog)?.plan_key ?? null;
  return noneRecord(appId, subscriber, defaultKey, nowIso());
}

export async function getEntitlementsView(appId: string, subscriber: string): Promise<EntitlementsView> {
  const state = await (await backend()).read(appId);
  const record = state.subscriptions[subscriber] ?? noneRecord(appId, subscriber, defaultPlan(state.catalog)?.plan_key ?? null, nowIso());
  return deriveEntitlements(record, state.catalog);
}

export async function getEntitlementView(appId: string, subscriber: string, key: string): Promise<EntitlementView> {
  const state = await (await backend()).read(appId);
  const record = state.subscriptions[subscriber] ?? noneRecord(appId, subscriber, defaultPlan(state.catalog)?.plan_key ?? null, nowIso());
  return deriveEntitlement(record, state.catalog, key);
}

// --- Stripe web ops --------------------------------------------------------------------------------
export interface CheckoutInput {
  appId: string;
  subscriber: string;
  planKey: string;
  successUrl: string;
  cancelUrl: string;
  scopeRef?: string;
  customerEmail?: string;
  // Optional free-trial length (days). When set, the Stripe subscription starts `trialing` (trial_end ≈
  // now + N days) instead of immediately `active`. Omitted ⇒ no trial (prior behavior).
  trialPeriodDays?: number;
  // Whether Checkout collects a card up-front — `'always'` = card-required trial; omitted ⇒ Stripe default.
  paymentMethodCollection?: 'always' | 'if_required';
}

export async function createCheckout(input: CheckoutInput): Promise<{ url: string; session_id: string }> {
  const cfg = await resolveBillingConfig(input.appId);
  if (!cfg.configured || !cfg.secretKey) throw billingNotConfigured();

  const state = await (await backend()).read(input.appId);
  const plan = state.catalog?.plans.find((p) => p.plan_key === input.planKey);
  if (!plan) throw unknownPlan(input.planKey);
  const priceId = plan.prices.stripe.price_id;
  if (!priceId) throw priceUnconfigured(input.planKey);

  const stripe = getStripeClient();
  // REUSE the subscriber's stripe_customer_id, else create + remember it (so the portal works and the
  // customer is reused across checkouts). Remembering upserts only the customer id / scope_ref — it never
  // fabricates a subscription (status stays whatever it was).
  let customerId = state.subscriptions[input.subscriber]?.provider_refs.stripe_customer_id ?? null;
  if (!customerId) {
    const created = await stripe.createCustomer({
      secretKey: cfg.secretKey,
      ...(input.customerEmail ? { email: input.customerEmail } : {}),
      metadata: { subscriber: input.subscriber, app: input.appId },
    });
    customerId = created.id;
    await rememberCustomer(input.appId, input.subscriber, customerId, input.scopeRef);
  }

  const metadata: Record<string, string> = { subscriber: input.subscriber, app: input.appId, plan_key: input.planKey };
  if (input.scopeRef) metadata.scope_ref = input.scopeRef;

  const session = await stripe.createCheckoutSession({
    secretKey: cfg.secretKey,
    priceId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    clientReferenceId: input.subscriber,
    customerId,
    ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
    metadata,
    taxEnabled: cfg.taxEnabled,
    ...(input.trialPeriodDays ? { trialPeriodDays: input.trialPeriodDays } : {}),
    ...(input.paymentMethodCollection ? { paymentMethodCollection: input.paymentMethodCollection } : {}),
  });
  return { url: session.url, session_id: session.id };
}

export async function createPortal(appId: string, subscriber: string, returnUrl: string): Promise<{ url: string }> {
  const cfg = await resolveBillingConfig(appId);
  if (!cfg.configured || !cfg.secretKey) throw billingNotConfigured();
  const state = await (await backend()).read(appId);
  const customerId = state.subscriptions[subscriber]?.provider_refs.stripe_customer_id ?? null;
  if (!customerId) throw notACustomer();
  const { url } = await getStripeClient().createPortalSession({ secretKey: cfg.secretKey, customerId, returnUrl });
  return { url };
}

// --- §1B — create a trialing subscription at signup (no payment method, TRIAL_DAYS, pause on end) ----
// Server-side op (SERVICE token gated in the route — never end-user reachable directly). Creates a
// Stripe Customer (reused if already present) + Subscription in `trialing` status with NO payment method
// and `trial_settings.end_behavior.missing_payment_method: 'pause'`. Persists the subscription-of-record
// immediately so entitlement reads return `trialing` without waiting for a webhook.
export interface TrialInput {
  appId: string;
  subscriber: string;
  planKey: string;
  scopeRef?: string;
  customerEmail?: string;
}

export async function createTrialingSubscriptionAtSignup(input: TrialInput): Promise<SubscriptionRecord> {
  const cfg = await resolveBillingConfig(input.appId);
  if (!cfg.configured || !cfg.secretKey) throw billingNotConfigured();

  const state = await (await backend()).read(input.appId);
  const plan = state.catalog?.plans.find((p) => p.plan_key === input.planKey);
  if (!plan) throw unknownPlan(input.planKey);
  const priceId = plan.prices.stripe.price_id;
  if (!priceId) throw priceUnconfigured(input.planKey);

  const stripe = getStripeClient();

  // Reuse or create the Stripe Customer.
  let customerId = state.subscriptions[input.subscriber]?.provider_refs.stripe_customer_id ?? null;
  if (!customerId) {
    const created = await stripe.createCustomer({
      secretKey: cfg.secretKey,
      ...(input.customerEmail ? { email: input.customerEmail } : {}),
      metadata: { subscriber: input.subscriber, app: input.appId },
    });
    customerId = created.id;
  }

  const metadata: Record<string, string> = { subscriber: input.subscriber, app: input.appId, plan_key: input.planKey };
  if (input.scopeRef) metadata.scope_ref = input.scopeRef;

  // Create the trialing subscription: NO payment method, TRIAL_DAYS trial, pause on trial end.
  const sub = await stripe.createTrialingSubscription({
    secretKey: cfg.secretKey,
    customerId,
    priceId,
    trialPeriodDays: TRIAL_DAYS,
    metadata,
  });

  // Immediately persist the canonical record so entitlement checks work before the first webhook arrives.
  const fields: Omit<SubscriptionRecord, 'version' | 'created_at' | 'updated_at'> = {
    subscriber: input.subscriber,
    app: input.appId,
    plan_key: input.planKey,
    status: mapStripeStatus(sub.status),
    source: 'stripe',
    current_period_end: unixToIso(sub.current_period_end),
    cancel_at_period_end: sub.cancel_at_period_end,
    trial_end: unixToIso(sub.trial_end),
    currency: sub.currency,
    scope_ref: input.scopeRef ?? null,
    provider_refs: {
      ...emptyProviderRefs(),
      stripe_customer_id: customerId,
      stripe_subscription_id: sub.id,
      stripe_price_id: sub.price_id,
    },
  };
  const { record } = await applyCanonicalSubscription(input.appId, fields, Date.now());
  return record;
}

// Upsert only the stripe_customer_id (+ optional echo-only scope_ref) onto the subscriber's record,
// preserving any existing subscription state (or seeding a fresh `none` record).
async function rememberCustomer(appId: string, subscriber: string, customerId: string, scopeRef?: string): Promise<void> {
  await (await backend()).mutate(appId, (state) => {
    const now = nowIso();
    const existing = state.subscriptions[subscriber] ?? noneRecord(appId, subscriber, defaultPlan(state.catalog)?.plan_key ?? null, now);
    const next: SubscriptionRecord = {
      ...existing,
      scope_ref: scopeRef ?? existing.scope_ref,
      provider_refs: { ...existing.provider_refs, stripe_customer_id: customerId },
      updated_at: now,
    };
    return { state: { ...state, subscriptions: { ...state.subscriptions, [subscriber]: next } }, result: undefined };
  });
}

// --- reconciliation SEAM (the ONE internal upsert; apple/google will feed the SAME seam) -----------
// Map a re-fetched canonical Stripe subscription into the subscription-of-record fields. `subscriberHint`
// is used when the metadata is absent (defense in depth).
function canonicalFromStripe(
  appId: string,
  sub: StripeSubscription,
  catalog: Catalog | null,
  existing: SubscriptionRecord | undefined,
): { subscriber: string; fields: Omit<SubscriptionRecord, 'version' | 'created_at' | 'updated_at'> } | null {
  const subscriber = sub.metadata.subscriber || existing?.subscriber;
  if (!subscriber) return null; // cannot attribute this subscription to a subscriber
  // plan_key: prefer the metadata we stamped at checkout; else map the price id via the catalog.
  const planKey =
    sub.metadata.plan_key ||
    catalog?.plans.find((p) => p.prices.stripe.price_id && p.prices.stripe.price_id === sub.price_id)?.plan_key ||
    existing?.plan_key ||
    null;
  const fields: Omit<SubscriptionRecord, 'version' | 'created_at' | 'updated_at'> = {
    subscriber,
    app: appId,
    plan_key: planKey,
    status: mapStripeStatus(sub.status),
    source: 'stripe',
    current_period_end: unixToIso(sub.current_period_end),
    cancel_at_period_end: sub.cancel_at_period_end,
    trial_end: unixToIso(sub.trial_end),
    currency: sub.currency,
    scope_ref: sub.metadata.scope_ref || existing?.scope_ref || null,
    provider_refs: {
      ...emptyProviderRefs(),
      ...(existing?.provider_refs ?? {}),
      stripe_customer_id: sub.customer_id ?? existing?.provider_refs.stripe_customer_id ?? null,
      stripe_subscription_id: sub.id,
      stripe_price_id: sub.price_id ?? existing?.provider_refs.stripe_price_id ?? null,
    },
  };
  return { subscriber, fields };
}

// Apply a canonical subscription snapshot under the monotonic-version guard: a write with an OLDER version
// than what is stored is dropped (so a stale re-fetch never clobbers a newer one — out-of-order / duplicate
// delivery converges). Exposed for tests to prove the guard directly. Also reports `previous_status` — the
// status atomically in place BEFORE this apply — so the caller can detect a genuine state transition (→
// past_due / → canceled / recovery) and notify exactly once. `none` when there was no prior record.
export async function applyCanonicalSubscription(
  appId: string,
  fields: Omit<SubscriptionRecord, 'version' | 'created_at' | 'updated_at'>,
  version: number,
): Promise<{ applied: boolean; record: SubscriptionRecord; previous_status: SubscriptionStatus }> {
  return (await backend()).mutate<{ applied: boolean; record: SubscriptionRecord; previous_status: SubscriptionStatus }>(appId, (state) => {
    const now = nowIso();
    const existing = state.subscriptions[fields.subscriber];
    const previous_status: SubscriptionStatus = existing?.status ?? 'none';
    if (existing && version < existing.version) {
      return { state, result: { applied: false, record: existing, previous_status } };
    }
    const record: SubscriptionRecord = {
      ...fields,
      version,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    return {
      state: { ...state, subscriptions: { ...state.subscriptions, [fields.subscriber]: record } },
      result: { applied: true, record, previous_status },
    };
  });
}

// Re-fetch the canonical Stripe subscription and upsert the record. Version = fetch recency (the later
// fetch reflects the later truth and wins the guard). Throws on a transient Stripe/store failure so the
// webhook returns 5xx and Stripe retries. On an APPLIED state transition (→ past_due / → canceled /
// recovery), fires a billing notification best-effort (C21) — this is the SINGLE seam both the webhook and
// the self-heal sweep flow through, so a dropped webhook the sweep later catches still notifies (once).
// `appName` lets the notification's email channel resolve the app for C12 (falls back to FORGE_APP_NAME).
async function reconcileSubscription(
  appId: string,
  secretKey: string,
  subscriptionId: string,
  appName?: string,
): Promise<SubscriptionRecord | null> {
  const stripe = getStripeClient();
  const sub = await stripe.retrieveSubscription(secretKey, subscriptionId);
  const version = Date.now();
  if (!sub) return null;
  const state = await (await backend()).read(appId);
  const existing = Object.values(state.subscriptions).find((r) => r.provider_refs.stripe_subscription_id === sub.id)
    ?? (sub.metadata.subscriber ? state.subscriptions[sub.metadata.subscriber] : undefined);
  const canonical = canonicalFromStripe(appId, sub, state.catalog, existing);
  if (!canonical) return null;
  const { applied, record, previous_status } = await applyCanonicalSubscription(appId, canonical.fields, version);
  // Only an APPLIED write can be a real transition; the guard inside billingTransitionNotification also
  // requires previous_status !== record.status, so a same-status re-fetch never notifies.
  if (applied) await notifyBillingTransition(appId, appName, previous_status, record);
  return record;
}

// Pull a subscription id out of a handled event's object (subscription events carry it as `id`; checkout
// sessions + invoices carry it as `subscription`). Returns null for customer-keyed events like
// setup_intent.succeeded / payment_method.attached — those are routed via customerIdFromEvent instead.
function subscriptionIdFromEvent(event: StripeEvent): string | null {
  const obj = event.data.object;
  if (event.type.startsWith('customer.subscription.')) {
    return typeof obj.id === 'string' ? obj.id : null;
  }
  const sub = obj.subscription;
  return typeof sub === 'string' ? sub : (sub as { id?: string } | null)?.id ?? null;
}

// For `setup_intent.succeeded` and `payment_method.attached` the subscription is not directly on the
// event — we look it up by Stripe customer id from our store.
function customerIdFromEvent(event: StripeEvent): string | null {
  const obj = event.data.object;
  const cust = obj.customer;
  return typeof cust === 'string' ? cust : null;
}

// §1B full webhook set (spec §1B, PRICING_BILLING_SPEC.md).
// customer.subscription.trial_will_end — T-2 reminder trigger (reconcile + fire T-2 notification).
// setup_intent.succeeded / payment_method.attached — card added at conversion; find sub by customer ID,
//   resume if paused (§1E), then reconcile so entitlements reflect the new status immediately.
// invoice.paid / invoice.payment_failed — post-conversion dunning only (§1G).
const HANDLED_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.trial_will_end', // §1B / §1F: T-2 reminder trigger
  'invoice.paid',
  'invoice.payment_failed',
  'setup_intent.succeeded',        // §1B / §1E: card added at conversion; resume if paused
  'payment_method.attached',       // §1B / §1E: card attached to customer; resume if paused
]);

export interface WebhookResult {
  status: number; // the HTTP status the route returns
  outcome: 'processed' | 'ignored' | 'duplicate' | 'not_configured' | 'signature_invalid';
  event_type?: string;
  record?: SubscriptionRecord | null;
}

// The webhook handler: verify the RAW bytes → dedupe on event.id → (handled type) re-fetch canonical + upsert.
// Unconfigured (no webhook secret) → no-op 200. Bad signature → the route returns 400 signature_invalid.
// A transient re-fetch/store failure THROWS → the route returns 5xx so Stripe retries.
export async function handleStripeWebhook(
  appId: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appName?: string,
): Promise<WebhookResult> {
  const cfg = await resolveBillingConfig(appId);
  // No signing secret ⇒ we cannot (and must not) trust the payload — no-op, never crash.
  if (!cfg.webhookSecret) return { status: 200, outcome: 'not_configured' };

  const event = verifyStripeSignature(rawBody, signatureHeader, cfg.webhookSecret);
  if (!event) return { status: 400, outcome: 'signature_invalid' };

  // Dedupe on event.id (one-shot). A replay is a 200 no-op. Recording the mark is idempotent-safe: even if
  // reprocessed, the upsert is idempotent via re-fetch + the monotonic version guard.
  const store = await backend();
  const fresh = await store.mutate(appId, (state) => {
    if (state.webhook_events[event.id]) return { state, result: false };
    const marks = { ...state.webhook_events, [event.id]: { id: event.id, type: event.type, received_at: nowIso() } };
    const nextState: BillingState = { ...state, webhook_events: marks };
    pruneWebhookEvents(nextState);
    return { state: nextState, result: true };
  });
  if (!fresh) return { status: 200, outcome: 'duplicate', event_type: event.type };

  if (!HANDLED_EVENT_TYPES.has(event.type)) return { status: 200, outcome: 'ignored', event_type: event.type };

  // --- customer-keyed events (setup_intent.succeeded / payment_method.attached) --------------------
  // These events carry a `customer` id, not a `subscription` id. We resolve the subscription by
  // looking up our stored record for that customer, then resume it if it is paused (§1E).
  if (event.type === 'setup_intent.succeeded' || event.type === 'payment_method.attached') {
    const customerId = customerIdFromEvent(event);
    if (!customerId) return { status: 200, outcome: 'ignored', event_type: event.type };

    const state = await (await backend()).read(appId);
    const existing = Object.values(state.subscriptions).find(
      (r) => r.provider_refs.stripe_customer_id === customerId,
    );
    if (!existing?.provider_refs.stripe_subscription_id) {
      return { status: 200, outcome: 'ignored', event_type: event.type };
    }
    const subscriptionId = existing.provider_refs.stripe_subscription_id;

    // If the subscription is paused, resume it now that a card has been added (§1E). We use the
    // stripe client directly here so a Stripe error propagates → 5xx → Stripe retries.
    if (existing.status === 'paused') {
      await getStripeClient().resumeSubscription({ secretKey: cfg.secretKey!, subscriptionId });
    }
    const record = await reconcileSubscription(appId, cfg.secretKey!, subscriptionId, appName);
    return { status: 200, outcome: 'processed', event_type: event.type, record };
  }

  // --- subscription-keyed events (standard path) -----------------------------------------------
  const subscriptionId = subscriptionIdFromEvent(event);
  if (!subscriptionId) return { status: 200, outcome: 'ignored', event_type: event.type };

  // Re-fetch canonical + upsert. A throw here propagates → route 5xx → Stripe retries (and the mark above
  // does not block reprocessing correctness because the upsert is idempotent).
  const record = await reconcileSubscription(appId, cfg.secretKey!, subscriptionId, appName);

  // §1F / §1B — T-2 reminder: fire best-effort when Stripe signals trial will end in ~3 days.
  if (event.type === 'customer.subscription.trial_will_end' && record) {
    try {
      const input = billingTrialWillEndNotification(record);
      if (input) await notify(appId, appName, input);
    } catch {
      // Swallow — billing reconciliation correctness must never hinge on notification delivery.
    }
  }

  return { status: 200, outcome: 'processed', event_type: event.type, record };
}

// --- reconcile sweep (self-heals dropped webhooks) -------------------------------------------------
// PLATFORM-INTERNAL: re-pull every non-terminal subscriber's Stripe subscription and re-derive. Chosen to
// live inside the platform (an operator / a C2 job triggers it via POST /billing/reconcile) rather than
// asking the app to poll — the app stays ignorant of Stripe. Not auto-scheduled by default (so it never
// hits Stripe when unconfigured); wire it to C2 per deployment. No-op when unconfigured.
export async function reconcileApp(appId: string, appName?: string): Promise<{ reconciled: number; skipped: number }> {
  const cfg = await resolveBillingConfig(appId);
  if (!cfg.configured || !cfg.secretKey) return { reconciled: 0, skipped: 0 };
  const state = await (await backend()).read(appId);
  let reconciled = 0;
  let skipped = 0;
  for (const record of Object.values(state.subscriptions)) {
    const subId = record.provider_refs.stripe_subscription_id;
    if (!subId || record.status === 'none' || record.status === 'canceled') {
      skipped++;
      continue;
    }
    try {
      await reconcileSubscription(appId, cfg.secretKey, subId, appName);
      reconciled++;
    } catch {
      skipped++;
    }
  }
  return { reconciled, skipped };
}

// --- administrative billing-customer teardown (account closure / right-to-be-forgotten) -----------
// Cancel any active/trialing subscription, delete the Stripe customer (the platform holds the key — the
// app never does), and DROP the platform's subscription-of-record row for the subscriber. Idempotent and
// safe when the principal was never a customer or Stripe isn't configured (those steps are skipped). The
// Stripe I/O runs BEFORE the local row is dropped, so a transient provider failure leaves the record in
// place for a retry rather than orphaning a live Stripe customer. NEVER touches the consumer's own rows.
export interface DeleteCustomerResult {
  deleted: boolean; // something was torn down (a record dropped and/or a Stripe artifact removed)
  subscriber: string;
  subscription_canceled: boolean; // an active/trialing subscription was canceled at Stripe
  stripe_customer_deleted: boolean; // the Stripe customer was deleted
  record_dropped: boolean; // the platform subscription-of-record row was removed
  stripe_configured: boolean; // whether Stripe is configured for this app (else Stripe steps were skipped)
}

export async function deleteCustomer(appId: string, subscriber: string): Promise<DeleteCustomerResult> {
  const store = await backend();
  const state = await store.read(appId);
  const record = state.subscriptions[subscriber];
  const cfg = await resolveBillingConfig(appId);
  const stripeConfigured = Boolean(cfg.configured && cfg.secretKey);

  const base: DeleteCustomerResult = {
    deleted: false,
    subscriber,
    subscription_canceled: false,
    stripe_customer_deleted: false,
    record_dropped: false,
    stripe_configured: stripeConfigured,
  };
  // Never a customer / no record → nothing to tear down (idempotent no-op).
  if (!record) return base;

  const customerId = record.provider_refs.stripe_customer_id;
  const subscriptionId = record.provider_refs.stripe_subscription_id;

  // Provider-side teardown FIRST (only when configured) so a failure aborts before we drop the local row.
  if (stripeConfigured) {
    const stripe = getStripeClient();
    // Also cancel `paused` subscriptions (§1D: paused is live at Stripe; must clean up on teardown).
    if (subscriptionId && (record.status === 'active' || record.status === 'trialing' || record.status === 'paused')) {
      const { canceled } = await stripe.cancelSubscription(cfg.secretKey!, subscriptionId);
      base.subscription_canceled = canceled;
    }
    if (customerId) {
      const { deleted } = await stripe.deleteCustomer(cfg.secretKey!, customerId);
      base.stripe_customer_deleted = deleted;
    }
  }

  // Drop the subscription-of-record row (idempotent: only if still present).
  base.record_dropped = await store.mutate(appId, (s) => {
    if (!s.subscriptions[subscriber]) return { state: s, result: false };
    const { [subscriber]: _drop, ...rest } = s.subscriptions;
    return { state: { ...s, subscriptions: rest }, result: true };
  });

  base.deleted = base.record_dropped || base.subscription_canceled || base.stripe_customer_deleted;
  return base;
}

export type { EntitlementValue };
