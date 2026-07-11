import type { Pool, PoolClient } from 'pg';
import { nowIso } from '../../../shared/time';
import type { Notification } from '../../../notifications/types';
import type {
  NotificationBackend,
  MigratableNotificationBackend,
  NotificationUpsertInput,
  NotificationListOpts,
} from './types';

// P26 (increment 4) — the POSTGRES notification backend: keyed durable state in a table. Upsert is one
// `INSERT … ON CONFLICT (app_id, owner, key) DO UPDATE` — NO whole-map read-modify-write, so concurrent
// upserts to distinct keys never lose an update and the P27-class race is gone (the DB serializes rows).
// Dismiss/clear are targeted UPDATE/DELETE; the list is an indexed read. Owner is stored as a NOT-NULL
// column with an EMPTY-STRING sentinel for legacy/app-scoped records, so a NULL doesn't defeat the
// (app_id, owner, key) uniqueness (NULLs are distinct in a unique index) — an owner-less re-derive stays
// idempotent. The O4 (owner, group_id, visibility) columns are baked in + defaulted.

export async function ensureNotificationSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_notifications (
      app_id     text NOT NULL,
      owner      text NOT NULL DEFAULT '',  -- '' = legacy/app-scoped (keeps (app,owner,key) uniqueness real)
      key        text NOT NULL,
      title      text NOT NULL,
      body       text,
      data       jsonb NOT NULL DEFAULT '{}',
      subject    text,
      dismissed  boolean NOT NULL DEFAULT false,
      created_at text NOT NULL,   -- ISO-8601, verbatim
      updated_at text NOT NULL,
      -- O4 ownership scope (baked in; households/C31 light up with no migration).
      group_id   text,
      visibility text NOT NULL DEFAULT 'private',
      PRIMARY KEY (app_id, owner, key)
    );
    CREATE INDEX IF NOT EXISTS forge_notifications_list ON forge_notifications (app_id, owner, created_at DESC);
  `);
}

// The `owner` column is never NULL — legacy/app-scoped records use '' so uniqueness works. Map back to
// the domain shape (owner omitted when '').
const toOwnerCol = (owner: string | undefined): string => owner ?? '';

interface NotifRow {
  owner: string; key: string; title: string; body: string | null; data: unknown; subject: string | null;
  dismissed: boolean; created_at: string; updated_at: string;
}
function rowToNotification(r: NotifRow): Notification {
  return {
    key: r.key,
    title: r.title,
    ...(r.body != null ? { body: r.body } : {}),
    data: (r.data as Record<string, unknown>) ?? {},
    ...(r.subject != null ? { subject: r.subject } : {}),
    ...(r.owner !== '' ? { owner: r.owner } : {}),
    dismissed: r.dismissed,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// Upsert preserving `dismissed` + `created_at` (a re-derived, still-true condition does not resurface,
// and its age is kept) — DO UPDATE touches only title/body/data/subject/updated_at.
const UPSERT_SQL = `
  INSERT INTO forge_notifications (app_id, owner, key, title, body, data, subject, dismissed, created_at, updated_at, group_id, visibility)
  VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,false,$8,$8, NULL, 'private')
  ON CONFLICT (app_id, owner, key) DO UPDATE SET
    title = EXCLUDED.title, body = EXCLUDED.body, data = EXCLUDED.data,
    subject = EXCLUDED.subject, updated_at = EXCLUDED.updated_at
  RETURNING owner, key, title, body, data, subject, dismissed, created_at, updated_at`;

function upsertParams(appId: string, input: NotificationUpsertInput, now: string): unknown[] {
  return [appId, toOwnerCol(input.owner), input.key, input.title, input.body ?? null, JSON.stringify(input.data ?? {}), input.subject ?? null, now];
}

export class PgNotificationBackend implements NotificationBackend, MigratableNotificationBackend {
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

  async upsert(appId: string, input: NotificationUpsertInput): Promise<Notification> {
    const r = await this.pool.query<NotifRow>(UPSERT_SQL, upsertParams(appId, input, nowIso()));
    return rowToNotification(r.rows[0]!);
  }

  async dismiss(appId: string, key: string, owner?: string): Promise<boolean> {
    const r = await this.pool.query(
      'UPDATE forge_notifications SET dismissed = true, updated_at = $4 WHERE app_id=$1 AND owner=$2 AND key=$3',
      [appId, toOwnerCol(owner), key, nowIso()],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async clear(appId: string, key: string, owner?: string): Promise<boolean> {
    const r = await this.pool.query(
      'DELETE FROM forge_notifications WHERE app_id=$1 AND owner=$2 AND key=$3',
      [appId, toOwnerCol(owner), key],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async list(appId: string, opts: NotificationListOpts): Promise<Notification[]> {
    // Indexed read, newest-first. Owner-scoped when `owner` is given (excludes the '' legacy records);
    // app-scoped (all owners) when omitted.
    const r = await this.pool.query<NotifRow>(
      `SELECT owner, key, title, body, data, subject, dismissed, created_at, updated_at
         FROM forge_notifications
        WHERE app_id = $1
          AND ($2::text IS NULL OR owner = $2)
          AND ($3::boolean OR dismissed = false)
        ORDER BY created_at DESC, key ASC`,
      [appId, opts.owner ?? null, opts.includeDismissed ?? false],
    );
    return r.rows.map(rowToNotification);
  }

  async assignOwner(appId: string, owner: string): Promise<number> {
    // One-time claim-legacy cutover: attribute every owner-less ('' ) record to `owner`, EXCEPT ones
    // that would collide with an existing (owner, key) — those are left legacy (matches the FS
    // re-key-skip-on-collision). Idempotent — a second run finds nothing to claim.
    const r = await this.pool.query(
      `UPDATE forge_notifications AS n
          SET owner = $2, updated_at = $3
        WHERE n.app_id = $1
          AND n.owner = ''
          AND NOT EXISTS (
            SELECT 1 FROM forge_notifications e
             WHERE e.app_id = n.app_id AND e.owner = $2 AND e.key = n.key
          )`,
      [appId, owner, nowIso()],
    );
    return r.rowCount ?? 0;
  }

  // --- migration surface ---------------------------------------------------
  async exportApp(appId: string): Promise<Notification[]> {
    const r = await this.pool.query<NotifRow>(
      'SELECT owner, key, title, body, data, subject, dismissed, created_at, updated_at FROM forge_notifications WHERE app_id=$1',
      [appId],
    );
    return r.rows.map(rowToNotification);
  }

  async importApp(appId: string, notifications: Notification[]): Promise<void> {
    await this.withTx(async (c) => {
      await c.query('DELETE FROM forge_notifications WHERE app_id=$1', [appId]);
      for (const n of notifications) {
        await c.query(
          `INSERT INTO forge_notifications (app_id, owner, key, title, body, data, subject, dismissed, created_at, updated_at, group_id, visibility)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10, NULL, 'private')`,
          [appId, toOwnerCol(n.owner), n.key, n.title, n.body ?? null, JSON.stringify(n.data ?? {}), n.subject ?? null, n.dismissed, n.created_at, n.updated_at],
        );
      }
    });
  }

  async __truncateAllForTests(): Promise<void> {
    await this.pool.query('TRUNCATE forge_notifications');
  }
}
