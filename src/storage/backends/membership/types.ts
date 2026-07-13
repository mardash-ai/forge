import type { MembershipState } from '../../../membership/types';

// C31 / P26 — the pluggable MembershipBackend interface (the platform-owned membership graph store). Same
// seam as every other store domain: a filesystem implementation (one guarded JSON doc per app) and a
// Postgres implementation (one jsonb row per app). Unlike the per-record stores, membership is modeled as
// a per-app DOCUMENT because its operations span multiple records under invariants (≥1-owner, singleton
// flip, one-shot invitations); `mutate` runs a pure op (src/membership/service.ts) under exclusive access
// (FS per-app lock / PG SELECT … FOR UPDATE) and commits the resulting state atomically. So the invariant
// logic lives ONCE and holds identically on both backends.
export interface MembershipBackend {
  // Read the full membership state for an app (a fresh copy — safe for the caller to inspect).
  read(appId: string): Promise<MembershipState>;

  // Run `fn` against the current state under exclusive access, then persist the returned state atomically.
  // `fn` may throw to ABORT with no write (the store rolls back). Returns fn's `result`.
  mutate<T>(appId: string, fn: (state: MembershipState) => { state: MembershipState; result: T }): Promise<T>;

  close?(): Promise<void>;
  __truncateAllForTests?(): Promise<void>;
}

export interface MigratableMembershipBackend {
  exportApp(appId: string): Promise<MembershipState>;
  importApp(appId: string, state: MembershipState): Promise<void>;
}
