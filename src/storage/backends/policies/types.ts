import type { PolicyRule } from '../../../authz/types';

// C29 / P26 — the pluggable PolicyBackend interface (the C29 policy store). Same seam as every other
// store domain: a filesystem implementation (a per-app JSON keyed map, guarded) and a Postgres
// implementation (one row per policy). Owner-scoping + the O4 (owner, group_id, visibility) model: a
// policy with no owner is APP-WIDE (applies to every actor); an owner-scoped policy is that user's. The
// enforcement point loads the applicable policies (the owner's + app-wide) and evaluates them in-process.
export interface PolicyBackend {
  put(appId: string, policy: PolicyRule): Promise<PolicyRule>; // upsert by id
  get(appId: string, id: string): Promise<PolicyRule | null>;
  delete(appId: string, id: string): Promise<boolean>;
  // `owner` set → that owner's policies PLUS app-wide (owner-less) policies (the set `authorize` needs).
  // `owner` unset → all of the app's policies (the admin/management view).
  list(appId: string, opts: { owner?: string }): Promise<PolicyRule[]>;
  close?(): Promise<void>;
  __truncateAllForTests?(): Promise<void>;
}

export interface MigratablePolicyBackend {
  exportApp(appId: string): Promise<PolicyRule[]>;
  importApp(appId: string, policies: PolicyRule[]): Promise<void>;
}
