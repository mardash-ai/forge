import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { store } from '../src/storage/store';
import { FsResourceBackend } from '../src/storage/backends/resources/fs';
import { PgResourceBackend, ensureResourceSchema } from '../src/storage/backends/resources/pg';
import { backfillResources } from '../src/storage/backends/resources/migrate';
import { nowIso } from '../src/shared/time';
import type { AgentTask, Application } from '../src/resources/types';

// P26 (increment 6) — Postgres resource backend-SPECIFIC coverage: exact jsonb round-trip, the O4 scope
// columns, owner-scoped list + claim-legacy, the transactional-upsert P27 fix (concurrent saves to
// distinct ids never lost), and id-preserving backfill. Runs ONLY when the Postgres resource backend is
// selected (`test:pg`); skipped in the default filesystem run.
const HAS_PG = process.env.FORGE_RESOURCES_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

const agentTask = (id: string, over: Partial<AgentTask> = {}): AgentTask => ({
  id, type: 'AgentTask', app_id: 'app_r', created_at: nowIso(), updated_at: nowIso(),
  label: 'planner', status: 'succeeded', model: 'claude-x', artifact: { ok: true }, implementation: 'model-anthropic',
  ...over,
});

describe.skipIf(!HAS_PG)('P26 Postgres resource backend — jsonb round-trip, O4, claim-legacy, P27, backfill', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('round-trips a resource exactly through the jsonb column, with the O4 scope defaulted', async () => {
    const t = agentTask('at_1', { owner: 'A', artifact: { nested: { n: 1, arr: [1, 2, 3], flag: true } } });
    await store.saveResource(t);
    const got = await store.getResource<AgentTask>('AgentTask', 'at_1');
    expect(got).toEqual(t); // exact round-trip (nested object, array, boolean)

    const row = await pool.query<{ owner: string; visibility: string; group_id: string | null }>(
      "SELECT owner, visibility, group_id FROM forge_resources WHERE type='AgentTask' AND id='at_1'",
      [],
    );
    expect(row.rows[0]).toMatchObject({ owner: 'A', visibility: 'private', group_id: null });
  });

  it('owner-scoped list excludes owner-less; claim-legacy stamps them (idempotent)', async () => {
    await store.saveResource(agentTask('at_owned', { owner: 'A' }));
    await store.saveResource(agentTask('at_legacy1'));            // owner-less
    await store.saveResource(agentTask('at_legacy2'));            // owner-less

    // Owner-scoped list sees only A's; app-scoped sees all three.
    expect((await store.listResources({ type: 'AgentTask', app_id: 'app_r', owner: 'A' })).map((r) => r.id)).toEqual(['at_owned']);
    expect((await store.listResources({ type: 'AgentTask', app_id: 'app_r' })).length).toBe(3);

    // claim-legacy attributes the two legacy runs to A (count 2), and stamps the jsonb owner too.
    expect(await store.assignResourceOwner('AgentTask', 'app_r', 'A')).toBe(2);
    const claimed = await store.getResource<AgentTask>('AgentTask', 'at_legacy1');
    expect((claimed as { owner?: string }).owner).toBe('A');
    expect((await store.listResources({ type: 'AgentTask', app_id: 'app_r', owner: 'A' })).length).toBe(3);
    expect(await store.assignResourceOwner('AgentTask', 'app_r', 'A')).toBe(0); // idempotent
  });

  it('findAppByName resolves an Application by its data->>name', async () => {
    const app: Application = {
      id: 'app_named', type: 'Application', app_id: 'app_named', created_at: nowIso(), updated_at: nowIso(),
      name: 'my-app', repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web', language: 'typescript', package_manager: 'npm',
    };
    await store.saveResource(app);
    expect((await store.findAppByName('my-app'))?.id).toBe('app_named');
    expect(await store.findAppByName('nope')).toBeNull();
  });

  it('closes P27: concurrent saves to distinct ids all persist (transactional upsert, no torn write)', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `at_c${i}`);
    await Promise.all(ids.map((id) => store.saveResource(agentTask(id, { app_id: 'app_conc' }))));
    const listed = await store.listResources({ type: 'AgentTask', app_id: 'app_conc' });
    expect(new Set(listed.map((r) => r.id))).toEqual(new Set(ids));
  });

  it('backfill (filesystem → Postgres) preserves resource ids + shapes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forge-res-bf-'));
    const prev = process.env.FORGE_STATE_DIR;
    process.env.FORGE_STATE_DIR = dir;
    try {
      const fs = new FsResourceBackend();
      await fs.save(agentTask('at_bf1', { app_id: 'app_bf', owner: 'A' }));
      await fs.save(agentTask('at_bf2', { app_id: 'app_bf' }));

      await ensureResourceSchema(pool);
      await pool.query("DELETE FROM forge_resources WHERE app_id='app_bf'");
      const pg = new PgResourceBackend(pool);
      const res = await backfillResources(fs, pg);
      expect(res.resources).toBeGreaterThanOrEqual(2);

      expect((await pg.get('AgentTask', 'at_bf1'))?.id).toBe('at_bf1');
      expect((await pg.list({ type: 'AgentTask', app_id: 'app_bf' })).map((r) => r.id).sort()).toEqual(['at_bf1', 'at_bf2']);
    } finally {
      if (prev === undefined) delete process.env.FORGE_STATE_DIR;
      else process.env.FORGE_STATE_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
