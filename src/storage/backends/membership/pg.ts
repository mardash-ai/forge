import type { Pool } from 'pg';
import { type MembershipState, emptyMembershipState } from '../../../membership/types';
import type { MembershipBackend, MigratableMembershipBackend } from './types';

// C31 / P26 — the POSTGRES membership backend: one jsonb row per app in `forge_membership` holding the
// whole graph (roles + groups + members + invitations). A mutation runs inside a transaction that first
// ensures the row exists, then `SELECT … FOR UPDATE` locks it, applies the pure op in JS, and UPDATEs —
// so the multi-record invariants (≥1-owner / singleton flip / one-shot invitations) are serialized per app
// exactly like the FS per-app lock, without duplicating the logic.
export async function ensureMembershipSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_membership (
      app_id     text PRIMARY KEY,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

interface Row { data: MembershipState }

function normalize(data: Partial<MembershipState> | undefined): MembershipState {
  return {
    roles: Array.isArray(data?.roles) ? data!.roles : [],
    groups: data?.groups && typeof data.groups === 'object' ? data.groups : {},
    members: data?.members && typeof data.members === 'object' ? data.members : {},
    invitations: data?.invitations && typeof data.invitations === 'object' ? data.invitations : {},
  };
}

export class PgMembershipBackend implements MembershipBackend, MigratableMembershipBackend {
  constructor(private readonly pool: Pool) {}

  async read(appId: string): Promise<MembershipState> {
    const r = await this.pool.query<Row>('SELECT data FROM forge_membership WHERE app_id=$1', [appId]);
    return r.rows[0] ? normalize(r.rows[0].data) : emptyMembershipState();
  }

  async mutate<T>(appId: string, fn: (state: MembershipState) => { state: MembershipState; result: T }): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Ensure the row exists so the FOR UPDATE below always locks something (first-write safe).
      await client.query(
        `INSERT INTO forge_membership (app_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (app_id) DO NOTHING`,
        [appId, JSON.stringify(emptyMembershipState())],
      );
      const cur = await client.query<Row>('SELECT data FROM forge_membership WHERE app_id=$1 FOR UPDATE', [appId]);
      const state = normalize(cur.rows[0]?.data);
      const { state: next, result } = fn(state);
      await client.query('UPDATE forge_membership SET data=$2::jsonb, updated_at=now() WHERE app_id=$1', [appId, JSON.stringify(next)]);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  // --- migration surface ---------------------------------------------------
  async exportApp(appId: string): Promise<MembershipState> {
    return this.read(appId);
  }

  async importApp(appId: string, state: MembershipState): Promise<void> {
    await this.pool.query(
      `INSERT INTO forge_membership (app_id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (app_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
      [appId, JSON.stringify(state)],
    );
  }

  async __truncateAllForTests(): Promise<void> {
    await this.pool.query('TRUNCATE forge_membership');
  }
}
