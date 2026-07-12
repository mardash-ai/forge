import { readdir } from 'node:fs/promises';
import { connectionsDir } from '../../../shared/paths';
import type { MigratableConnectionBackend } from './types';

// C24 / P26 — the connector-vault backfill (filesystem → Postgres). The SEALED tokens move verbatim (still
// AES-256-GCM ciphertext at rest — plaintext is never touched). Idempotent per app (import replaces).

// FS docs are `<appId>.json` under the connections dir; app ids are sanitizer-safe.
export async function listFsConnectionApps(): Promise<string[]> {
  try {
    const files = await readdir(connectionsDir());
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

export interface BackfillConnectionsResult {
  app: string;
  connections: number;
  requests: number;
}

export async function backfillConnections(
  from: MigratableConnectionBackend,
  to: MigratableConnectionBackend,
  appIds: string[],
): Promise<BackfillConnectionsResult[]> {
  const results: BackfillConnectionsResult[] = [];
  for (const app of appIds) {
    const data = await from.exportApp(app);
    await to.importApp(app, data);
    results.push({ app, connections: data.connections.length, requests: data.requests.length });
  }
  return results;
}
