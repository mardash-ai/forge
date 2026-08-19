import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { FsMcpBackend } from '../src/storage/backends/mcp/fs';
import { gcStaleClients } from '../src/shared/dcr-gc';
import { nowIso } from '../src/shared/time';
import type { OAuthClient, Consent } from '../src/mcp/types';

// DCR GC safety tests — proven on seeded stale clients (no production data required).
//
// Acceptance criteria:
//  ✓  Deletes only never-consented clients older than maxAgeDays
//  ✓  Consented clients are NEVER deleted regardless of age
//  ✓  Clients younger than maxAgeDays are NOT deleted even without consent
//  ✓  Mixed-state seeding (some consented, some stale, some recent) produces the correct outcome

const APP = 'app_gc_test';

function makeClient(overrides: Partial<OAuthClient> & { client_id: string }): OAuthClient {
  return {
    client_name: 'Test Client',
    redirect_uris: ['https://example.com/cb'],
    token_endpoint_auth_method: 'none',
    created_at: nowIso(),
    ...overrides,
  };
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeConsent(clientId: string): Consent {
  const now = nowIso();
  return {
    client_id: clientId,
    owner: 'user_gc',
    scopes: ['read'],
    created_at: now,
    updated_at: now,
  };
}

let dir: string;
let prevDir: string | undefined;

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-dcr-gc-'));
  process.env.FORGE_STATE_DIR = dir;
  await store.init();
});

afterEach(async () => {
  if (prevDir === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevDir;
  await rm(dir, { recursive: true, force: true });
});

describe('gcStaleClients — FS backend', () => {
  it('deletes never-consented clients older than maxAgeDays', async () => {
    const backend = new FsMcpBackend();
    const stale = makeClient({ client_id: 'stale_1', created_at: daysAgoIso(31) });
    await backend.putClient(APP, stale);

    const result = await gcStaleClients(APP, backend, { maxAgeDays: 30 });
    expect(result.deleted).toBe(1);
    expect(result.checked).toBe(1);
    expect(result.skipped_consented).toBe(0);
    expect(result.skipped_too_recent).toBe(0);

    // Verify it's actually gone
    expect(await backend.getClient(APP, 'stale_1')).toBeNull();
  });

  it('PRESERVES consented clients regardless of age', async () => {
    const backend = new FsMcpBackend();
    const old_consented = makeClient({ client_id: 'old_c', created_at: daysAgoIso(100) });
    await backend.putClient(APP, old_consented);
    await backend.putConsent(APP, makeConsent('old_c'));

    const result = await gcStaleClients(APP, backend, { maxAgeDays: 30 });
    expect(result.deleted).toBe(0);
    expect(result.skipped_consented).toBe(1);

    // Still exists
    expect(await backend.getClient(APP, 'old_c')).not.toBeNull();
  });

  it('PRESERVES never-consented clients younger than maxAgeDays', async () => {
    const backend = new FsMcpBackend();
    const fresh = makeClient({ client_id: 'fresh_1', created_at: daysAgoIso(5) });
    await backend.putClient(APP, fresh);

    const result = await gcStaleClients(APP, backend, { maxAgeDays: 30 });
    expect(result.deleted).toBe(0);
    expect(result.skipped_too_recent).toBe(1);

    expect(await backend.getClient(APP, 'fresh_1')).not.toBeNull();
  });

  it('handles mixed state: stale unconsented deleted, consented + recent preserved', async () => {
    const backend = new FsMcpBackend();

    // Stale + unconsented → should be deleted
    await backend.putClient(APP, makeClient({ client_id: 'del_1', created_at: daysAgoIso(45) }));
    await backend.putClient(APP, makeClient({ client_id: 'del_2', created_at: daysAgoIso(60) }));

    // Old but consented → preserved
    await backend.putClient(APP, makeClient({ client_id: 'keep_consented', created_at: daysAgoIso(90) }));
    await backend.putConsent(APP, makeConsent('keep_consented'));

    // Young + unconsented → preserved (too recent)
    await backend.putClient(APP, makeClient({ client_id: 'keep_recent', created_at: daysAgoIso(10) }));

    const result = await gcStaleClients(APP, backend, { maxAgeDays: 30 });
    expect(result.checked).toBe(4);
    expect(result.deleted).toBe(2);
    expect(result.skipped_consented).toBe(1);
    expect(result.skipped_too_recent).toBe(1);

    expect(await backend.getClient(APP, 'del_1')).toBeNull();
    expect(await backend.getClient(APP, 'del_2')).toBeNull();
    expect(await backend.getClient(APP, 'keep_consented')).not.toBeNull();
    expect(await backend.getClient(APP, 'keep_recent')).not.toBeNull();
  });

  it('handles an empty client set gracefully', async () => {
    const backend = new FsMcpBackend();
    const result = await gcStaleClients(APP, backend, { maxAgeDays: 30 });
    expect(result.checked).toBe(0);
    expect(result.deleted).toBe(0);
  });

  it('uses DCR_GC_MAX_AGE_DAYS env var as the default age threshold', async () => {
    const prev = process.env.DCR_GC_MAX_AGE_DAYS;
    process.env.DCR_GC_MAX_AGE_DAYS = '7'; // 7-day threshold
    try {
      const backend = new FsMcpBackend();
      // 5 days old: would survive a 30-day threshold, but NOT a 7-day one
      await backend.putClient(APP, makeClient({ client_id: 'env_del', created_at: daysAgoIso(8) }));
      const result = await gcStaleClients(APP, backend); // no maxAgeDays override → reads env
      expect(result.max_age_days).toBe(7);
      expect(result.deleted).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.DCR_GC_MAX_AGE_DAYS;
      else process.env.DCR_GC_MAX_AGE_DAYS = prev;
    }
  });

  it('listClients and listConsentedClientIds work correctly on FS backend', async () => {
    const backend = new FsMcpBackend();
    const c1 = makeClient({ client_id: 'c1' });
    const c2 = makeClient({ client_id: 'c2' });
    await backend.putClient(APP, c1);
    await backend.putClient(APP, c2);
    await backend.putConsent(APP, makeConsent('c1'));

    const clients = await backend.listClients(APP);
    expect(clients.map((c) => c.client_id).sort()).toEqual(['c1', 'c2']);

    const consented = await backend.listConsentedClientIds(APP);
    expect(consented).toContain('c1');
    expect(consented).not.toContain('c2');
  });

  it('deleteClient removes the client and returns true; false for unknown', async () => {
    const backend = new FsMcpBackend();
    await backend.putClient(APP, makeClient({ client_id: 'del_me' }));
    expect(await backend.deleteClient(APP, 'del_me')).toBe(true);
    expect(await backend.getClient(APP, 'del_me')).toBeNull();
    expect(await backend.deleteClient(APP, 'del_me')).toBe(false); // already gone
  });
});

// Postgres variant — self-skips when the Postgres MCP backend is not configured.
const HAS_PG = process.env.FORGE_MCP_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

describe.skipIf(!HAS_PG)('gcStaleClients — PG backend', () => {
  let pgBackend: import('../src/storage/backends/mcp/pg').PgMcpBackend;
  let pool: import('pg').Pool;

  beforeEach(async () => {
    const { Pool } = await import('pg');
    const { PgMcpBackend, ensureMcpSchema } = await import('../src/storage/backends/mcp/pg');
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
    await ensureMcpSchema(pool);
    pgBackend = new PgMcpBackend(pool);
    await pgBackend.__truncateAllForTests?.();
  });
  afterEach(async () => {
    await pgBackend.__truncateAllForTests?.();
    await pool.end();
  });

  it('round-trip: register→authorize guard passes on PG (stored == sent)', async () => {
    const client = makeClient({
      client_id: 'pg_rt',
      redirect_uris: ['http://127.0.0.1:5000/callback'],
    });
    await pgBackend.putClient(APP, client);
    const retrieved = await pgBackend.getClient(APP, 'pg_rt');
    // stored-vs-sent: the redirect_uris must be EXACTLY what was registered
    expect(retrieved?.redirect_uris).toEqual(['http://127.0.0.1:5000/callback']);
  });

  it('GC on PG: deletes stale unconsented, preserves consented + recent', async () => {
    const old_stale = makeClient({ client_id: 'pg_stale', created_at: daysAgoIso(40) });
    const consented = makeClient({ client_id: 'pg_cons', created_at: daysAgoIso(60) });
    const recent = makeClient({ client_id: 'pg_recent', created_at: daysAgoIso(5) });

    await pgBackend.putClient(APP, old_stale);
    await pgBackend.putClient(APP, consented);
    await pgBackend.putClient(APP, recent);
    await pgBackend.putConsent(APP, makeConsent('pg_cons'));

    const result = await gcStaleClients(APP, pgBackend, { maxAgeDays: 30 });
    expect(result.deleted).toBe(1);
    expect(result.skipped_consented).toBe(1);
    expect(result.skipped_too_recent).toBe(1);

    expect(await pgBackend.getClient(APP, 'pg_stale')).toBeNull();
    expect(await pgBackend.getClient(APP, 'pg_cons')).not.toBeNull();
    expect(await pgBackend.getClient(APP, 'pg_recent')).not.toBeNull();
  });
});
