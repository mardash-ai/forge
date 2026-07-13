import type { BillingState } from '../../../billing/state';

// C33 / P26 — the pluggable BillingBackend interface (the payment-source-agnostic billing store). Same seam
// as C31 membership: a filesystem implementation (one guarded JSON doc per app) and a Postgres
// implementation (one jsonb row per app). Billing is modeled as a per-app DOCUMENT because the
// reconciliation upsert spans records under invariants (monotonic-version subscription upsert + one-shot
// webhook-event dedupe); `mutate` runs a pure op under exclusive access (FS per-app lock / PG SELECT … FOR
// UPDATE) and commits the resulting state atomically, so the invariant logic lives ONCE and holds
// identically on both backends.
export interface BillingBackend {
  // Read the full billing state for an app (a fresh copy — safe for the caller to inspect).
  read(appId: string): Promise<BillingState>;

  // Run `fn` against the current state under exclusive access, then persist the returned state atomically.
  // `fn` may throw to ABORT with no write. Returns fn's `result`.
  mutate<T>(appId: string, fn: (state: BillingState) => { state: BillingState; result: T }): Promise<T>;

  close?(): Promise<void>;
  __truncateAllForTests?(): Promise<void>;
}

export interface MigratableBillingBackend {
  exportApp(appId: string): Promise<BillingState>;
  importApp(appId: string, state: BillingState): Promise<void>;
}
