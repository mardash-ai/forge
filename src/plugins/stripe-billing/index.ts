import Stripe from 'stripe';
import type { SubscriptionStatus } from '../../billing/types';

// Plugin: stripe-billing — the genuine TECHNOLOGY BOUNDARY for the web billing surface (the live Stripe
// API + Stripe's webhook-signature scheme). Like the C24 outbound-OAuth client and email-smtp, it is
// SWAPPABLE: tests inject a deterministic in-memory Stripe (no network), and the routes/service only ever
// talk to the installed client — never the network directly. Implemented over the OFFICIAL `stripe` SDK
// (chosen over the built-in fetch approach; the slim-image weight cost is accepted): checkout / portal /
// customer / subscription I/O go through the SDK, and webhook signatures are verified with the SDK's
// `constructEvent`. The platform holds the Stripe secret key; the app never imports a Stripe SDK and never
// sees the key or a raw event.

const STRIPE_TIMEOUT_MS = 20_000;

// --- normalized shapes (source-agnostic canon lives in ../../billing) ---------------------------------
// The client returns NORMALIZED objects (the fields the service maps into a SubscriptionRecord), so a stub
// provider and the real SDK are interchangeable and the mapping is tested without a network.
export interface StripeSubscription {
  id: string;
  status: string; // Stripe's native status vocabulary (mapped by mapStripeStatus below)
  current_period_end: number | null; // unix seconds
  cancel_at_period_end: boolean;
  trial_end: number | null; // unix seconds
  customer_id: string | null;
  price_id: string | null;
  currency: string | null; // ISO-4217 lowercased
  metadata: Record<string, string>; // { subscriber, app, plan_key, scope_ref } we set at checkout
}

export interface StripeCheckoutSessionEvent {
  id: string;
  subscription_id: string | null;
  customer_id: string | null;
  client_reference_id: string | null;
  metadata: Record<string, string>;
}

export interface CreateCheckoutInput {
  secretKey: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  clientReferenceId: string; // the subscriber
  customerId?: string; // reuse an existing Stripe customer when we have one
  customerEmail?: string; // else prefill the email (only when no customerId)
  metadata: Record<string, string>; // { subscriber, app, plan_key, scope_ref }
  taxEnabled: boolean; // Stripe Tax (automatic_tax)
  // Optional free trial: set `subscription_data.trial_period_days` so the resulting subscription starts
  // in Stripe status `trialing` (trial_end ≈ now + N days) rather than immediately `active`. A positive
  // integer number of days; omitted ⇒ no trial (immediate active subscription, the prior behavior).
  trialPeriodDays?: number;
  // Whether Checkout collects a payment method up-front. `'always'` = require a card even for a trial (a
  // "card-required trial" that auto-converts to paid); `'if_required'` = Stripe's default (may skip the
  // card for a trial). Omitted ⇒ Stripe's default.
  paymentMethodCollection?: 'always' | 'if_required';
}

// §1B — direct subscription creation at signup: no payment method, trial + pause on end.
// Used by POST /billing/trial (server-side call at signup; distinct from Checkout which opens a UI page).
export interface CreateTrialingSubscriptionInput {
  secretKey: string;
  customerId: string;
  priceId: string;
  // Trial length (days). MUST equal TRIAL_DAYS; expressed as a parameter so the stub is stateless.
  trialPeriodDays: number;
  metadata: Record<string, string>; // { subscriber, app, plan_key }
}

// §1E — resume a paused subscription after a card has been added. `billing_cycle_anchor: 'now'`
// restarts the billing cycle from the resume date (the first charge happens immediately for the period).
export interface ResumeSubscriptionInput {
  secretKey: string;
  subscriptionId: string;
}

export interface CreatePortalInput {
  secretKey: string;
  customerId: string;
  returnUrl: string;
}

export interface CreateCustomerInput {
  secretKey: string;
  email?: string;
  metadata: Record<string, string>;
}

export interface StripeClient {
  createCustomer(input: CreateCustomerInput): Promise<{ id: string }>;
  createCheckoutSession(input: CreateCheckoutInput): Promise<{ id: string; url: string }>;
  createPortalSession(input: CreatePortalInput): Promise<{ url: string }>;
  // §1B — create a trialing subscription directly (no Checkout UI) with NO payment method and
  // `trial_settings.end_behavior.missing_payment_method: 'pause'`. Returns the normalized subscription.
  createTrialingSubscription(input: CreateTrialingSubscriptionInput): Promise<StripeSubscription>;
  // §1E — resume a paused subscription after a card has been added at conversion. Idempotent — an
  // already-active / already-canceled subscription resolves to `{ resumed: false }`.
  resumeSubscription(input: ResumeSubscriptionInput): Promise<{ resumed: boolean; subscription: StripeSubscription | null }>;
  // Re-fetch the CANONICAL subscription (idempotent reconciliation input). null when it no longer exists.
  retrieveSubscription(secretKey: string, subscriptionId: string): Promise<StripeSubscription | null>;
  // Cancel a subscription NOW (administrative teardown). Idempotent — a subscription that is already gone
  // (404) or already canceled resolves to `{ canceled: false }` rather than throwing.
  cancelSubscription(secretKey: string, subscriptionId: string): Promise<{ canceled: boolean }>;
  // Delete a customer at the payment provider (removes its saved payment methods + cancels its
  // subscriptions provider-side). Idempotent — an already-deleted / unknown (404) customer ⇒ `{ deleted: false }`.
  deleteCustomer(secretKey: string, customerId: string): Promise<{ deleted: boolean }>;
}

// --- Stripe → canonical status mapping ----------------------------------------------------------------
// Every native Stripe status collapses into the canonical 7-state vocabulary consumers branch on.
// `paused` is distinct from `canceled` (§1D): the subscription persists; adding a card resumes it.
export function mapStripeStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
    case 'unpaid': // retries exhausted but the subscription is retained → treat as past_due (grace)
      return 'past_due';
    case 'incomplete':
      return 'incomplete';
    case 'paused': // §1D: trial ended with no payment method; read-only grace; can resume
      return 'paused';
    case 'incomplete_expired': // the initial payment never succeeded and the window expired → terminal
    case 'canceled':
      return 'canceled';
    default:
      return 'canceled';
  }
}

export function unixToIso(unix: number | null | undefined): string | null {
  if (typeof unix !== 'number' || !Number.isFinite(unix) || unix <= 0) return null;
  return new Date(unix * 1000).toISOString();
}

// --- SDK instances ------------------------------------------------------------------------------------
// One Stripe instance per secret key (a Builder app typically has exactly one). Construction is pure — no
// network — so it is cheap and safe to memoize. The SDK's pinned api version matches its bundled types.
const clientsByKey = new Map<string, Stripe>();
function stripeApi(secretKey: string): Stripe {
  let s = clientsByKey.get(secretKey);
  if (!s) {
    s = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: STRIPE_TIMEOUT_MS });
    clientsByKey.set(secretKey, s);
  }
  return s;
}

// A single instance used ONLY for its webhook helpers (constructEvent / generateTestHeaderString). Both are
// pure-crypto and make NO network call, so the api key here is irrelevant — the WEBHOOK SIGNING SECRET is
// what verification uses. Kept separate from the per-secret-key API clients above.
let webhookOnly: Stripe | null = null;
function stripeWebhooks(): Stripe['webhooks'] {
  if (!webhookOnly) webhookOnly = new Stripe('sk_webhook_verify_only_no_network');
  return webhookOnly.webhooks;
}

// --- webhook signature verification (raw bytes) -------------------------------------------------------
// Verification is delegated to the SDK's `stripe.webhooks.constructEvent(rawBody, header, secret)`, which
// enforces Stripe's `t=<unix>,v1=<hexHmac>` scheme AND the timestamp tolerance window (replay defense) and
// throws on ANY failure (bad signature / stale / malformed). We verify from the RAW request bytes (the app
// never re-serializes) and return the parsed event on success, or null on any failure. The returned event
// is projected onto the minimal shape the service consumes.
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export function verifyStripeSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  webhookSecret: string,
  opts: { toleranceSeconds?: number } = {},
): StripeEvent | null {
  if (!signatureHeader) return null;
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  try {
    const event = stripeWebhooks().constructEvent(payload, signatureHeader, webhookSecret, tolerance);
    if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') return null;
    const object = (event.data?.object ?? {}) as unknown as Record<string, unknown>;
    return { id: event.id, type: event.type, data: { object } };
  } catch {
    // StripeSignatureVerificationError (bad sig / stale / malformed) → treat as not-verified.
    return null;
  }
}

// The header value a sender computes for a raw payload — the real Stripe proxy does NOT need this, but the
// tests (and any first-party signing) use it to prove the raw-bytes → verify → upsert path end to end. Uses
// the SDK's own test-header generator, the exact inverse of `constructEvent`.
export function computeStripeSignatureHeader(
  rawBody: Buffer | string,
  webhookSecret: string,
  atSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  return stripeWebhooks().generateTestHeaderString({ payload, secret: webhookSecret, timestamp: atSeconds });
}

// --- normalize an SDK Subscription into the source-agnostic shape -------------------------------------
function normalizeSubscription(sub: Stripe.Subscription): StripeSubscription {
  const item = sub.items?.data?.[0];
  const price = item?.price ?? null;
  const customer = sub.customer;
  // `current_period_end` lives on the subscription ITEM in current api versions (and historically on the
  // subscription itself) — read the item first, then fall back to the subscription for older shapes.
  const periodEnd =
    (typeof item?.current_period_end === 'number' ? item.current_period_end : undefined) ??
    (sub as unknown as { current_period_end?: number }).current_period_end ??
    null;
  return {
    id: sub.id,
    status: String(sub.status ?? ''),
    current_period_end: typeof periodEnd === 'number' ? periodEnd : null,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    trial_end: typeof sub.trial_end === 'number' ? sub.trial_end : null,
    customer_id: typeof customer === 'string' ? customer : customer?.id ?? null,
    price_id: price?.id ?? null,
    currency: price?.currency ?? ((sub as unknown as { currency?: string }).currency ?? null),
    metadata: (sub.metadata as Record<string, string> | null) ?? {},
  };
}

// --- the real SDK-backed client -----------------------------------------------------------------------
export const sdkStripeClient: StripeClient = {
  async createCustomer({ secretKey, email, metadata }) {
    const customer = await stripeApi(secretKey).customers.create({
      ...(email ? { email } : {}),
      metadata,
    });
    return { id: customer.id };
  },

  // §1B — create the trialing subscription directly (no Checkout UI). The subscription starts in
  // `trialing` status; no payment method is collected; `missing_payment_method: pause` ensures that
  // trial-end with no card pauses the subscription (no invoice, no charge) rather than canceling.
  async createTrialingSubscription({ secretKey, customerId, priceId, trialPeriodDays, metadata }) {
    const sub = await stripeApi(secretKey).subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      trial_period_days: trialPeriodDays,
      trial_settings: {
        end_behavior: {
          missing_payment_method: 'pause',
        },
      },
      metadata,
    });
    return normalizeSubscription(sub);
  },

  // §1E — resume a paused subscription after a card has been added. billing_cycle_anchor: 'now'
  // starts a fresh billing cycle from the resume date so the subscriber is charged immediately.
  async resumeSubscription({ secretKey, subscriptionId }) {
    try {
      const sub = await stripeApi(secretKey).subscriptions.resume(subscriptionId, {
        billing_cycle_anchor: 'now',
      });
      return { resumed: true, subscription: normalizeSubscription(sub) };
    } catch (err) {
      // Already active / canceled / not found → idempotent no-op, not an error.
      if (err instanceof Stripe.errors.StripeInvalidRequestError && err.statusCode === 404) {
        return { resumed: false, subscription: null };
      }
      if (err instanceof Stripe.errors.StripeInvalidRequestError && err.statusCode === 400) {
        // Subscription is not in a paused state (e.g. already active) → idempotent.
        return { resumed: false, subscription: null };
      }
      throw err;
    }
  },

  async createCheckoutSession(input) {
    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.clientReferenceId,
      automatic_tax: { enabled: input.taxEnabled },
      tax_id_collection: { enabled: true },
      metadata: input.metadata,
      // Stamp the subscription so a webhook re-fetch carries our metadata. A trial (when requested) makes
      // the resulting subscription start `trialing`, so the webhook records status:"trialing" + trial_end.
      subscription_data: {
        metadata: input.metadata,
        ...(input.trialPeriodDays ? { trial_period_days: input.trialPeriodDays } : {}),
      },
    };
    // Require a card up-front for a card-required trial (or whenever the caller asks). Top-level Checkout
    // param, independent of the trial: `'always'` collects a payment method even when a trial is present.
    if (input.paymentMethodCollection) {
      params.payment_method_collection = input.paymentMethodCollection;
    }
    if (input.customerId) {
      params.customer = input.customerId;
      // customer_update is only valid when a customer is attached.
      params.customer_update = { address: 'auto', name: 'auto' };
    } else if (input.customerEmail) {
      params.customer_email = input.customerEmail;
    }
    const session = await stripeApi(input.secretKey).checkout.sessions.create(params);
    return { id: session.id, url: session.url ?? '' };
  },

  async createPortalSession({ secretKey, customerId, returnUrl }) {
    const session = await stripeApi(secretKey).billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  },

  async retrieveSubscription(secretKey, subscriptionId) {
    try {
      const sub = await stripeApi(secretKey).subscriptions.retrieve(subscriptionId);
      return normalizeSubscription(sub);
    } catch (err) {
      // A subscription that no longer exists → null (reconcile treats it as absent), not an error.
      if (err instanceof Stripe.errors.StripeInvalidRequestError && err.statusCode === 404) return null;
      throw err;
    }
  },

  async cancelSubscription(secretKey, subscriptionId) {
    try {
      await stripeApi(secretKey).subscriptions.cancel(subscriptionId);
      return { canceled: true };
    } catch (err) {
      // Already canceled / never existed (404) → nothing to do (idempotent teardown), not an error.
      if (err instanceof Stripe.errors.StripeInvalidRequestError && err.statusCode === 404) return { canceled: false };
      throw err;
    }
  },

  async deleteCustomer(secretKey, customerId) {
    try {
      const res = await stripeApi(secretKey).customers.del(customerId);
      return { deleted: Boolean((res as { deleted?: boolean }).deleted) };
    } catch (err) {
      // Already deleted / unknown customer (404) → treat as done (idempotent teardown), not an error.
      if (err instanceof Stripe.errors.StripeInvalidRequestError && err.statusCode === 404) return { deleted: false };
      throw err;
    }
  },
};

// --- installable client (swappable for tests) ---------------------------------------------------------
let client: StripeClient = sdkStripeClient;
export function getStripeClient(): StripeClient {
  return client;
}
export function setStripeClient(c: StripeClient): void {
  client = c;
}
export function resetStripeClient(): void {
  client = sdkStripeClient;
}

export { normalizeSubscription };
