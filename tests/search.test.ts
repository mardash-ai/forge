import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { searchStore } from '../src/storage/search-store';
import { registerSearchRoutes } from '../src/api/search-routes';
import { rankDocuments, tokenize, stem } from '../src/search/rank';
import type { SearchDocument } from '../src/search/types';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';

// C19 — Search / indexing. A generic, per-app, owner-scoped full-text search. The PURE ranker
// (rank.ts) is unit-tested directly; the file-backed store + the four data-plane routes are driven
// against a throwaway FORGE_STATE_DIR / Fastify instance.

const doc = (over: Partial<SearchDocument> & Pick<SearchDocument, 'owner' | 'type' | 'id' | 'title'>): SearchDocument => over;

// ============================================================================
// PURE — tokenize / stem / BM25 ranking / snippet
// ============================================================================

describe('C19 — tokenize + stem (pure)', () => {
  it('lowercases, splits on non-alphanumerics, and stems', () => {
    expect(tokenize('Weekly Report: Q3 Goals!')).toEqual(['weekly', 'report', 'q3', 'goal']);
    expect(tokenize('')).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });

  it('converges common plural/gerund variants to the same stem (recall)', () => {
    expect(stem('goals')).toBe(stem('goal'));
    expect(stem('notes')).toBe(stem('note'));
    expect(stem('meetings')).toBe(stem('meeting'));
    expect(stem('running')).toBe(stem('runs'));
    expect(stem('studies')).toBe('study');
  });
});

describe('C19 — BM25 ranking (pure)', () => {
  it('a TITLE match outranks a BODY-only match (title is weighted above body)', () => {
    const docs = [
      doc({ owner: 'u', type: 'goal', id: 'body', title: 'Something else entirely', body: 'the alpha appears only in the body here' }),
      doc({ owner: 'u', type: 'goal', id: 'title', title: 'Alpha initiative', body: 'unrelated content' }),
    ];
    const { hits, total } = rankDocuments(docs, { q: 'alpha', limit: 20, offset: 0 });
    expect(total).toBe(2);
    expect(hits[0]!.id).toBe('title'); // title match wins
    expect(hits[1]!.id).toBe('body');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('matches via stemming and ranks a doc containing the term higher; non-matches are excluded', () => {
    const docs = [
      doc({ owner: 'u', type: 'note', id: 'n1', title: 'Quarterly reports', body: 'revenue' }),
      doc({ owner: 'u', type: 'note', id: 'n2', title: 'Grocery list', body: 'milk and eggs' }),
    ];
    const { hits, total } = rankDocuments(docs, { q: 'report', limit: 20, offset: 0 });
    expect(total).toBe(1); // only n1 matches (n2 has no query term)
    expect(hits.map((h) => h.id)).toEqual(['n1']);
  });

  it('tie-break is updated_at desc, then id asc (deterministic)', () => {
    // identical single-term title docs → identical score; order falls to updated_at desc, then id
    const docs = [
      doc({ owner: 'u', type: 't', id: 'b', title: 'zebra', updated_at: '2026-01-02T00:00:00Z' }),
      doc({ owner: 'u', type: 't', id: 'a', title: 'zebra', updated_at: '2026-01-02T00:00:00Z' }),
      doc({ owner: 'u', type: 't', id: 'c', title: 'zebra', updated_at: '2026-01-03T00:00:00Z' }),
    ];
    const { hits } = rankDocuments(docs, { q: 'zebra', limit: 20, offset: 0 });
    expect(hits.map((h) => h.id)).toEqual(['c', 'a', 'b']); // newest first, then id asc among the tie
  });

  it('builds an HTML <mark> snippet and ESCAPES the surrounding text', () => {
    const docs = [
      doc({ owner: 'u', type: 'note', id: 'n', title: 'Report', body: 'Revenue & <growth> for the alpha quarter looked great' }),
    ];
    const { hits } = rankDocuments(docs, { q: 'alpha', limit: 20, offset: 0 });
    const snip = hits[0]!.snippet;
    expect(snip).toContain('<mark>alpha</mark>'); // matched term highlighted
    expect(snip).toContain('&amp;'); // & escaped
    expect(snip).toContain('&lt;growth&gt;'); // angle brackets escaped
    expect(snip).not.toMatch(/<growth>/); // never raw HTML from doc content
  });

  it('filters by type and by created_at date range', () => {
    const docs = [
      doc({ owner: 'u', type: 'goal', id: 'g', title: 'alpha goal', created_at: '2026-03-01T00:00:00Z' }),
      doc({ owner: 'u', type: 'task', id: 't', title: 'alpha task', created_at: '2026-03-10T00:00:00Z' }),
      doc({ owner: 'u', type: 'task', id: 'old', title: 'alpha task old', created_at: '2026-01-01T00:00:00Z' }),
    ];
    // type filter
    expect(rankDocuments(docs, { q: 'alpha', types: ['task'], limit: 20, offset: 0 }).hits.map((h) => h.id).sort()).toEqual(['old', 't']);
    // date range (inclusive) — only March window
    const inMarch = rankDocuments(docs, { q: 'alpha', date_from: '2026-02-01T00:00:00Z', date_to: '2026-03-31T00:00:00Z', limit: 20, offset: 0 });
    expect(inMarch.hits.map((h) => h.id).sort()).toEqual(['g', 't']);
  });

  it('paginates: total is the pre-paging match count; offset past the end yields empty hits', () => {
    const docs = Array.from({ length: 5 }, (_, i) => doc({ owner: 'u', type: 't', id: `d${i}`, title: `alpha ${i}` }));
    const page = rankDocuments(docs, { q: 'alpha', limit: 2, offset: 0 });
    expect(page.total).toBe(5);
    expect(page.hits).toHaveLength(2);
    expect(rankDocuments(docs, { q: 'alpha', limit: 2, offset: 99 }).hits).toEqual([]); // past the end
  });

  it('an empty query returns no hits (the route rejects empty q with 400 before this)', () => {
    expect(rankDocuments([doc({ owner: 'u', type: 't', id: '1', title: 'x' })], { q: '   ', limit: 20, offset: 0 })).toEqual({ hits: [], total: 0 });
  });

  it('round-trips attrs + created_at on a hit', () => {
    const docs = [doc({ owner: 'u', type: 'goal', id: 'g', title: 'alpha', attrs: { url: '/g/1', done: false }, created_at: '2026-05-05T00:00:00Z' })];
    const { hits } = rankDocuments(docs, { q: 'alpha', limit: 20, offset: 0 });
    expect(hits[0]!.attrs).toEqual({ url: '/g/1', done: false });
    expect(hits[0]!.created_at).toBe('2026-05-05T00:00:00Z');
  });
});

// ============================================================================
// STORE — file-backed upsert / delete / reindex / owner-scoped search
// ============================================================================

describe('C19 — search store (file-backed)', () => {
  let dir: string;
  let prev: string | undefined;
  const APP = 'app_x';

  beforeEach(async () => {
    prev = process.env.FORGE_STATE_DIR;
    dir = await mkdtemp(path.join(tmpdir(), 'forge-search-'));
    process.env.FORGE_STATE_DIR = dir;
    await store.init();
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });

  it('searches empty before anything is indexed (degrades, never throws)', async () => {
    expect(await searchStore.search(APP, { owner: 'A', q: 'anything' })).toMatchObject({ hits: [], total: 0 });
  });

  it('upsert is idempotent by (owner, type, id) — re-index updates in place, preserves created_at', async () => {
    const first = await searchStore.index(APP, doc({ owner: 'A', type: 'goal', id: 'g1', title: 'Learn piano' }));
    await searchStore.index(APP, doc({ owner: 'A', type: 'goal', id: 'g1', title: 'Learn the piano properly' }));
    const res = await searchStore.search(APP, { owner: 'A', q: 'piano' });
    expect(res.total).toBe(1); // no duplicate despite two indexes of the same (owner,type,id)
    expect(res.hits[0]!.title).toBe('Learn the piano properly'); // updated in place
    // a different id (same owner/type) is a distinct document
    await searchStore.index(APP, doc({ owner: 'A', type: 'goal', id: 'g2', title: 'Learn piano scales' }));
    expect((await searchStore.search(APP, { owner: 'A', q: 'piano' })).total).toBe(2);
    // created_at is stable across re-index
    const reindexed = await searchStore.index(APP, doc({ owner: 'A', type: 'goal', id: 'g1', title: 'Learn piano again' }));
    expect(reindexed.created_at).toBe(first.created_at);
  });

  it('OWNER-SCOPING CRUX: A’s search never returns B’s document, even on the same terms/type/id', async () => {
    // Same (type,id) for two owners, query term in the body so the snippet is drawn from it.
    await searchStore.index(APP, doc({ owner: 'A', type: 'note', id: 'shared-id', title: 'plan', body: 'alpha is the A-only-marker note' }));
    await searchStore.index(APP, doc({ owner: 'B', type: 'note', id: 'shared-id', title: 'plan', body: 'alpha is the B-only-marker note' }));

    const aRes = await searchStore.search(APP, { owner: 'A', q: 'alpha' });
    const bRes = await searchStore.search(APP, { owner: 'B', q: 'alpha' });
    expect(aRes.total).toBe(1);
    expect(aRes.hits[0]!.snippet).toContain('A-only-marker'); // A sees ONLY A's content…
    expect(aRes.hits[0]!.snippet).not.toContain('B-only-marker'); // …never B's, despite the shared (type,id)
    expect(aRes.hits.every((h) => h.id === 'shared-id')).toBe(true);
    // The two owners' identical (type,id) are DISTINCT records (idempotency key includes owner)
    expect(bRes.total).toBe(1);
    expect(bRes.hits[0]!.snippet).toContain('B-only-marker');
    // A third owner with no docs sees nothing
    expect((await searchStore.search(APP, { owner: 'C', q: 'alpha' })).total).toBe(0);
  });

  it('delete removes a hit (idempotent); a missing document is a no-op', async () => {
    await searchStore.index(APP, doc({ owner: 'A', type: 'task', id: 't1', title: 'buy alpha milk' }));
    expect((await searchStore.search(APP, { owner: 'A', q: 'alpha' })).total).toBe(1);
    expect(await searchStore.delete(APP, { owner: 'A', type: 'task', id: 't1' })).toBe(true);
    expect((await searchStore.search(APP, { owner: 'A', q: 'alpha' })).total).toBe(0); // gone
    expect(await searchStore.delete(APP, { owner: 'A', type: 'task', id: 't1' })).toBe(false); // already gone
    // deleting under the wrong owner never touches A's data
    await searchStore.index(APP, doc({ owner: 'A', type: 'task', id: 't2', title: 'alpha again' }));
    expect(await searchStore.delete(APP, { owner: 'B', type: 'task', id: 't2' })).toBe(false);
    expect((await searchStore.search(APP, { owner: 'A', q: 'alpha' })).total).toBe(1);
  });

  it('reindex bulk-loads many documents in one shot', async () => {
    const docs = Array.from({ length: 4 }, (_, i) => doc({ owner: 'A', type: 'goal', id: `g${i}`, title: `alpha goal ${i}` }));
    expect(await searchStore.reindex(APP, docs)).toBe(4);
    expect((await searchStore.search(APP, { owner: 'A', q: 'alpha' })).total).toBe(4);
    // re-running reindex is idempotent by key (still 4, not 8)
    expect(await searchStore.reindex(APP, docs)).toBe(4);
    expect((await searchStore.search(APP, { owner: 'A', q: 'alpha' })).total).toBe(4);
  });

  it('isolates the index per app', async () => {
    await searchStore.index('app_a', doc({ owner: 'A', type: 'note', id: 'n', title: 'alpha in app a' }));
    await searchStore.index('app_b', doc({ owner: 'A', type: 'note', id: 'n', title: 'alpha in app b' }));
    expect((await searchStore.search('app_a', { owner: 'A', q: 'alpha' })).hits[0]!.title).toBe('alpha in app a');
    expect((await searchStore.search('app_b', { owner: 'A', q: 'alpha' })).hits[0]!.title).toBe('alpha in app b');
  });
});

// ============================================================================
// ROUTES — the four data-plane endpoints via Fastify inject
// ============================================================================

describe('C19 — search routes', () => {
  const APP = 'demo';
  const APP_ID = 'app_demo';
  let dir: string;
  let prev: string | undefined;
  let server: FastifyInstance;

  const seedApp = async (): Promise<void> => {
    const now = nowIso();
    const application: Application = {
      id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
      name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web',
      language: 'typescript', package_manager: 'npm',
    };
    await store.saveResource(application);
  };

  beforeEach(async () => {
    prev = process.env.FORGE_STATE_DIR;
    dir = await mkdtemp(path.join(tmpdir(), 'forge-search-routes-'));
    process.env.FORGE_STATE_DIR = dir;
    await store.init();
    await seedApp();
    server = Fastify({ logger: false });
    registerSearchRoutes(server, { defaultApp: () => APP });
    await server.ready();
  });
  afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
    if (prev === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });

  const post = (url: string, payload: unknown) => server.inject({ method: 'POST', url, payload: payload as object });

  it('index → search returns the caller’s ranked hits with <mark> snippets', async () => {
    const r = await post('/index', { owner: 'A', type: 'goal', id: 'g1', title: 'Alpha launch plan', body: 'ship the alpha to users' });
    expect(r.statusCode).toBe(200);
    expect(r.json().document).toMatchObject({ owner: 'A', type: 'goal', id: 'g1', title: 'Alpha launch plan' });

    const s = await post('/search', { owner: 'A', q: 'alpha' });
    expect(s.statusCode).toBe(200);
    const body = s.json();
    expect(body.total).toBe(1);
    expect(body.hits[0]).toMatchObject({ type: 'goal', id: 'g1', title: 'Alpha launch plan' });
    expect(body.hits[0].snippet).toContain('<mark>');
    expect(typeof body.took_ms).toBe('number');
  });

  it('OWNER-SCOPING via the route: A’s /search never returns B’s document', async () => {
    await post('/index', { owner: 'A', type: 'note', id: 'shared', title: 'secret', body: 'alpha for A-marker' });
    await post('/index', { owner: 'B', type: 'note', id: 'shared', title: 'secret', body: 'alpha for B-marker' });
    const a = (await post('/search', { owner: 'A', q: 'alpha' })).json();
    expect(a.total).toBe(1);
    expect(a.hits[0].snippet).toContain('A-marker');
    expect(a.hits[0].snippet).not.toContain('B-marker'); // never the other owner's content
  });

  it('empty q → 400; missing owner → 400', async () => {
    expect((await post('/search', { owner: 'A', q: '' })).statusCode).toBe(400);
    expect((await post('/search', { owner: 'A', q: '   ' })).statusCode).toBe(400);
    expect((await post('/search', { q: 'alpha' })).statusCode).toBe(400);
  });

  it('search DEGRADES to 503 (not 500) on an internal store failure', async () => {
    vi.spyOn(searchStore, 'search').mockRejectedValueOnce(new Error('backend down'));
    const r = await post('/search', { owner: 'A', q: 'alpha' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('search_unavailable');
  });

  it('clamps limit server-side to [1, 100]', async () => {
    // index 3 docs; a huge limit still succeeds (clamped) and returns all 3
    for (let i = 0; i < 3; i++) await post('/index', { owner: 'A', type: 'goal', id: `g${i}`, title: `alpha ${i}` });
    const r = await post('/search', { owner: 'A', q: 'alpha', limit: 9999 });
    expect(r.statusCode).toBe(200);
    expect(r.json().hits.length).toBe(3);
    // limit below 1 clamps up to 1
    const one = await post('/search', { owner: 'A', q: 'alpha', limit: 0 });
    expect(one.json().hits.length).toBe(1);
  });

  it('date_from/date_to filter the results', async () => {
    await post('/index', { owner: 'A', type: 'note', id: 'jan', title: 'alpha jan', created_at: '2026-01-15T00:00:00Z' });
    await post('/index', { owner: 'A', type: 'note', id: 'jun', title: 'alpha jun', created_at: '2026-06-15T00:00:00Z' });
    const r = await post('/search', { owner: 'A', q: 'alpha', date_from: '2026-05-01T00:00:00Z' });
    expect(r.json().hits.map((h: { id: string }) => h.id)).toEqual(['jun']);
  });

  it('delete route removes a document (idempotent)', async () => {
    await post('/index', { owner: 'A', type: 'task', id: 't1', title: 'alpha task' });
    expect((await post('/search', { owner: 'A', q: 'alpha' })).json().total).toBe(1);
    const d = await post('/index/delete', { owner: 'A', type: 'task', id: 't1' });
    expect(d.statusCode).toBe(200);
    expect(d.json().deleted).toBe(true);
    expect((await post('/search', { owner: 'A', q: 'alpha' })).json().total).toBe(0);
    expect((await post('/index/delete', { owner: 'A', type: 'task', id: 't1' })).json().deleted).toBe(false);
  });

  it('reindex route bulk-upserts an array', async () => {
    const r = await post('/reindex', { documents: [
      { owner: 'A', type: 'goal', id: 'g1', title: 'alpha one' },
      { owner: 'A', type: 'goal', id: 'g2', title: 'alpha two' },
    ] });
    expect(r.statusCode).toBe(200);
    expect(r.json().indexed).toBe(2);
    expect((await post('/search', { owner: 'A', q: 'alpha' })).json().total).toBe(2);
  });

  it('validates write input (422) and unknown app (404)', async () => {
    expect((await post('/index', { type: 'goal', id: 'g', title: 't' })).statusCode).toBe(422); // no owner
    expect((await post('/index', { owner: 'A', id: 'g', title: 't' })).statusCode).toBe(422); // no type
    expect((await post('/index', { owner: 'A', type: 'goal', title: 't' })).statusCode).toBe(422); // no id
    expect((await post('/index', { owner: 'A', type: 'goal', id: 'g' })).statusCode).toBe(422); // no title
    expect((await post('/reindex', { documents: 'nope' })).statusCode).toBe(422); // not an array

    // unknown app: a server with no default + no seeded app-name match
    const s2 = Fastify({ logger: false });
    registerSearchRoutes(s2); // no defaultApp
    await s2.ready();
    expect((await s2.inject({ method: 'POST', url: '/index', payload: { owner: 'A', type: 'goal', id: 'g', title: 't' } })).statusCode).toBe(404);
    expect((await s2.inject({ method: 'POST', url: '/search', payload: { owner: 'A', q: 'alpha' } })).statusCode).toBe(404);
    await s2.close();
  });
});
