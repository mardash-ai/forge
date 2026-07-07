// Notification — a durable, per-app, keyed notification (capability C4). The app derives WHICH
// conditions matter (domain — e.g. "goal has been cold for 7 days", "task overdue") and upserts a
// Notification by a stable `key` (e.g. "cold:<goalId>"); Forge persists it, tracks dismissal, and
// lets the app clear it when the condition no longer applies. Keyed upsert makes re-deriving the
// same condition idempotent (no duplicates), and a scheduled job (C2) can keep the store current
// while the user is away — so the inbox/badge is right even before they open the app.
export interface Notification {
  // Stable, app-defined identity for the condition (dedupes re-derivations).
  key: string;
  title: string;
  body?: string;
  // App-defined payload the inbox renders (denormalized snapshot).
  data: Record<string, unknown>;
  // Optional subject ref (e.g. the goal id) the notification is about.
  subject?: string;
  // Dismissed by the user — kept out of the active feed, but remembered so a re-derivation of the
  // same still-true condition does not resurface it.
  dismissed: boolean;
  created_at: string;
  updated_at: string;
}
