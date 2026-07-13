import type { Pool } from 'pg';
import { type BillingState, emptyBillingState } from '../../../billing/state';
import type { BillingBackend, MigratableBillingBackend } from './types';

// C33 / P26 — the POSTGRES billing backend: one jsonb row per app in `forge_billing` holding the whole
// billing state (catalog + subscriptions + webhook-event dedupe). A mutation runs inside a transaction that
// ensures the row exists, then `SELECT … FOR UPDATE` locks it, applies the pure op in JS, and UPDATEs — so
// the monotonic-version subscription upsert + one-shot webhook dedupe are serialized per app exactly like
// the FS per-app lock, without duplicating the logic. Holds NO card data / raw secret — only the
// subscription-of-record + provider handle ids.
export async function ensureBillingSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_billing (
      app_id     text PRIMARY KEY,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

interface Row { data: BillingState }

function normalize(data: Partial<BillingState> | undefined): BillingState {
  return {
    catalog: data?.catalog ?? null,
    subscriptions: data?.subscriptions && typeof data.subscriptions === 'object' ? data.subscriptions : {},
    webhook_events: data?.webhook_events && typeof data.webhook_events === 'object' ? data.webhook_events : {},
  };
}

export class PgBillingBackend implements BillingBackend, MigratableBillingBackend {
  constructor(private readonly pool: Pool) {}

  async read(appId: string): Promise<BillingState> {
    const r = await this.pool.query<Row>('SELECT data FROM forge_billing WHERE app_id=$1', [appId]);
    return r.rows[0] ? normalize(r.rows[0].data) : emptyBillingState();
  }

  async mutate<T>(appId: string, fn: (state: BillingState) => { state: BillingState; result: T }): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Ensure the row exists so the FOR UPDATE below always locks something (first-write safe).
      await client.query(
        `INSERT INTO forge_billing (app_id, data) VALUES ($1, $2::jsonb) ON CONFLICT (app_id) DO NOTHING`,
        [appId, JSON.stringify(emptyBillingState())],
      );
      const cur = await client.query<Row>('SELECT data FROM forge_billing WHERE app_id=$1 FOR UPDATE', [appId]);
      const state = normalize(cur.rows[0]?.data);
      const { state: next, result } = fn(state);
      await client.query('UPDATE forge_billing SET data=$2::jsonb, updated_at=now() WHERE app_id=$1', [appId, JSON.stringify(next)]);
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
  async exportApp(appId: string): Promise<BillingState> {
    return this.read(appId);
  }

  async importApp(appId: string, state: BillingState): Promise<void> {
    await this.pool.query(
      `INSERT INTO forge_billing (app_id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (app_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
      [appId, JSON.stringify(state)],
    );
  }

  async __truncateAllForTests(): Promise<void> {
    await this.pool.query('TRUNCATE forge_billing');
  }
}
