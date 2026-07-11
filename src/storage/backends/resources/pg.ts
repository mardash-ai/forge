import type { Pool } from 'pg';
import { nowIso } from '../../../shared/time';
import type { AnyResource, ResourceType, BaseResource } from '../../../resources/types';
import type { ResourceBackend, MigratableResourceBackend } from './types';

// P26 (increment 6) — the POSTGRES resource backend: one `jsonb` row per resource in `forge_resources`,
// keyed by (type, id). `save` is a SINGLE `INSERT … ON CONFLICT DO UPDATE` — transactional, so the
// P27 torn-write on the Resource store is gone. The full resource object rides the `data` jsonb (exact
// round-trip); type/id/app_id/owner/timestamps are also projected into columns for indexed filtering.
// Owner-scoping (C11) + the O4 (owner, group_id, visibility) columns are baked in.

export async function ensureResourceSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_resources (
      type       text NOT NULL,
      id         text NOT NULL,
      app_id     text,
      owner      text,
      created_at text,
      updated_at text,
      data       jsonb NOT NULL,
      -- O4 ownership scope (baked in; households/C31 light up with no migration).
      group_id   text,
      visibility text NOT NULL DEFAULT 'private',
      PRIMARY KEY (type, id)
    );
    CREATE INDEX IF NOT EXISTS forge_resources_scope ON forge_resources (type, app_id, owner);
    CREATE INDEX IF NOT EXISTS forge_resources_id ON forge_resources (id);
  `);
}

interface ResRow { data: AnyResource }

const UPSERT_SQL = `
  INSERT INTO forge_resources (type, id, app_id, owner, created_at, updated_at, data)
  VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
  ON CONFLICT (type, id) DO UPDATE SET
    app_id=EXCLUDED.app_id, owner=EXCLUDED.owner, created_at=EXCLUDED.created_at,
    updated_at=EXCLUDED.updated_at, data=EXCLUDED.data`;

function upsertParams(r: BaseResource): unknown[] {
  const any = r as AnyResource;
  return [r.type, r.id, any.app_id ?? null, any.owner ?? null, any.created_at ?? null, any.updated_at ?? null, JSON.stringify(r)];
}

export class PgResourceBackend implements ResourceBackend, MigratableResourceBackend {
  constructor(private readonly pool: Pool) {}

  async save<T extends BaseResource>(resource: T): Promise<T> {
    await this.pool.query(UPSERT_SQL, upsertParams(resource));
    return resource;
  }

  async get<T extends AnyResource = AnyResource>(type: ResourceType, id: string): Promise<T | null> {
    const r = await this.pool.query<ResRow>('SELECT data FROM forge_resources WHERE type=$1 AND id=$2', [type, id]);
    return r.rows[0] ? (r.rows[0].data as T) : null;
  }

  async delete(type: ResourceType, id: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM forge_resources WHERE type=$1 AND id=$2', [type, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async findById(id: string): Promise<AnyResource | null> {
    const r = await this.pool.query<ResRow>('SELECT data FROM forge_resources WHERE id=$1 LIMIT 1', [id]);
    return r.rows[0] ? r.rows[0].data : null;
  }

  async list(filter: { type?: ResourceType; app_id?: string; owner?: string } = {}): Promise<AnyResource[]> {
    const r = await this.pool.query<ResRow>(
      `SELECT data FROM forge_resources
        WHERE ($1::text IS NULL OR type = $1)
          AND ($2::text IS NULL OR app_id = $2)
          AND ($3::text IS NULL OR owner = $3)
        ORDER BY created_at DESC NULLS LAST, id ASC`,
      [filter.type ?? null, filter.app_id ?? null, filter.owner ?? null],
    );
    return r.rows.map((row) => row.data);
  }

  async assignOwner(type: ResourceType, app_id: string, owner: string): Promise<number> {
    // Stamp `owner` onto every owner-less resource of this type for the app (both the column and the
    // jsonb `owner`/`updated_at`), in one indexed UPDATE. Idempotent — a second run claims nothing.
    const now = nowIso();
    const r = await this.pool.query(
      `UPDATE forge_resources
          SET owner = $3, updated_at = $4,
              data = jsonb_set(jsonb_set(data, '{owner}', to_jsonb($3::text)), '{updated_at}', to_jsonb($4::text))
        WHERE type = $1 AND app_id = $2 AND owner IS NULL`,
      [type, app_id, owner, now],
    );
    return r.rowCount ?? 0;
  }

  async findAppByName(name: string): Promise<AnyResource | null> {
    const r = await this.pool.query<ResRow>(
      "SELECT data FROM forge_resources WHERE type='Application' AND data->>'name' = $1 LIMIT 1",
      [name],
    );
    return r.rows[0] ? r.rows[0].data : null;
  }

  // --- migration surface ---------------------------------------------------
  async exportAll(): Promise<AnyResource[]> {
    const r = await this.pool.query<ResRow>('SELECT data FROM forge_resources');
    return r.rows.map((row) => row.data);
  }

  async importAll(resources: AnyResource[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const res of resources) await client.query(UPSERT_SQL, upsertParams(res as BaseResource));
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async __truncateAllForTests(): Promise<void> {
    await this.pool.query('TRUNCATE forge_resources');
  }
}
