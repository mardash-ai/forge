import { readdir } from 'node:fs/promises';
import { blobsDir } from '../../../shared/paths';
import type { MigratableBlobBackend } from './types';

// P26 — the blob backfill (filesystem → object store + Postgres). For each app, copies every blob's
// bytes into the object store and its metadata into Postgres with the `blob_id` PRESERVED (the app's
// stored handle keeps working). Idempotent per blob (importOne upserts metadata + overwrites bytes).

// FS blob metadata docs are `<appId>.json` directly under blobsDir() (siblings of the `bytes/` and
// `uploads/` dirs); app ids are sanitizer-safe, so the stem IS the app id.
export async function listFsBlobApps(): Promise<string[]> {
  try {
    const entries = await readdir(blobsDir(), { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

export interface BackfillBlobsResult {
  app: string;
  blobs: number;
}

export async function backfillBlobs(
  from: MigratableBlobBackend,
  to: MigratableBlobBackend,
  appIds: string[],
): Promise<BackfillBlobsResult[]> {
  const results: BackfillBlobsResult[] = [];
  for (const app of appIds) {
    const metas = await from.exportMeta(app);
    for (const meta of metas) {
      await to.importOne(app, meta, await from.openBytes(app, meta.blob_id));
    }
    results.push({ app, blobs: metas.length });
  }
  return results;
}
