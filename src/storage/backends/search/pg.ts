import type { Pool, PoolClient } from 'pg';
import { nowIso } from '../../../shared/time';
import { clampLimit, clampOffset, type SearchDocument, type SearchQuery, type SearchResponse, type SearchHit } from '../../../search/types';
import type { SearchBackend, MigratableSearchBackend } from './types';

// P26 (increment 2) — the POSTGRES search backend: a REAL inverted index. A `tsvector` GENERATED from
// title(A)/tags(B)/body(C) via setweight, indexed with GIN; queries run `tsv @@ websearch_to_tsquery`
// ranked by `ts_rank` — so a search is a GIN-indexed lookup, NOT the filesystem backend's O(owned-docs)
// in-memory BM25 rescan. Owner-scoping is structural via the O4 (owner, group_id, visibility) columns
// (a `WHERE owner=$ AND visibility='private'`); the columns are baked in + defaulted, so group-shared
// visibility (households / C31) lights up later with no migration. Contract-stable: /index, /index/delete,
// /reindex, /search behave identically to the filesystem backend.

// Snippet highlight sentinels — distinctive ASCII tokens, content-unlikely, NOT touched by HTML escaping
// (no & < > " '). Postgres marks matches with these; we then HTML-ESCAPE the whole snippet in JS and swap
// the sentinels for <mark></mark> — so raw HTML in document content can't reach the rendered snippet (the
// security parity the FS ranker's escaping provides), while matched terms still highlight.
const SEL_START = '[fMark]';
const SEL_STOP = '[/fMark]';
const HEADLINE_OPTS = `StartSel="${SEL_START}", StopSel="${SEL_STOP}", MaxFragments=1, MaxWords=35, MinWords=1, HighlightAll=FALSE`;

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE[c]!);
}
function finishSnippet(raw: string): string {
  // Escape document text, then reveal the (sentinel) highlight marks as <mark> tags.
  return escapeHtml(raw).split(SEL_START).join('<mark>').split(SEL_STOP).join('</mark>');
}

export async function ensureSearchSchema(pool: Pool): Promise<void> {
  // The weighted tsvector is maintained by a BEFORE INSERT/UPDATE trigger rather than a GENERATED
  // column: `array_to_string` (folding tags) is not IMMUTABLE, which a generated column forbids, but a
  // trigger may use any function. Same result — a title(A)/tags(B)/body(C)-weighted inverted index.
  //
  // The O4 (owner, group_id, visibility) scope columns were baked in at increment 2; C19 access-aware
  // search now WIRES them and adds the explicit per-caller share grants (shared_with / shared_writers)
  // via ADD COLUMN IF NOT EXISTS — an ADDITIVE, idempotent migration with safe defaults (empty arrays),
  // so an existing index keeps working and needs no data migration (docs default to owner-only/private
  // until the consumer re-indexes them WITH their ACL fields).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_search_docs (
      app_id     text NOT NULL,
      owner      text NOT NULL,
      type       text NOT NULL,
      id         text NOT NULL,
      title      text NOT NULL,
      body       text,
      tags       text[] NOT NULL DEFAULT '{}',
      attrs      jsonb,
      created_at text,   -- app-supplied ISO-8601 (kept verbatim; date filter ranges over it lexically)
      updated_at text,
      -- O4 ownership scope (baked in; households/C31 light up with no migration).
      group_id   text,
      visibility text NOT NULL DEFAULT 'private',
      -- C19 access-aware explicit share grants (opaque caller ids). Empty ⇒ owner-only.
      shared_with    text[] NOT NULL DEFAULT '{}',
      shared_writers text[] NOT NULL DEFAULT '{}',
      tsv        tsvector,
      PRIMARY KEY (app_id, owner, type, id)
    );

    -- Idempotent, additive: light up the share-grant columns on a pre-C19-ACL index without a data migration.
    ALTER TABLE forge_search_docs ADD COLUMN IF NOT EXISTS shared_with    text[] NOT NULL DEFAULT '{}';
    ALTER TABLE forge_search_docs ADD COLUMN IF NOT EXISTS shared_writers text[] NOT NULL DEFAULT '{}';

    CREATE OR REPLACE FUNCTION forge_search_tsv_update() RETURNS trigger AS $fn$
    BEGIN
      NEW.tsv :=
        setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
        setweight(to_tsvector('english', array_to_string(coalesce(NEW.tags, '{}'), ' ')), 'B') ||
        setweight(to_tsvector('english', coalesce(NEW.body, '')), 'C');
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS forge_search_tsv_trg ON forge_search_docs;
    CREATE TRIGGER forge_search_tsv_trg BEFORE INSERT OR UPDATE ON forge_search_docs
      FOR EACH ROW EXECUTE FUNCTION forge_search_tsv_update();

    CREATE INDEX IF NOT EXISTS forge_search_docs_tsv ON forge_search_docs USING GIN (tsv);
    CREATE INDEX IF NOT EXISTS forge_search_docs_scope ON forge_search_docs (app_id, owner, visibility);
    -- Supports the group/shared branch of the access-aware predicate (a same-group widening).
    CREATE INDEX IF NOT EXISTS forge_search_docs_group ON forge_search_docs (app_id, group_id, visibility);
  `);
}

interface DocRow {
  owner: string; type: string; id: string; title: string; body: string | null;
  tags: string[] | null; attrs: unknown; created_at: string | null; updated_at: string | null;
  group_id?: string | null; visibility?: string | null;
  shared_with?: string[] | null; shared_writers?: string[] | null;
}
function rowToDoc(r: DocRow): SearchDocument {
  return {
    owner: r.owner, type: r.type, id: r.id, title: r.title,
    ...(r.body != null ? { body: r.body } : {}),
    ...(Array.isArray(r.tags) && r.tags.length > 0 ? { tags: r.tags } : {}),
    ...(r.attrs != null ? { attrs: r.attrs as Record<string, unknown> } : {}),
    ...(r.created_at != null ? { created_at: r.created_at } : {}),
    ...(r.updated_at != null ? { updated_at: r.updated_at } : {}),
    // C19 ACL metadata — round-tripped so the returned/exported document mirrors what was stored (parity
    // with the FS backend). `private` + empty grant arrays are the owner-only default and are elided.
    ...(r.group_id != null ? { groupId: r.group_id } : {}),
    ...(r.visibility != null && r.visibility !== 'private' ? { visibility: r.visibility as SearchDocument['visibility'] } : {}),
    ...(Array.isArray(r.shared_with) && r.shared_with.length > 0 ? { sharedWith: r.shared_with } : {}),
    ...(Array.isArray(r.shared_writers) && r.shared_writers.length > 0 ? { sharedWriters: r.shared_writers } : {}),
  };
}

// The columns round-tripped by index()/reindex() RETURNING and by exportApp — base fields + the C19 ACL
// scope, so a stored doc reconstructs faithfully (parity with the FS backend, and backfill preserves ACL).
const DOC_COLS = 'owner, type, id, title, body, tags, attrs, created_at, updated_at, group_id, visibility, shared_with, shared_writers';

// One idempotent upsert (preserves created_at across re-index, exactly like the FS normalize:
// created_at = input ?? existing ?? now; updated_at = input ?? now). The ACL scope ($12..$15) is written
// on every upsert with owner-only defaults (group_id NULL, visibility 'private', empty grant arrays), so
// a doc indexed WITHOUT ACL fields is exactly owner-only, and a re-index UPDATES the scope in place.
const UPSERT_SQL = `
  INSERT INTO forge_search_docs (app_id, owner, type, id, title, body, tags, attrs, created_at, updated_at, group_id, visibility, shared_with, shared_writers)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb, COALESCE($9,$11), COALESCE($10,$11), $12, $13, $14, $15)
  ON CONFLICT (app_id, owner, type, id) DO UPDATE SET
    title      = EXCLUDED.title,
    body       = EXCLUDED.body,
    tags       = EXCLUDED.tags,
    attrs      = EXCLUDED.attrs,
    created_at = COALESCE($9, forge_search_docs.created_at),
    updated_at = COALESCE($10, $11),
    group_id       = EXCLUDED.group_id,
    visibility     = EXCLUDED.visibility,
    shared_with    = EXCLUDED.shared_with,
    shared_writers = EXCLUDED.shared_writers
  RETURNING ${DOC_COLS}`;

function upsertParams(appId: string, d: SearchDocument, now: string): unknown[] {
  return [
    appId, d.owner, d.type, d.id, d.title,
    d.body ?? null,
    Array.isArray(d.tags) ? d.tags : [],
    d.attrs != null ? JSON.stringify(d.attrs) : null,
    d.created_at ?? null,
    d.updated_at ?? null,
    now,
    // C19 ACL scope — owner-only defaults when the fields are absent.
    d.groupId ?? null,
    d.visibility ?? 'private',
    Array.isArray(d.sharedWith) ? d.sharedWith : [],
    Array.isArray(d.sharedWriters) ? d.sharedWriters : [],
  ];
}

export class PgSearchBackend implements SearchBackend, MigratableSearchBackend {
  constructor(private readonly pool: Pool) {}

  private async withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async index(appId: string, doc: SearchDocument): Promise<SearchDocument> {
    const r = await this.pool.query<DocRow>(UPSERT_SQL, upsertParams(appId, doc, nowIso()));
    return rowToDoc(r.rows[0]!);
  }

  async reindex(appId: string, docs: SearchDocument[]): Promise<number> {
    if (docs.length === 0) return 0;
    return this.withTx(async (c) => {
      const now = nowIso();
      for (const d of docs) await c.query(UPSERT_SQL, upsertParams(appId, d, now));
      return docs.length;
    });
  }

  async delete(appId: string, ref: { owner: string; type: string; id: string }): Promise<boolean> {
    const r = await this.pool.query(
      'DELETE FROM forge_search_docs WHERE app_id=$1 AND owner=$2 AND type=$3 AND id=$4',
      [appId, ref.owner, ref.type, ref.id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  // GIN-indexed, access-aware, ranked. `total` is the pre-paging match count; `hits` is the page. The
  // ACL predicate is applied in SQL, BEFORE limit/offset, so counts + pagination stay correct.
  async search(appId: string, query: SearchQuery): Promise<SearchResponse> {
    const started = Date.now();
    const types = query.types && query.types.length > 0 ? query.types : null;
    // C19 access-aware scope. Absent (or absent groupId) ⇒ $7 is NULL ⇒ the group/shared OR-branch is
    // dead and the predicate reduces to `owner = $3` — exactly today's owner-only search. `$3 = ANY(...)`
    // matches "shared-to-me" (the caller ∈ the doc's shared_with ∪ shared_writers).
    const scopeGroupId = query.scope?.groupId ?? null;
    const canReadAll = query.scope?.canReadAll ?? false;
    // Shared filter (owner + access predicate + type/date + the fts match). $1..$8 are the same for both.
    const filter = `
      FROM forge_search_docs, websearch_to_tsquery('english', $2) q
      WHERE app_id = $1
        AND tsv @@ q
        AND (
          owner = $3
          OR (
            $7::text IS NOT NULL
            AND group_id = $7
            AND (
              (visibility = 'group'  AND $8::boolean)
              OR (visibility = 'shared' AND ($3 = ANY(shared_with) OR $3 = ANY(shared_writers)))
            )
          )
        )
        AND ($4::text[] IS NULL OR type = ANY($4))
        AND ($5::text IS NULL OR (created_at IS NOT NULL AND created_at >= $5))
        AND ($6::text IS NULL OR (created_at IS NOT NULL AND created_at <= $6))`;
    const filterParams = [appId, query.q, query.owner, types, query.date_from ?? null, query.date_to ?? null, scopeGroupId, canReadAll];

    const countRes = await this.pool.query<{ n: string }>(`SELECT count(*)::text AS n ${filter}`, filterParams);
    const total = Number(countRes.rows[0]!.n);

    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const rowsRes = await this.pool.query<{
      type: string; id: string; title: string; attrs: unknown; created_at: string | null; score: number; snippet: string;
    }>(
      `SELECT type, id, title, attrs, created_at,
              ts_rank(tsv, q) AS score,
              ts_headline('english', title || ' ' || coalesce(body, ''), q, '${HEADLINE_OPTS}') AS snippet
       ${filter}
       ORDER BY score DESC, updated_at DESC NULLS LAST, id ASC
       LIMIT $9 OFFSET $10`,
      [...filterParams, limit, offset],
    );

    const hits: SearchHit[] = rowsRes.rows.map((r) => ({
      type: r.type,
      id: r.id,
      title: r.title,
      snippet: finishSnippet(r.snippet ?? ''),
      score: r.score,
      ...(r.attrs != null ? { attrs: r.attrs as Record<string, unknown> } : {}),
      ...(r.created_at != null ? { created_at: r.created_at } : {}),
    }));
    return { hits, total, took_ms: Date.now() - started };
  }

  // --- migration surface ---------------------------------------------------
  async exportApp(appId: string): Promise<SearchDocument[]> {
    const r = await this.pool.query<DocRow>(`SELECT ${DOC_COLS} FROM forge_search_docs WHERE app_id=$1`, [appId]);
    return r.rows.map(rowToDoc);
  }

  async importApp(appId: string, docs: SearchDocument[]): Promise<void> {
    await this.withTx(async (c) => {
      await c.query('DELETE FROM forge_search_docs WHERE app_id=$1', [appId]);
      for (const d of docs) await c.query(UPSERT_SQL, upsertParams(appId, d, nowIso()));
    });
  }

  async __truncateAllForTests(): Promise<void> {
    await this.pool.query('TRUNCATE forge_search_docs');
  }
}
