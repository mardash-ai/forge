import { readdir } from 'node:fs/promises';
import { appEventsDir } from '../../../shared/paths';
import type { MigratableEventBackend } from './types';

// P26 — the event backfill (filesystem → Postgres). Copies each app's JSONL log into the target,
// OLDEST-FIRST, so ids, timestamps, and append order are all preserved (the app never re-emits).
// Idempotent per app (import replaces).

// FS app-event logs are `<appId>.jsonl`; app ids are sanitizer-safe, so the stem IS the app id.
export async function listFsEventApps(): Promise<string[]> {
  try {
    const files = await readdir(appEventsDir());
    return files.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length));
  } catch {
    return [];
  }
}

export interface BackfillEventsResult {
  app: string;
  events: number;
}

export async function backfillEvents(
  from: MigratableEventBackend,
  to: MigratableEventBackend,
  appIds: string[],
): Promise<BackfillEventsResult[]> {
  const results: BackfillEventsResult[] = [];
  for (const app of appIds) {
    const events = await from.exportApp(app);
    await to.importApp(app, events);
    results.push({ app, events: events.length });
  }
  return results;
}
