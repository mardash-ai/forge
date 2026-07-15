import type { SearchDocument, SearchScope } from './types';

// C19 access-aware search — the SINGLE source of truth for "may this caller see this document?". It is
// applied IN the index, over the full candidate set, BEFORE limit/offset paging. That ordering is the
// whole point: a post-query filter (rank → page → drop the ones the caller can't see) would under-fetch
// under `limit` and corrupt `total`/pagination. The filesystem backend calls this directly; the Postgres
// backend encodes the IDENTICAL predicate in SQL. Pure + deterministic — no I/O, unit-testable.
//
// The predicate (caller = the query owner; scope = the caller's optional access scope):
//
//   owner == caller
//   OR ( doc.groupId == scope.groupId
//        AND ( (visibility == 'group'  AND scope.canReadAll)
//           OR (visibility == 'shared' AND caller ∈ sharedWith ∪ sharedWriters) ) )
//
// Backward-compatibility invariants that fall straight out of this:
//   - No scope on the query        ⇒ only `owner == caller` can be true ⇒ owner-only (today's behavior).
//   - No ACL metadata on a document⇒ visibility defaults to 'private', groupId absent ⇒ owner-only.
//   - 'group'/'shared' are ONLY ever evaluated within the SAME groupId ⇒ a cross-group caller never
//     matches, so nothing leaks across households.
export function docVisibleTo(doc: SearchDocument, caller: string, scope?: SearchScope): boolean {
  // You always see what you own — any visibility, share list, or (absent) scope notwithstanding.
  if (doc.owner === caller) return true;

  // Without a scope (or without the caller's own group) there is no group to widen into ⇒ owner-only.
  if (!scope || !scope.groupId) return false;

  // Group/shared visibility is only ever matched WITHIN the same group. Cross-group ⇒ never.
  if (!doc.groupId || doc.groupId !== scope.groupId) return false;

  const visibility = doc.visibility ?? 'private';
  if (visibility === 'group') return scope.canReadAll === true;
  if (visibility === 'shared') {
    return (doc.sharedWith?.includes(caller) ?? false) || (doc.sharedWriters?.includes(caller) ?? false);
  }
  // 'private' (or an unknown value) shared into a group is still never visible to a non-owner.
  return false;
}
