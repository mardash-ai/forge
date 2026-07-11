import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { getBackends } from '../src/storage/backends';
import { FsMcpBackend } from '../src/storage/backends/mcp/fs';
import { PgMcpBackend, ensureMcpSchema } from '../src/storage/backends/mcp/pg';
import { backfillMcp } from '../src/storage/backends/mcp/migrate';
import { nowIso } from '../src/shared/time';
import type { OAuthGrant, Consent } from '../src/mcp/types';

// C23 / P26 — Postgres MCP backend-SPECIFIC coverage: jsonb round-trip, one-shot consumeGrant (no
// double-spend), O4 columns on consents/grants, revokeUserGrants, monotonic instruction versions, and
// backfill. Runs ONLY when the Postgres MCP backend is selected (`test:pg`); skipped in the filesystem run.
const HAS_PG = process.env.FORGE_MCP_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

const grant = (over: Partial<OAuthGrant> = {}): OAuthGrant => ({
  kind: 'access', token_hash: 'h1', client_id: 'c1', owner: 'A', scopes: ['s:read'], expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: nowIso(), ...over,
});

describe.skipIf(!HAS_PG)('P26 Postgres MCP backend — jsonb, one-shot grants, O4, backfill', () => {
  const APP = 'app_pg_mcp';
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('round-trips a grant through jsonb with projected columns', async () => {
    const b = (await getBackends()).mcp;
    const g = grant({ token_hash: 'rt1', kind: 'refresh', scopes: ['s:read', 's:write'], group_id: 'g1', visibility: 'shared' });
    await b.putGrant(APP, g);
    expect(await b.getGrant(APP, 'refresh', 'rt1')).toEqual(g); // exact round-trip

    const row = await pool.query<{ owner: string; client_id: string; visibility: string; group_id: string }>(
      "SELECT owner, client_id, visibility, group_id FROM forge_mcp_grants WHERE app_id=$1 AND kind='refresh' AND token_hash='rt1'",
      [APP],
    );
    expect(row.rows[0]).toMatchObject({ owner: 'A', client_id: 'c1', visibility: 'shared', group_id: 'g1' });
  });

  it('consumeGrant is one-shot — a second consume finds nothing (no double-spend)', async () => {
    const b = (await getBackends()).mcp;
    await b.putGrant(APP, grant({ kind: 'code', token_hash: 'code1' }));
    expect((await b.consumeGrant(APP, 'code', 'code1'))?.token_hash).toBe('code1');
    expect(await b.consumeGrant(APP, 'code', 'code1')).toBeNull();
  });

  it('revokeUserGrants + revokeConsent cut a user off', async () => {
    const b = (await getBackends()).mcp;
    await b.putGrant(APP, grant({ token_hash: 'ua1', owner: 'U', kind: 'access' }));
    await b.putGrant(APP, grant({ token_hash: 'ur1', owner: 'U', kind: 'refresh' }));
    expect(await b.revokeUserGrants(APP, 'U')).toBe(2);
    expect(await b.getGrant(APP, 'access', 'ua1')).toBeNull();

    const consent: Consent = { client_id: 'cX', owner: 'U', scopes: ['s:read'], created_at: nowIso(), updated_at: nowIso() };
    await b.putConsent(APP, consent);
    await b.putGrant(APP, grant({ token_hash: 'live1', owner: 'U', client_id: 'cX' }));
    expect(await b.revokeConsent(APP, 'cX', 'U')).toBe(true);
    expect(await b.getGrant(APP, 'access', 'live1')).toBeNull(); // consent revocation also dropped the token
    expect(await b.getConsent(APP, 'cX', 'U')).toBeNull();
  });

  it('appendInstructions assigns monotonic versions', async () => {
    const b = (await getBackends()).mcp;
    const v1 = await b.appendInstructions(APP, { text: 'a', created_at: nowIso() });
    const v2 = await b.appendInstructions(APP, { text: 'b', created_at: nowIso() });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect((await b.latestInstructions(APP))?.text).toBe('b');
  });

  it('backfill (filesystem → Postgres) preserves the full MCP state', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forge-mcp-bf-'));
    const prev = process.env.FORGE_STATE_DIR;
    process.env.FORGE_STATE_DIR = dir;
    try {
      const APP2 = 'app_mcp_backfill';
      const fs = new FsMcpBackend();
      await fs.putTool(APP2, { name: 't1', description: '', input_schema: { type: 'object' }, scope: 's:read', family: 'read', handler_path: '/h', created_at: nowIso(), updated_at: nowIso() });
      await fs.appendInstructions(APP2, { text: 'preamble', created_at: nowIso() });
      await fs.putClient(APP2, { client_id: 'cli1', redirect_uris: ['https://x/cb'], token_endpoint_auth_method: 'none', created_at: nowIso() });

      await ensureMcpSchema(pool);
      for (const t of ['forge_mcp_tools', 'forge_mcp_instructions', 'forge_mcp_clients', 'forge_mcp_consents', 'forge_mcp_grants']) {
        await pool.query(`DELETE FROM ${t} WHERE app_id=$1`, [APP2]);
      }
      const pg = new PgMcpBackend(pool);
      const [res] = await backfillMcp(fs, pg, [APP2]);
      expect(res).toMatchObject({ app: APP2, tools: 1, instructions: 1, clients: 1 });
      expect((await pg.getTool(APP2, 't1'))?.scope).toBe('s:read');
      expect((await pg.latestInstructions(APP2))?.text).toBe('preamble');
      expect((await pg.getClient(APP2, 'cli1'))?.redirect_uris).toEqual(['https://x/cb']);
    } finally {
      if (prev === undefined) delete process.env.FORGE_STATE_DIR;
      else process.env.FORGE_STATE_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
