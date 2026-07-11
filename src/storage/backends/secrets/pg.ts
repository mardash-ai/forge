import type { Pool } from 'pg';
import type { SecretsBackend, MigratableSecretsBackend, Sealed, Vault } from './types';

// P26 (increment 6) — the POSTGRES secrets backend: one SEALED row per (app, name). The row holds the
// AES-256-GCM ciphertext (iv/tag/data base64) — never plaintext, exactly like the FS vault. Writing a
// secret is a SINGLE `INSERT … ON CONFLICT DO UPDATE` — no whole-vault read-modify-write — which is the
// P27 fix on the Postgres path (the DB serializes the row; concurrent `secrets set`s can't lose an
// update). Contract-stable: the facade seals/opens under the master key; this only stores the ciphertext.

export async function ensureSecretsSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_secrets (
      app_id text NOT NULL,
      name   text NOT NULL,
      iv     text NOT NULL,   -- AES-256-GCM nonce (base64)
      tag    text NOT NULL,   -- GCM auth tag (base64)
      data   text NOT NULL,   -- ciphertext (base64) — NEVER plaintext
      PRIMARY KEY (app_id, name)
    );
  `);
}

export class PgSecretsBackend implements SecretsBackend, MigratableSecretsBackend {
  constructor(private readonly pool: Pool) {}

  async readVault(appId: string): Promise<Vault> {
    const r = await this.pool.query<{ name: string; iv: string; tag: string; data: string }>(
      'SELECT name, iv, tag, data FROM forge_secrets WHERE app_id=$1',
      [appId],
    );
    const vault: Vault = {};
    for (const row of r.rows) vault[row.name] = { iv: row.iv, tag: row.tag, data: row.data };
    return vault;
  }

  async setSecret(appId: string, name: string, sealed: Sealed): Promise<void> {
    await this.pool.query(
      `INSERT INTO forge_secrets (app_id, name, iv, tag, data) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (app_id, name) DO UPDATE SET iv=EXCLUDED.iv, tag=EXCLUDED.tag, data=EXCLUDED.data`,
      [appId, name, sealed.iv, sealed.tag, sealed.data],
    );
  }

  async unsetSecret(appId: string, name: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM forge_secrets WHERE app_id=$1 AND name=$2', [appId, name]);
    return (r.rowCount ?? 0) > 0;
  }

  async listNames(appId: string): Promise<string[]> {
    const r = await this.pool.query<{ name: string }>('SELECT name FROM forge_secrets WHERE app_id=$1 ORDER BY name ASC', [appId]);
    return r.rows.map((row) => row.name);
  }

  // --- migration surface ---------------------------------------------------
  async exportApp(appId: string): Promise<Vault> {
    return this.readVault(appId);
  }

  async importApp(appId: string, vault: Vault): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM forge_secrets WHERE app_id=$1', [appId]);
      for (const [name, sealed] of Object.entries(vault)) {
        await client.query('INSERT INTO forge_secrets (app_id, name, iv, tag, data) VALUES ($1,$2,$3,$4,$5)', [appId, name, sealed.iv, sealed.tag, sealed.data]);
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async __truncateAllForTests(): Promise<void> {
    await this.pool.query('TRUNCATE forge_secrets');
  }
}
