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
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';
import {
  setStripeClient,
  resetStripeClient,
  computeStripeSignatureHeader,
  type StripeClient,
  type StripeSubscription,
} from '../src/plugins/stripe-billing/index';
import {
  billingTransitionNotification,
  billingDeepLink,
  BILLING_NOTIFY_CHANNELS,
} from '../src/billing/notify';
import { noneRecord, emptyProviderRefs, type SubscriptionRecord } from '../src/billing/types';

// C33 + C21 — billing state-change NOTIFICATIONS. Two layers under test:
//   1. the PURE transition → notification mapping (billingTransitionNotification) — owner/channels/title/
//      deep-link/idempotency, and the "only on a real state change" guard, without any I/O; and
//   2. the WIRING through the Stripe webhook — an active→past_due webhook lands an in_app notification
//      (owner-scoped, deep-linked to /billing), an unchanged-status webhook lands nothing, and a retry is
//      idempotent (no double-notify).

const APP = 'demo';
const APP_ID = 'app_demo';
const WEBHOOK_SECRET = 'whsec_test_secret';
const PUBLIC_BASE = 'https://app.demo.test';

// ============================ 1. pure transition → notification =====================================
describe('C33+C21 — billingTransitionNotification (pure mapping)', () => {
  const rec = (over: Partial<SubscriptionRecord>): SubscriptionRecord => ({
    ...noneRecord(APP_ID, 'user_1', 'free', nowIso()),
    plan_key: 'pro_month',
    source: 'stripe',
    current_period_end: '2026-08-01T00:00:00.000Z',
    provider_refs: { ...emptyProviderRefs(), stripe_subscription_id: 'sub_abc', stripe_customer_id: 'cus_1' },
    ...over,
  });

  it('→ past_due notifies once: right owner, channels, title, /billing deep-link, period-keyed idempotency', () => {
    const n = billingTransitionNotification('active', rec({ status: 'past_due' }), PUBLIC_BASE);
    expect(n).not.toBeNull();
    expect(n!.owner).toBe('user_1');
    expect(n!.key).toBe('billing.subscription.past_due');
    expect(n!.title).toMatch(/payment/i);
    expect(n!.channels).toEqual([...BILLING_NOTIFY_CHANNELS]);
    expect(n!.channels).toContain('email'); // MUST-DELIVER: email is a default channel
    expect(n!.channels).toContain('in_app');
    expect((n!.data as { url: string }).url).toBe(`${PUBLIC_BASE}/billing`);
    expect((n!.data as { status: string }).status).toBe('past_due');
    // idempotency keyed by subscription + status + period (so a retry in the same period dedupes).
    expect(n!.idempotencyKey).toBe('billing:sub_abc:past_due:2026-08-01T00:00:00.000Z');
  });

  it('→ canceled notifies with the cancellation copy + /billing deep-link', () => {
    const n = billingTransitionNotification('active', rec({ status: 'canceled' }), PUBLIC_BASE);
    expect(n).not.toBeNull();
    expect(n!.key).toBe('billing.subscription.canceled');
    expect(n!.title).toMatch(/cancel/i);
    expect(n!.idempotencyKey).toBe('billing:sub_abc:canceled:2026-08-01T00:00:00.000Z');
  });

  it('recovery past_due → active notifies "you\'re all set"', () => {
    const n = billingTransitionNotification('past_due', rec({ status: 'active' }), PUBLIC_BASE);
    expect(n).not.toBeNull();
    expect(n!.key).toBe('billing.subscription.active');
    expect(n!.idempotencyKey).toBe('billing:sub_abc:recovered:2026-08-01T00:00:00.000Z');
  });

  it('an UNCHANGED status is NOT a transition → null (never notify on a same-status webhook)', () => {
    expect(billingTransitionNotification('past_due', rec({ status: 'past_due' }), PUBLIC_BASE)).toBeNull();
    expect(billingTransitionNotification('active', rec({ status: 'active' }), PUBLIC_BASE)).toBeNull();
    expect(billingTransitionNotification('canceled', rec({ status: 'canceled' }), PUBLIC_BASE)).toBeNull();
  });

  it('a FRESH activation (none/trialing → active) does NOT notify (only past_due recovery does)', () => {
    expect(billingTransitionNotification('none', rec({ status: 'active' }), PUBLIC_BASE)).toBeNull();
    expect(billingTransitionNotification('trialing', rec({ status: 'active' }), PUBLIC_BASE)).toBeNull();
    expect(billingTransitionNotification('incomplete', rec({ status: 'active' }), PUBLIC_BASE)).toBeNull();
  });

  it('a new billing PERIOD yields a NEW idempotency key (a re-failure next period notifies again)', () => {
    const p1 = billingTransitionNotification('active', rec({ status: 'past_due', current_period_end: '2026-08-01T00:00:00.000Z' }), PUBLIC_BASE);
    const p2 = billingTransitionNotification('active', rec({ status: 'past_due', current_period_end: '2026-09-01T00:00:00.000Z' }), PUBLIC_BASE);
    expect(p1!.idempotencyKey).not.toBe(p2!.idempotencyKey);
  });

  it('deep-link falls back to the bare /billing path when no app public URL is configured', () => {
    expect(billingDeepLink(undefined)).toBe('/billing');
    expect(billingDeepLink('https://app.demo.test/')).toBe('https://app.demo.test/billing');
  });
});

// ============================ 2. wiring through the Stripe webhook ===================================
describe('C33+C21 — webhook fires the notification on a real transition (idempotently)', () => {
  let dir: string;
  let prevDir: string | undefined;
  let prevKey: string | undefined;
  let prevPublic: string | undefined;
  let server: FastifyInstance;
  let subs: Map<string, StripeSubscription | null>;
  let defaultSub: StripeSubscription | null;

  const stubStripe: StripeClient = {
    createCustomer: async () => ({ id: 'cus_test_1' }),
    createCheckoutSession: async () => ({ id: 'cs_1', url: 'https://checkout.test/cs_1' }),
    createPortalSession: async () => ({ url: 'https://portal.test/p/1' }),
    retrieveSubscription: async (_secretKey, subscriptionId) => (subs.has(subscriptionId) ? subs.get(subscriptionId)! : defaultSub),
    cancelSubscription: async () => ({ canceled: true }),
    deleteCustomer: async () => ({ deleted: true }),
  };

  function stripeSub(over: Partial<StripeSubscription> = {}): StripeSubscription {
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
      ...over,
    };
  }

  async function deliverEvent(event: Record<string, unknown>) {
    const raw = JSON.stringify(event);
    const header = computeStripeSignatureHeader(raw, WEBHOOK_SECRET);
    return server.inject({
      method: 'POST', url: '/hooks/billing/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
      payload: raw,
    });
  }

  const seedUser = async (): Promise<string> => {
    const user = await authStore.createUser(APP_ID, { email: 'payer@demo.test', email_verified: true });
    return user.id;
  };

  const listOwnerNotifications = async (owner: string) => store.listNotifications(APP_ID, { owner, includeDismissed: true });

  beforeEach(async () => {
    prevDir = process.env.FORGE_STATE_DIR;
    prevKey = process.env.FORGE_SECRETS_KEY;
    prevPublic = process.env.FORGE_AUTH_PUBLIC_URL;
    dir = await mkdtemp(path.join(tmpdir(), 'forge-billing-notify-'));
    process.env.FORGE_STATE_DIR = dir;
    process.env.FORGE_SECRETS_KEY = 'billing-notify-master-key';
    process.env.FORGE_AUTH_PUBLIC_URL = PUBLIC_BASE;
    await store.init();
    const now = nowIso();
    await store.saveResource({
      id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
      name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web', language: 'typescript', package_manager: 'npm',
    } as Application);
    await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_test_x');
    await setSecret(APP_ID, 'STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);

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
    if (prevPublic === undefined) delete process.env.FORGE_AUTH_PUBLIC_URL; else process.env.FORGE_AUTH_PUBLIC_URL = prevPublic;
    await rm(dir, { recursive: true, force: true });
  });

  it('a FRESH activation then an UNCHANGED active webhook notify NOTHING', async () => {
    const uid = await seedUser();
    defaultSub = stripeSub({ status: 'active', metadata: { subscriber: uid, app: APP_ID, plan_key: 'pro_month' } });
    // none → active (fresh subscription): not a billing-problem transition.
    expect((await deliverEvent({ id: 'evt_1', type: 'customer.subscription.created', data: { object: { id: 'sub_123' } } })).json().outcome).toBe('processed');
    // active → active (a routine update webhook): unchanged status.
    expect((await deliverEvent({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { id: 'sub_123' } } })).json().outcome).toBe('processed');
    expect(await listOwnerNotifications(uid)).toHaveLength(0);
  });

  it('active → past_due lands ONE owner-scoped in_app notification deep-linked to /billing; a retry does not double-notify', async () => {
    const uid = await seedUser();
    // First observe active…
    defaultSub = stripeSub({ status: 'active', metadata: { subscriber: uid, app: APP_ID, plan_key: 'pro_month' } });
    await deliverEvent({ id: 'evt_active', type: 'customer.subscription.created', data: { object: { id: 'sub_123' } } });
    expect(await listOwnerNotifications(uid)).toHaveLength(0);

    // …then Stripe reports the payment failed → past_due.
    defaultSub = stripeSub({ status: 'past_due', metadata: { subscriber: uid, app: APP_ID, plan_key: 'pro_month' } });
    const failed = { id: 'evt_failed', type: 'invoice.payment_failed', data: { object: { subscription: 'sub_123' } } };
    await deliverEvent(failed);

    const after = await listOwnerNotifications(uid);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ key: 'billing.subscription.past_due', owner: uid });
    expect((after[0]!.data as { url: string }).url).toBe(`${PUBLIC_BASE}/billing`);

    // Retry the SAME event → deduped at the webhook, no reprocess → still exactly one notification.
    expect((await deliverEvent(failed)).json().outcome).toBe('duplicate');
    // A DIFFERENT event carrying the still-past_due status → no state change → still one notification.
    defaultSub = stripeSub({ status: 'past_due', metadata: { subscriber: uid, app: APP_ID, plan_key: 'pro_month' } });
    await deliverEvent({ id: 'evt_recheck', type: 'customer.subscription.updated', data: { object: { id: 'sub_123' } } });
    expect(await listOwnerNotifications(uid)).toHaveLength(1);
  });

  it('active → canceled lands the cancellation notification', async () => {
    const uid = await seedUser();
    defaultSub = stripeSub({ status: 'active', metadata: { subscriber: uid, app: APP_ID, plan_key: 'pro_month' } });
    await deliverEvent({ id: 'evt_a', type: 'customer.subscription.created', data: { object: { id: 'sub_123' } } });
    defaultSub = stripeSub({ status: 'canceled', metadata: { subscriber: uid, app: APP_ID, plan_key: 'pro_month' } });
    await deliverEvent({ id: 'evt_del', type: 'customer.subscription.deleted', data: { object: { id: 'sub_123' } } });

    const after = await listOwnerNotifications(uid);
    expect(after.map((n) => n.key)).toContain('billing.subscription.canceled');
  });
});
