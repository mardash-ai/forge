import { readdir } from 'node:fs/promises';
import { pushDir } from '../../../shared/paths';
import type { MigratablePushBackend } from './types';

// C21 / P26 — the notification-delivery backfill (filesystem → Postgres). Copies each app's push
// subscriptions + delivery ledger into the target verbatim (endpoints, keys, owners, timestamps
// preserved). Idempotent per app (import replaces the app's set).

// FS push docs are `<appId>.json`; app ids are sanitizer-safe, so the stem IS the app id.
export async function listFsPushApps(): Promise<string[]> {
  try {
    const files = await readdir(pushDir());
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

export interface BackfillPushResult {
  app: string;
  subscriptions: number;
  deliveries: number;
}

export async function backfillPush(
  from: MigratablePushBackend,
  to: MigratablePushBackend,
  appIds: string[],
): Promise<BackfillPushResult[]> {
  const results: BackfillPushResult[] = [];
  for (const app of appIds) {
    const data = await from.exportApp(app);
    await to.importApp(app, data);
    results.push({ app, subscriptions: data.subscriptions.length, deliveries: data.deliveries.length });
  }
  return results;
}
