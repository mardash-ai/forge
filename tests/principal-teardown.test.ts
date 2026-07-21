import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { getBackends } from '../src/storage/backends';
import { registerAuthRoutes } from '../src/api/auth-routes';
import { registerBillingRoutes } from '../src/api/billing-routes';
import { registerMembershipRoutes } from '../src/api/membership-routes';
import { setSecret } from '../src/plugins/secrets-local/index';
import { hashPassword } from '../src/plugins/auth-identity/index';
import * as authStore from '../src/plugins/auth-identity/store';
import { applyCanonicalSubscription } from '../src/billing/service';
import { emptyProviderRefs, type SubscriptionRecord } from '../src/billing/types';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';
import type { RoleDef } from '../src/membership/types';
import {
  setStripeClient,
  resetStripeClient,
  type StripeClient,
  type StripeSubscription,
} from '../src/plugins/stripe-billing/index';

// "Administrative principal teardown" — the machinery behind account deletion / right-to-be-forgotten:
// three idempotent, SERVICE-token-gated admin ops (identity delete / billing-customer delete / membership
// teardown), each keyed by the principal id. Exercised end-to-end through the configured store backends
// (filesystem default / Postgres on the pg run) with an in-memory STUB Stripe (no network), asserting the
// identity can no longer authenticate, the customer + subscription are gone at the provider AND in the
// platform record, and the membership rows are removed — while a SHARED group loses only the one member.
const APP = 'demo';
const APP_ID = 'app_demo';
const SESSION_SECRET = 'teardown-test-session-secret';
const SERVICE_TOKEN = 'svc-teardown-123';
const WEBHOOK_SECRET = 'whsec_teardown';
const SVC = { 'x-forge-service-token': SERVICE_TOKEN };

let dir: string;
let prevDir: string | undefined;
let prevKey: string | undefined;
let server: FastifyInstance;

// --- stub Stripe that RECORDS the provider-side teardown calls ----------------------------------
let deletedCustomers: string[];
let canceledSubs: string[];
let customerSeq: number;

const stubStripe: StripeClient = {
  createCustomer: async () => ({ id: `cus_${++customerSeq}` }),
  createCheckoutSession: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }),
  createPortalSession: async () => ({ url: 'https://portal.stripe.test/1' }),
  createTrialingSubscription: async (input) => ({
    id: 'sub_trial_teardown', status: 'trialing',
    trial_end: Math.floor(Date.now() / 1000) + input.trialPeriodDays * 24 * 3600,
    current_period_end: null, cancel_at_period_end: false,
    customer_id: input.customerId, price_id: input.priceId, currency: 'usd',
    metadata: input.metadata,
  }),
  resumeSubscription: async () => ({ resumed: false, subscription: null }),
  retrieveSubscription: async (): Promise<StripeSubscription | null> => null,
  cancelSubscription: async (_secretKey, id) => {
    canceledSubs.push(id);
    return { canceled: true };
  },
  deleteCustomer: async (_secretKey, id) => {
    deletedCustomers.push(id);
    return { deleted: true };
  },
};

const ROLES: RoleDef[] = [
  { key: 'owner', label: 'Owner', permissions: ['members.invite', 'members.manage_roles', 'members.remove'], rank: 100, owner_role: true, assignable: true },
  { key: 'member', label: 'Member', permissions: [], rank: 10, owner_role: false, assignable: true },
];

const seedApp = async (): Promise<void> => {
  const now = nowIso();
  await store.saveResource({
    id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
    name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web', language: 'typescript', package_manager: 'npm',
  } as Application);
};

const configureStripe = async (): Promise<void> => {
  await setSecret(APP_ID, 'STRIPE_SECRET_KEY', 'sk_test_x');
  await setSecret(APP_ID, 'STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
};

// Seed an ACTIVE subscription-of-record for a subscriber, with the Stripe handles filled (as a real
// checkout+webhook would have), via the canonical upsert path.
const seedActiveCustomer = async (subscriber: string, customerId: string, subscriptionId: string): Promise<void> => {
  const fields: Omit<SubscriptionRecord, 'version' | 'created_at' | 'updated_at'> = {
    subscriber, app: APP_ID, plan_key: 'pro', status: 'active', source: 'stripe',
    current_period_end: new Date(Date.now() + 30 * 864e5).toISOString(), cancel_at_period_end: false,
    trial_end: null, currency: 'usd', scope_ref: null,
    provider_refs: { ...emptyProviderRefs(), stripe_customer_id: customerId, stripe_subscription_id: subscriptionId, stripe_price_id: 'price_pro' },
  };
  const { applied } = await applyCanonicalSubscription(APP_ID, fields, Date.now());
  expect(applied).toBe(true);
};

const setRoles = () => server.inject({ method: 'PUT', url: '/roles', payload: { roles: ROLES } });
const ensureGroup = (owner: string) => server.inject({ method: 'POST', url: '/groups/ensure', payload: { owner } });

// Provision a SHARED group: A owns it, B accepts an invitation (flips it off singleton).
const sharedGroup = async (a: string, b: string, bRole = 'member'): Promise<string> => {
  const g = (await ensureGroup(a)).json().group.id as string;
  const inv = await server.inject({ method: 'POST', url: `/groups/${g}/invitations`, payload: { actor: a, invitee_hint: b, role: bRole } });
  const token = inv.json().invitation.token as string;
  const acc = await server.inject({ method: 'POST', url: '/invitations/accept', payload: { token, owner: b } });
  expect(acc.statusCode).toBe(200);
  return g;
};

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevKey = process.env.FORGE_SECRETS_KEY;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-teardown-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_SECRETS_KEY = 'teardown-test-master-key';
  await store.init();
  await seedApp();
  await setSecret(APP_ID, 'AUTH_SESSION_SECRET', SESSION_SECRET);
  await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', SERVICE_TOKEN);

  deletedCustomers = [];
  canceledSubs = [];
  customerSeq = 0;
  setStripeClient(stubStripe);

  server = Fastify({ logger: false });
  registerAuthRoutes(server, { defaultApp: () => APP });
  registerBillingRoutes(server, { defaultApp: () => APP });
  registerMembershipRoutes(server, { defaultApp: () => APP });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  resetStripeClient();
  const b = await getBackends();
  await b.billing.__truncateAllForTests?.();
  await b.membership.__truncateAllForTests?.();
  await b.identity.__truncateAllForTests?.();
  if (prevDir === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prevDir;
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY; else process.env.FORGE_SECRETS_KEY = prevKey;
  await rm(dir, { recursive: true, force: true });
});

// ===================================================================================================
describe('principal teardown — full purge of a solo principal', () => {
  it('deletes the identity + billing customer + group-of-one so nothing survives', async () => {
    await configureStripe();
    await setRoles();

    // A principal: an identity (with a password + a live session), a billing customer, a group-of-one.
    const email = 'closeme@demo.test';
    const user = await authStore.createUser(APP_ID, { email, email_verified: true, password_hash: await hashPassword('password123') });
    const session = await authStore.createSession(APP_ID, user.id, 3600);
    await seedActiveCustomer(user.id, 'cus_solo', 'sub_solo');
    const grp = (await ensureGroup(user.id)).json().group.id as string;

    // Sanity: everything exists BEFORE teardown.
    expect(await authStore.findByEmail(APP_ID, email)).not.toBeNull();
    expect((await getBackends()).billing && (await (await getBackends()).billing.read(APP_ID)).subscriptions[user.id]).toBeTruthy();
    expect((await (await getBackends()).membership.read(APP_ID)).groups[grp]).toBeTruthy();

    // 1) Identity delete.
    const idRes = await server.inject({ method: 'DELETE', url: `/auth/admin/identity/${user.id}`, headers: SVC });
    expect(idRes.statusCode).toBe(200);
    expect(idRes.json()).toMatchObject({ deleted: true, user_id: user.id });

    // 2) Billing-customer delete.
    const billRes = await server.inject({ method: 'DELETE', url: '/billing/customer', headers: SVC, payload: { subscriber: user.id } });
    expect(billRes.statusCode).toBe(200);
    expect(billRes.json()).toMatchObject({ deleted: true, subscription_canceled: true, stripe_customer_deleted: true, record_dropped: true });

    // 3) Membership teardown.
    const memRes = await server.inject({ method: 'DELETE', url: `/identities/${user.id}/memberships`, headers: SVC });
    expect(memRes.statusCode).toBe(200);
    expect(memRes.json().groups_deleted).toContain(grp);

    // --- assert the identity can no longer authenticate + its email is FREED --------------------
    expect(await authStore.getUser(APP_ID, user.id)).toBeNull();
    expect(await authStore.findByEmail(APP_ID, email)).toBeNull();
    expect(await authStore.getSession(APP_ID, session.id)).toBeNull();
    // The email is re-registrable (a fresh, DIFFERENT user id).
    const reborn = await authStore.createUser(APP_ID, { email, email_verified: true });
    expect(reborn.id).not.toBe(user.id);

    // --- assert the customer + subscription are gone at the PROVIDER and in the platform RECORD --
    expect(canceledSubs).toContain('sub_solo');
    expect(deletedCustomers).toContain('cus_solo');
    expect((await (await getBackends()).billing.read(APP_ID)).subscriptions[user.id]).toBeUndefined();

    // --- assert the membership rows are removed (group-of-one deleted) --------------------------
    const graph = await (await getBackends()).membership.read(APP_ID);
    expect(graph.groups[grp]).toBeUndefined();
    expect(Object.values(graph.members).some((m) => m.owner === user.id)).toBe(false);

    // A UserDeleted fact was recorded (redacted email, no secrets).
    const events = await store.listEvents({ app_id: APP_ID, resource_id: user.id });
    expect(events.some((e) => e.type === 'UserDeleted')).toBe(true);
  });
});

describe('principal teardown — shared group keeps the group, drops just the member', () => {
  it('removes only the departing member and emits membership.removed (via:teardown)', async () => {
    await setRoles();
    const grp = await sharedGroup('ownerA', 'memberB', 'member');

    const res = await server.inject({ method: 'DELETE', url: '/identities/memberB/memberships', headers: SVC });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups_deleted).toHaveLength(0);
    expect(res.json().memberships_removed).toEqual([{ group_id: grp, role: 'member' }]);

    // The group SURVIVES; A stays, B is gone.
    const graph = await (await getBackends()).membership.read(APP_ID);
    expect(graph.groups[grp]).toBeTruthy();
    expect(graph.members[`${grp}:ownerA`]).toBeTruthy();
    expect(graph.members[`${grp}:memberB`]).toBeUndefined();

    // membership.removed emitted for the shared-group removal.
    const evs = await store.listAppEvents({ app_id: APP_ID, subject: grp });
    const removed = evs.find((e) => e.type === 'membership.removed' && (e.data as { removed_owner?: string }).removed_owner === 'memberB');
    expect(removed).toBeTruthy();
    expect(removed!.data).toMatchObject({ removed_owner: 'memberB', via: 'teardown' });
  });

  it('promotes an heir when the departing identity was the SOLE owner (preserves ≥1 owner)', async () => {
    await setRoles();
    const grp = await sharedGroup('ownerA', 'memberB', 'member');

    // Tear down the sole owner A → B is promoted to the owner-role, the group survives.
    const res = await server.inject({ method: 'DELETE', url: '/identities/ownerA/memberships', headers: SVC });
    expect(res.statusCode).toBe(200);
    expect(res.json().groups_deleted).toHaveLength(0);
    expect(res.json().promotions).toEqual([{ group_id: grp, promoted_owner: 'memberB' }]);

    const graph = await (await getBackends()).membership.read(APP_ID);
    expect(graph.groups[grp]).toBeTruthy();
    expect(graph.members[`${grp}:ownerA`]).toBeUndefined();
    expect(graph.members[`${grp}:memberB`]!.role).toBe('owner');
  });
});

describe('principal teardown — idempotency + safety', () => {
  it('identity delete on an absent identity is a 200 no-op (not a 404)', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/auth/admin/identity/user_ghost', headers: SVC });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: false, user_id: 'user_ghost' });
  });

  it('billing-customer delete for a never-a-customer subscriber is a safe 200 no-op', async () => {
    await configureStripe();
    const res = await server.inject({ method: 'DELETE', url: '/billing/customer', headers: SVC, payload: { subscriber: 'never_paid' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deleted: false, record_dropped: false, stripe_customer_deleted: false, subscription_canceled: false });
    expect(deletedCustomers).toHaveLength(0);
  });

  it('billing-customer delete drops the record even when Stripe is NOT configured', async () => {
    // No STRIPE_SECRET_KEY set — the Stripe steps are skipped but the platform record is still dropped.
    await seedActiveCustomer('unconf_user', 'cus_unconf', 'sub_unconf');
    const res = await server.inject({ method: 'DELETE', url: '/billing/customer', headers: SVC, payload: { subscriber: 'unconf_user' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deleted: true, stripe_configured: false, record_dropped: true, stripe_customer_deleted: false, subscription_canceled: false });
    expect(deletedCustomers).toHaveLength(0);
    expect((await (await getBackends()).billing.read(APP_ID)).subscriptions['unconf_user']).toBeUndefined();
  });

  it('membership teardown for an identity with no memberships is a clean 200 no-op', async () => {
    await setRoles();
    const res = await server.inject({ method: 'DELETE', url: '/identities/nobody/memberships', headers: SVC });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ owner: 'nobody', groups_deleted: [], memberships_removed: [], promotions: [], removed_rows: 0 });
  });

  it('a full re-run of all three ops is idempotent (second pass changes nothing)', async () => {
    await configureStripe();
    await setRoles();
    const user = await authStore.createUser(APP_ID, { email: 'twice@demo.test', email_verified: true });
    await seedActiveCustomer(user.id, 'cus_twice', 'sub_twice');
    await ensureGroup(user.id);
    for (const run of [1, 2]) {
      const a = await server.inject({ method: 'DELETE', url: `/auth/admin/identity/${user.id}`, headers: SVC });
      const b = await server.inject({ method: 'DELETE', url: '/billing/customer', headers: SVC, payload: { subscriber: user.id } });
      const c = await server.inject({ method: 'DELETE', url: `/identities/${user.id}/memberships`, headers: SVC });
      expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([200, 200, 200]);
      if (run === 2) {
        expect(a.json().deleted).toBe(false);
        expect(b.json().deleted).toBe(false);
        expect(c.json().removed_rows).toBe(0);
      }
    }
  });
});

describe('principal teardown — service-gating (NOT end-user reachable)', () => {
  it('every teardown op is refused (401) without a valid service token', async () => {
    await configureStripe();
    await setRoles();
    const user = await authStore.createUser(APP_ID, { email: 'gated@demo.test', email_verified: true });
    await seedActiveCustomer(user.id, 'cus_gated', 'sub_gated');
    await ensureGroup(user.id);

    const noToken = [
      await server.inject({ method: 'DELETE', url: `/auth/admin/identity/${user.id}` }),
      await server.inject({ method: 'DELETE', url: '/billing/customer', payload: { subscriber: user.id } }),
      await server.inject({ method: 'DELETE', url: `/identities/${user.id}/memberships` }),
    ];
    for (const r of noToken) expect(r.statusCode).toBe(401);

    const wrongToken = { 'x-forge-service-token': 'nope' };
    expect((await server.inject({ method: 'DELETE', url: `/auth/admin/identity/${user.id}`, headers: wrongToken })).statusCode).toBe(401);
    expect((await server.inject({ method: 'DELETE', url: '/billing/customer', headers: wrongToken, payload: { subscriber: user.id } })).statusCode).toBe(401);
    expect((await server.inject({ method: 'DELETE', url: `/identities/${user.id}/memberships`, headers: wrongToken })).statusCode).toBe(401);

    // Nothing was torn down while unauthorized.
    expect(await authStore.getUser(APP_ID, user.id)).not.toBeNull();
    expect((await (await getBackends()).billing.read(APP_ID)).subscriptions[user.id]).toBeTruthy();
    expect(deletedCustomers).toHaveLength(0);
  });

  it('a Bearer authorization header also carries the service token', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/auth/admin/identity/user_ghost', headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(false);
  });

  it('billing-customer delete requires a subscriber (422)', async () => {
    const res = await server.inject({ method: 'DELETE', url: '/billing/customer', headers: SVC, payload: {} });
    expect(res.statusCode).toBe(422);
  });
});

describe('admin identity enumeration — GET /auth/admin/identities (the "list all accounts" seam)', () => {
  it('lists EVERY identity for the app (full email, derived provider, created_at) with a service token', async () => {
    const google = await authStore.createUser(APP_ID, { email: 'ExecG@Demo.test', email_verified: true, provider: 'google', provider_user_id: 'g-1' });
    const pw = await authStore.createUser(APP_ID, { email: 'pw@demo.test', email_verified: true, password_hash: await hashPassword('password123') });
    // A "zombie" with neither provider nor password (created out-of-band) → provider null.
    const zombie = await authStore.createUser(APP_ID, { email: 'zombie@demo.test', email_verified: false });

    const res = await server.inject({ method: 'GET', url: '/auth/admin/identities', headers: SVC });
    expect(res.statusCode).toBe(200);
    const byId = new Map<string, { user_id: string; email: string | null; provider: string | null; created_at: string | null }>(
      res.json().identities.map((i: { user_id: string; email: string | null; provider: string | null; created_at: string | null }) => [i.user_id, i]),
    );
    expect(byId.size).toBe(3);
    // Full (canonical, lowercased) email is returned — NOT redacted — so an operator can recognize the account.
    expect(byId.get(google.id)).toMatchObject({ user_id: google.id, email: 'execg@demo.test', provider: 'google' });
    expect(byId.get(pw.id)).toMatchObject({ email: 'pw@demo.test', provider: 'password' });
    expect(byId.get(zombie.id)).toMatchObject({ email: 'zombie@demo.test', provider: null });
    // created_at present on every row.
    for (const row of byId.values()) expect(typeof row.created_at).toBe('string');
  });

  it('returns { identities: [] } when the app has no accounts (never 404)', async () => {
    const res = await server.inject({ method: 'GET', url: '/auth/admin/identities', headers: SVC });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ identities: [] });
  });

  it('is SERVICE-gated: refused (401) with no token and with a wrong token; a Bearer token is accepted', async () => {
    await authStore.createUser(APP_ID, { email: 'seen@demo.test', email_verified: true });
    expect((await server.inject({ method: 'GET', url: '/auth/admin/identities' })).statusCode).toBe(401);
    expect((await server.inject({ method: 'GET', url: '/auth/admin/identities', headers: { 'x-forge-service-token': 'nope' } })).statusCode).toBe(401);
    const bearer = await server.inject({ method: 'GET', url: '/auth/admin/identities', headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
    expect(bearer.statusCode).toBe(200);
    expect(bearer.json().identities).toHaveLength(1);
  });
});
