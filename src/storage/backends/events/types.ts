import type { AppEvent } from '../../../events/app-events';

// P26 (increment 3) — the pluggable EventBackend interface (C3 application event log / timeline). This
// is the highest-write store. Defined at the capability-operation level (append a fact, read the
// per-(app, owner) feed newest-first, latest-time-per-subject, the one-time owner migration), so a
// filesystem implementation (append-only JSONL) and a Postgres implementation (an append TABLE with
// B-tree indexes + DISTINCT-ON) both satisfy the identical method set — POST /app-events,
// GET /app-events, GET /app-events/latest, and `inspect app-events` never know which runs. Owner-scoping
// (C11) is preserved: an owner-scoped read returns ONLY that owner's events; an owner-less read is
// app-scoped (all owners). The O4 (owner, group_id, visibility) columns are baked in + defaulted so
// group-shared timelines (C31) light up with no second migration.

export interface AppEventInput {
  type: string;
  subject?: string;
  owner?: string;
  data?: Record<string, unknown>;
}

export interface AppEventListOpts {
  subject?: string;
  owner?: string;
  limit?: number;
}

export interface EventBackend {
  append(appId: string, input: AppEventInput): Promise<AppEvent>;
  list(appId: string, opts: AppEventListOpts): Promise<AppEvent[]>; // newest-first
  latestTimes(appId: string, owner?: string): Promise<Record<string, string>>; // subject -> newest ISO
  assignOwner(appId: string, owner: string): Promise<number>; // one-time claim-legacy migration
  close?(): Promise<void>;
  __truncateAllForTests?(): Promise<void>;
}

// Migration surface (backfill FS → PG / dual-write mirror). Events are exported OLDEST-FIRST (insertion
// order) and imported in that order, so ids, timestamps, AND append order are all preserved.
export interface MigratableEventBackend {
  exportApp(appId: string): Promise<AppEvent[]>;
  importApp(appId: string, events: AppEvent[]): Promise<void>;
}

// The feed limit is clamped to [1, 500], default 100 — identical on both backends.
export function clampEventLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 100, 1), 500);
}
