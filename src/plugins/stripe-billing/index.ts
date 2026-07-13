import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SubscriptionStatus } from '../../billing/types';

// Plugin: stripe-billing — the genuine TECHNOLOGY BOUNDARY for the web billing surface (the live Stripe
// REST API + Stripe's webhook-signature scheme). Like the C24 outbound-OAuth client and email-smtp, it is
// SWAPPABLE: tests inject a deterministic in-memory Stripe (no network), and the routes/service only ever
// talk to the installed client — never the network directly. Dependency-clean: Node's built-in fetch +
// crypto only (no SDK), keeping the slim multi-arch data-plane image clean. The platform holds the Stripe
// secret key; the app never imports a Stripe SDK and never sees the key or a raw event.

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const STRIPE_TIMEOUT_MS = 20_000;

// --- normalized shapes (source-agnostic canon lives in ../../billing) ---------------------------------
// The client returns NORMALIZED objects (the fields the service maps into a SubscriptionRecord), so a stub
// provider and the real API are interchangeable and the mapping is tested without a network.
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
  // Re-fetch the CANONICAL subscription (idempotent reconciliation input). null when it no longer exists.
  retrieveSubscription(secretKey: string, subscriptionId: string): Promise<StripeSubscription | null>;
}

// --- Stripe → canonical status mapping ----------------------------------------------------------------
// Every native Stripe status collapses into the canonical 6-state vocabulary consumers branch on.
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
    case 'incomplete_expired': // the initial payment never succeeded and the window expired → terminal
    case 'canceled':
    case 'paused': // trial ended with no payment method; grants nothing → terminal for entitlement purposes
      return 'canceled';
    default:
      return 'canceled';
  }
}

export function unixToIso(unix: number | null | undefined): string | null {
  if (typeof unix !== 'number' || !Number.isFinite(unix) || unix <= 0) return null;
  return new Date(unix * 1000).toISOString();
}

// --- webhook signature verification (raw bytes) -------------------------------------------------------
// Stripe's scheme: header `t=<unix>,v1=<hexHmac>[,v1=<hexHmac>]`. signed_payload = `${t}.${rawBody}`;
// expected = HMAC-SHA256(webhookSecret, signed_payload). Verify from the RAW request bytes (the app never
// re-serializes) and constant-time compare. A timestamp outside the tolerance window is rejected (replay
// defense). Returns the parsed event on success, or null on ANY failure (bad signature / stale / malformed).
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

function parseSignatureHeader(header: string): { t: number | null; v1: string[] } {
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') {
      const n = Number(v);
      if (Number.isFinite(n)) t = n;
    } else if (k === 'v1') {
      v1.push(v);
    }
  }
  return { t, v1 };
}

function hexEqualsAny(expectedHex: string, candidates: string[]): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  for (const c of candidates) {
    let cand: Buffer;
    try {
      cand = Buffer.from(c, 'hex');
    } catch {
      continue;
    }
    if (cand.length === expected.length && timingSafeEqual(cand, expected)) return true;
  }
  return false;
}

export function verifyStripeSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  webhookSecret: string,
  opts: { toleranceSeconds?: number; nowMs?: number } = {},
): StripeEvent | null {
  if (!signatureHeader) return null;
  const { t, v1 } = parseSignatureHeader(signatureHeader);
  if (t === null || v1.length === 0) return null;

  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (tolerance > 0 && Math.abs(nowSec - t) > tolerance) return null;

  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const signedPayload = Buffer.concat([Buffer.from(`${t}.`, 'utf8'), raw]);
  const expected = createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');
  if (!hexEqualsAny(expected, v1)) return null;

  try {
    const parsed = JSON.parse(raw.toString('utf8')) as StripeEvent;
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.type !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// The header value a sender computes for a raw payload — used by the real proxy is NOT needed, but the
// tests (and any first-party signing) use it to prove the raw-bytes → verify → upsert path end to end.
export function computeStripeSignatureHeader(
  rawBody: Buffer | string,
  webhookSecret: string,
  atSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const signedPayload = Buffer.concat([Buffer.from(`${atSeconds}.`, 'utf8'), raw]);
  const sig = createHmac('sha256', webhookSecret).update(signedPayload).digest('hex');
  return `t=${atSeconds},v1=${sig}`;
}

// --- the real HTTP client -----------------------------------------------------------------------------
async function stripePost(
  secretKey: string,
  path: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = (json.error as { message?: string; code?: string } | undefined) ?? undefined;
    throw new Error(`stripe ${path} failed: ${res.status}${err?.message ? ` ${err.message}` : ''}`);
  }
  return json;
}

function normalizeSubscription(obj: Record<string, unknown>): StripeSubscription {
  const items = (obj.items as { data?: Array<{ price?: { id?: string; currency?: string } }> } | undefined)?.data ?? [];
  const price = items[0]?.price;
  const customer = obj.customer;
  return {
    id: String(obj.id),
    status: String(obj.status ?? ''),
    current_period_end: typeof obj.current_period_end === 'number' ? obj.current_period_end : null,
    cancel_at_period_end: Boolean(obj.cancel_at_period_end),
    trial_end: typeof obj.trial_end === 'number' ? obj.trial_end : null,
    customer_id: typeof customer === 'string' ? customer : (customer as { id?: string } | null)?.id ?? null,
    price_id: price?.id ?? null,
    currency: price?.currency ?? (typeof obj.currency === 'string' ? obj.currency : null),
    metadata: (obj.metadata as Record<string, string> | undefined) ?? {},
  };
}

export const httpStripeClient: StripeClient = {
  async createCustomer({ secretKey, email, metadata }) {
    const form: Record<string, string> = {};
    if (email) form.email = email;
    for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
    const obj = await stripePost(secretKey, '/customers', form);
    return { id: String(obj.id) };
  },

  async createCheckoutSession(input) {
    const form: Record<string, string> = {
      mode: 'subscription',
      'line_items[0][price]': input.priceId,
      'line_items[0][quantity]': '1',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.clientReferenceId,
      'automatic_tax[enabled]': input.taxEnabled ? 'true' : 'false',
      'tax_id_collection[enabled]': 'true',
    };
    if (input.customerId) {
      form.customer = input.customerId;
      // customer_update is only valid when a customer is attached.
      form['customer_update[address]'] = 'auto';
      form['customer_update[name]'] = 'auto';
    } else if (input.customerEmail) {
      form.customer_email = input.customerEmail;
    }
    for (const [k, v] of Object.entries(input.metadata)) {
      form[`metadata[${k}]`] = v;
      form[`subscription_data[metadata][${k}]`] = v; // stamp the subscription so re-fetch carries it
    }
    const obj = await stripePost(input.secretKey, '/checkout/sessions', form);
    return { id: String(obj.id), url: String(obj.url) };
  },

  async createPortalSession({ secretKey, customerId, returnUrl }) {
    const obj = await stripePost(secretKey, '/billing_portal/sessions', {
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: String(obj.url) };
  },

  async retrieveSubscription(secretKey, subscriptionId) {
    const res = await fetch(`${STRIPE_API_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (json.error as { message?: string } | undefined) ?? undefined;
      throw new Error(`stripe retrieve subscription failed: ${res.status}${err?.message ? ` ${err.message}` : ''}`);
    }
    return normalizeSubscription(json);
  },
};

// --- installable client (swappable for tests) ---------------------------------------------------------
let client: StripeClient = httpStripeClient;
export function getStripeClient(): StripeClient {
  return client;
}
export function setStripeClient(c: StripeClient): void {
  client = c;
}
export function resetStripeClient(): void {
  client = httpStripeClient;
}

export { normalizeSubscription };
