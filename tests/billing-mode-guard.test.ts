import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { registerBillingRoutes } from '../src/api/billing-routes';
import { setSecret } from '../src/plugins/secrets-local/index';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';
import {
  setStripeClient,
  resetStripeClient,
  type StripeClient,
  type StripeSubscription,
} from '../src/plugins/stripe-billing/index';
import {
  checkStripeModeConsistency,
  keyModeFromSecretKey,
  firstCatalogPriceId,
  type CatalogLike,
} from '../src/billing/mode-guard';
import type { PlanDef } from '../src/billing/types';

// C33 — Stripe mode-consistency guard tests. No real Stripe network calls.
// The stub Stripe client returns predictable livemode values based on a price registry.

const APP = 'demo';
const APP_ID = 'app_demo';
const SERVICE_TOKEN = 'svc-mode-guard-test';

let dir: string;
let prevDir: string | undefined;
let prevKey: string | undefined;
let server: FastifyInstance;

// --- stub Stripe client with a price registry ----------------------------------------
// Maps priceId → livemode. Set per-test.
const priceRegistry = new Map<string, boolean>();
let priceRetrieveCalls: Array<{ secretKey: string; priceId: string }>;

const stubStripe: StripeClient = {
  createCustomer: async () => ({ id: 'cus_stub' }),
  createCheckoutSession: async () => ({ id: 'cs_stub', url: 'https://stub' }),
  createPortalSession: async () => ({ url: 'https://portal.stub' }),
  createTrialingSubscription: async () =>
    ({
      id: 'sub_stub',
      status: 'trialing',
      current_period_end: null,
      cancel_at_period_end: false,
      trial_end: null,
      customer_id: 'cus_stub',
      price_id: null,
      currency: null,
      metadata: {},
    }) as StripeSubscription,
  resumeSubscription: async () => ({ resumed: false, subscription: null }),
  retrieveSubscription: async () => null,
  cancelSubscription: async () => ({ canceled: false }),
  deleteCustomer: async () => ({ deleted: false }),
  retrievePrice: async (secretKey, priceId) => {
    priceRetrieveCalls.push({ secretKey, priceId });
    if (!priceRegistry.has(priceId)) return null;
    return { id: priceId, livemode: priceRegistry.get(priceId)! };
  },
};

// --- catalog builders ---------------------------------------------------------------
function makeCatalog(plans: Partial<PlanDef>[]): CatalogLike {
  return {
    plans: plans.map((p, i) => ({
      plan_key: p.plan_key ?? `plan_${i}`,
      display: { name: p.display?.name ?? `Plan ${i}` },
      interval: p.interval ?? 'month',
      prices: p.prices ?? {
        stripe: { price_id: null, currency: null },
        apple: { product_id: null },
        google: { product_id: null },
      },
      entitlements: p.entitlements ?? {},
      is_default: p.is_default ?? i === 0,
    })) as PlanDef[],
  };
}

const CATALOG_WITH_TEST_PRICE = makeCatalog([
  { plan_key: 'free', is_default: true },
  {
    plan_key: 'pro',
    prices: { stripe: { price_id: 'price_test_123', currency: 'usd' }, apple: { product_id: null }, google: { product_id: null } },
    is_default: false,
  },
]);

const CATALOG_WITH_LIVE_PRICE = makeCatalog([
  { plan_key: 'free', is_default: true },
  {
    plan_key: 'pro',
    prices: { stripe: { price_id: 'price_live_123', currency: 'usd' }, apple: { product_id: null }, google: { product_id: null } },
    is_default: false,
  },
]);

const CATALOG_NO_PRICES = makeCatalog([{ plan_key: 'free', is_default: true }]);

// --- test helpers -------------------------------------------------------------------
const seedApp = async (): Promise<void> => {
  const now = nowIso();
  await store.saveResource({
    id: APP_ID,
    type: 'Application',
    app_id: APP_ID,
    created_at: now,
    updated_at: now,
    name: APP,
    repo_path: '/app',
    platform: 'web',
    framework: 'nextjs',
    template: 'nextjs-web',
    language: 'typescript',
    package_manager: 'npm',
  } as Application);
};

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevKey = process.env.FORGE_SECRETS_KEY;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-mode-guard-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_SECRETS_KEY = 'mode-guard-test-master-key';
  await store.init();
  await seedApp();

  // Configure auth service token so PUT /billing/catalog is allowed in tests
  await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', SERVICE_TOKEN);

  priceRegistry.clear();
  priceRetrieveCalls = [];
  setStripeClient(stubStripe);

  server = Fastify({ logger: false });
  registerBillingRoutes(server, { defaultApp: () => APP });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  resetStripeClient();
  if (prevDir !== undefined) process.env.FORGE_STATE_DIR = prevDir;
  else delete process.env.FORGE_STATE_DIR;
  if (prevKey !== undefined) process.env.FORGE_SECRETS_KEY = prevKey;
  else delete process.env.FORGE_SECRETS_KEY;
  await rm(dir, { recursive: true, force: true });
});

// ===================================================================================
// Unit: pure helper functions
// ===================================================================================

describe('keyModeFromSecretKey', () => {
  it('returns live for sk_live_ prefix', () => {
    expect(keyModeFromSecretKey('sk_live_abc123')).toBe('live');
  });
  it('returns test for sk_test_ prefix', () => {
    expect(keyModeFromSecretKey('sk_test_abc123')).toBe('test');
  });
  it('returns test for any other prefix', () => {
    expect(keyModeFromSecretKey('sk_something_else')).toBe('test');
  });
  it('returns test for empty string', () => {
    expect(keyModeFromSecretKey('')).toBe('test');
  });
});

describe('firstCatalogPriceId', () => {
  it('returns null for null catalog', () => {
    expect(firstCatalogPriceId(null)).toBeNull();
  });
  it('returns null when no plans have a stripe price_id', () => {
    expect(firstCatalogPriceId(CATALOG_NO_PRICES)).toBeNull();
  });
  it('returns the first non-null stripe price_id', () => {
    expect(firstCatalogPriceId(CATALOG_WITH_TEST_PRICE)).toBe('price_test_123');
  });
  it('skips plans with null price_id and returns first non-null', () => {
    // free plan has price_id: null, pro has price_test_123 → returns pro's
    expect(firstCatalogPriceId(CATALOG_WITH_TEST_PRICE)).toBe('price_test_123');
  });
});

// ===================================================================================
// Unit: checkStripeModeConsistency
// ===================================================================================

describe('checkStripeModeConsistency', () => {
  it('returns configured:false, ok:true when billing is not configured', async () => {
    // No STRIPE_SECRET_KEY set
    const result = await checkStripeModeConsistency(APP_ID, CATALOG_WITH_TEST_PRICE);
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('returns ok:true when no price IDs in catalog', async () => {
    await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_test_x');
    const result = await checkStripeModeConsistency(APP_ID, CATALOG_NO_PRICES);
    expect(result.configured).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.keyMode).toBe('test');
    expect(result.detail).toMatch(/no stripe price/i);
  });

  it('returns ok:true when key is test and price is test (modes match)', async () => {
    await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_test_abc123');
    priceRegistry.set('price_test_123', false); // livemode: false = test
    const result = await checkStripeModeConsistency(APP_ID, CATALOG_WITH_TEST_PRICE);
    expect(result.configured).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.keyMode).toBe('test');
    expect(result.priceMode).toBe('test');
    expect(result.priceId).toBe('price_test_123');
  });

  it('returns ok:true when key is live and price is live (modes match)', async () => {
    await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_live_abc123');
    priceRegistry.set('price_live_123', true); // livemode: true
    const result = await checkStripeModeConsistency(APP_ID, CATALOG_WITH_LIVE_PRICE);
    expect(result.configured).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.keyMode).toBe('live');
    expect(result.priceMode).toBe('live');
    expect(result.priceId).toBe('price_live_123');
  });

  it('returns ok:false with detail when live key is paired with test price', async () => {
    await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_live_abc123');
    priceRegistry.set('price_test_123', false); // livemode: false = test
    const result = await checkStripeModeConsistency(APP_ID, CATALOG_WITH_TEST_PRICE);
    expect(result.configured).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.keyMode).toBe('live');
    expect(result.priceMode).toBe('test');
    expect(result.priceId).toBe('price_test_123');
    expect(result.detail).toMatch(/live/);
    expect(result.detail).toMatch(/test/);
    expect(result.detail).toMatch(/price_test_123/);
    expect(result.detail).toMatch(/sk_live_/);
  });

  it('returns ok:false with detail when test key is paired with live price', async () => {
    await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_test_abc123');
    priceRegistry.set('price_live_123', true); // livemode: true
    const result = await checkStripeModeConsistency(APP_ID, CATALOG_WITH_LIVE_PRICE);
    expect(result.configured).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.keyMode).toBe('test');
    expect(result.priceMode).toBe('live');
    expect(result.priceId).toBe('price_live_123');
    expect(result.detail).toMatch(/test/);
    expect(result.detail).toMatch(/live/);
    expect(result.detail).toMatch(/price_live_123/);
  });

  it('returns ok:false when price is not found in Stripe', async () => {
    await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_test_abc123');
    // price_test_123 NOT in priceRegistry → retrievePrice returns null
    const result = await checkStripeModeConsistency(APP_ID, CATALOG_WITH_TEST_PRICE);
    expect(result.configured).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/not found/i);
    expect(result.detail).toMatch(/price_test_123/);
  });

  it('calls retrievePrice with the correct secretKey and priceId', async () => {
    await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_test_mykey');
    priceRegistry.set('price_test_123', false);
    await checkStripeModeConsistency(APP_ID, CATALOG_WITH_TEST_PRICE);
    expect(priceRetrieveCalls).toHaveLength(1);
    expect(priceRetrieveCalls[0]!.secretKey).toBe('sk_test_mykey');
    expect(priceRetrieveCalls[0]!.priceId).toBe('price_test_123');
  });

  it('only retrieves one price even when multiple plans have price IDs', async () => {
    await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_test_abc');
    const multiPriceCatalog = makeCatalog([
      { plan_key: 'free', is_default: true },
      {
        plan_key: 'month',
        prices: { stripe: { price_id: 'price_a', currency: 'usd' }, apple: { product_id: null }, google: { product_id: null } },
        is_default: false,
      },
      {
        plan_key: 'year',
        prices: { stripe: { price_id: 'price_b', currency: 'usd' }, apple: { product_id: null }, google: { product_id: null } },
        is_default: false,
      },
    ]);
    priceRegistry.set('price_a', false); // test mode
    await checkStripeModeConsistency(APP_ID, multiPriceCatalog);
    // Only one retrievePrice call — the guard fetches exactly one price.
    expect(priceRetrieveCalls).toHaveLength(1);
    expect(priceRetrieveCalls[0]!.priceId).toBe('price_a');
  });
});

// ===================================================================================
// HTTP: GET /billing/mode-check
// ===================================================================================

describe('GET /billing/mode-check', () => {
  it('returns configured:false, ok:true when billing is not configured', async () => {
    const res = await server.inject({ method: 'GET', url: '/billing/mode-check' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { configured: boolean; ok: boolean };
    expect(body.configured).toBe(false);
    expect(body.ok).toBe(true);
  });

  it('returns ok:true when key mode matches price mode (both test)', async () => {
    await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_test_x');
    priceRegistry.set('price_test_123', false);
    // Seed the catalog via the API
    await server.inject({
      method: 'PUT',
      url: '/billing/catalog',
      headers: { 'x-forge-service-token': SERVICE_TOKEN },
      payload: {
        plans: [
          {
            plan_key: 'free',
            display: { name: 'Free' },
            interval: 'month',
            prices: { stripe: { price_id: null, currency: null }, apple: { product_id: null }, google: { product_id: null } },
            entitlements: {},
            is_default: true,
          },
          {
            plan_key: 'pro',
            display: { name: 'Pro' },
            interval: 'month',
            prices: { stripe: { price_id: 'price_test_123', currency: 'usd' }, apple: { product_id: null }, google: { product_id: null } },
            entitlements: {},
            is_default: false,
          },
        ],
      },
    });
    const res = await server.inject({ method: 'GET', url: '/billing/mode-check' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { configured: boolean; ok: boolean; keyMode: string; priceMode: string };
    expect(body.configured).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.keyMode).toBe('test');
    expect(body.priceMode).toBe('test');
  });

  it('returns ok:false and detail when live key is paired with test price', async () => {
    await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_live_x');
    priceRegistry.set('price_test_123', false); // test mode price
    await server.inject({
      method: 'PUT',
      url: '/billing/catalog',
      headers: { 'x-forge-service-token': SERVICE_TOKEN },
      payload: {
        plans: [
          {
            plan_key: 'free',
            display: { name: 'Free' },
            interval: 'month',
            prices: { stripe: { price_id: null, currency: null }, apple: { product_id: null }, google: { product_id: null } },
            entitlements: {},
            is_default: true,
          },
          {
            plan_key: 'pro',
            display: { name: 'Pro' },
            interval: 'month',
            prices: { stripe: { price_id: 'price_test_123', currency: 'usd' }, apple: { product_id: null }, google: { product_id: null } },
            entitlements: {},
            is_default: false,
          },
        ],
      },
    });
    const res = await server.inject({ method: 'GET', url: '/billing/mode-check' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { configured: boolean; ok: boolean; keyMode: string; priceMode: string; detail: string };
    expect(body.configured).toBe(true);
    expect(body.ok).toBe(false);
    expect(body.keyMode).toBe('live');
    expect(body.priceMode).toBe('test');
    expect(body.detail).toMatch(/mismatch/i);
    expect(body.detail).toMatch(/live/);
    expect(body.detail).toMatch(/test/);
  });
});

// ===================================================================================
// HTTP: GET /billing/catalog — includes tax_enabled
// ===================================================================================

describe('GET /billing/catalog tax_enabled field', () => {
  it('includes tax_enabled:true (default) when STRIPE_TAX_ENABLED is not set', async () => {
    const savedVal = process.env.STRIPE_TAX_ENABLED;
    delete process.env.STRIPE_TAX_ENABLED;
    await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_test_x');
    const res = await server.inject({ method: 'GET', url: '/billing/catalog' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { tax_enabled: boolean; configured: boolean };
    expect(body.tax_enabled).toBe(true);
    expect(body.configured).toBe(true);
    if (savedVal !== undefined) process.env.STRIPE_TAX_ENABLED = savedVal;
  });

  it('includes tax_enabled:false when STRIPE_TAX_ENABLED=false', async () => {
    await setSecret(APP_ID, 'STRIPE_TAX_ENABLED', 'false');
    const res = await server.inject({ method: 'GET', url: '/billing/catalog' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { tax_enabled: boolean };
    expect(body.tax_enabled).toBe(false);
  });

  it('includes tax_enabled:false when STRIPE_TAX_ENABLED=0', async () => {
    await setSecret(APP_ID, 'STRIPE_TAX_ENABLED', '0');
    const res = await server.inject({ method: 'GET', url: '/billing/catalog' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { tax_enabled: boolean };
    expect(body.tax_enabled).toBe(false);
  });

  it('includes tax_enabled:true when STRIPE_TAX_ENABLED=true', async () => {
    await setSecret(APP_ID, 'STRIPE_TAX_ENABLED', 'true');
    const res = await server.inject({ method: 'GET', url: '/billing/catalog' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { tax_enabled: boolean };
    expect(body.tax_enabled).toBe(true);
  });
});
