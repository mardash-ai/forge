import { readdir } from 'node:fs/promises';
import { searchDir } from '../../../shared/paths';
import type { MigratableSearchBackend } from './types';

// P26 — the search backfill (filesystem → Postgres). Reads each app's FS index doc and IMPORTS it into
// the target backend, (owner, type, id) keys preserved, so a cutover is contract-stable (no re-index
// needed from the app). Idempotent per app (import replaces).

// FS search files are `<sanitizedAppId>.json`; app ids are sanitizer-safe, so the stem IS the app id.
export async function listFsSearchApps(): Promise<string[]> {
  try {
    const files = await readdir(searchDir());
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

export interface BackfillSearchResult {
  app: string;
  documents: number;
}

export async function backfillSearch(
  from: MigratableSearchBackend,
  to: MigratableSearchBackend,
  appIds: string[],
): Promise<BackfillSearchResult[]> {
  const results: BackfillSearchResult[] = [];
  for (const app of appIds) {
    const docs = await from.exportApp(app);
    await to.importApp(app, docs);
    results.push({ app, documents: docs.length });
  }
  return results;
}
