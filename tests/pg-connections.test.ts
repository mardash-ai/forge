import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getBackends } from '../src/storage/backends';
import { FsConnectionBackend } from '../src/storage/backends/connections/fs';
import { PgConnectionBackend } from '../src/storage/backends/connections/pg';
import { backfillConnections } from '../src/storage/backends/connections/migrate';
import { nowIso } from '../src/shared/time';
import type { Connection, ConnectRequest } from '../src/connectors/types';

// C24 / P26 — Postgres connector-vault backend-SPECIFIC coverage: jsonb round-trip, one-shot consumeRequest
// (no double-spend), owner-scoped listing, and FS→PG backfill. Runs ONLY when the Postgres connections
// backend is selected (`test:pg`); skipped in the filesystem run.
const HAS_PG = process.env.FORGE_CONNECTIONS_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

const sealed = (s: string) => ({ iv: `iv-${s}`, tag: `tag-${s}`, data: `data-${s}` });

const conn = (over: Partial<Connection> = {}): Connection => ({
  owner: 'A', provider: 'google', access_sealed: sealed('a'), refresh_sealed: sealed('r'),
  access_expires_at: new Date(Date.now() + 3600_000).toISOString(), scopes: ['openid', 'email'],
  status: 'connected', account_label: 'a@gmail.test', connected_at: nowIso(), updated_at: nowIso(), ...over,
});

const request = (over: Partial<ConnectRequest> = {}): ConnectRequest => ({
  state: 'st1', owner: 'A', provider: 'google', code_verifier: 'verifier', redirect_uri: 'https://x/callback',
  scopes: ['openid'], created_at: nowIso(), expires_at: new Date(Date.now() + 600_000).toISOString(), ...over,
});

describe.skipIf(!HAS_PG)('P26 Postgres connector-vault backend — jsonb, one-shot requests, backfill', () => {
  const APP = 'app_pg_conn';
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('round-trips a connection through jsonb with projected columns', async () => {
    const b = (await getBackends()).connections;
    const c = conn({ owner: 'A', provider: 'google' });
    await b.putConnection(APP, c);
    expect(await b.getConnection(APP, 'A', 'google')).toEqual(c); // exact round-trip (sealed tokens intact)
    const row = await pool.query<{ owner: string; provider: string; status: string }>(
      'SELECT owner, provider, status FROM forge_connections WHERE app_id=$1 AND owner=$2 AND provider=$3',
      [APP, 'A', 'google'],
    );
    expect(row.rows[0]).toMatchObject({ owner: 'A', provider: 'google', status: 'connected' });
  });

  it('listConnections is owner-scoped', async () => {
    const b = (await getBackends()).connections;
    await b.putConnection(APP, conn({ owner: 'A', provider: 'google' }));
    await b.putConnection(APP, conn({ owner: 'A', provider: 'microsoft' }));
    await b.putConnection(APP, conn({ owner: 'B', provider: 'google' }));
    expect((await b.listConnections(APP, 'A')).map((c) => c.provider)).toEqual(['google', 'microsoft']);
    expect((await b.listConnections(APP, 'B')).map((c) => c.provider)).toEqual(['google']);
  });

  it('consumeRequest is one-shot — a second consume finds nothing (no double-spend)', async () => {
    const b = (await getBackends()).connections;
    await b.putRequest(APP, request({ state: 'once' }));
    expect((await b.consumeRequest(APP, 'once'))?.state).toBe('once');
    expect(await b.consumeRequest(APP, 'once')).toBeNull();
  });

  it('pruneExpiredRequests drops only stale pending requests', async () => {
    const b = (await getBackends()).connections;
    await b.putRequest(APP, request({ state: 'fresh', expires_at: new Date(Date.now() + 600_000).toISOString() }));
    await b.putRequest(APP, request({ state: 'stale', expires_at: new Date(Date.now() - 1000).toISOString() }));
    expect(await b.pruneExpiredRequests(APP, nowIso())).toBe(1);
    expect(await b.consumeRequest(APP, 'stale')).toBeNull();
    expect((await b.consumeRequest(APP, 'fresh'))?.state).toBe('fresh');
  });

  it('backfills FS → PG verbatim (sealed tokens move as ciphertext)', async () => {
    const fs = new FsConnectionBackend();
    const pg = new PgConnectionBackend(pool);
    const app = 'app_backfill_conn';
    const c = conn({ owner: 'X', provider: 'google' });
    await fs.putConnection(app, c);
    await fs.putRequest(app, request({ state: 'pending-x', owner: 'X' }));
    const [result] = await backfillConnections(fs, pg, [app]);
    expect(result).toMatchObject({ app, connections: 1, requests: 1 });
    expect(await pg.getConnection(app, 'X', 'google')).toEqual(c);
    await pool.query('DELETE FROM forge_connections WHERE app_id=$1', [app]);
    await pool.query('DELETE FROM forge_connection_requests WHERE app_id=$1', [app]);
  });
});
