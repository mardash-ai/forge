import type { FastifyInstance } from 'fastify';
import { store } from '../storage/store';
import { searchStore } from '../storage/search-store';
import type { SearchDocument, SearchScope, DocVisibility } from '../search/types';

// C19 — the SEARCH / indexing surface. Registered on BOTH the control-plane API (dev) and the
// data-plane server (prod sidecar), like the C3 app-event + C4 notification routes (app→Forge): the
// running app indexes its own resources and queries them back. Reached server-side the same way the
// app reaches C3/C4 (base URL via the app's FORGE_EVENTS_URL; `app` defaults to the sidecar's
// FORGE_APP_NAME, so the app usually needn't pass it).
//
//   POST /index          { app?, owner, type, id, title, body?, tags?, attrs?, created_at?, updated_at?,
//                          groupId?, visibility?, sharedWith?, sharedWriters? }                            -> { document }
//   POST /index/delete   { app?, owner, type, id }                                                         -> { deleted }
//   POST /reindex        { app?, documents: Document[] }                                                   -> { indexed }
//   POST /search         { app?, owner, q, types?, limit?, offset?, date_from?, date_to?,
//                          scope?: { groupId?, canReadAll? } }                                             -> { hits, total, took_ms }
//
// OWNER-SCOPING (mandatory): `owner` (C10's session userId) is REQUIRED on every write and every
// search. The platform stamps it on writes; a /search ALWAYS returns the caller's own documents.
// Trust model is app-asserted: the private data-plane trusts the `owner`/`scope` the app sends (exactly
// as C3/C4/C1 do); there is no per-user token scheme.
//
// C19 ACCESS-AWARE SEARCH (additive, backward compatible): a document may carry ACL metadata —
// `groupId`, `visibility` ('private' | 'group' | 'shared'), and explicit `sharedWith` / `sharedWriters`
// grant lists. When /search is given the caller's `scope` (`{ groupId?, canReadAll? }`), the index
// returns the caller's own docs PLUS group/shared docs the scope authorizes, applying — IN the index,
// BEFORE limit/paging — the predicate:
//     owner == caller
//     OR ( doc.groupId == scope.groupId
//          AND ( (visibility=='group'  AND scope.canReadAll)
//             OR (visibility=='shared' AND caller ∈ sharedWith ∪ sharedWriters) ) )
// OMIT `scope` ⇒ exactly today's owner-only search. A doc indexed WITHOUT ACL metadata is owner-only
// (private). See src/search/acl.ts for the single source of truth.
//
// FAILURE MODES:
//   - Writes (/index, /index/delete, /reindex) are BEST-EFFORT (the app calls them alongside its
//     mutations): missing required fields → 422; a genuine store failure surfaces as a 500 the app's
//     short-timeout client swallows (the write is non-fatal; /reindex is the backstop).
//   - /search is user-invoked: bad input (missing owner, empty q) → 400; an internal store failure →
//     503 with a `search_unavailable` code the app can soft-handle (degrade to empty results), NOT a
//     500. Pagination past the end → empty hits (a 200, not an error).
export function registerSearchRoutes(
  app: FastifyInstance,
  opts: { defaultApp?: () => string | undefined } = {},
): void {
  const resolveAppId = async (name?: string): Promise<string | null> => {
    const n = name ?? opts.defaultApp?.();
    if (!n) return null;
    const a = await store.findAppByName(n);
    return a && a.type === 'Application' ? a.id : null;
  };
  const unknownApp = { error: { code: 'not_found', message: 'unknown app (pass `app` or set FORGE_APP_NAME).', retry: 'change-input' } };
  const invalid = (message: string) => ({ error: { code: 'invalid_input', message, retry: 'change-input' } });

  // Validate + normalise one indexable document. Returns the document or an error message.
  const parseDoc = (raw: unknown): { doc: SearchDocument } | { err: string } => {
    const b = (raw ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const strArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? (v as unknown[]).filter((s): s is string => typeof s === 'string') : undefined;
    const owner = str(b.owner);
    const type = str(b.type);
    const id = str(b.id);
    const title = str(b.title);
    if (!owner || !owner.trim()) return { err: 'a document requires a non-empty string `owner`.' };
    if (!type || !type.trim()) return { err: 'a document requires a non-empty string `type`.' };
    if (!id || !id.trim()) return { err: 'a document requires a non-empty string `id`.' };
    if (title === undefined || !title.trim()) return { err: 'a document requires a non-empty string `title`.' };
    const attrs = b.attrs !== undefined && typeof b.attrs === 'object' && b.attrs !== null ? (b.attrs as Record<string, unknown>) : undefined;
    // C19 ACL metadata (all optional; absent ⇒ owner-only). `groupId` is read as a dedicated field, and
    // for continuity with consumers that already stamp it into `attrs`, falls back to `attrs.groupId`.
    const groupId = str(b.groupId) ?? (attrs && typeof attrs.groupId === 'string' ? attrs.groupId : undefined);
    const visibility = str(b.visibility);
    if (visibility !== undefined && visibility !== 'private' && visibility !== 'group' && visibility !== 'shared') {
      return { err: "`visibility` must be one of 'private' | 'group' | 'shared'." };
    }
    const sharedWith = strArr(b.sharedWith);
    const sharedWriters = strArr(b.sharedWriters);
    const doc: SearchDocument = {
      owner,
      type,
      id,
      title,
      ...(str(b.body) !== undefined ? { body: str(b.body) } : {}),
      ...(Array.isArray(b.tags) ? { tags: (b.tags as unknown[]).filter((t): t is string => typeof t === 'string') } : {}),
      ...(attrs !== undefined ? { attrs } : {}),
      ...(str(b.created_at) !== undefined ? { created_at: str(b.created_at) } : {}),
      ...(str(b.updated_at) !== undefined ? { updated_at: str(b.updated_at) } : {}),
      ...(groupId !== undefined ? { groupId } : {}),
      ...(visibility !== undefined ? { visibility: visibility as DocVisibility } : {}),
      ...(sharedWith !== undefined ? { sharedWith } : {}),
      ...(sharedWriters !== undefined ? { sharedWriters } : {}),
    };
    return { doc };
  };

  // Upsert one document — idempotent by (owner, type, id). Best-effort: the app fire-and-forgets.
  app.post('/index', async (req, reply) => {
    const parsed = parseDoc(req.body);
    if ('err' in parsed) return reply.status(422).send(invalid(parsed.err));
    const app_id = await resolveAppId((req.body as { app?: string })?.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const document = await searchStore.index(app_id, parsed.doc);
    return reply.status(200).send({ document });
  });

  // Remove one document by (owner, type, id) — idempotent.
  app.post('/index/delete', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; owner?: string; type?: string; id?: string };
    if (!b.owner || typeof b.owner !== 'string') return reply.status(422).send(invalid('delete requires a string `owner`.'));
    if (!b.type || typeof b.type !== 'string') return reply.status(422).send(invalid('delete requires a string `type`.'));
    if (!b.id || typeof b.id !== 'string') return reply.status(422).send(invalid('delete requires a string `id`.'));
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const deleted = await searchStore.delete(app_id, { owner: b.owner, type: b.type, id: b.id });
    return reply.status(200).send({ deleted });
  });

  // Bulk upsert (backfill / cutover). Each element is validated; the first bad one → 422.
  app.post('/reindex', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; documents?: unknown };
    if (!Array.isArray(b.documents)) return reply.status(422).send(invalid('`documents` must be an array of documents.'));
    const docs: SearchDocument[] = [];
    for (const raw of b.documents) {
      const parsed = parseDoc(raw);
      if ('err' in parsed) return reply.status(422).send(invalid(`a document is invalid: ${parsed.err}`));
      docs.push(parsed.doc);
    }
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const indexed = await searchStore.reindex(app_id, docs);
    return reply.status(200).send({ indexed });
  });

  // Search the caller's own documents. Owner-scoped, BM25-ranked, <mark> snippets.
  app.post('/search', async (req, reply) => {
    const b = (req.body ?? {}) as {
      app?: string; owner?: string; q?: string; types?: unknown;
      limit?: unknown; offset?: unknown; date_from?: string; date_to?: string; scope?: unknown;
    };
    // Client-error input (user-invoked read) → 400, never a masked empty 200.
    if (!b.owner || typeof b.owner !== 'string') return reply.status(400).send(invalid('search requires a string `owner`.'));
    if (typeof b.q !== 'string' || !b.q.trim()) return reply.status(400).send(invalid('search requires a non-empty query `q`.'));
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);

    const types = Array.isArray(b.types) ? (b.types as unknown[]).filter((t): t is string => typeof t === 'string') : undefined;
    // C19 access-aware scope (optional). Absent ⇒ owner-only. Only the recognised fields are read;
    // anything else is ignored (a malformed scope simply falls back to owner-only, never a 500).
    let scope: SearchScope | undefined;
    if (b.scope !== undefined && typeof b.scope === 'object' && b.scope !== null) {
      const s = b.scope as Record<string, unknown>;
      scope = {
        ...(typeof s.groupId === 'string' ? { groupId: s.groupId } : {}),
        ...(typeof s.canReadAll === 'boolean' ? { canReadAll: s.canReadAll } : {}),
      };
    }
    try {
      const result = await searchStore.search(app_id, {
        owner: b.owner,
        q: b.q,
        ...(types && types.length > 0 ? { types } : {}),
        ...(typeof b.limit === 'number' || typeof b.limit === 'string' ? { limit: Number(b.limit) } : {}),
        ...(typeof b.offset === 'number' || typeof b.offset === 'string' ? { offset: Number(b.offset) } : {}),
        ...(typeof b.date_from === 'string' ? { date_from: b.date_from } : {}),
        ...(typeof b.date_to === 'string' ? { date_to: b.date_to } : {}),
        ...(scope ? { scope } : {}),
      });
      return reply.status(200).send(result);
    } catch {
      // Internal store/ranking failure → degrade, do NOT 500. The app soft-handles this by showing
      // empty results with a "search temporarily unavailable" note.
      return reply.status(503).send({
        error: { code: 'search_unavailable', message: 'search is temporarily unavailable; try again shortly.', retry: 'backoff' },
      });
    }
  });
}
