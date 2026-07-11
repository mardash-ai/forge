import { readdir } from 'node:fs/promises';
import { mcpDir } from '../../../shared/paths';
import type { MigratableMcpBackend } from './types';

// C23 / P26 — the MCP-host backfill (filesystem → Postgres). Copies each app's full MCP state verbatim
// (tools, instruction versions, clients, consents, and live grants). Idempotent per app (import replaces).
export async function listFsMcpApps(): Promise<string[]> {
  try {
    const files = await readdir(mcpDir());
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

export interface BackfillMcpResult {
  app: string;
  tools: number;
  instructions: number;
  clients: number;
  consents: number;
  grants: number;
}

export async function backfillMcp(
  from: MigratableMcpBackend,
  to: MigratableMcpBackend,
  appIds: string[],
): Promise<BackfillMcpResult[]> {
  const results: BackfillMcpResult[] = [];
  for (const app of appIds) {
    const data = await from.exportApp(app);
    await to.importApp(app, data);
    results.push({
      app,
      tools: data.tools.length,
      instructions: data.instructions.length,
      clients: data.clients.length,
      consents: data.consents.length,
      grants: data.grants.length,
    });
  }
  return results;
}
