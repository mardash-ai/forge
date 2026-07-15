// C19 — Search / indexing. A generic, per-app, owner-scoped search surface: an app indexes its own
// resources (goals/tasks/notes/…) and queries them full-text, reached server-side exactly like the
// C3 app-event log + C4 notifications (base URL via the app's FORGE_EVENTS_URL; optional `app` field
// defaulting to the sidecar's FORGE_APP_NAME).
//
// The document is deliberately TYPE-AGNOSTIC: the app's resource types are just `type` values, so one
// index serves every kind of thing the app owns. `(owner, type, id)` is the idempotency key — a
// re-index UPSERTS in place (exactly the C4 upsert-by-key pattern), so the app can safely call /index
// alongside every mutation without creating duplicates.

// An indexable document the app owns. `owner` is REQUIRED (unlike C3/C4, where it is optional): every
// C19 write is owner-stamped and every C19 read is implicitly `WHERE owner = <caller>`, so there is
// no cross-owner surface at all — the crux of the capability.
export interface SearchDocument {
  // Owner (C11) — the opaque per-user id (e.g. C10's session `userId`). REQUIRED. The platform stamps
  // it on every write and filters to it on every read; a document never leaks across owners.
  owner: string;
  // App-defined resource kind, e.g. 'goal' | 'task' | 'note'. Not constrained to a platform enum.
  type: string;
  // The app's own row id for this resource. `(owner, type, id)` is the idempotency key.
  id: string;
  // Primary text, weighted ABOVE body in ranking. Required (a document with nothing to match on is
  // not indexable).
  title: string;
  // Secondary full-text body.
  body?: string;
  // Free-form tags, indexed (weighted between title and body).
  tags?: string[];
  // A small denormalized bag round-tripped back verbatim on every hit — so the app can render a hit
  // (icon, url, status, …) without a second lookup. NOT full-text indexed.
  attrs?: Record<string, unknown>;
  // App-supplied timestamps (ISO-8601). `created_at` is returned on hits and is the field the
  // date_from/date_to filter ranges over; `updated_at` is the primary ranking tie-break (desc).
  created_at?: string;
  updated_at?: string;

  // --- C19 access-aware ACL metadata (ADDITIVE; a doc indexed WITHOUT these behaves exactly as before
  // — owner-only) --------------------------------------------------------------------------------------
  // The household/group this document belongs to. Group- and shared-visibility are ONLY ever evaluated
  // within the SAME groupId — a cross-group caller never matches. Absent ⇒ the doc is owner-only,
  // whatever `visibility` says (there is no group to widen into).
  groupId?: string;
  // Access scope. Default `'private'` (also the meaning of an absent value) ⇒ ONLY the owner can see it.
  // `'group'` ⇒ any same-group caller whose query scope carries the read-all capability. `'shared'` ⇒
  // ONLY the callers listed in sharedWith / sharedWriters (plus, always, the owner).
  visibility?: DocVisibility;
  // Explicit per-caller share grants (opaque caller ids, e.g. C10 session userIds). A caller present in
  // EITHER list may read a `'shared'` document. `sharedWriters` are those additionally granted write
  // access by the consumer; for READ scoping (all C19 does) the two lists are unioned. Ignored unless
  // `visibility === 'shared'`.
  sharedWith?: string[];
  sharedWriters?: string[];
}

// The three access scopes a document can carry. Absent ⇒ treated as 'private'.
export type DocVisibility = 'private' | 'group' | 'shared';

// The caller's access scope, passed on a `/search` to widen the result set beyond the caller's own
// documents. OMITTING scope entirely ⇒ exactly today's owner-only search (backward compatible).
//   - groupId    — the caller's own group/household id. Group/shared docs are only ever matched when
//                  they carry the SAME groupId. Absent ⇒ no group widening (owner-only).
//   - canReadAll — the caller's role capability flag ("may read ALL of the group's docs"). Gates
//                  `visibility === 'group'` documents. `shared`-visibility docs do NOT need it —
//                  they are matched by explicit grant (caller ∈ sharedWith ∪ sharedWriters).
export interface SearchScope {
  groupId?: string;
  canReadAll?: boolean;
}

// A single ranked search hit. `attrs` + `created_at` are round-tripped from the stored document so the
// app can render the hit directly. `snippet` is an HTML excerpt with matched terms wrapped in <mark>.
export interface SearchHit {
  type: string;
  id: string;
  title: string;
  snippet: string;
  score: number;
  attrs?: Record<string, unknown>;
  created_at?: string;
}

// A search request. `owner` is REQUIRED and scopes the whole query. `q` is the free-text query; an
// empty `q` is a 400 (client error), never an empty-result 200. `types` narrows to those resource
// kinds; `date_from`/`date_to` range over the document's `created_at` (inclusive). `limit` is clamped
// server-side to [1, 100] (default 20); `offset` past the end yields empty hits, not an error.
//
// `mode` is reserved: C19 ships only lexical (BM25) search. A future capability adds
// 'semantic' | 'hybrid' (vector search paired with the AI/RAG layer) WITHOUT changing this shape.
export interface SearchQuery {
  owner: string;
  q: string;
  types?: string[];
  limit?: number;
  offset?: number;
  date_from?: string;
  date_to?: string;
  mode?: 'lexical';
  // C19 access-aware scope (optional). Present ⇒ the query returns the caller's own docs PLUS the
  // group/shared docs the scope authorizes (see SearchScope + `docVisibleTo`). Absent ⇒ owner-only,
  // exactly as before. The ACL predicate is applied IN the index, BEFORE limit/offset, so `total` and
  // pagination stay correct.
  scope?: SearchScope;
}

// The /search response. `total` is the count of documents that matched BEFORE limit/offset paging;
// `took_ms` is the server-side ranking time (observability, best-effort).
export interface SearchResponse {
  hits: SearchHit[];
  total: number;
  took_ms?: number;
}

// Server-side clamps + defaults (config, not architecture — the orchestrator set these for the MVP).
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

// Clamp a caller-supplied limit into [1, MAX_LIMIT], defaulting when absent/NaN.
export function clampLimit(limit: unknown): number {
  const n = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(n), 1), MAX_LIMIT);
}

// Clamp a caller-supplied offset to a non-negative integer (default 0).
export function clampOffset(offset: unknown): number {
  const n = typeof offset === 'number' ? offset : Number(offset);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}
