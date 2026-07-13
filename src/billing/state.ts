import type { Catalog, SubscriptionRecord, WebhookEventMark } from './types';

// C33 — the per-app BILLING STATE document the store persists. Modeled as one document per app (like the
// C31 membership graph) rather than per-record tables, because the reconciliation upsert (subscription +
// webhook-dedupe) runs under a single exclusive `mutate` so the monotonic-version guard + one-shot event
// dedupe are atomic and hold IDENTICALLY on the filesystem and Postgres backends. Held OUT of the generic
// Resource store — payment records must never surface through the inspectable `/resources` API.
export interface BillingState {
  catalog: Catalog | null;
  subscriptions: Record<string, SubscriptionRecord>; // keyed by subscriber
  webhook_events: Record<string, WebhookEventMark>; // keyed by provider event id (dedupe)
}

export function emptyBillingState(): BillingState {
  return { catalog: null, subscriptions: {}, webhook_events: {} };
}

// Keep the dedupe map bounded (highest-write, unlike catalog/subscriptions) — retain the most recent marks
// by received_at. A replay older than the window would re-process, which is SAFE (the upsert is idempotent
// via re-fetch + the monotonic version guard), so this only bounds storage, never correctness.
export const WEBHOOK_DEDUPE_MAX = 2000;

export function pruneWebhookEvents(state: BillingState, max: number = WEBHOOK_DEDUPE_MAX): void {
  const ids = Object.keys(state.webhook_events);
  if (ids.length <= max) return;
  const sorted = ids
    .map((id) => state.webhook_events[id]!)
    .sort((a, b) => (a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0));
  const drop = sorted.slice(0, sorted.length - max);
  for (const m of drop) delete state.webhook_events[m.id];
}
