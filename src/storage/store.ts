import { mkdir, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { resourcesDir, eventsFile, logsDir, stateDir } from '../shared/paths';
import type { AnyResource, ResourceType, BaseResource } from '../resources/types';
import type { ForgeEvent, EventType } from '../events/catalog';
import type { AppEvent } from '../events/app-events';
import type { Notification } from '../notifications/types';
import { newEventId } from '../shared/ids';
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

  // --- Resource store (C1/C2/C7/C12/C14 + core) — P26: pluggable ResourceBackend ------------------
  // These methods forward to the configured ResourceBackend (filesystem default, or Postgres via
  // FORGE_RESOURCES_BACKEND=postgres); the signatures are unchanged, so every capability + the
  // `/resources` routes + `inspect` are contract-stable and never know which backend runs. Writes are
  // atomic (FS temp+rename) / transactional (PG upsert) — closing the P27 torn-write on this store.

  async saveResource<T extends BaseResource>(resource: T): Promise<T> {
    return (await getBackends()).resources.save(resource);
  }

  async deleteResource(type: ResourceType, id: string): Promise<boolean> {
    return (await getBackends()).resources.delete(type, id);
  }

  async getResource<T extends AnyResource = AnyResource>(type: ResourceType, id: string): Promise<T | null> {
    return (await getBackends()).resources.get<T>(type, id);
  }

  async findResourceById(id: string): Promise<AnyResource | null> {
    return (await getBackends()).resources.findById(id);
  }

  async listResources(filter: { type?: ResourceType; app_id?: string; owner?: string } = {}): Promise<AnyResource[]> {
    return (await getBackends()).resources.list(filter);
  }

  async assignResourceOwner(type: ResourceType, app_id: string, owner: string): Promise<number> {
    return (await getBackends()).resources.assignOwner(type, app_id, owner);
  }

  async findAppByName(name: string): Promise<AnyResource | null> {
    return (await getBackends()).resources.findAppByName(name);
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

  // --- Notifications (C4) — P26: pluggable NotificationBackend --------------------
  // Durable, per-app, keyed notifications (upsert by key; dismiss/clear/list). These methods forward to
  // the configured NotificationBackend (filesystem default, or Postgres via
  // FORGE_NOTIFICATIONS_BACKEND=postgres); the signatures are unchanged, so the C4 routes and the
  // claim-legacy migration are contract-stable and never know which backend runs. On Postgres, upsert is
  // an INSERT … ON CONFLICT (no whole-map rewrite) and dismiss/clear are targeted UPDATE/DELETE, so
  // concurrent mutations to distinct keys can't lose an update (the P5/P27 race is gone by construction).

  async upsertNotification(
    app_id: string,
    input: { key: string; title: string; body?: string; data?: Record<string, unknown>; subject?: string; owner?: string },
  ): Promise<Notification> {
    const { notifications } = await getBackends();
    return notifications.upsert(app_id, input);
  }

  async dismissNotification(app_id: string, key: string, owner?: string): Promise<boolean> {
    const { notifications } = await getBackends();
    return notifications.dismiss(app_id, key, owner);
  }

  async clearNotification(app_id: string, key: string, owner?: string): Promise<boolean> {
    const { notifications } = await getBackends();
    return notifications.clear(app_id, key, owner);
  }

  async listNotifications(
    app_id: string,
    opts: { includeDismissed?: boolean; owner?: string } = {},
  ): Promise<Notification[]> {
    const { notifications } = await getBackends();
    return notifications.list(app_id, opts);
  }

  async assignNotificationOwner(app_id: string, owner: string): Promise<number> {
    const { notifications } = await getBackends();
    return notifications.assignOwner(app_id, owner);
  }

  stateDir(): string {
    return stateDir();
  }
}

export const store = new Store();
