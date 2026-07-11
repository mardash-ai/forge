import type { MigratableResourceBackend } from './types';

// P26 — the resource backfill (filesystem → Postgres). Copies every resource verbatim (ids preserved),
// so C1/C2/C7/C12/C14 records + the dev/build resources move without re-creation. Idempotent (importAll
// upserts by (type, id)).
export interface BackfillResourcesResult {
  resources: number;
}

export async function backfillResources(
  from: MigratableResourceBackend,
  to: MigratableResourceBackend,
): Promise<BackfillResourcesResult> {
  const all = await from.exportAll();
  await to.importAll(all);
  return { resources: all.length };
}
