import type { Notification } from '../../../notifications/types';

// P26 (increment 4) — the pluggable NotificationBackend interface (C4). Defined at the
// capability-operation level (upsert-by-key, dismiss, clear, owner-scoped list, the one-time owner
// migration), so a filesystem implementation (a per-app JSON keyed map, mutex + atomic rewrite) and a
// Postgres implementation (INSERT … ON CONFLICT upsert + targeted UPDATE/DELETE, no whole-map rewrite)
// both satisfy the identical method set — POST /notifications[/dismiss|/clear] + GET /notifications never
// know which runs. Scoping is by (app, owner, key): two users may hold the SAME key as distinct records;
// an owner-scoped read/mutate touches only that owner's; an owner-less record is app-scoped (legacy). The
// O4 (owner, group_id, visibility) columns are baked in + defaulted so group-shared inboxes (C31) light
// up with no second migration.

export interface NotificationUpsertInput {
  key: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  subject?: string;
  owner?: string;
}

export interface NotificationListOpts {
  includeDismissed?: boolean;
  owner?: string;
}

export interface NotificationBackend {
  upsert(appId: string, input: NotificationUpsertInput): Promise<Notification>;
  dismiss(appId: string, key: string, owner?: string): Promise<boolean>;
  clear(appId: string, key: string, owner?: string): Promise<boolean>;
  list(appId: string, opts: NotificationListOpts): Promise<Notification[]>; // newest-first
  assignOwner(appId: string, owner: string): Promise<number>; // one-time claim-legacy migration
  close?(): Promise<void>;
  __truncateAllForTests?(): Promise<void>;
}

// Migration surface (backfill FS → PG / dual-write mirror). Notifications are copied verbatim (owner,
// key, dismissed, created_at/updated_at preserved).
export interface MigratableNotificationBackend {
  exportApp(appId: string): Promise<Notification[]>;
  importApp(appId: string, notifications: Notification[]): Promise<void>; // replace the app's set
}
