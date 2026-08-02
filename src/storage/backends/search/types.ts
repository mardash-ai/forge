import type { SearchDocument, SearchQuery, SearchResponse } from '../../../search/types';

// P26 (increment 2) — the pluggable SearchBackend interface (C19). Defined at the capability-operation
// level (index / delete / reindex / owner-scoped ranked search), so a filesystem implementation (a JSON
// map + the pure in-TS BM25 ranker) and a Postgres implementation (a real tsvector + GIN inverted index,
// websearch_to_tsquery + ts_rank) both satisfy the identical method set — the /index, /index/delete,
// /reindex, /search routes never know which is running. Owner-scoping is structural in BOTH: every write
// is owner-stamped and every search is `WHERE owner = <caller>` (extended to the O4 (owner, group_id,
// visibility) scope in the Postgres schema, defaulted so households/C31 need no second migration).
export interface SearchBackend {
  index(appId: string, doc: SearchDocument): Promise<SearchDocument>;
  reindex(appId: string, docs: SearchDocument[]): Promise<number>;
  delete(appId: string, ref: { owner: string; type: string; id: string }): Promise<boolean>;
  // Owner-scoped, ranked. May throw on an internal failure — the route catches it and degrades to 503.
  search(appId: string, query: SearchQuery): Promise<SearchResponse>;
  // lifecycle (optional): external-resource backends implement.
  /**
   * Remove EVERY row this owner has, and report how many.
   *
   * Added for whole-account teardown (C34). Before this the only delete was per-{key,id,endpoint},
   * so erasing an account meant enumerating its rows first — and for two of these backends the
   * enumeration was not even exposed over HTTP, which made a complete deletion impossible from
   * outside. A cascade that cannot reach a subsystem leaves residue that outlives the account.
   */
  deleteByOwner(appId: string, owner: string): Promise<number>;
  close?(): Promise<void>;
  __truncateAllForTests?(): Promise<void>;
}

// Migration surface (backfill FS → PG / dual-write mirror). Documents are copied verbatim, so the
// (owner, type, id) idempotency key is preserved and a cutover is contract-stable.
export interface MigratableSearchBackend {
  exportApp(appId: string): Promise<SearchDocument[]>;
  importApp(appId: string, docs: SearchDocument[]): Promise<void>; // replace the app's index
}
