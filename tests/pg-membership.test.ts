import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { getBackends } from '../src/storage/backends';
import { FsMembershipBackend } from '../src/storage/backends/membership/fs';
import { PgMembershipBackend, ensureMembershipSchema } from '../src/storage/backends/membership/pg';
import { backfillMembership } from '../src/storage/backends/membership/migrate';
import { putRoles, provisionGroup } from '../src/membership/service';
import { memberKey, type RoleDef } from '../src/membership/types';
import { nowIso } from '../src/shared/time';

// C31 / P26 — Postgres membership backend-SPECIFIC coverage: the per-app jsonb document round-trips, a
// mutation is serialized (SELECT … FOR UPDATE) into ONE row, and the filesystem → Postgres backfill copies
// the whole graph. Runs ONLY when the Postgres membership backend is selected (`test:pg`); skipped on the
// default filesystem run.
const HAS_PG = process.env.FORGE_MEMBERSHIP_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

const ROLES: RoleDef[] = [
  { key: 'owner', permissions: ['members.invite'], rank: 100, owner_role: true, assignable: true },
  { key: 'member', permissions: [], rank: 10, owner_role: false, assignable: true },
];

describe.skipIf(!HAS_PG)('P26 Postgres membership backend — jsonb document, serialized mutate, backfill', () => {
  const APP = 'app_pg_membership';
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('read is empty until written; mutate persists roles + a provisioned group in ONE row', async () => {
    const b = (await getBackends()).membership;
    expect(await b.read(APP)).toEqual({ roles: [], groups: {}, members: {}, invitations: {} });

    await b.mutate(APP, (s) => putRoles(s, ROLES));
    const { group } = await b.mutate(APP, (s) =>
      provisionGroup(s, { owner: 'A', now: nowIso(), newGroupId: 'grp_1', dedupeOwnerSingleton: true }),
    );
    const state = await b.read(APP);
    expect(state.roles.map((r) => r.key)).toEqual(['owner', 'member']);
    expect(state.groups[group.id]).toMatchObject({ id: 'grp_1', singleton: true });
    expect(state.members[memberKey('grp_1', 'A')]).toMatchObject({ owner: 'A', role: 'owner', status: 'active' });

    const n = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM forge_membership WHERE app_id=$1', [APP]);
    expect(Number(n.rows[0]!.n)).toBe(1); // one document row per app
  });

  it('concurrent mutates are serialized — the group-of-one is provisioned exactly once', async () => {
    const APP2 = 'app_pg_membership_race';
    const b = (await getBackends()).membership;
    await b.mutate(APP2, (s) => putRoles(s, ROLES));
    // Fire many ensure-style provisions for the same owner at once; the owner-singleton dedupe under the
    // row lock must yield exactly one created:true.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        b.mutate(APP2, (s) => provisionGroup(s, { owner: 'Z', now: nowIso(), newGroupId: `grp_${Math.random().toString(36).slice(2)}`, dedupeOwnerSingleton: true })),
      ),
    );
    expect(results.filter((r) => r.created).length).toBe(1);
    const state = await b.read(APP2);
    expect(Object.keys(state.groups).length).toBe(1);
  });

  it('backfill (filesystem → Postgres) copies the whole membership document', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forge-membership-bf-'));
    const prev = process.env.FORGE_STATE_DIR;
    process.env.FORGE_STATE_DIR = dir;
    try {
      const APP3 = 'app_membership_backfill';
      const fs = new FsMembershipBackend();
      await fs.mutate(APP3, (s) => putRoles(s, ROLES));
      await fs.mutate(APP3, (s) => provisionGroup(s, { owner: 'A', now: nowIso(), newGroupId: 'grp_bf', dedupeOwnerSingleton: true }));

      await ensureMembershipSchema(pool);
      await pool.query('DELETE FROM forge_membership WHERE app_id=$1', [APP3]);
      const pg = new PgMembershipBackend(pool);
      expect(await backfillMembership(fs, pg, [APP3])).toEqual([{ app: APP3, groups: 1, members: 1, invitations: 0, roles: 2 }]);

      const state = await pg.read(APP3);
      expect(state.groups['grp_bf']).toBeTruthy();
      expect(state.members[memberKey('grp_bf', 'A')]?.role).toBe('owner');
    } finally {
      if (prev === undefined) delete process.env.FORGE_STATE_DIR;
      else process.env.FORGE_STATE_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
