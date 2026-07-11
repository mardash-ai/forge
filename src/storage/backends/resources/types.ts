import type { AnyResource, ResourceType, BaseResource } from '../../../resources/types';

// P26 (increment 6) — the pluggable ResourceBackend interface (the generic Resource store behind C1
// AgentTask/Artifact, C2 ScheduledJob, C7 Deployment, C12 EmailDelivery, C14 Verification, and the
// dev/build resources). A filesystem implementation keeps one JSON file per resource; a Postgres
// implementation keeps one `jsonb` row per resource. Both satisfy the identical method set, so the
// `store` resource surface + the `/resources` routes + `inspect` never know which runs. Writes are
// TRANSACTIONAL on Postgres (a single upsert) and atomic (temp + rename) on the filesystem — closing the
// P27 torn-write on the Resource store. Owner-scoping (C11) is preserved; the O4 (owner, group_id,
// visibility) columns are baked into the Postgres schema.
export interface ResourceBackend {
  save<T extends BaseResource>(resource: T): Promise<T>; // upsert
  get<T extends AnyResource = AnyResource>(type: ResourceType, id: string): Promise<T | null>;
  delete(type: ResourceType, id: string): Promise<boolean>;
  findById(id: string): Promise<AnyResource | null>;
  list(filter: { type?: ResourceType; app_id?: string; owner?: string }): Promise<AnyResource[]>; // newest-first
  assignOwner(type: ResourceType, app_id: string, owner: string): Promise<number>; // one-time C11 migration
  findAppByName(name: string): Promise<AnyResource | null>;
  close?(): Promise<void>;
  __truncateAllForTests?(): Promise<void>;
}

// Migration surface (backfill FS → PG / dual-write mirror). Resources move verbatim (ids preserved).
export interface MigratableResourceBackend {
  exportAll(): Promise<AnyResource[]>;
  importAll(resources: AnyResource[]): Promise<void>;
}
