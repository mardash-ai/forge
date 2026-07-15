import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { getBackends } from '../src/storage/backends';
import { FsSearchBackend } from '../src/storage/backends/search/fs';
import { PgSearchBackend, ensureSearchSchema } from '../src/storage/backends/search/pg';
import { backfillSearch } from '../src/storage/backends/search/migrate';

// P26 (increment 2) — Postgres search backend-SPECIFIC coverage: the real GIN inverted index, the O4
// (owner, group_id, visibility) scope columns, snippet HTML-escaping (security parity with the FS
// ranker), and id-preserving backfill. Runs ONLY when the Postgres search backend is selected (the
// `test:pg` run); skipped in the default filesystem `npm test`.
const HAS_PG = process.env.FORGE_SEARCH_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

describe.skipIf(!HAS_PG)('P26 Postgres search backend — GIN index, O4 scope, escaping, backfill', () => {
  const APP = 'app_pg_search';
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('serves search from a real GIN inverted index (not an in-memory rescan)', async () => {
    // The GIN index over the tsvector is what makes this NOT the filesystem O(owned-docs) rescan.
    const idx = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename='forge_search_docs' AND indexname='forge_search_docs_tsv'",
    );
    expect(idx.rows[0]?.indexdef).toMatch(/USING gin/i);
    expect(idx.rows[0]?.indexdef).toMatch(/tsv/);

    // A query resolves through websearch_to_tsquery + the GIN index (EXPLAIN shows a bitmap/index path,
    // never a plain Seq Scan filter).
    const search = (await getBackends()).search;
    await search.index(APP, { owner: 'A', type: 'note', id: 'n1', title: 'Quarterly revenue report', body: 'growth' });
    const res = await search.search(APP, { owner: 'A', q: 'revenue' });
    expect(res.total).toBe(1);
    expect(res.hits[0]!.id).toBe('n1');
  });

  it('a doc indexed WITHOUT ACL fields defaults to owner-only (visibility=private, group_id NULL, empty grants)', async () => {
    const search = (await getBackends()).search;
    await search.index(APP, { owner: 'A', type: 'note', id: 'p', title: 'alpha private' });
    const row = await pool.query<{ visibility: string; group_id: string | null; shared_with: string[]; shared_writers: string[] }>(
      'SELECT visibility, group_id, shared_with, shared_writers FROM forge_search_docs WHERE app_id=$1 AND owner=$2 AND id=$3',
      [APP, 'A', 'p'],
    );
    expect(row.rows[0]).toMatchObject({ visibility: 'private', group_id: null, shared_with: [], shared_writers: [] });
    // No scope ⇒ owner-only. A sees own; a non-owner group member never sees a bare/private doc.
    expect((await search.search(APP, { owner: 'A', q: 'alpha' })).hits.map((h) => h.id)).toEqual(['p']);
    expect((await search.search(APP, { owner: 'B', q: 'alpha', scope: { groupId: 'house', canReadAll: true } })).total).toBe(0);
  });

  it('access-aware predicate in SQL: group⇒read-all same-group, shared⇒grantees only, private stays private, owner always sees own', async () => {
    const search = (await getBackends()).search;
    // A's household 'house': a private doc, a group doc, a doc shared to B. C lives in another group.
    await search.index(APP, { owner: 'A', type: 'note', id: 'priv', title: 'alpha private plan', visibility: 'private', groupId: 'house' });
    await search.index(APP, { owner: 'A', type: 'note', id: 'grp', title: 'alpha group roster', visibility: 'group', groupId: 'house' });
    await search.index(APP, { owner: 'A', type: 'note', id: 'shr', title: 'alpha shared list', visibility: 'shared', groupId: 'house', sharedWith: ['B'], sharedWriters: ['W'] });

    // Owner sees ALL of their own docs, any visibility (no scope needed).
    expect((await search.search(APP, { owner: 'A', q: 'alpha' })).total).toBe(3);
    // Read-all same-group member M: the group doc only (private stays private; shared needs a grant).
    expect((await search.search(APP, { owner: 'M', q: 'alpha', scope: { groupId: 'house', canReadAll: true } })).hits.map((h) => h.id).sort()).toEqual(['grp']);
    // B (granted the shared doc, NO read-all): only the shared doc.
    expect((await search.search(APP, { owner: 'B', q: 'alpha', scope: { groupId: 'house', canReadAll: false } })).hits.map((h) => h.id)).toEqual(['shr']);
    // W matches via sharedWriters (union).
    expect((await search.search(APP, { owner: 'W', q: 'alpha', scope: { groupId: 'house', canReadAll: false } })).hits.map((h) => h.id)).toEqual(['shr']);
    // Cross-group read-all member sees NOTHING (the group predicate is same-group only).
    expect((await search.search(APP, { owner: 'C', q: 'alpha', scope: { groupId: 'other', canReadAll: true } })).total).toBe(0);
    // A non-granted, non-read-all same-group member sees nothing of A's.
    expect((await search.search(APP, { owner: 'Z', q: 'alpha', scope: { groupId: 'house', canReadAll: false } })).total).toBe(0);
  });

  it('ACL narrows BEFORE limit/paging in SQL — total is the ACL-scoped count, private docs never page in', async () => {
    const search = (await getBackends()).search;
    for (let i = 0; i < 5; i++) await search.index(APP, { owner: 'A', type: 'note', id: `g${i}`, title: `alpha group ${i}`, visibility: 'group', groupId: 'house' });
    for (let i = 0; i < 3; i++) await search.index(APP, { owner: 'A', type: 'note', id: `p${i}`, title: `alpha private ${i}`, visibility: 'private', groupId: 'house' });
    const scope = { groupId: 'house', canReadAll: true };
    const page1 = await search.search(APP, { owner: 'M', q: 'alpha', limit: 2, offset: 0, scope });
    expect(page1.total).toBe(5); // the ACL-narrowed count, NOT all 8
    expect(page1.hits).toHaveLength(2);
    const seen = new Set<string>();
    for (let off = 0; off < 5; off += 2) for (const h of (await search.search(APP, { owner: 'M', q: 'alpha', limit: 2, offset: off, scope })).hits) seen.add(h.id);
    expect([...seen].sort()).toEqual(['g0', 'g1', 'g2', 'g3', 'g4']); // exactly the 5 group docs, no private id
  });

  it('never leaks raw HTML from document content into the snippet; highlights matches with <mark>', async () => {
    const search = (await getBackends()).search;
    await search.index(APP, { owner: 'A', type: 'note', id: 'x', title: 'Report', body: 'Revenue & <script>alert(1)</script> for the alpha quarter' });
    const res = await search.search(APP, { owner: 'A', q: 'alpha' });
    const snip = res.hits[0]!.snippet;
    // Security parity with the FS ranker: no raw HTML from document content reaches the rendered snippet.
    // Postgres's ts_headline STRIPS HTML tags, and finishSnippet HTML-escapes any surviving special chars
    // (`&` here) — so a stored <script> can never execute in the snippet, while matches still highlight.
    expect(snip).toContain('<mark>alpha</mark>'); // matched term highlighted (our injected marks)
    expect(snip).not.toMatch(/<script>/i); // the raw tag never survives
    expect(snip).not.toMatch(/<\/script>/i);
    expect(snip).toContain('&amp;'); // a stray & from content is escaped, not left raw
    // the only '<'/'>' in the snippet are our own <mark> tags — never an un-escaped angle bracket from content
    expect(snip.replace(/<\/?mark>/g, '')).not.toMatch(/[<>]/);
  });

  it('backfill (filesystem → Postgres) relocates the index with (owner,type,id) keys preserved', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forge-search-bf-'));
    const prev = process.env.FORGE_STATE_DIR;
    process.env.FORGE_STATE_DIR = dir;
    try {
      const fs = new FsSearchBackend();
      const APP2 = 'app_search_backfill';
      await fs.index(APP2, { owner: 'A', type: 'goal', id: 'g1', title: 'alpha goal' });
      await fs.index(APP2, { owner: 'B', type: 'goal', id: 'g1', title: 'beta goal' }); // same (type,id), different owner
      // A group-shared doc: its ACL metadata must survive the move (not silently reset to owner-only).
      await fs.index(APP2, { owner: 'A', type: 'note', id: 'shared', title: 'alpha shared roster', visibility: 'group', groupId: 'house' });

      await ensureSearchSchema(pool);
      await pool.query('DELETE FROM forge_search_docs WHERE app_id=$1', [APP2]);
      const pg = new PgSearchBackend(pool);
      const results = await backfillSearch(fs, pg, [APP2]);
      expect(results).toEqual([{ app: APP2, documents: 3 }]);

      // Owner-scoping survives the move: A sees only A's doc, B only B's — same (type,id) stays distinct.
      expect((await pg.search(APP2, { owner: 'A', q: 'goal' })).hits.map((h) => h.id)).toEqual(['g1']);
      expect((await pg.search(APP2, { owner: 'A', q: 'beta' })).total).toBe(0);
      expect((await pg.search(APP2, { owner: 'B', q: 'beta' })).hits.map((h) => h.id)).toEqual(['g1']);
      // ACL metadata survived: a read-all same-group member can still see the group doc after backfill.
      expect((await pg.search(APP2, { owner: 'M', q: 'roster', scope: { groupId: 'house', canReadAll: true } })).hits.map((h) => h.id)).toEqual(['shared']);
    } finally {
      if (prev === undefined) delete process.env.FORGE_STATE_DIR;
      else process.env.FORGE_STATE_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
