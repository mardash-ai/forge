import { readdir } from 'node:fs/promises';
import { authDir } from '../../../shared/paths';
import type { MigratableIdentityBackend } from './types';

// P26 — the identity backfill (filesystem → Postgres) that seeds the migration. Reads each app's FS
// identity doc and IMPORTS it into the target backend, ids preserved (so cookies/sessions stay valid),
// then the operator flips reads to the new backend (dual-write window → cutover). Contract-stable: no
// user or session is re-minted, only relocated.

// The app ids that have a filesystem identity doc. FS auth files are `<sanitizedAppId>.json`; app ids
// are already sanitizer-safe (alnum + _/-), so the filename stem IS the app id.
export async function listFsIdentityApps(): Promise<string[]> {
  try {
    const files = await readdir(authDir());
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch {
    return []; // no auth dir yet — nothing to migrate
  }
}

export interface BackfillAppResult {
  app: string;
  users: number;
  sessions: number;
  refresh_tokens: number;
}

// Copy the identity state for each app from `from` (e.g. filesystem) to `to` (e.g. Postgres). Import is
// a REPLACE per app, so re-running is idempotent (converges the target to the source).
export async function backfillIdentity(
  from: MigratableIdentityBackend,
  to: MigratableIdentityBackend,
  appIds: string[],
): Promise<BackfillAppResult[]> {
  const results: BackfillAppResult[] = [];
  for (const app of appIds) {
    const snap = await from.exportApp(app);
    await to.importApp(app, snap);
    results.push({ app, users: snap.users.length, sessions: snap.sessions.length, refresh_tokens: snap.refresh_tokens.length });
  }
  return results;
}
