import type { Pool } from 'pg';
import type { Connection, ConnectRequest } from '../../../connectors/types';
import type { ConnectionBackend, MigratableConnectionBackend, ConnectionsExport } from './types';

// C24 / P26 — the POSTGRES connector-vault backend: one table per record kind. The full object rides
// `data jsonb` (exact round-trip, SEALED tokens only — never plaintext); projected columns are what the
// queries filter/order/upsert on. A pending connect request is ONE-SHOT — consumeRequest is a
// `DELETE … RETURNING data` (atomic, no double-spend), exactly like the C23 authorization-code path.
export async function ensureConnectionsSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_connections (
      app_id     text NOT NULL,
      owner      text NOT NULL,
      provider   text NOT NULL,
      status     text NOT NULL DEFAULT 'connected',
      expires_at text,
      data       jsonb NOT NULL,   -- the full Connection; access/refresh tokens are AES-256-GCM ciphertext
      updated_at text,
      PRIMARY KEY (app_id, owner, provider)
    );
    CREATE INDEX IF NOT EXISTS forge_connections_owner ON forge_connections (app_id, owner);
    CREATE TABLE IF NOT EXISTS forge_connection_requests (
      app_id     text NOT NULL,
      state      text NOT NULL,
      owner      text NOT NULL,
      provider   text NOT NULL,
      expires_at text,
      data       jsonb NOT NULL,   -- the full ConnectRequest (PKCE verifier + owner captured at start)
      PRIMARY KEY (app_id, state)
    );
  `);
}

interface DataRow<T> { data: T }

export class PgConnectionBackend implements ConnectionBackend, MigratableConnectionBackend {
  constructor(private readonly pool: Pool) {}

  // --- connections ----------------------------------------------------------
  async putConnection(appId: string, conn: Connection): Promise<Connection> {
    await this.pool.query(
      `INSERT INTO forge_connections (app_id, owner, provider, status, expires_at, data, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT (app_id, owner, provider) DO UPDATE SET
         status=EXCLUDED.status, expires_at=EXCLUDED.expires_at, data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`,
      [appId, conn.owner, conn.provider, conn.status, conn.access_expires_at, JSON.stringify(conn), conn.updated_at],
    );
    return conn;
  }
  async getConnection(appId: string, owner: string, provider: string): Promise<Connection | null> {
    const r = await this.pool.query<DataRow<Connection>>(
      'SELECT data FROM forge_connections WHERE app_id=$1 AND owner=$2 AND provider=$3',
      [appId, owner, provider],
    );
    return r.rows[0]?.data ?? null;
  }
  async listConnections(appId: string, owner: string): Promise<Connection[]> {
    const r = await this.pool.query<DataRow<Connection>>(
      'SELECT data FROM forge_connections WHERE app_id=$1 AND owner=$2 ORDER BY provider ASC',
      [appId, owner],
    );
    return r.rows.map((row) => row.data);
  }
  async deleteConnection(appId: string, owner: string, provider: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM forge_connections WHERE app_id=$1 AND owner=$2 AND provider=$3', [appId, owner, provider]);
    return (r.rowCount ?? 0) > 0;
  }

  // --- pending connect requests ---------------------------------------------
  async putRequest(appId: string, req: ConnectRequest): Promise<ConnectRequest> {
    await this.pool.query(
      `INSERT INTO forge_connection_requests (app_id, state, owner, provider, expires_at, data)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (app_id, state) DO UPDATE SET
         owner=EXCLUDED.owner, provider=EXCLUDED.provider, expires_at=EXCLUDED.expires_at, data=EXCLUDED.data`,
      [appId, req.state, req.owner, req.provider, req.expires_at, JSON.stringify(req)],
    );
    return req;
  }
  async consumeRequest(appId: string, state: string): Promise<ConnectRequest | null> {
    const r = await this.pool.query<DataRow<ConnectRequest>>(
      'DELETE FROM forge_connection_requests WHERE app_id=$1 AND state=$2 RETURNING data',
      [appId, state],
    );
    return r.rows[0]?.data ?? null;
  }
  async pruneExpiredRequests(appId: string, nowIso: string): Promise<number> {
    const r = await this.pool.query('DELETE FROM forge_connection_requests WHERE app_id=$1 AND expires_at <= $2', [appId, nowIso]);
    return r.rowCount ?? 0;
  }

  // --- migration surface ----------------------------------------------------
  async exportApp(appId: string): Promise<ConnectionsExport> {
    const [connections, requests] = await Promise.all([
      this.pool.query<DataRow<Connection>>('SELECT data FROM forge_connections WHERE app_id=$1', [appId]),
      this.pool.query<DataRow<ConnectRequest>>('SELECT data FROM forge_connection_requests WHERE app_id=$1', [appId]),
    ]);
    return { connections: connections.rows.map((r) => r.data), requests: requests.rows.map((r) => r.data) };
  }
  async importApp(appId: string, data: ConnectionsExport): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM forge_connections WHERE app_id=$1', [appId]);
      await client.query('DELETE FROM forge_connection_requests WHERE app_id=$1', [appId]);
      for (const c of data.connections) {
        await client.query(
          'INSERT INTO forge_connections (app_id, owner, provider, status, expires_at, data, updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)',
          [appId, c.owner, c.provider, c.status, c.access_expires_at, JSON.stringify(c), c.updated_at],
        );
      }
      for (const r of data.requests) {
        await client.query(
          'INSERT INTO forge_connection_requests (app_id, state, owner, provider, expires_at, data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
          [appId, r.state, r.owner, r.provider, r.expires_at, JSON.stringify(r)],
        );
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
    await this.pool.query('TRUNCATE forge_connections, forge_connection_requests');
  }
}
