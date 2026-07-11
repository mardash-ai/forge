import { mkdir, readFile, writeFile, appendFile, rename } from 'node:fs/promises';
import { appEventsDir, appEventsFile } from '../../../shared/paths';
import { newId } from '../../../shared/ids';
import { nowIso } from '../../../shared/time';
import type { AppEvent } from '../../../events/app-events';
import {
  clampEventLimit,
  type EventBackend,
  type MigratableEventBackend,
  type AppEventInput,
  type AppEventListOpts,
} from './types';

// P26 — the FILESYSTEM event backend: the legacy C3 behavior, unchanged, moved behind the EventBackend
// interface. A per-app append-only JSONL log; reads scan + parse the file (newest-first = insertion
// order reversed), filtering by (owner, subject). This is the DEFAULT backend — nothing regresses when
// Postgres is not selected.

export class FsEventBackend implements EventBackend, MigratableEventBackend {
  private async readAll(appId: string): Promise<AppEvent[]> {
    let raw: string;
    try {
      raw = await readFile(appEventsFile(appId), 'utf8');
    } catch {
      return [];
    }
    const out: AppEvent[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line) as AppEvent);
      } catch {
        // skip a corrupt line
      }
    }
    return out;
  }

  async append(appId: string, input: AppEventInput): Promise<AppEvent> {
    const event: AppEvent = {
      id: newId('aevt'),
      app_id: appId,
      type: input.type,
      subject: input.subject,
      owner: input.owner,
      data: input.data ?? {},
      at: nowIso(),
    };
    await mkdir(appEventsDir(), { recursive: true });
    await appendFile(appEventsFile(appId), JSON.stringify(event) + '\n');
    return event;
  }

  async list(appId: string, opts: AppEventListOpts): Promise<AppEvent[]> {
    let events = await this.readAll(appId);
    if (opts.owner !== undefined) events = events.filter((e) => e.owner === opts.owner);
    if (opts.subject !== undefined) events = events.filter((e) => e.subject === opts.subject);
    events.reverse(); // newest-first
    return events.slice(0, clampEventLimit(opts.limit));
  }

  async latestTimes(appId: string, owner?: string): Promise<Record<string, string>> {
    const latest: Record<string, string> = {};
    for (const e of await this.readAll(appId)) {
      if (owner !== undefined && e.owner !== owner) continue;
      if (!e.subject) continue;
      const prev = latest[e.subject];
      if (!prev || prev < e.at) latest[e.subject] = e.at;
    }
    return latest;
  }

  async assignOwner(appId: string, owner: string): Promise<number> {
    const events = await this.readAll(appId);
    let n = 0;
    const rewritten = events.map((e) => {
      if (e.owner === undefined) {
        n++;
        return { ...e, owner };
      }
      return e;
    });
    if (n === 0) return 0;
    await mkdir(appEventsDir(), { recursive: true });
    const file = appEventsFile(appId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, rewritten.map((e) => JSON.stringify(e)).join('\n') + '\n');
    await rename(tmp, file);
    return n;
  }

  // Append an EXACT event (id + at preserved) — the dual-write mirror path, so the FS log stays a
  // faithful copy of Postgres without re-minting ids. Not part of the EventBackend contract.
  async mirrorAppend(appId: string, event: AppEvent): Promise<void> {
    await mkdir(appEventsDir(), { recursive: true });
    await appendFile(appEventsFile(appId), JSON.stringify(event) + '\n');
  }

  // --- migration surface (oldest-first, insertion order) -------------------
  async exportApp(appId: string): Promise<AppEvent[]> {
    return this.readAll(appId);
  }

  async importApp(appId: string, events: AppEvent[]): Promise<void> {
    await mkdir(appEventsDir(), { recursive: true });
    const file = appEventsFile(appId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
    await rename(tmp, file);
  }
}
