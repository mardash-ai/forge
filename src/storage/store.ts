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
import { getBackends } from './backends';

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

  // List resources, optionally scoped. `owner` (C11) is the opaque per-user id: when supplied the
  // result is filtered to `resource.owner === owner` (per-user resources like C1 agent-runs never
  // leak across users); when omitted the query is app-scoped (all owners), so a C10-less caller and
  // every pre-C11 record still read exactly as before.
  async listResources(
    filter: { type?: ResourceType; app_id?: string; owner?: string } = {},
  ): Promise<AnyResource[]> {
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
          if (filter.owner !== undefined && r.owner !== filter.owner) continue;
          out.push(r);
        } catch {
          // skip corrupt entries
        }
      }
    }
    out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return out;
  }

  // Assign every owner-less resource of a type for an app to `owner` (C11 one-time migration). This
  // is the platform-side counterpart to a consumer backfilling ITS OWN tables on cutover: legacy
  // app-scoped C1 agent-runs/artifacts (owner absent) get claimed by the seeded owner so they show
  // up under owner-scoped queries. Idempotent — already-owned records are left untouched. Returns
  // the number of records claimed.
  async assignResourceOwner(type: ResourceType, app_id: string, owner: string): Promise<number> {
    const orphans = (await this.listResources({ type, app_id })).filter((r) => r.owner === undefined);
    let n = 0;
    for (const r of orphans) {
      const updated = { ...r, owner, updated_at: nowIso() } as AnyResource;
      await this.saveResource(updated as BaseResource);
      n++;
    }
    return n;
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

  // --- Application event log (C3) — P26: pluggable EventBackend -------------------
  // A per-app append-only log of app DOMAIN facts, separate from the ForgeEvent log above. These four
  // methods forward to the configured EventBackend (filesystem default, or Postgres via
  // FORGE_EVENTS_BACKEND=postgres); the method signatures are unchanged, so the C3 routes, `inspect
  // app-events`, and the claim-legacy migration are contract-stable and never know which backend runs.

  async appendAppEvent(input: {
    app_id: string;
    type: string;
    subject?: string;
    // Owner (C11) — the opaque user id this fact belongs to. Absent = app-scoped/legacy.
    owner?: string;
    data?: Record<string, unknown>;
  }): Promise<AppEvent> {
    const { events } = await getBackends();
    return events.append(input.app_id, { type: input.type, subject: input.subject, owner: input.owner, data: input.data });
  }

  // The per-app feed, newest-first, optionally filtered to a single subject and/or `owner` (C11).
  // An owner-scoped read returns ONLY that owner's events; omitted = app-scoped (all owners). A missing
  // log reads as an empty feed (best-effort — the app must degrade, never crash).
  async listAppEvents(filter: { app_id: string; subject?: string; owner?: string; limit?: number }): Promise<AppEvent[]> {
    const { events } = await getBackends();
    return events.list(filter.app_id, { subject: filter.subject, owner: filter.owner, limit: filter.limit });
  }

  // Latest event time per subject (cold-subject detection). Subject-less events are ignored; when
  // `owner` (C11) is supplied, only that owner's events count.
  async latestAppEventTimes(app_id: string, owner?: string): Promise<Record<string, string>> {
    const { events } = await getBackends();
    return events.latestTimes(app_id, owner);
  }

  // Assign every owner-less app event for an app to `owner` (C11 one-time claim-legacy migration).
  // Idempotent — already-owned events are untouched. Returns the number of events claimed.
  async assignAppEventOwner(app_id: string, owner: string): Promise<number> {
    const { events } = await getBackends();
    return events.assignOwner(app_id, owner);
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

  // The per-app map's STORAGE key for a notification (C11). Owner-less notifications keep the bare
  // app key (unchanged on-disk format — pre-C11 files still load). Owner-scoped notifications are
  // namespaced by owner with a NUL separator (which never appears in a normal key), so two users
  // may hold the SAME app `key` (e.g. "cold:g1") as distinct records that never clobber each other.
  private notifStorageKey(owner: string | undefined, key: string): string {
    return owner === undefined ? key : `${owner} ${key}`;
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
  // Upsert by (app, owner, key). `owner` (C11) namespaces the record so two users may hold the same
  // `key` as distinct notifications; the returned `.key` is always the caller's app key (the owner
  // namespacing is internal). Re-deriving the same condition updates in place (idempotent) and
  // PRESERVES the dismissed flag + created_at — so a dismissed-but-still-true condition stays
  // dismissed instead of resurfacing.
  async upsertNotification(
    app_id: string,
    input: { key: string; title: string; body?: string; data?: Record<string, unknown>; subject?: string; owner?: string },
  ): Promise<Notification> {
    return this.withNotifLock(app_id, async () => {
      const map = await this.readNotifications(app_id);
      const now = nowIso();
      const storageKey = this.notifStorageKey(input.owner, input.key);
      const prev = map[storageKey];
      const n: Notification = {
        key: input.key,
        title: input.title,
        body: input.body,
        data: input.data ?? {},
        subject: input.subject,
        owner: input.owner,
        dismissed: prev?.dismissed ?? false,
        created_at: prev?.created_at ?? now,
        updated_at: now,
      };
      map[storageKey] = n;
      await this.writeNotifications(app_id, map);
      return n;
    });
  }

  async dismissNotification(app_id: string, key: string, owner?: string): Promise<boolean> {
    return this.withNotifLock(app_id, async () => {
      const map = await this.readNotifications(app_id);
      const n = map[this.notifStorageKey(owner, key)];
      if (!n) return false;
      n.dismissed = true;
      n.updated_at = nowIso();
      await this.writeNotifications(app_id, map);
      return true;
    });
  }

  // Remove a notification entirely — its condition no longer applies. Scoped by (app, owner, key).
  async clearNotification(app_id: string, key: string, owner?: string): Promise<boolean> {
    return this.withNotifLock(app_id, async () => {
      const map = await this.readNotifications(app_id);
      const storageKey = this.notifStorageKey(owner, key);
      if (!(storageKey in map)) return false;
      delete map[storageKey];
      await this.writeNotifications(app_id, map);
      return true;
    });
  }

  // List notifications. When `owner` (C11) is supplied, returns ONLY that owner's notifications
  // (cross-owner reads come back empty); when omitted, the list is app-scoped (all owners), so a
  // C10-less caller and legacy owner-less notifications read exactly as before.
  async listNotifications(
    app_id: string,
    opts: { includeDismissed?: boolean; owner?: string } = {},
  ): Promise<Notification[]> {
    const map = await this.readNotifications(app_id);
    let list = Object.values(map);
    if (opts.owner !== undefined) list = list.filter((n) => n.owner === opts.owner);
    if (!opts.includeDismissed) list = list.filter((n) => !n.dismissed);
    list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest-first
    return list;
  }

  // Assign every owner-less notification for an app to `owner` (C11 one-time migration): stamp
  // `owner` onto each legacy record AND re-key it from the bare app key to the owner-namespaced
  // storage key. Already-owned records and any that would collide with an existing owner-scoped
  // key are left as-is. Serialized under the per-app notif lock. Returns the number claimed.
  async assignNotificationOwner(app_id: string, owner: string): Promise<number> {
    return this.withNotifLock(app_id, async () => {
      const map = await this.readNotifications(app_id);
      let n = 0;
      for (const [storageKey, note] of Object.entries(map)) {
        if (note.owner !== undefined) continue; // already owned
        const target = this.notifStorageKey(owner, note.key);
        if (target in map) continue; // owner already has this key — don't clobber
        delete map[storageKey];
        map[target] = { ...note, owner, updated_at: nowIso() };
        n++;
      }
      if (n > 0) await this.writeNotifications(app_id, map);
      return n;
    });
  }

  stateDir(): string {
    return stateDir();
  }
}

export const store = new Store();
