import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { getBackends } from '../src/storage/backends';
import { FsBillingBackend } from '../src/storage/backends/billing/fs';
import { PgBillingBackend, ensureBillingSchema } from '../src/storage/backends/billing/pg';
import { backfillBilling } from '../src/storage/backends/billing/migrate';
import { emptyBillingState } from '../src/billing/state';
import { emptyProviderRefs, type Catalog, type SubscriptionRecord } from '../src/billing/types';
import { nowIso } from '../src/shared/time';

// C33 / P26 — Postgres billing backend-SPECIFIC coverage: the per-app jsonb document round-trips, a mutation
// is serialized (SELECT … FOR UPDATE) into ONE row, and the filesystem → Postgres backfill copies the whole
// billing document (catalog + subscriptions + webhook-event dedupe). Runs ONLY when the Postgres billing
// backend is selected (`test:pg`); skipped on the default filesystem run.
const HAS_PG = process.env.FORGE_BILLING_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

function record(subscriber: string, status: SubscriptionRecord['status'], version: number): SubscriptionRecord {
  const now = nowIso();
  return {
    subscriber, app: 'x', plan_key: 'pro_month', status, source: 'stripe',
    current_period_end: null, cancel_at_period_end: false, trial_end: null, currency: 'usd', scope_ref: null,
    provider_refs: { ...emptyProviderRefs(), stripe_subscription_id: 'sub_1' },
    version, created_at: now, updated_at: now,
  };
}

const CATALOG: Catalog = {
  plans: [
    { plan_key: 'free', display: { name: 'Free' }, interval: 'month', prices: { stripe: { price_id: null, currency: null }, apple: { product_id: null }, google: { product_id: null } }, entitlements: { a: 1 }, is_default: true },
  ],
  updated_at: nowIso(),
};

describe.skipIf(!HAS_PG)('P26 Postgres billing backend — jsonb document, serialized mutate, backfill', () => {
  const APP = 'app_pg_billing';
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('read is empty until written; mutate persists catalog + a subscription in ONE row', async () => {
    const b = (await getBackends()).billing;
    expect(await b.read(APP)).toEqual(emptyBillingState());

    await b.mutate(APP, (s) => ({ state: { ...s, catalog: CATALOG }, result: undefined }));
    await b.mutate(APP, (s) => ({ state: { ...s, subscriptions: { u1: record('u1', 'active', 1) } }, result: undefined }));

    const state = await b.read(APP);
    expect(state.catalog?.plans[0]!.plan_key).toBe('free');
    expect(state.subscriptions.u1!.status).toBe('active');

    const n = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM forge_billing WHERE app_id=$1', [APP]);
    expect(Number(n.rows[0]!.n)).toBe(1); // one document row per app
  });

  it('the monotonic-version guard holds under the serialized mutate (a stale write is dropped)', async () => {
    const APP2 = 'app_pg_billing_guard';
    const b = (await getBackends()).billing;
    // Apply v5, then attempt a stale v3 — the stale write must not overwrite.
    await b.mutate(APP2, (s) => ({ state: { ...s, subscriptions: { u: record('u', 'canceled', 5) } }, result: undefined }));
    await b.mutate(APP2, (s) => {
      const existing = s.subscriptions.u;
      if (existing && 3 < existing.version) return { state: s, result: false };
      return { state: { ...s, subscriptions: { u: record('u', 'active', 3) } }, result: true };
    });
    expect((await b.read(APP2)).subscriptions.u!.status).toBe('canceled');
  });

  it('backfill (filesystem → Postgres) copies the whole billing document', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forge-billing-bf-'));
    const prev = process.env.FORGE_STATE_DIR;
    process.env.FORGE_STATE_DIR = dir;
    try {
      const APP3 = 'app_billing_backfill';
      const fs = new FsBillingBackend();
      await fs.mutate(APP3, (s) => ({ state: { ...s, catalog: CATALOG, subscriptions: { u1: record('u1', 'active', 1) }, webhook_events: { evt_1: { id: 'evt_1', type: 't', received_at: nowIso() } } }, result: undefined }));

      await ensureBillingSchema(pool);
      await pool.query('DELETE FROM forge_billing WHERE app_id=$1', [APP3]);
      const pg = new PgBillingBackend(pool);
      expect(await backfillBilling(fs, pg, [APP3])).toEqual([{ app: APP3, plans: 1, subscriptions: 1, webhook_events: 1 }]);

      const state = await pg.read(APP3);
      expect(state.catalog?.plans[0]!.plan_key).toBe('free');
      expect(state.subscriptions.u1!.status).toBe('active');
      expect(state.webhook_events.evt_1!.id).toBe('evt_1');
    } finally {
      if (prev === undefined) delete process.env.FORGE_STATE_DIR;
      else process.env.FORGE_STATE_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
