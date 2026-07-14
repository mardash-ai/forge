import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { getBackends } from '../src/storage/backends';
import { registerBillingRoutes } from '../src/api/billing-routes';
import { setSecret } from '../src/plugins/secrets-local/index';
import * as authStore from '../src/plugins/auth-identity/store';
import { signSessionToken } from '../src/shared/session';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';
import {
  setStripeClient,
  resetStripeClient,
  mapStripeStatus,
  computeStripeSignatureHeader,
  verifyStripeSignature,
  type StripeClient,
  type StripeSubscription,
} from '../src/plugins/stripe-billing/index';
import { deriveEntitlements, deriveEntitlement } from '../src/billing/entitlements';
import { applyCanonicalSubscription } from '../src/billing/service';
import { noneRecord, emptyProviderRefs, type Catalog, type SubscriptionRecord } from '../src/billing/types';

// C33 — billing / subscriptions / entitlements. Driven through the configured `billing` store backend
// (filesystem default / Postgres on the pg run) with an in-memory STUB Stripe client — so checkout, portal,
// the subscription-of-record reconciliation (webhook verify → re-fetch → upsert), entitlement derivation,
// catalog validation, and graceful degradation are all validated on BOTH backends WITHOUT a network call.
const APP = 'demo';
const APP_ID = 'app_demo';
const SESSION_SECRET = 'billing-test-session-secret';
const SERVICE_TOKEN = 'svc-billing-123';
const WEBHOOK_SECRET = 'whsec_test_secret';

let dir: string;
let prevDir: string | undefined;
let prevKey: string | undefined;
let server: FastifyInstance;

// --- mutable stub Stripe client -------------------------------------------------
let customers: number;
let checkoutInputs: Array<Record<string, unknown>>;
let portalInputs: Array<Record<string, unknown>>;
// The canonical subscription the stub returns from retrieveSubscription, keyed by id (default fallback).
let subs: Map<string, StripeSubscription | null>;
let defaultSub: StripeSubscription | null;

const stubStripe: StripeClient = {
  createCustomer: async () => {
    customers += 1;
    return { id: `cus_test_${customers}` };
  },
  createCheckoutSession: async (input) => {
    checkoutInputs.push(input as unknown as Record<string, unknown>);
    return { id: 'cs_test_1', url: 'https://checkout.stripe.test/session/cs_test_1' };
  },
  createPortalSession: async (input) => {
    portalInputs.push(input as unknown as Record<string, unknown>);
    return { url: 'https://portal.stripe.test/p/1' };
  },
  retrieveSubscription: async (_secretKey, subscriptionId) => {
    if (subs.has(subscriptionId)) return subs.get(subscriptionId)!;
    return defaultSub;
  },
  cancelSubscription: async () => ({ canceled: true }),
  deleteCustomer: async () => ({ deleted: true }),
};

function stripeSub(overrides: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: 'sub_123',
    status: 'active',
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    cancel_at_period_end: false,
    trial_end: null,
    customer_id: 'cus_test_1',
    price_id: 'price_pro_month',
    currency: 'usd',
    metadata: { subscriber: '', app: APP_ID, plan_key: 'pro_month' },
    ...overrides,
  };
}

const CATALOG_PLANS = [
  {
    plan_key: 'free',
    display: { name: 'Free', order: 0 },
    interval: 'month',
    prices: { stripe: { price_id: null, currency: null }, apple: { product_id: null }, google: { product_id: null } },
    entitlements: { 'feature.max_items': 10, 'feature.household': false },
    is_default: true,
  },
  {
    plan_key: 'pro_month',
    display: { name: 'Pro (monthly)', order: 1 },
    interval: 'month',
    prices: { stripe: { price_id: 'price_pro_month', currency: 'usd' }, apple: { product_id: null }, google: { product_id: null } },
    entitlements: { 'feature.max_items': 1000, 'feature.household': true },
    is_default: false,
  },
  {
    plan_key: 'pro_year',
    display: { name: 'Pro (yearly)', order: 2 },
    interval: 'year',
    prices: { stripe: { price_id: 'price_pro_year', currency: 'usd' }, apple: { product_id: null }, google: { product_id: null } },
    entitlements: { 'feature.max_items': 1000, 'feature.household': true },
    is_default: false,
  },
  {
    plan_key: 'enterprise',
    display: { name: 'Enterprise' },
    interval: 'month',
    // Catalog-valid but NOT purchasable — no stripe price id yet.
    prices: { stripe: { price_id: null, currency: null }, apple: { product_id: null }, google: { product_id: null } },
    entitlements: { 'feature.max_items': 100000, 'feature.household': true },
    is_default: false,
  },
];

const seedApp = async (): Promise<void> => {
  const now = nowIso();
  await store.saveResource({
    id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
    name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web', language: 'typescript', package_manager: 'npm',
  } as Application);
};

const signIn = async (email = 'payer@demo.test'): Promise<{ userId: string; cookie: string }> => {
  const user = await authStore.createUser(APP_ID, { email, email_verified: true });
  const session = await authStore.createSession(APP_ID, user.id, 3600);
  const token = signSessionToken({ userId: user.id, email: user.email, sessionId: session.id }, SESSION_SECRET);
  return { userId: user.id, cookie: `forge_session=${token}` };
};

const configureStripe = async (): Promise<void> => {
  await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_test_x');
  await setSecret(APP_ID, 'STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
};

const seedCatalog = async (): Promise<void> => {
  const res = await server.inject({
    method: 'PUT', url: '/billing/catalog',
    headers: { 'x-forge-service-token': SERVICE_TOKEN },
    payload: { plans: CATALOG_PLANS },
  });
  expect(res.statusCode).toBe(200);
};

// Deliver a signed Stripe webhook event to the sidecar (RAW bytes + a real signature header).
async function deliverEvent(event: Record<string, unknown>, opts: { secret?: string; badSig?: boolean } = {}) {
  const raw = JSON.stringify(event);
  const header = opts.badSig
    ? `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`
    : computeStripeSignatureHeader(raw, opts.secret ?? WEBHOOK_SECRET);
  return server.inject({
    method: 'POST', url: '/hooks/billing/stripe',
    headers: { 'content-type': 'application/json', 'stripe-signature': header },
    payload: raw,
  });
}

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevKey = process.env.FORGE_SECRETS_KEY;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-billing-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_SECRETS_KEY = 'billing-test-master-key';
  await store.init();
  await seedApp();
  await setSecret(APP_ID, 'AUTH_SESSION_SECRET', SESSION_SECRET);
  await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', SERVICE_TOKEN);

  customers = 0;
  checkoutInputs = [];
  portalInputs = [];
  subs = new Map();
  defaultSub = stripeSub();
  setStripeClient(stubStripe);

  server = Fastify({ logger: false });
  registerBillingRoutes(server, { defaultApp: () => APP });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  resetStripeClient();
  await (await getBackends()).billing.__truncateAllForTests?.();
  if (prevDir === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prevDir;
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY; else process.env.FORGE_SECRETS_KEY = prevKey;
  await rm(dir, { recursive: true, force: true });
});

// ===================================================================================================
describe('C33 — Stripe → canonical status mapping', () => {
  it('maps every native Stripe status into the canonical 6-state vocabulary', () => {
    expect(mapStripeStatus('active')).toBe('active');
    expect(mapStripeStatus('trialing')).toBe('trialing');
    expect(mapStripeStatus('past_due')).toBe('past_due');
    expect(mapStripeStatus('unpaid')).toBe('past_due');
    expect(mapStripeStatus('incomplete')).toBe('incomplete');
    expect(mapStripeStatus('incomplete_expired')).toBe('canceled');
    expect(mapStripeStatus('canceled')).toBe('canceled');
    expect(mapStripeStatus('paused')).toBe('canceled');
    expect(mapStripeStatus('something_new')).toBe('canceled'); // unknown → conservative terminal
  });
});

describe('C33 — entitlement derivation (grace + free default)', () => {
  const catalog: Catalog = { plans: CATALOG_PLANS as unknown as Catalog['plans'], updated_at: nowIso() };
  const base = (over: Partial<SubscriptionRecord>): SubscriptionRecord => ({
    ...noneRecord(APP_ID, 'u1', 'free', nowIso()),
    plan_key: 'pro_month', source: 'stripe',
    provider_refs: { ...emptyProviderRefs(), stripe_subscription_id: 'sub_1' },
    ...over,
  });
  const future = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();

  it('active/trialing → the active plan map', () => {
    for (const status of ['active', 'trialing'] as const) {
      const d = deriveEntitlements(base({ status }), catalog);
      expect(d.plan_key).toBe('pro_month');
      expect(d.entitlements['feature.max_items']).toBe(1000);
      expect(d.entitlements['feature.household']).toBe(true);
    }
  });

  it('past_due/incomplete WITHIN current_period_end → GRACE keeps the paid entitlements', () => {
    for (const status of ['past_due', 'incomplete'] as const) {
      const d = deriveEntitlements(base({ status, current_period_end: future }), catalog);
      expect(d.plan_key).toBe('pro_month');
      expect(d.entitlements['feature.max_items']).toBe(1000);
    }
  });

  it('past_due/incomplete PAST current_period_end → falls to the free default', () => {
    for (const status of ['past_due', 'incomplete'] as const) {
      const d = deriveEntitlements(base({ status, current_period_end: past }), catalog);
      expect(d.plan_key).toBe('free');
      expect(d.entitlements['feature.max_items']).toBe(10);
      expect(d.entitlements['feature.household']).toBe(false);
    }
  });

  it('canceled/none → the free default plan map', () => {
    for (const status of ['canceled', 'none'] as const) {
      const d = deriveEntitlements(base({ status }), catalog);
      expect(d.plan_key).toBe('free');
      expect(d.entitlements['feature.max_items']).toBe(10);
    }
  });

  it('single-key read reports source plan vs default + a null value for an unknown key', () => {
    const paid = deriveEntitlement(base({ status: 'active' }), catalog, 'feature.max_items');
    expect(paid).toMatchObject({ key: 'feature.max_items', value: 1000, source: 'plan', plan_key: 'pro_month' });
    const free = deriveEntitlement(base({ status: 'canceled' }), catalog, 'feature.max_items');
    expect(free).toMatchObject({ value: 10, source: 'default', plan_key: 'free' });
    const unknown = deriveEntitlement(base({ status: 'active' }), catalog, 'feature.nope');
    expect(unknown).toMatchObject({ value: null, source: 'plan' });
  });

  it('empty catalog → no entitlements, plan_key null', () => {
    const d = deriveEntitlements(base({ status: 'active' }), null);
    expect(d.plan_key).toBeNull();
    expect(d.entitlements).toEqual({});
  });
});

describe('C33 — catalog validation', () => {
  it('accepts a valid catalog (idempotent replace) and reads it back', async () => {
    await seedCatalog();
    const res = await server.inject({ method: 'GET', url: '/billing/catalog' });
    expect(res.statusCode).toBe(200);
    expect(res.json().plans).toHaveLength(4);
    // Replace is idempotent — PUT again is fine.
    await seedCatalog();
    expect((await server.inject({ method: 'GET', url: '/billing/catalog' })).json().plans).toHaveLength(4);
  });

  it('rejects a catalog without exactly one is_default plan (422)', async () => {
    const twoDefaults = CATALOG_PLANS.map((p) => ({ ...p, is_default: true }));
    const res = await server.inject({ method: 'PUT', url: '/billing/catalog', headers: { 'x-forge-service-token': SERVICE_TOKEN }, payload: { plans: twoDefaults } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_catalog');
  });

  it('rejects duplicate plan_keys (422)', async () => {
    const dup = [CATALOG_PLANS[0], { ...CATALOG_PLANS[1], plan_key: 'free' }];
    const res = await server.inject({ method: 'PUT', url: '/billing/catalog', headers: { 'x-forge-service-token': SERVICE_TOKEN }, payload: { plans: dup } });
    expect(res.statusCode).toBe(422);
  });

  it('catalog WRITE requires the service token (a browser cannot rewrite pricing)', async () => {
    const res = await server.inject({ method: 'PUT', url: '/billing/catalog', payload: { plans: CATALOG_PLANS } });
    expect(res.statusCode).toBe(401);
  });
});

describe('C33 — graceful degradation when unconfigured', () => {
  it('a subscription READ still returns 200 `none` (never 404) with no Stripe configured', async () => {
    const { userId, cookie } = await signIn();
    const res = await server.inject({ method: 'GET', url: '/billing/subscription', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ subscriber: userId, status: 'none', source: null });
    expect(res.json().provider_refs.stripe_customer_id).toBeNull();
  });

  it('checkout degrades to 503 billing_not_configured (never a crash)', async () => {
    await seedCatalog();
    const { cookie } = await signIn();
    const res = await server.inject({ method: 'POST', url: '/billing/checkout', headers: { cookie }, payload: { plan_key: 'pro_month', success_url: 'https://app/s', cancel_url: 'https://app/c' } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('billing_not_configured');
  });

  it('an unconfigured webhook (no signing secret) is a 200 no-op, not a crash', async () => {
    // Stripe key set but no webhook secret → cannot trust payloads → no-op.
    await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_test_x');
    const res = await deliverEvent({ id: 'evt_x', type: 'customer.subscription.updated', data: { object: { id: 'sub_123' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('not_configured');
  });
});

describe('C33 — checkout + portal (Stripe web ops)', () => {
  it('checkout resolves the plan → price, creates+remembers a customer, returns a hosted url', async () => {
    await configureStripe();
    await seedCatalog();
    const { userId, cookie } = await signIn();
    const res = await server.inject({ method: 'POST', url: '/billing/checkout', headers: { cookie }, payload: { plan_key: 'pro_month', success_url: 'https://app/s', cancel_url: 'https://app/c', scope_ref: 'household:42' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ url: 'https://checkout.stripe.test/session/cs_test_1', session_id: 'cs_test_1' });
    // Stripe Tax on, correct price, subscriber as client_reference_id + metadata.
    expect(checkoutInputs[0]).toMatchObject({ priceId: 'price_pro_month', taxEnabled: true, clientReferenceId: userId });
    expect((checkoutInputs[0]!.metadata as Record<string, string>).scope_ref).toBe('household:42');
    // The customer was created + REMEMBERED (echo-only scope_ref stored) so the portal works before any webhook.
    const rec = await (await getBackends()).billing.read(APP_ID);
    expect(rec.subscriptions[userId]!.provider_refs.stripe_customer_id).toBe('cus_test_1');
    expect(rec.subscriptions[userId]!.scope_ref).toBe('household:42');
    // A second checkout REUSES the customer (no new create).
    await server.inject({ method: 'POST', url: '/billing/checkout', headers: { cookie }, payload: { plan_key: 'pro_year', success_url: 'https://app/s', cancel_url: 'https://app/c' } });
    expect(customers).toBe(1);
    expect(checkoutInputs[1]).toMatchObject({ customerId: 'cus_test_1', priceId: 'price_pro_year' });
  });

  it('checkout on an unknown plan → 422 unknown_plan', async () => {
    await configureStripe();
    await seedCatalog();
    const { cookie } = await signIn();
    const res = await server.inject({ method: 'POST', url: '/billing/checkout', headers: { cookie }, payload: { plan_key: 'nope', success_url: 'https://app/s', cancel_url: 'https://app/c' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('unknown_plan');
  });

  it('checkout on a plan with no stripe price → 422 price_unconfigured', async () => {
    await configureStripe();
    await seedCatalog();
    const { cookie } = await signIn();
    const res = await server.inject({ method: 'POST', url: '/billing/checkout', headers: { cookie }, payload: { plan_key: 'enterprise', success_url: 'https://app/s', cancel_url: 'https://app/c' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('price_unconfigured');
  });

  it('portal for a subscriber with no customer yet → 404 not_a_customer', async () => {
    await configureStripe();
    const { cookie } = await signIn();
    const res = await server.inject({ method: 'POST', url: '/billing/portal', headers: { cookie }, payload: { return_url: 'https://app/account' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_a_customer');
  });

  it('portal returns a hosted url once the subscriber is a customer', async () => {
    await configureStripe();
    await seedCatalog();
    const { cookie } = await signIn();
    await server.inject({ method: 'POST', url: '/billing/checkout', headers: { cookie }, payload: { plan_key: 'pro_month', success_url: 'https://app/s', cancel_url: 'https://app/c' } });
    const res = await server.inject({ method: 'POST', url: '/billing/portal', headers: { cookie }, payload: { return_url: 'https://app/account' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe('https://portal.stripe.test/p/1');
  });
});

describe('C33 — owner/subscriber trust model', () => {
  it('a session user may only read their OWN subscription (403 on a mismatched subscriber)', async () => {
    const { cookie } = await signIn();
    const res = await server.inject({ method: 'GET', url: '/billing/subscription?subscriber=someone_else', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('an unauthenticated read is refused (subscriber is never trusted from an anonymous client)', async () => {
    const res = await server.inject({ method: 'GET', url: '/billing/subscription?subscriber=anyone' });
    expect(res.statusCode).toBe(401);
  });

  it('a SERVICE-token read may act for a passed subscriber (background check)', async () => {
    const res = await server.inject({ method: 'GET', url: '/billing/subscription?subscriber=user_bg', headers: { 'x-forge-service-token': SERVICE_TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ subscriber: 'user_bg', status: 'none' });
  });
});

describe('C33 — webhook: signature verify + idempotent + out-of-order convergence', () => {
  it('verifyStripeSignature accepts a correct signature and rejects tampering/stale', () => {
    const raw = JSON.stringify({ id: 'evt_1', type: 'x', data: { object: {} } });
    const header = computeStripeSignatureHeader(raw, WEBHOOK_SECRET);
    expect(verifyStripeSignature(raw, header, WEBHOOK_SECRET)?.id).toBe('evt_1');
    expect(verifyStripeSignature(raw + ' ', header, WEBHOOK_SECRET)).toBeNull(); // body tampered
    expect(verifyStripeSignature(raw, header, 'wrong_secret')).toBeNull(); // wrong secret
    const stale = computeStripeSignatureHeader(raw, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 10_000);
    expect(verifyStripeSignature(raw, stale, WEBHOOK_SECRET)).toBeNull(); // outside tolerance
  });

  it('a signed webhook re-fetches canonical Stripe + UPSERTS the subscription-of-record', async () => {
    await configureStripe();
    await seedCatalog();
    const { userId, cookie } = await signIn();
    defaultSub = stripeSub({ metadata: { subscriber: userId, app: APP_ID, plan_key: 'pro_month' } });

    const res = await deliverEvent({ id: 'evt_100', type: 'customer.subscription.updated', data: { object: { id: 'sub_123' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('processed');

    // The canonical record now reads active/pro with the Stripe handles filled + the entitlements derived.
    const sub = await server.inject({ method: 'GET', url: '/billing/subscription', headers: { cookie } });
    expect(sub.json()).toMatchObject({ subscriber: userId, status: 'active', source: 'stripe', plan_key: 'pro_month', currency: 'usd', cancel_at_period_end: false });
    expect(sub.json().provider_refs).toMatchObject({ stripe_subscription_id: 'sub_123', stripe_price_id: 'price_pro_month', stripe_customer_id: 'cus_test_1' });
    const ent = await server.inject({ method: 'GET', url: '/billing/entitlements', headers: { cookie } });
    expect(ent.json()).toMatchObject({ status: 'active', plan_key: 'pro_month' });
    expect(ent.json().entitlements['feature.household']).toBe(true);
  });

  it('a BAD signature is a 400 signature_invalid and writes nothing', async () => {
    await configureStripe();
    const res = await deliverEvent({ id: 'evt_bad', type: 'customer.subscription.updated', data: { object: { id: 'sub_123' } } }, { badSig: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('signature_invalid');
    const state = await (await getBackends()).billing.read(APP_ID);
    expect(Object.keys(state.subscriptions)).toHaveLength(0);
    expect(Object.keys(state.webhook_events)).toHaveLength(0);
  });

  it('a duplicate event id is a 200 no-op (idempotent replay)', async () => {
    await configureStripe();
    const uid = 'user_dedupe';
    defaultSub = stripeSub({ metadata: { subscriber: uid, app: APP_ID, plan_key: 'pro_month' } });
    const evt = { id: 'evt_dupe', type: 'customer.subscription.updated', data: { object: { id: 'sub_123' } } };
    const first = await deliverEvent(evt);
    expect(first.json().outcome).toBe('processed');
    const replay = await deliverEvent(evt);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().outcome).toBe('duplicate');
  });

  it('unknown event types are ignored (200), never an error', async () => {
    await configureStripe();
    const res = await deliverEvent({ id: 'evt_unknown', type: 'charge.dispute.created', data: { object: {} } });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('ignored');
  });

  it('out-of-order convergence: whichever fetch is NEWER wins the monotonic-version guard', async () => {
    await configureStripe();
    const uid = 'user_ooo';
    // Two canonical snapshots for the same subscriber: an OLD (active) and a NEW (canceled) state.
    const fields = (status: SubscriptionRecord['status']) => ({
      subscriber: uid, app: APP_ID, plan_key: 'pro_month', status, source: 'stripe' as const,
      current_period_end: null, cancel_at_period_end: false, trial_end: null, currency: 'usd', scope_ref: null,
      provider_refs: { ...emptyProviderRefs(), stripe_subscription_id: 'sub_123' },
    });
    // Apply the NEWER snapshot first (higher version), then a STALE older snapshot (lower version).
    const newer = await applyCanonicalSubscription(APP_ID, fields('canceled'), 2000);
    expect(newer.applied).toBe(true);
    const stale = await applyCanonicalSubscription(APP_ID, fields('active'), 1000);
    expect(stale.applied).toBe(false); // the stale re-fetch is dropped
    // The store still holds the NEWER (canceled) state.
    const sub = await server.inject({ method: 'GET', url: '/billing/subscription?subscriber=user_ooo', headers: { 'x-forge-service-token': SERVICE_TOKEN } });
    expect(sub.json().status).toBe('canceled');
  });

  it('re-fetch convergence: two DIFFERENT events both re-fetch the CURRENT canonical state', async () => {
    await configureStripe();
    const uid = 'user_conv';
    // First event observes the sub as active…
    defaultSub = stripeSub({ status: 'active', metadata: { subscriber: uid, app: APP_ID, plan_key: 'pro_month' } });
    await deliverEvent({ id: 'evt_a', type: 'customer.subscription.created', data: { object: { id: 'sub_123' } } });
    // …then Stripe's truth becomes past_due; a later event re-fetches THAT (not whatever the event carried).
    defaultSub = stripeSub({ status: 'past_due', metadata: { subscriber: uid, app: APP_ID, plan_key: 'pro_month' } });
    await deliverEvent({ id: 'evt_b', type: 'invoice.payment_failed', data: { object: { subscription: 'sub_123' } } });
    const sub = await server.inject({ method: 'GET', url: '/billing/subscription?subscriber=user_conv', headers: { 'x-forge-service-token': SERVICE_TOKEN } });
    expect(sub.json().status).toBe('past_due');
  });
});

describe('C33 — reserved provider webhooks (adapters deferred)', () => {
  it('apple + google webhooks are reserved → 501 not_configured', async () => {
    for (const provider of ['apple', 'google']) {
      const res = await server.inject({ method: 'POST', url: `/hooks/billing/${provider}`, payload: { any: 'thing' } });
      expect(res.statusCode).toBe(501);
      expect(res.json().error.code).toBe('not_configured');
    }
  });
});
