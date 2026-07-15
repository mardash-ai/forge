import type { Pool, PoolClient } from 'pg';
import { nowIso } from '../../../shared/time';
import type {
  PushBackend,
  MigratablePushBackend,
  PushSubscriptionRecord,
  PushSubscriptionInput,
  PushExport,
} from './types';

// C21 / P26 — the POSTGRES notification-delivery backend: push subscriptions + the delivery-idempotency
// ledger as two tables. A subscription upsert is one `INSERT … ON CONFLICT (app_id, endpoint) DO UPDATE`
// (dedupe by endpoint, no whole-doc rewrite). A delivery claim is `INSERT … ON CONFLICT DO NOTHING`
// returning the row count — the DB serializes it, so a concurrent double-submit yields exactly one
// claimer (first-writer-wins) with no app lock. Owner is a NOT-NULL column (subscriptions are always
// user-scoped). Holds NO secret material — only the browser-public p256dh/auth keys.

export async function ensurePushSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_push_subscriptions (
      app_id     text NOT NULL,
      endpoint   text NOT NULL,
      owner      text NOT NULL,
      p256dh     text NOT NULL,
      auth       text NOT NULL,
      created_at text NOT NULL,   -- ISO-8601, verbatim
      updated_at text NOT NULL,
      PRIMARY KEY (app_id, endpoint)
    );
    CREATE INDEX IF NOT EXISTS forge_push_subscriptions_owner ON forge_push_subscriptions (app_id, owner);

    CREATE TABLE IF NOT EXISTS forge_push_deliveries (
      app_id      text NOT NULL,
      owner       text NOT NULL,
      idem_key    text NOT NULL,
      claimed_at  text NOT NULL,  -- ISO-8601
      PRIMARY KEY (app_id, owner, idem_key)
    );
    CREATE INDEX IF NOT EXISTS forge_push_deliveries_claimed ON forge_push_deliveries (app_id, claimed_at);
  `);
}

interface SubRow {
  endpoint: string;
  owner: string;
  p256dh: string;
  auth: string;
  created_at: string;
  updated_at: string;
}
function rowToSub(r: SubRow): PushSubscriptionRecord {
  return {
    endpoint: r.endpoint,
    keys: { p256dh: r.p256dh, auth: r.auth },
    owner: r.owner,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export class PgPushBackend implements PushBackend, MigratablePushBackend {
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

  async registerSubscription(appId: string, input: PushSubscriptionInput): Promise<PushSubscriptionRecord> {
    const now = nowIso();
    const r = await this.pool.query<SubRow>(
      `INSERT INTO forge_push_subscriptions (app_id, endpoint, owner, p256dh, auth, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6)
       ON CONFLICT (app_id, endpoint) DO UPDATE SET
         owner = EXCLUDED.owner, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, updated_at = EXCLUDED.updated_at
       RETURNING endpoint, owner, p256dh, auth, created_at, updated_at`,
      [appId, input.endpoint, input.owner, input.keys.p256dh, input.keys.auth, now],
    );
    return rowToSub(r.rows[0]!);
  }

  async unregisterSubscription(appId: string, endpoint: string, owner?: string): Promise<boolean> {
    const r =
      owner === undefined
        ? await this.pool.query('DELETE FROM forge_push_subscriptions WHERE app_id=$1 AND endpoint=$2', [appId, endpoint])
        : await this.pool.query('DELETE FROM forge_push_subscriptions WHERE app_id=$1 AND endpoint=$2 AND owner=$3', [appId, endpoint, owner]);
    return (r.rowCount ?? 0) > 0;
  }

  async listSubscriptions(appId: string, owner: string): Promise<PushSubscriptionRecord[]> {
    const r = await this.pool.query<SubRow>(
      `SELECT endpoint, owner, p256dh, auth, created_at, updated_at
         FROM forge_push_subscriptions WHERE app_id=$1 AND owner=$2 ORDER BY created_at ASC, endpoint ASC`,
      [appId, owner],
    );
    return r.rows.map(rowToSub);
  }

  async pruneSubscription(appId: string, endpoint: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM forge_push_subscriptions WHERE app_id=$1 AND endpoint=$2', [appId, endpoint]);
    return (r.rowCount ?? 0) > 0;
  }

  async claimDelivery(appId: string, owner: string, idemKey: string, when: string): Promise<boolean> {
    // Atomic first-writer-wins: only the INSERT that actually adds the row claims the key.
    const r = await this.pool.query(
      `INSERT INTO forge_push_deliveries (app_id, owner, idem_key, claimed_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT (app_id, owner, idem_key) DO NOTHING`,
      [appId, owner, idemKey, when],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async pruneDeliveriesBefore(appId: string, cutoffIso: string): Promise<number> {
    const r = await this.pool.query('DELETE FROM forge_push_deliveries WHERE app_id=$1 AND claimed_at < $2', [appId, cutoffIso]);
    return r.rowCount ?? 0;
  }

  // --- migration surface ----------------------------------------------------
  async exportApp(appId: string): Promise<PushExport> {
    const subs = await this.pool.query<SubRow>(
      'SELECT endpoint, owner, p256dh, auth, created_at, updated_at FROM forge_push_subscriptions WHERE app_id=$1',
      [appId],
    );
    const delivs = await this.pool.query<{ owner: string; idem_key: string; claimed_at: string }>(
      'SELECT owner, idem_key, claimed_at FROM forge_push_deliveries WHERE app_id=$1',
      [appId],
    );
    return { subscriptions: subs.rows.map(rowToSub), deliveries: delivs.rows };
  }

  async importApp(appId: string, data: PushExport): Promise<void> {
    await this.withTx(async (c) => {
      await c.query('DELETE FROM forge_push_subscriptions WHERE app_id=$1', [appId]);
      await c.query('DELETE FROM forge_push_deliveries WHERE app_id=$1', [appId]);
      for (const s of data.subscriptions) {
        await c.query(
          `INSERT INTO forge_push_subscriptions (app_id, endpoint, owner, p256dh, auth, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [appId, s.endpoint, s.owner, s.keys.p256dh, s.keys.auth, s.created_at, s.updated_at],
        );
      }
      for (const d of data.deliveries) {
        await c.query(
          `INSERT INTO forge_push_deliveries (app_id, owner, idem_key, claimed_at) VALUES ($1,$2,$3,$4)`,
          [appId, d.owner, d.idem_key, d.claimed_at],
        );
      }
    });
  }

  async __truncateAllForTests(): Promise<void> {
    await this.pool.query('TRUNCATE forge_push_subscriptions, forge_push_deliveries');
  }
}
