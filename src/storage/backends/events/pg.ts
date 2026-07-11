import type { Pool, PoolClient } from 'pg';
import { newId } from '../../../shared/ids';
import { nowIso } from '../../../shared/time';
import type { AppEvent } from '../../../events/app-events';
import {
  clampEventLimit,
  type EventBackend,
  type MigratableEventBackend,
  type AppEventInput,
  type AppEventListOpts,
} from './types';

// P26 (increment 3) — the POSTGRES event backend: an APPEND table for the C3 timeline (the highest-write
// store). B-tree indexes on (app_id, owner, at) and (app_id, subject); the per-(app, owner) feed is an
// indexed range read (newest-first), and "latest time per subject" is a single DISTINCT ON — NOT the
// filesystem backend's whole-file scan-and-parse. A monotonic `seq` (IDENTITY) preserves append order as
// the deterministic newest-first tiebreak (so events sharing an `at` millisecond keep insertion order,
// exactly like the JSONL backend). Timestamps (`at`) are stored VERBATIM (the app-supplied/emit ISO) and
// ids are preserved. Owner-scoping (C11) + the O4 (owner, group_id, visibility) columns are baked in.

export async function ensureEventSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_app_events (
      app_id     text NOT NULL,
      id         text NOT NULL,
      seq        bigint GENERATED ALWAYS AS IDENTITY,  -- append order (deterministic newest-first tiebreak)
      type       text NOT NULL,
      subject    text,
      owner      text,
      data       jsonb NOT NULL DEFAULT '{}',
      at         text NOT NULL,   -- ISO-8601, verbatim
      -- O4 ownership scope (baked in; households/C31 light up with no migration).
      group_id   text,
      visibility text NOT NULL DEFAULT 'private',
      PRIMARY KEY (app_id, id)
    );
    CREATE INDEX IF NOT EXISTS forge_app_events_owner_at ON forge_app_events (app_id, owner, at DESC);
    CREATE INDEX IF NOT EXISTS forge_app_events_subject  ON forge_app_events (app_id, subject);
  `);
}

interface EventRow {
  id: string; app_id: string; type: string; subject: string | null; owner: string | null; data: unknown; at: string;
}
function rowToEvent(r: EventRow): AppEvent {
  return {
    id: r.id,
    app_id: r.app_id,
    type: r.type,
    ...(r.subject != null ? { subject: r.subject } : {}),
    ...(r.owner != null ? { owner: r.owner } : {}),
    data: (r.data as Record<string, unknown>) ?? {},
    at: r.at,
  };
}

const INSERT_SQL = `
  INSERT INTO forge_app_events (app_id, id, type, subject, owner, data, at, group_id, visibility)
  VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7, NULL, 'private')`;

export class PgEventBackend implements EventBackend, MigratableEventBackend {
  constructor(private readonly pool: Pool) {}

  private async withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async append(appId: string, input: AppEventInput): Promise<AppEvent> {
    const event: AppEvent = {
      id: newId('aevt'),
      app_id: appId,
      type: input.type,
      subject: input.subject,
      owner: input.owner,
      data: input.data ?? {},
      at: nowIso(),
    };
    await this.pool.query(INSERT_SQL, [appId, event.id, event.type, input.subject ?? null, input.owner ?? null, JSON.stringify(event.data), event.at]);
    return event;
  }

  async list(appId: string, opts: AppEventListOpts): Promise<AppEvent[]> {
    // Indexed range read, newest-first. `at DESC, seq DESC` = insertion order reversed (deterministic).
    const r = await this.pool.query<EventRow>(
      `SELECT app_id, id, type, subject, owner, data, at
         FROM forge_app_events
        WHERE app_id = $1
          AND ($2::text IS NULL OR owner = $2)
          AND ($3::text IS NULL OR subject = $3)
        ORDER BY at DESC, seq DESC
        LIMIT $4`,
      [appId, opts.owner ?? null, opts.subject ?? null, clampEventLimit(opts.limit)],
    );
    return r.rows.map(rowToEvent);
  }

  async latestTimes(appId: string, owner?: string): Promise<Record<string, string>> {
    // "Latest time per subject" — one DISTINCT ON, not a whole-log scan. Owner-scoped; subject-less
    // events are excluded (they have no subject to key on).
    const r = await this.pool.query<{ subject: string; at: string }>(
      `SELECT DISTINCT ON (subject) subject, at
         FROM forge_app_events
        WHERE app_id = $1
          AND subject IS NOT NULL
          AND ($2::text IS NULL OR owner = $2)
        ORDER BY subject, at DESC, seq DESC`,
      [appId, owner ?? null],
    );
    const out: Record<string, string> = {};
    for (const row of r.rows) out[row.subject] = row.at;
    return out;
  }

  async assignOwner(appId: string, owner: string): Promise<number> {
    // One-time claim-legacy cutover: attribute every owner-less (legacy) event to `owner`. Idempotent —
    // a second run finds no owner-less rows and claims 0.
    const r = await this.pool.query(
      'UPDATE forge_app_events SET owner = $2 WHERE app_id = $1 AND owner IS NULL',
      [appId, owner],
    );
    return r.rowCount ?? 0;
  }

  // --- migration surface (oldest-first, insertion order preserved via seq) --
  async exportApp(appId: string): Promise<AppEvent[]> {
    const r = await this.pool.query<EventRow>(
      'SELECT app_id, id, type, subject, owner, data, at FROM forge_app_events WHERE app_id=$1 ORDER BY seq ASC',
      [appId],
    );
    return r.rows.map(rowToEvent);
  }

  async importApp(appId: string, events: AppEvent[]): Promise<void> {
    await this.withTx(async (c) => {
      await c.query('DELETE FROM forge_app_events WHERE app_id=$1', [appId]);
      // Insert in array order (oldest-first) so `seq` reflects the original append order.
      for (const e of events) {
        await c.query(INSERT_SQL, [appId, e.id, e.type, e.subject ?? null, e.owner ?? null, JSON.stringify(e.data ?? {}), e.at]);
      }
    });
  }

  async __truncateAllForTests(): Promise<void> {
    await this.pool.query('TRUNCATE forge_app_events');
  }
}
