import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { getBackends } from '../src/storage/backends';
import { FsPolicyBackend } from '../src/storage/backends/policies/fs';
import { PgPolicyBackend, ensurePolicySchema } from '../src/storage/backends/policies/pg';
import { backfillPolicies } from '../src/storage/backends/policies/migrate';
import { nowIso } from '../src/shared/time';
import type { PolicyRule } from '../src/authz/types';

// C29 / P26 — Postgres policy backend-SPECIFIC coverage: jsonb round-trip + O4 columns, owner-scoped +
// app-wide list, single-upsert (one row), and backfill. Runs ONLY when the Postgres policy backend is
// selected (`test:pg`); skipped in the default filesystem run.
const HAS_PG = process.env.FORGE_POLICY_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

const rule = (id: string, over: Partial<PolicyRule> = {}): PolicyRule => ({
  id, effect: 'allow', priority: 0, match: {}, created_at: nowIso(), updated_at: nowIso(), ...over,
});

describe.skipIf(!HAS_PG)('P26 Postgres policy backend — jsonb + O4, owner/app-wide list, upsert, backfill', () => {
  const APP = 'app_pg_policy';
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('round-trips a policy through jsonb, with O4 columns projected', async () => {
    const p = rule('pol_1', { owner: 'A', effect: 'deny', priority: 7, match: { tool: ['send_email'], max_amount: 50 }, reason: 'no' });
    const b = (await getBackends()).policy;
    await b.put(APP, p);
    expect(await b.get(APP, 'pol_1')).toEqual(p); // exact round-trip

    const row = await pool.query<{ owner: string; effect: string; priority: number; visibility: string }>(
      "SELECT owner, effect, priority, visibility FROM forge_policies WHERE app_id=$1 AND id='pol_1'",
      [APP],
    );
    expect(row.rows[0]).toMatchObject({ owner: 'A', effect: 'deny', priority: 7, visibility: 'private' });
  });

  it('list(owner) returns that owner’s + app-wide policies; list() returns all', async () => {
    const b = (await getBackends()).policy;
    await b.put(APP, rule('appwide', { effect: 'allow' })); // no owner
    await b.put(APP, rule('a_rule', { owner: 'A' }));
    await b.put(APP, rule('b_rule', { owner: 'B' }));

    expect((await b.list(APP, { owner: 'A' })).map((p) => p.id).sort()).toEqual(['a_rule', 'appwide']);
    expect((await b.list(APP, { owner: 'B' })).map((p) => p.id).sort()).toEqual(['appwide', 'b_rule']);
    expect((await b.list(APP, {})).length).toBe(3); // admin view — all
  });

  it('put is a single upsert — one row after re-put', async () => {
    const b = (await getBackends()).policy;
    await b.put(APP, rule('up', { priority: 1 }));
    await b.put(APP, rule('up', { priority: 9 }));
    const n = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM forge_policies WHERE app_id=$1 AND id='up'", [APP]);
    expect(Number(n.rows[0]!.n)).toBe(1);
    expect((await b.get(APP, 'up'))?.priority).toBe(9);
  });

  it('backfill (filesystem → Postgres) preserves policy ids + shapes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forge-policy-bf-'));
    const prev = process.env.FORGE_STATE_DIR;
    process.env.FORGE_STATE_DIR = dir;
    try {
      const APP2 = 'app_policy_backfill';
      const fs = new FsPolicyBackend();
      await fs.put(APP2, rule('bf1', { owner: 'A', effect: 'deny' }));
      await fs.put(APP2, rule('bf2', { effect: 'allow' }));

      await ensurePolicySchema(pool);
      await pool.query('DELETE FROM forge_policies WHERE app_id=$1', [APP2]);
      const pg = new PgPolicyBackend(pool);
      expect(await backfillPolicies(fs, pg, [APP2])).toEqual([{ app: APP2, policies: 2 }]);

      expect((await pg.get(APP2, 'bf1'))?.effect).toBe('deny');
      expect((await pg.list(APP2, {})).map((p) => p.id).sort()).toEqual(['bf1', 'bf2']);
    } finally {
      if (prev === undefined) delete process.env.FORGE_STATE_DIR;
      else process.env.FORGE_STATE_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
