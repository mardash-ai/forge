// C21 / P26 — the pluggable PushBackend interface (the notification-DELIVERY store). Same seam as every
// other store domain: a filesystem implementation (a per-app guarded JSON doc) and a Postgres
// implementation (two tables). It holds two record kinds per app:
//   - subscriptions: a user's browser Web Push subscriptions — the endpoint + the p256dh/auth keys the
//                    RFC 8291 encryption needs — keyed by `endpoint` (globally unique per push service),
//                    stamped with the owning `owner` (the C10 session userId). Deduped by endpoint: a
//                    device re-registering the same endpoint UPDATES in place (one row per endpoint).
//   - deliveries:   a short-lived cross-channel delivery-idempotency ledger keyed by (owner, idem_key).
//                   `claimDelivery` is an ATOMIC first-writer-wins claim (INSERT … ON CONFLICT DO NOTHING
//                   on PG; a guarded check-then-set on FS) so a retried notify() with the same idempotency
//                   key sends push/email AT MOST ONCE, even under a concurrent double-submit.
// Scoping is by (app, owner): a subscription list / a delivery claim only ever touches the caller's own.
// Holds NO secret material — the VAPID private key lives in the C5 secret vault, never here.

// A browser Web Push subscription (the shape `PushManager.subscribe()` yields, minus expirationTime).
// `endpoint` is the push-service URL forge POSTs the encrypted payload to; `keys.p256dh` (the UA public
// key) + `keys.auth` (the auth secret) are the RFC 8291 inputs.
export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  // Owner (C11) — the opaque per-user id (C10 session userId) this device belongs to.
  owner: string;
  created_at: string;
  updated_at: string;
}

// What a caller registers (owner + the browser subscription). The record's timestamps are backend-minted.
export interface PushSubscriptionInput {
  owner: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushBackend {
  // subscriptions (durable) — upsert by endpoint (dedupe); a re-register updates keys/owner in place.
  registerSubscription(appId: string, input: PushSubscriptionInput): Promise<PushSubscriptionRecord>;
  // Remove one subscription by endpoint. When `owner` is given it must match (a user can only remove
  // their own); omit it for a server-side prune (a push service reported the endpoint 404/410 GONE).
  unregisterSubscription(appId: string, endpoint: string, owner?: string): Promise<boolean>;
  // Every live subscription for one owner (the fan-out target for a push notification).
  listSubscriptions(appId: string, owner: string): Promise<PushSubscriptionRecord[]>;
  // Prune a dead endpoint (a push service returned 404/410). Endpoint-only (we prune what we just tried).
  pruneSubscription(appId: string, endpoint: string): Promise<boolean>;

  // delivery idempotency (short-lived) — ATOMIC first-writer claim. Returns true when THIS call claimed
  // the key (proceed with push/email); false when it was already claimed (a retry — skip external sends).
  claimDelivery(appId: string, owner: string, idemKey: string, nowIso: string): Promise<boolean>;
  // Housekeeping: drop delivery-ledger entries older than the cutoff (bounds the ledger). Best-effort.
  pruneDeliveriesBefore(appId: string, cutoffIso: string): Promise<number>;

  close?(): Promise<void>;
  __truncateAllForTests?(): Promise<void>;
}

// A delivery-ledger entry (owner + idempotency key + when it was claimed).
export interface DeliveryClaim {
  owner: string;
  idem_key: string;
  claimed_at: string;
}

// The full per-app push state (used by the migration surface — FS → PG / dual-write mirror).
export interface PushExport {
  subscriptions: PushSubscriptionRecord[];
  deliveries: DeliveryClaim[];
}

export interface MigratablePushBackend {
  exportApp(appId: string): Promise<PushExport>;
  importApp(appId: string, data: PushExport): Promise<void>;
}
