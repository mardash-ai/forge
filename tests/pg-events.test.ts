import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { getBackends } from '../src/storage/backends';
import { FsEventBackend } from '../src/storage/backends/events/fs';
import { PgEventBackend, ensureEventSchema } from '../src/storage/backends/events/pg';
import { backfillEvents } from '../src/storage/backends/events/migrate';
import type { AppEvent } from '../src/events/app-events';

// P26 (increment 3) — Postgres event backend-SPECIFIC coverage: the append table's B-tree indexes,
// DISTINCT-ON latest-per-subject, the deterministic append-order tiebreak (seq) for same-millisecond
// events, verbatim timestamps, the O4 scope columns, and id/timestamp/order-preserving backfill. Runs
// ONLY when the Postgres event backend is selected (`test:pg`); skipped in the default filesystem run.
const HAS_PG = process.env.FORGE_EVENTS_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

describe.skipIf(!HAS_PG)('P26 Postgres event backend — indexes, DISTINCT ON, order, O4, backfill', () => {
  const APP = 'app_pg_events';
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('is an append table with B-tree indexes on (app,owner,at) and (app,subject)', async () => {
    const idx = await pool.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename='forge_app_events'",
    );
    const byName = Object.fromEntries(idx.rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName['forge_app_events_owner_at']).toMatch(/\(app_id, owner, at/);
    expect(byName['forge_app_events_subject']).toMatch(/\(app_id, subject\)/);
  });

  it('latestTimes uses DISTINCT ON — newest at per subject, owner-scoped, subject-less ignored', async () => {
    const ev = (await getBackends()).events;
    await ev.append(APP, { type: 'a', subject: 'g1', owner: 'A' });
    await ev.append(APP, { type: 'b', subject: 'g1', owner: 'A' });
    await ev.append(APP, { type: 'c', subject: 'g2', owner: 'A' });
    await ev.append(APP, { type: 'd', subject: 'g1', owner: 'B' }); // other owner
    await ev.append(APP, { type: 'no-subject', owner: 'A' });

    const latest = await ev.latestTimes(APP, 'A');
    expect(Object.keys(latest).sort()).toEqual(['g1', 'g2']); // no subject-less entry, no B's data
    const aFeed = await ev.list(APP, { owner: 'A', subject: 'g1' });
    expect(latest['g1']).toBe(aFeed[0]!.at); // A's newest g1 timestamp
  });

  it('preserves append order for same-millisecond events via the seq tiebreak (newest-first)', async () => {
    const at = '2026-02-02T02:02:02.222Z'; // identical timestamp for all three
    const pg = new PgEventBackend(pool);
    const events: AppEvent[] = [
      { id: 'e1', app_id: APP, type: 't1', data: {}, at },
      { id: 'e2', app_id: APP, type: 't2', data: {}, at },
      { id: 'e3', app_id: APP, type: 't3', data: {}, at },
    ];
    await pg.importApp(`${APP}_order`, events); // seq assigned in array order
    const feed = await pg.list(`${APP}_order`, {});
    // identical `at` → order falls to seq DESC = insertion order reversed (deterministic).
    expect(feed.map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);
  });

  it('stores timestamps verbatim and bakes in the O4 (owner, group_id, visibility) columns', async () => {
    const ev = (await getBackends()).events;
    const e = await ev.append(APP, { type: 'x', subject: 's', owner: 'A' });
    const row = await pool.query<{ at: string; visibility: string; group_id: string | null }>(
      'SELECT at, visibility, group_id FROM forge_app_events WHERE app_id=$1 AND id=$2',
      [APP, e.id],
    );
    expect(row.rows[0]!.at).toBe(e.at); // verbatim ISO
    expect(row.rows[0]).toMatchObject({ visibility: 'private', group_id: null }); // O4 scope, defaulted
  });

  it('backfill (filesystem → Postgres) preserves ids, timestamps, and append order', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forge-events-bf-'));
    const prev = process.env.FORGE_STATE_DIR;
    process.env.FORGE_STATE_DIR = dir;
    try {
      const fs = new FsEventBackend();
      const APP2 = 'app_events_backfill';
      const a = await fs.append(APP2, { type: 'first', subject: 'g', owner: 'A' });
      const b = await fs.append(APP2, { type: 'second', subject: 'g', owner: 'A' });

      await ensureEventSchema(pool);
      await pool.query('DELETE FROM forge_app_events WHERE app_id=$1', [APP2]);
      const pg = new PgEventBackend(pool);
      const results = await backfillEvents(fs, pg, [APP2]);
      expect(results).toEqual([{ app: APP2, events: 2 }]);

      // ids + timestamps preserved; newest-first order preserved (second before first).
      const feed = await pg.list(APP2, { owner: 'A' });
      expect(feed.map((e) => e.id)).toEqual([b.id, a.id]);
      expect(feed.map((e) => e.at)).toEqual([b.at, a.at]);
      expect(feed.map((e) => e.type)).toEqual(['second', 'first']);
    } finally {
      if (prev === undefined) delete process.env.FORGE_STATE_DIR;
      else process.env.FORGE_STATE_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
