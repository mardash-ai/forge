import { readdir } from 'node:fs/promises';
import { notificationsDir } from '../../../shared/paths';
import type { MigratableNotificationBackend } from './types';

// P26 — the notification backfill (filesystem → Postgres). Copies each app's keyed map into the target
// verbatim (owner, key, dismissed, created_at/updated_at preserved). Idempotent per app (import replaces).

// FS notification docs are `<appId>.json`; app ids are sanitizer-safe, so the stem IS the app id.
export async function listFsNotificationApps(): Promise<string[]> {
  try {
    const files = await readdir(notificationsDir());
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

export interface BackfillNotificationsResult {
  app: string;
  notifications: number;
}

export async function backfillNotifications(
  from: MigratableNotificationBackend,
  to: MigratableNotificationBackend,
  appIds: string[],
): Promise<BackfillNotificationsResult[]> {
  const results: BackfillNotificationsResult[] = [];
  for (const app of appIds) {
    const notifications = await from.exportApp(app);
    await to.importApp(app, notifications);
    results.push({ app, notifications: notifications.length });
  }
  return results;
}
