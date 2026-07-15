import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { getBackends } from '../src/storage/backends';
import { FsPushBackend } from '../src/storage/backends/push/fs';
import { PgPushBackend, ensurePushSchema } from '../src/storage/backends/push/pg';
import { backfillPush } from '../src/storage/backends/push/migrate';

// C21 / P26 — Postgres push backend-SPECIFIC coverage: the dedupe-by-endpoint upsert (ON CONFLICT
// (app_id, endpoint) DO UPDATE — one row per endpoint, preserves created_at), the ATOMIC first-writer
// delivery claim (INSERT … ON CONFLICT DO NOTHING — exactly one winner under concurrency, no app lock),
// and backfill parity. Runs ONLY when the Postgres push backend is selected (`test:pg`); skipped otherwise.
const HAS_PG = process.env.FORGE_PUSH_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

const sub = (endpoint: string, p256dh = 'kp', auth = 'ka') => ({ endpoint, keys: { p256dh, auth } });

describe.skipIf(!HAS_PG)('P26 Postgres push backend — dedupe upsert, atomic claim, backfill', () => {
  const APP = 'app_pg_push';
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('registerSubscription dedupes by endpoint (ON CONFLICT) — one row, keys updated, created_at preserved', async () => {
    const p = (await getBackends()).push;
    const first = await p.registerSubscription(APP, { owner: 'A', ...sub('https://push/1', 'old', 'olda') });
    const second = await p.registerSubscription(APP, { owner: 'A', ...sub('https://push/1', 'new', 'newa') });
    const rows = await pool.query('SELECT count(*)::int AS n FROM forge_push_subscriptions WHERE app_id=$1 AND endpoint=$2', [APP, 'https://push/1']);
    expect(rows.rows[0].n).toBe(1);
    expect(second.keys).toEqual({ p256dh: 'new', auth: 'newa' });
    expect(second.created_at).toBe(first.created_at);
    expect((await p.listSubscriptions(APP, 'A')).length).toBe(1);
  });

  it('unregister honors the owner; prune is owner-agnostic', async () => {
    const p = (await getBackends()).push;
    await p.registerSubscription(APP, { owner: 'A', ...sub('https://push/2') });
    expect(await p.unregisterSubscription(APP, 'https://push/2', 'B')).toBe(false); // not B's
    expect(await p.unregisterSubscription(APP, 'https://push/2', 'A')).toBe(true);
    await p.registerSubscription(APP, { owner: 'A', ...sub('https://push/3') });
    expect(await p.pruneSubscription(APP, 'https://push/3')).toBe(true); // server-side cleanup
  });

  it('claimDelivery is an atomic first-writer claim — one winner across a concurrent double-submit', async () => {
    const p = (await getBackends()).push;
    const now = new Date().toISOString();
    const results = await Promise.all(Array.from({ length: 10 }, () => p.claimDelivery(APP, 'A', 'race', now)));
    expect(results.filter((r) => r === true).length).toBe(1);
    expect(await p.claimDelivery(APP, 'A', 'race', now)).toBe(false); // already claimed
    expect(await p.claimDelivery(APP, 'B', 'race', now)).toBe(true); // scoped by owner
  });

  it('pruneDeliveriesBefore drops stale ledger entries', async () => {
    const p = (await getBackends()).push;
    await p.claimDelivery(APP, 'A', 'old', '2020-01-01T00:00:00.000Z');
    await p.claimDelivery(APP, 'A', 'new', new Date().toISOString());
    const dropped = await p.pruneDeliveriesBefore(APP, '2021-01-01T00:00:00.000Z');
    expect(dropped).toBe(1);
    expect(await p.claimDelivery(APP, 'A', 'old', new Date().toISOString())).toBe(true); // old was pruned → claimable again
    expect(await p.claimDelivery(APP, 'A', 'new', new Date().toISOString())).toBe(false); // new survived
  });

  it('backfill (filesystem → Postgres) preserves subscriptions + delivery ledger', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forge-push-bf-'));
    const prev = process.env.FORGE_STATE_DIR;
    process.env.FORGE_STATE_DIR = dir;
    try {
      const fs = new FsPushBackend();
      const APP2 = 'app_push_backfill';
      await fs.registerSubscription(APP2, { owner: 'A', ...sub('https://push/a1', 'x', 'y') });
      await fs.registerSubscription(APP2, { owner: 'B', ...sub('https://push/b1') });
      await fs.claimDelivery(APP2, 'A', 'op-1', new Date().toISOString());

      await ensurePushSchema(pool);
      await pool.query('DELETE FROM forge_push_subscriptions WHERE app_id=$1', [APP2]);
      await pool.query('DELETE FROM forge_push_deliveries WHERE app_id=$1', [APP2]);
      const pg = new PgPushBackend(pool);
      const results = await backfillPush(fs, pg, [APP2]);
      expect(results).toEqual([{ app: APP2, subscriptions: 2, deliveries: 1 }]);

      expect((await pg.listSubscriptions(APP2, 'A'))[0]).toMatchObject({ endpoint: 'https://push/a1', keys: { p256dh: 'x', auth: 'y' } });
      expect((await pg.listSubscriptions(APP2, 'B')).map((s) => s.endpoint)).toEqual(['https://push/b1']);
      expect(await pg.claimDelivery(APP2, 'A', 'op-1', new Date().toISOString())).toBe(false); // ledger carried over
    } finally {
      if (prev === undefined) delete process.env.FORGE_STATE_DIR;
      else process.env.FORGE_STATE_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
