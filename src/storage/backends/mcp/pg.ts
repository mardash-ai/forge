import type { Pool } from 'pg';
import type {
  ToolRegistration,
  InstructionBlock,
  OAuthClient,
  Consent,
  OAuthGrant,
  GrantKind,
  McpExport,
} from '../../../mcp/types';
import type { McpBackend, MigratableMcpBackend } from './types';

// C23 / P26 — the POSTGRES MCP-host backend: one table per record kind. Each full object rides `data jsonb`
// (exact round-trip); the columns projected out are what the queries filter/order/upsert on. Codes +
// refresh tokens are ONE-SHOT — consumeGrant is a `DELETE … RETURNING data` (atomic, no double-spend). O4
// (owner, group_id, visibility) columns are baked into the sensitive tables (consents + grants).
export async function ensureMcpSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_mcp_tools (
      app_id     text NOT NULL,
      name       text NOT NULL,
      data       jsonb NOT NULL,
      updated_at text,
      PRIMARY KEY (app_id, name)
    );
    CREATE TABLE IF NOT EXISTS forge_mcp_instructions (
      app_id     text NOT NULL,
      version    integer NOT NULL,
      data       jsonb NOT NULL,
      created_at text,
      PRIMARY KEY (app_id, version)
    );
    CREATE TABLE IF NOT EXISTS forge_mcp_clients (
      app_id     text NOT NULL,
      client_id  text NOT NULL,
      data       jsonb NOT NULL,
      created_at text,
      PRIMARY KEY (app_id, client_id)
    );
    CREATE TABLE IF NOT EXISTS forge_mcp_consents (
      app_id     text NOT NULL,
      client_id  text NOT NULL,
      owner      text NOT NULL,
      data       jsonb NOT NULL,
      group_id   text,
      visibility text NOT NULL DEFAULT 'private',
      updated_at text,
      PRIMARY KEY (app_id, client_id, owner)
    );
    CREATE INDEX IF NOT EXISTS forge_mcp_consents_owner ON forge_mcp_consents (app_id, owner);
    CREATE TABLE IF NOT EXISTS forge_mcp_grants (
      app_id     text NOT NULL,
      kind       text NOT NULL,   -- code | access | refresh
      token_hash text NOT NULL,   -- sha256 of the opaque secret (never the raw token)
      owner      text NOT NULL,
      client_id  text NOT NULL,
      expires_at text,
      data       jsonb NOT NULL,
      group_id   text,
      visibility text NOT NULL DEFAULT 'private',
      PRIMARY KEY (app_id, kind, token_hash)
    );
    CREATE INDEX IF NOT EXISTS forge_mcp_grants_owner ON forge_mcp_grants (app_id, owner);
  `);
}

interface DataRow<T> { data: T }

export class PgMcpBackend implements McpBackend, MigratableMcpBackend {
  constructor(private readonly pool: Pool) {}

  // --- tools ----------------------------------------------------------------
  async putTool(appId: string, tool: ToolRegistration): Promise<ToolRegistration> {
    await this.pool.query(
      `INSERT INTO forge_mcp_tools (app_id, name, data, updated_at) VALUES ($1,$2,$3::jsonb,$4)
       ON CONFLICT (app_id, name) DO UPDATE SET data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`,
      [appId, tool.name, JSON.stringify(tool), tool.updated_at],
    );
    return tool;
  }
  async getTool(appId: string, name: string): Promise<ToolRegistration | null> {
    const r = await this.pool.query<DataRow<ToolRegistration>>('SELECT data FROM forge_mcp_tools WHERE app_id=$1 AND name=$2', [appId, name]);
    return r.rows[0]?.data ?? null;
  }
  async listTools(appId: string): Promise<ToolRegistration[]> {
    const r = await this.pool.query<DataRow<ToolRegistration>>('SELECT data FROM forge_mcp_tools WHERE app_id=$1 ORDER BY name ASC', [appId]);
    return r.rows.map((row) => row.data);
  }
  async deleteTool(appId: string, name: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM forge_mcp_tools WHERE app_id=$1 AND name=$2', [appId, name]);
    return (r.rowCount ?? 0) > 0;
  }

  // --- instruction blocks ---------------------------------------------------
  async appendInstructions(appId: string, input: { text: string; label?: string; created_at: string }): Promise<InstructionBlock> {
    // Next version = MAX+1, assigned inside the INSERT so a concurrent append can't collide on the PK.
    const r = await this.pool.query<DataRow<InstructionBlock>>(
      `INSERT INTO forge_mcp_instructions (app_id, version, data, created_at)
       SELECT $1, v, jsonb_build_object('version', v, 'text', $2::text, 'created_at', $3::text)
              || (CASE WHEN $4::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('label', $4::text) END), $3
         FROM (SELECT COALESCE(MAX(version),0)+1 AS v FROM forge_mcp_instructions WHERE app_id=$1) s
       RETURNING data`,
      [appId, input.text, input.created_at, input.label ?? null],
    );
    return r.rows[0]!.data;
  }
  async latestInstructions(appId: string): Promise<InstructionBlock | null> {
    const r = await this.pool.query<DataRow<InstructionBlock>>('SELECT data FROM forge_mcp_instructions WHERE app_id=$1 ORDER BY version DESC LIMIT 1', [appId]);
    return r.rows[0]?.data ?? null;
  }
  async getInstructions(appId: string, version: number): Promise<InstructionBlock | null> {
    const r = await this.pool.query<DataRow<InstructionBlock>>('SELECT data FROM forge_mcp_instructions WHERE app_id=$1 AND version=$2', [appId, version]);
    return r.rows[0]?.data ?? null;
  }
  async listInstructions(appId: string): Promise<InstructionBlock[]> {
    const r = await this.pool.query<DataRow<InstructionBlock>>('SELECT data FROM forge_mcp_instructions WHERE app_id=$1 ORDER BY version ASC', [appId]);
    return r.rows.map((row) => row.data);
  }

  // --- clients --------------------------------------------------------------
  async putClient(appId: string, client: OAuthClient): Promise<OAuthClient> {
    await this.pool.query(
      `INSERT INTO forge_mcp_clients (app_id, client_id, data, created_at) VALUES ($1,$2,$3::jsonb,$4)
       ON CONFLICT (app_id, client_id) DO UPDATE SET data=EXCLUDED.data`,
      [appId, client.client_id, JSON.stringify(client), client.created_at],
    );
    return client;
  }
  async getClient(appId: string, clientId: string): Promise<OAuthClient | null> {
    const r = await this.pool.query<DataRow<OAuthClient>>('SELECT data FROM forge_mcp_clients WHERE app_id=$1 AND client_id=$2', [appId, clientId]);
    return r.rows[0]?.data ?? null;
  }

  // --- consent --------------------------------------------------------------
  async putConsent(appId: string, consent: Consent): Promise<Consent> {
    await this.pool.query(
      `INSERT INTO forge_mcp_consents (app_id, client_id, owner, data, group_id, visibility, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
       ON CONFLICT (app_id, client_id, owner) DO UPDATE SET
         data=EXCLUDED.data, group_id=EXCLUDED.group_id, visibility=EXCLUDED.visibility, updated_at=EXCLUDED.updated_at`,
      [appId, consent.client_id, consent.owner, JSON.stringify(consent), consent.group_id ?? null, consent.visibility ?? 'private', consent.updated_at],
    );
    return consent;
  }
  async getConsent(appId: string, clientId: string, owner: string): Promise<Consent | null> {
    const r = await this.pool.query<DataRow<Consent>>('SELECT data FROM forge_mcp_consents WHERE app_id=$1 AND client_id=$2 AND owner=$3', [appId, clientId, owner]);
    return r.rows[0]?.data ?? null;
  }
  async listConsents(appId: string, owner: string): Promise<Consent[]> {
    const r = await this.pool.query<DataRow<Consent>>('SELECT data FROM forge_mcp_consents WHERE app_id=$1 AND owner=$2', [appId, owner]);
    return r.rows.map((row) => row.data);
  }
  async revokeConsent(appId: string, clientId: string, owner: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query('DELETE FROM forge_mcp_consents WHERE app_id=$1 AND client_id=$2 AND owner=$3', [appId, clientId, owner]);
      // Cut the connector off now: drop this user's live tokens for the client.
      await client.query('DELETE FROM forge_mcp_grants WHERE app_id=$1 AND client_id=$2 AND owner=$3', [appId, clientId, owner]);
      await client.query('COMMIT');
      return (r.rowCount ?? 0) > 0;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  // --- grants (codes + tokens) ----------------------------------------------
  async putGrant(appId: string, grant: OAuthGrant): Promise<OAuthGrant> {
    await this.pool.query(
      `INSERT INTO forge_mcp_grants (app_id, kind, token_hash, owner, client_id, expires_at, data, group_id, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
       ON CONFLICT (app_id, kind, token_hash) DO UPDATE SET
         owner=EXCLUDED.owner, client_id=EXCLUDED.client_id, expires_at=EXCLUDED.expires_at, data=EXCLUDED.data,
         group_id=EXCLUDED.group_id, visibility=EXCLUDED.visibility`,
      [appId, grant.kind, grant.token_hash, grant.owner, grant.client_id, grant.expires_at, JSON.stringify(grant), grant.group_id ?? null, grant.visibility ?? 'private'],
    );
    return grant;
  }
  async getGrant(appId: string, kind: GrantKind, tokenHash: string): Promise<OAuthGrant | null> {
    const r = await this.pool.query<DataRow<OAuthGrant>>('SELECT data FROM forge_mcp_grants WHERE app_id=$1 AND kind=$2 AND token_hash=$3', [appId, kind, tokenHash]);
    return r.rows[0]?.data ?? null;
  }
  async consumeGrant(appId: string, kind: GrantKind, tokenHash: string): Promise<OAuthGrant | null> {
    const r = await this.pool.query<DataRow<OAuthGrant>>('DELETE FROM forge_mcp_grants WHERE app_id=$1 AND kind=$2 AND token_hash=$3 RETURNING data', [appId, kind, tokenHash]);
    return r.rows[0]?.data ?? null;
  }
  async revokeGrant(appId: string, kind: GrantKind, tokenHash: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM forge_mcp_grants WHERE app_id=$1 AND kind=$2 AND token_hash=$3', [appId, kind, tokenHash]);
    return (r.rowCount ?? 0) > 0;
  }
  async revokeUserGrants(appId: string, owner: string): Promise<number> {
    const r = await this.pool.query('DELETE FROM forge_mcp_grants WHERE app_id=$1 AND owner=$2', [appId, owner]);
    return r.rowCount ?? 0;
  }

  // --- migration surface ----------------------------------------------------
  async exportApp(appId: string): Promise<McpExport> {
    const [tools, instructions, clients, consents, grants] = await Promise.all([
      this.pool.query<DataRow<ToolRegistration>>('SELECT data FROM forge_mcp_tools WHERE app_id=$1', [appId]),
      this.pool.query<DataRow<InstructionBlock>>('SELECT data FROM forge_mcp_instructions WHERE app_id=$1 ORDER BY version ASC', [appId]),
      this.pool.query<DataRow<OAuthClient>>('SELECT data FROM forge_mcp_clients WHERE app_id=$1', [appId]),
      this.pool.query<DataRow<Consent>>('SELECT data FROM forge_mcp_consents WHERE app_id=$1', [appId]),
      this.pool.query<DataRow<OAuthGrant>>('SELECT data FROM forge_mcp_grants WHERE app_id=$1', [appId]),
    ]);
    return {
      tools: tools.rows.map((r) => r.data),
      instructions: instructions.rows.map((r) => r.data),
      clients: clients.rows.map((r) => r.data),
      consents: consents.rows.map((r) => r.data),
      grants: grants.rows.map((r) => r.data),
    };
  }
  async importApp(appId: string, data: McpExport): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const table of ['forge_mcp_tools', 'forge_mcp_instructions', 'forge_mcp_clients', 'forge_mcp_consents', 'forge_mcp_grants']) {
        await client.query(`DELETE FROM ${table} WHERE app_id=$1`, [appId]);
      }
      for (const t of data.tools) {
        await client.query('INSERT INTO forge_mcp_tools (app_id, name, data, updated_at) VALUES ($1,$2,$3::jsonb,$4)', [appId, t.name, JSON.stringify(t), t.updated_at]);
      }
      for (const b of data.instructions) {
        await client.query('INSERT INTO forge_mcp_instructions (app_id, version, data, created_at) VALUES ($1,$2,$3::jsonb,$4)', [appId, b.version, JSON.stringify(b), b.created_at]);
      }
      for (const c of data.clients) {
        await client.query('INSERT INTO forge_mcp_clients (app_id, client_id, data, created_at) VALUES ($1,$2,$3::jsonb,$4)', [appId, c.client_id, JSON.stringify(c), c.created_at]);
      }
      for (const c of data.consents) {
        await client.query('INSERT INTO forge_mcp_consents (app_id, client_id, owner, data, group_id, visibility, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)', [appId, c.client_id, c.owner, JSON.stringify(c), c.group_id ?? null, c.visibility ?? 'private', c.updated_at]);
      }
      for (const g of data.grants) {
        await client.query('INSERT INTO forge_mcp_grants (app_id, kind, token_hash, owner, client_id, expires_at, data, group_id, visibility) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)', [appId, g.kind, g.token_hash, g.owner, g.client_id, g.expires_at, JSON.stringify(g), g.group_id ?? null, g.visibility ?? 'private']);
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
    await this.pool.query('TRUNCATE forge_mcp_tools, forge_mcp_instructions, forge_mcp_clients, forge_mcp_consents, forge_mcp_grants');
  }
}
