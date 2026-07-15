import type { Pool } from 'pg';
import type { PolicyRule } from '../../../authz/types';
import type { PolicyBackend, MigratablePolicyBackend } from './types';

// C29 / P26 — the POSTGRES policy backend: one row per policy in `forge_policies`. The full PolicyRule
// rides `data jsonb` (exact round-trip); owner/effect/priority are projected into columns for the
// owner-scoped list + ordering. `put` is a single upsert (transactional). The O4 (owner, group_id,
// visibility) columns are baked in.
export async function ensurePolicySchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_policies (
      app_id     text NOT NULL,
      id         text NOT NULL,
      owner      text,           -- NULL = app-wide (applies to every actor)
      effect     text NOT NULL,  -- allow | needs-approval | deny
      priority   integer NOT NULL DEFAULT 0,
      data       jsonb NOT NULL,
      created_at text,
      updated_at text,
      -- O4 ownership scope (baked in; households/C31 light up with no migration).
      group_id   text,
      visibility text NOT NULL DEFAULT 'private',
      PRIMARY KEY (app_id, id)
    );
    CREATE INDEX IF NOT EXISTS forge_policies_owner ON forge_policies (app_id, owner);
  `);
}

interface PolicyRow { data: PolicyRule }

const UPSERT_SQL = `
  INSERT INTO forge_policies (app_id, id, owner, effect, priority, data, created_at, updated_at, group_id, visibility)
  VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
  ON CONFLICT (app_id, id) DO UPDATE SET
    owner=EXCLUDED.owner, effect=EXCLUDED.effect, priority=EXCLUDED.priority, data=EXCLUDED.data,
    created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at, group_id=EXCLUDED.group_id, visibility=EXCLUDED.visibility`;

function upsertParams(appId: string, p: PolicyRule): unknown[] {
  return [appId, p.id, p.owner ?? null, p.effect, p.priority, JSON.stringify(p), p.created_at ?? null, p.updated_at ?? null, p.group_id ?? null, p.visibility ?? 'private'];
}

export class PgPolicyBackend implements PolicyBackend, MigratablePolicyBackend {
  constructor(private readonly pool: Pool) {}

  async put(appId: string, policy: PolicyRule): Promise<PolicyRule> {
    await this.pool.query(UPSERT_SQL, upsertParams(appId, policy));
    return policy;
  }

  async get(appId: string, id: string): Promise<PolicyRule | null> {
    const r = await this.pool.query<PolicyRow>('SELECT data FROM forge_policies WHERE app_id=$1 AND id=$2', [appId, id]);
    return r.rows[0] ? r.rows[0].data : null;
  }

  async delete(appId: string, id: string, opts: { owner?: string } = {}): Promise<boolean> {
    // Owner-scoped delete (opts.owner set) adds `AND owner=$3`, so a caller can remove only its own rules
    // (an app-wide/owner-less or another owner's rule never matches). No owner = management delete (any id).
    const r =
      opts.owner === undefined
        ? await this.pool.query('DELETE FROM forge_policies WHERE app_id=$1 AND id=$2', [appId, id])
        : await this.pool.query('DELETE FROM forge_policies WHERE app_id=$1 AND id=$2 AND owner=$3', [appId, id, opts.owner]);
    return (r.rowCount ?? 0) > 0;
  }

  async list(appId: string, opts: { owner?: string }): Promise<PolicyRule[]> {
    const r = await this.pool.query<PolicyRow>(
      `SELECT data FROM forge_policies
        WHERE app_id = $1 AND ($2::text IS NULL OR owner = $2 OR owner IS NULL)
        ORDER BY priority DESC, id ASC`,
      [appId, opts.owner ?? null],
    );
    return r.rows.map((row) => row.data);
  }

  // --- migration surface ---------------------------------------------------
  async exportApp(appId: string): Promise<PolicyRule[]> {
    const r = await this.pool.query<PolicyRow>('SELECT data FROM forge_policies WHERE app_id=$1', [appId]);
    return r.rows.map((row) => row.data);
  }

  async importApp(appId: string, policies: PolicyRule[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM forge_policies WHERE app_id=$1', [appId]);
      for (const p of policies) await client.query(UPSERT_SQL, upsertParams(appId, p));
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async __truncateAllForTests(): Promise<void> {
    await this.pool.query('TRUNCATE forge_policies');
  }
}
