import { readdir } from 'node:fs/promises';
import { secretsDir } from '../../../shared/paths';
import type { MigratableSecretsBackend } from './types';

// P26 — the secrets backfill (filesystem → Postgres). The SEALED vault moves verbatim (still AES-256-GCM
// ciphertext at rest — the plaintext is never touched). Idempotent per app (import replaces).

// FS vaults are `vault-<appId>.json` under the secrets dir; app ids are sanitizer-safe.
export async function listFsSecretApps(): Promise<string[]> {
  try {
    const files = await readdir(secretsDir());
    return files
      .filter((f) => f.startsWith('vault-') && f.endsWith('.json'))
      .map((f) => f.slice('vault-'.length, -'.json'.length));
  } catch {
    return [];
  }
}

export interface BackfillSecretsResult {
  app: string;
  secrets: number;
}

export async function backfillSecrets(
  from: MigratableSecretsBackend,
  to: MigratableSecretsBackend,
  appIds: string[],
): Promise<BackfillSecretsResult[]> {
  const results: BackfillSecretsResult[] = [];
  for (const app of appIds) {
    const vault = await from.exportApp(app);
    await to.importApp(app, vault);
    results.push({ app, secrets: Object.keys(vault).length });
  }
  return results;
}
