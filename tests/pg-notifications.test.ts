import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { getBackends } from '../src/storage/backends';
import { FsNotificationBackend } from '../src/storage/backends/notifications/fs';
import { PgNotificationBackend, ensureNotificationSchema } from '../src/storage/backends/notifications/pg';
import { backfillNotifications } from '../src/storage/backends/notifications/migrate';

// P26 (increment 4) — Postgres notification backend-SPECIFIC coverage: the ON CONFLICT upsert (no
// whole-map rewrite; preserves dismissed + created_at), the empty-string owner sentinel, the O4 scope
// columns, native concurrency (distinct keys never lost, no app lock), and backfill parity. Runs ONLY
// when the Postgres notification backend is selected (`test:pg`); skipped in the default filesystem run.
const HAS_PG = process.env.FORGE_NOTIFICATIONS_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

describe.skipIf(!HAS_PG)('P26 Postgres notification backend — upsert, sentinel, O4, concurrency, backfill', () => {
  const APP = 'app_pg_notifs';
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('upsert is one ON CONFLICT (no whole-map rewrite): re-derive updates in place, preserves dismissed + created_at', async () => {
    const n = (await getBackends()).notifications;
    const first = await n.upsert(APP, { key: 'k', title: 'v1', owner: 'A' });
    await n.dismiss(APP, 'k', 'A');
    const rederived = await n.upsert(APP, { key: 'k', title: 'v2 (still true)', owner: 'A' });
    // one row (the PK (app_id, owner, key) deduped the upsert), title updated, created_at + dismissed kept
    const rows = await pool.query('SELECT count(*)::int AS n FROM forge_notifications WHERE app_id=$1 AND owner=$2 AND key=$3', [APP, 'A', 'k']);
    expect(rows.rows[0].n).toBe(1);
    expect(rederived.title).toBe('v2 (still true)');
    expect(rederived.created_at).toBe(first.created_at);
    expect(rederived.dismissed).toBe(true); // a dismissed-but-still-true condition does not resurface
  });

  it('stores legacy/app-scoped notifications with the empty-string owner sentinel + baked-in O4 columns', async () => {
    const n = (await getBackends()).notifications;
    await n.upsert(APP, { key: 'legacy', title: 'no owner' }); // owner-less
    const row = await pool.query<{ owner: string; visibility: string; group_id: string | null }>(
      "SELECT owner, visibility, group_id FROM forge_notifications WHERE app_id=$1 AND key='legacy'",
      [APP],
    );
    expect(row.rows[0]).toMatchObject({ owner: '', visibility: 'private', group_id: null });
    // The domain shape omits owner for a legacy record (owner '' -> undefined).
    const listed = await n.list(APP, {});
    expect(listed.find((x) => x.key === 'legacy')!.owner).toBeUndefined();
    // An owner-scoped list excludes the legacy record; an app-scoped list includes it.
    expect((await n.list(APP, { owner: 'nobody' })).some((x) => x.key === 'legacy')).toBe(false);
  });

  it('handles concurrent upserts to distinct keys natively (ON CONFLICT, no app lock) — none lost', async () => {
    const n = (await getBackends()).notifications;
    const keys = Array.from({ length: 50 }, (_, i) => `c${i}`);
    await Promise.all(keys.map((key) => n.upsert(APP, { key, title: key, owner: 'A' })));
    const list = await n.list(APP, { owner: 'A' });
    expect(new Set(list.map((x) => x.key))).toEqual(new Set(keys));
  });

  it('backfill (filesystem → Postgres) preserves owner, key, dismissed, and created_at', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forge-notifs-bf-'));
    const prev = process.env.FORGE_STATE_DIR;
    process.env.FORGE_STATE_DIR = dir;
    try {
      const fs = new FsNotificationBackend();
      const APP2 = 'app_notifs_backfill';
      const a = await fs.upsert(APP2, { key: 'cold:g1', title: "A's", owner: 'A' });
      await fs.dismiss(APP2, 'cold:g1', 'A');
      await fs.upsert(APP2, { key: 'cold:g1', title: "B's", owner: 'B' }); // same key, other owner

      await ensureNotificationSchema(pool);
      await pool.query('DELETE FROM forge_notifications WHERE app_id=$1', [APP2]);
      const pg = new PgNotificationBackend(pool);
      const results = await backfillNotifications(fs, pg, [APP2]);
      expect(results).toEqual([{ app: APP2, notifications: 2 }]);

      // Two owners keep the SAME key as distinct records; A's is dismissed + created_at preserved.
      const aAll = await pg.list(APP2, { owner: 'A', includeDismissed: true });
      expect(aAll).toHaveLength(1);
      expect(aAll[0]).toMatchObject({ key: 'cold:g1', owner: 'A', dismissed: true, created_at: a.created_at });
      const bList = await pg.list(APP2, { owner: 'B' });
      expect(bList.map((x) => x.title)).toEqual(["B's"]);
    } finally {
      if (prev === undefined) delete process.env.FORGE_STATE_DIR;
      else process.env.FORGE_STATE_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
