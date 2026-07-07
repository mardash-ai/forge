import { mkdir, readFile, writeFile, readdir, appendFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import {
  resourcesDir,
  eventsFile,
  appEventsDir,
  appEventsFile,
  notificationsDir,
  notificationsFile,
  logsDir,
  stateDir,
} from '../shared/paths';
import type { AnyResource, ResourceType, BaseResource } from '../resources/types';
import type { ForgeEvent, EventType } from '../events/catalog';
import type { AppEvent } from '../events/app-events';
import type { Notification } from '../notifications/types';
import { newEventId, newId } from '../shared/ids';
import type { Actor } from '../shared/domain';
import { nowIso } from '../shared/time';

// Filesystem-backed Resource + Event store. Intentionally simple for v1 local
// mode (JSON documents + append-only JSONL). Postgres comes later in service
// mode; the interface here is what Capabilities depend on.
export class Store {
  async init(): Promise<void> {
    await mkdir(resourcesDir(), { recursive: true });
    await mkdir(logsDir(), { recursive: true });
    await mkdir(path.dirname(eventsFile()), { recursive: true });
  }

  private resourceTypeDir(type: ResourceType): string {
    return path.join(resourcesDir(), type);
  }

  private resourcePath(type: ResourceType, id: string): string {
    return path.join(this.resourceTypeDir(type), `${id}.json`);
  }

  async saveResource<T extends BaseResource>(resource: T): Promise<T> {
    await mkdir(this.resourceTypeDir(resource.type), { recursive: true });
    await writeFile(this.resourcePath(resource.type, resource.id), JSON.stringify(resource, null, 2));
    return resource;
  }

  async deleteResource(type: ResourceType, id: string): Promise<boolean> {
    try {
      await rm(this.resourcePath(type, id));
      return true;
    } catch {
      return false;
    }
  }

  async getResource<T extends AnyResource = AnyResource>(
    type: ResourceType,
    id: string,
  ): Promise<T | null> {
    try {
      const raw = await readFile(this.resourcePath(type, id), 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  // Find a resource by id across all types (used when the caller only has an id).
  async findResourceById(id: string): Promise<AnyResource | null> {
    for (const type of await this.listTypes()) {
      const r = await this.getResource(type, id);
      if (r) return r;
    }
    return null;
  }

  private async listTypes(): Promise<ResourceType[]> {
    try {
      const entries = await readdir(resourcesDir(), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name as ResourceType);
    } catch {
      return [];
    }
  }

  async listResources(filter: { type?: ResourceType; app_id?: string } = {}): Promise<AnyResource[]> {
    const types = filter.type ? [filter.type] : await this.listTypes();
    const out: AnyResource[] = [];
    for (const type of types) {
      let files: string[] = [];
      try {
        files = await readdir(this.resourceTypeDir(type));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await readFile(path.join(this.resourceTypeDir(type), file), 'utf8');
          const r = JSON.parse(raw) as AnyResource;
          if (filter.app_id && r.app_id !== filter.app_id) continue;
          out.push(r);
        } catch {
          // skip corrupt entries
        }
      }
    }
    out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return out;
  }

  async findAppByName(name: string): Promise<AnyResource | null> {
    const apps = await this.listResources({ type: 'Application' });
    return apps.find((a) => (a as { name?: string }).name === name) ?? null;
  }

  async appendEvent(input: {
    type: EventType;
    resource_type: string;
    resource_id: string;
    app_id?: string;
    actor: Actor;
    data?: Record<string, unknown>;
  }): Promise<ForgeEvent> {
    const event: ForgeEvent = {
      id: newEventId(),
      type: input.type,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      app_id: input.app_id,
      timestamp: nowIso(),
      actor: input.actor,
      data: input.data ?? {},
    };
    await mkdir(path.dirname(eventsFile()), { recursive: true });
    await appendFile(eventsFile(), JSON.stringify(event) + '\n');
    return event;
  }

  async listEvents(filter: { app_id?: string; resource_id?: string; limit?: number } = {}): Promise<ForgeEvent[]> {
    let raw: string;
    try {
      raw = await readFile(eventsFile(), 'utf8');
    } catch {
      return [];
    }
    let events = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as ForgeEvent);
    if (filter.app_id) events = events.filter((e) => e.app_id === filter.app_id);
    if (filter.resource_id) events = events.filter((e) => e.resource_id === filter.resource_id);
    events.reverse(); // newest first
    if (filter.limit) events = events.slice(0, filter.limit);
    return events;
  }

  // --- Application event log (C3) -------------------------------------------------
  // A per-app append-only log of app DOMAIN facts, separate from the ForgeEvent log
  // above. `type`/`subject` are app-defined; `data` is a denormalized snapshot.

  async appendAppEvent(input: {
    app_id: string;
    type: string;
    subject?: string;
    data?: Record<string, unknown>;
  }): Promise<AppEvent> {
    const event: AppEvent = {
      id: newId('aevt'),
      app_id: input.app_id,
      type: input.type,
      subject: input.subject,
      data: input.data ?? {},
      at: nowIso(),
    };
    await mkdir(appEventsDir(), { recursive: true });
    await appendFile(appEventsFile(input.app_id), JSON.stringify(event) + '\n');
    return event;
  }

  // The per-app feed, newest-first, optionally filtered to a single subject. A missing log
  // reads as an empty feed (best-effort — the app must degrade, never crash).
  async listAppEvents(filter: { app_id: string; subject?: string; limit?: number }): Promise<AppEvent[]> {
    let raw: string;
    try {
      raw = await readFile(appEventsFile(filter.app_id), 'utf8');
    } catch {
      return [];
    }
    let events = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AppEvent);
    if (filter.subject !== undefined) events = events.filter((e) => e.subject === filter.subject);
    events.reverse(); // newest first
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return events.slice(0, limit);
  }

  // Latest event time per subject — the primitive cold-subject detection needs (e.g. "goals
  // with no activity in N days"). Events without a subject are ignored.
  async latestAppEventTimes(app_id: string): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(appEventsFile(app_id), 'utf8');
    } catch {
      return {};
    }
    const latest: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      let e: AppEvent;
      try {
        e = JSON.parse(line) as AppEvent;
      } catch {
        continue;
      }
      if (!e.subject) continue;
      const prev = latest[e.subject];
      if (!prev || prev < e.at) latest[e.subject] = e.at;
    }
    return latest;
  }

  // --- Notifications (C4) ---------------------------------------------------------
  // Durable, per-app, keyed notifications. The app derives WHICH conditions matter and upserts
  // by a stable key; Forge persists + tracks dismissal + clear. One JSON doc (keyed map) per app.
  //
  // A mutation is a read-modify-write of the whole per-app map. That RMW is NOT atomic on its
  // own, so two concurrent mutations (even to DIFFERENT keys) would both read the same map, each
  // apply only its own change, and the later write would clobber the earlier one — a lost update.
  // `withNotifLock` serializes every mutation for a given app so the RMW runs one-at-a-time, and
  // `writeNotifications` replaces the file atomically (temp + rename) so a concurrent reader never
  // observes a half-written file. Reads do not take the lock.

  // Per-app promise chain (async mutex). Keyed by app_id so different apps never block each other.
  private notifLocks = new Map<string, Promise<unknown>>();

  private withNotifLock<T>(app_id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.notifLocks.get(app_id) ?? Promise.resolve();
    // Run fn after the previous holder settles, whether it resolved or rejected.
    const run = prev.then(fn, fn);
    // The lock tail must never reject, or a failed mutation would wedge the next waiter.
    this.notifLocks.set(
      app_id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async readNotifications(app_id: string): Promise<Record<string, Notification>> {
    try {
      return JSON.parse(await readFile(notificationsFile(app_id), 'utf8')) as Record<string, Notification>;
    } catch {
      return {};
    }
  }

  // Atomic replace: write a sibling temp file then rename over the target. rename(2) is atomic on
  // the same filesystem, so a reader sees either the whole old file or the whole new one.
  private async writeNotifications(app_id: string, map: Record<string, Notification>): Promise<void> {
    await mkdir(notificationsDir(), { recursive: true });
    const file = notificationsFile(app_id);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(map, null, 2));
    await rename(tmp, file);
  }

  // Upsert by (app, key). Re-deriving the same condition updates in place (idempotent) and
  // PRESERVES the dismissed flag + created_at — so a dismissed-but-still-true condition stays
  // dismissed instead of resurfacing.
  async upsertNotification(
    app_id: string,
    input: { key: string; title: string; body?: string; data?: Record<string, unknown>; subject?: string },
  ): Promise<Notification> {
    return this.withNotifLock(app_id, async () => {
      const map = await this.readNotifications(app_id);
      const now = nowIso();
      const prev = map[input.key];
      const n: Notification = {
        key: input.key,
        title: input.title,
        body: input.body,
        data: input.data ?? {},
        subject: input.subject,
        dismissed: prev?.dismissed ?? false,
        created_at: prev?.created_at ?? now,
        updated_at: now,
      };
      map[input.key] = n;
      await this.writeNotifications(app_id, map);
      return n;
    });
  }

  async dismissNotification(app_id: string, key: string): Promise<boolean> {
    return this.withNotifLock(app_id, async () => {
      const map = await this.readNotifications(app_id);
      const n = map[key];
      if (!n) return false;
      n.dismissed = true;
      n.updated_at = nowIso();
      await this.writeNotifications(app_id, map);
      return true;
    });
  }

  // Remove a notification entirely — its condition no longer applies.
  async clearNotification(app_id: string, key: string): Promise<boolean> {
    return this.withNotifLock(app_id, async () => {
      const map = await this.readNotifications(app_id);
      if (!(key in map)) return false;
      delete map[key];
      await this.writeNotifications(app_id, map);
      return true;
    });
  }

  async listNotifications(app_id: string, opts: { includeDismissed?: boolean } = {}): Promise<Notification[]> {
    const map = await this.readNotifications(app_id);
    let list = Object.values(map);
    if (!opts.includeDismissed) list = list.filter((n) => !n.dismissed);
    list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest-first
    return list;
  }

  stateDir(): string {
    return stateDir();
  }
}

export const store = new Store();
