import type { SearchDocument, SearchHit, SearchResponse } from './types';

// C19 — the PURE lexical ranking core. No I/O: it takes an already-owner-scoped set of documents and
// a query, and returns ranked hits with <mark> snippets. Owner-scoping is enforced by the STORE/route
// (the caller only ever passes ONE owner's documents in) — this module never sees an owner and cannot
// leak across owners. Deterministic given its inputs, so it is unit-testable directly.
//
// Backend: a self-contained BM25(F)-lite over an in-memory inverted view built per query. Forge's own
// data-plane store is filesystem JSON/JSONL (no Postgres for platform state — Postgres in productionize
// is the APP's optional database, not Forge's), so C19 stays dependency-free and ships in the slim
// data-plane image, consistent with the C3/C4/C15 file-backed stores.

// BM25 knobs (standard defaults).
const K1 = 1.2;
const B = 0.75;

// Field weights — `title` outranks `body`; tags sit between. A term appearing in the title contributes
// more to the document's weighted term-frequency, so a title match outranks a body-only match.
const TITLE_WEIGHT = 3;
const TAG_WEIGHT = 2;
const BODY_WEIGHT = 1;

// Snippet sizing (characters of context around the first match).
const SNIPPET_BEFORE = 60;
const SNIPPET_LEN = 200;

// --- tokenization -----------------------------------------------------------------------------------

// A light, deterministic stemmer: case-fold, then strip a plural suffix AND a gerund/past suffix in
// sequence so common variants converge (notes/note, meetings/meet, running/runs→run, studies/study),
// without a heavy Porter dependency. Applying plural then gerund (not early-returning) is what makes
// "meetings" and "meeting" both reduce to "meet". Good enough for recall; ranking does the rest.
export function stem(raw: string): string {
  let t = raw.toLowerCase();
  if (t.length <= 2) return t;
  // 1) plural
  if (t.endsWith('ies') && t.length > 4) t = t.slice(0, -3) + 'y'; // parties -> party
  else if (/(?:s|x|z|ch|sh)es$/.test(t)) t = t.slice(0, -2); // boxes -> box, dishes -> dish
  else if (t.endsWith('s') && !t.endsWith('ss') && t.length > 3) t = t.slice(0, -1); // goals -> goal
  // 2) gerund / past tense (undoing a doubled final consonant: running -> runn -> run)
  if (t.endsWith('ing') && t.length > 5) {
    t = t.slice(0, -3);
    if (/([bdfglmnprt])\1$/.test(t)) t = t.slice(0, -1);
  } else if (t.endsWith('ed') && t.length > 4) {
    t = t.slice(0, -2);
    if (/([bdfglmnprt])\1$/.test(t)) t = t.slice(0, -1);
  }
  return t;
}

// Split text into stemmed tokens (alphanumeric runs), lowercased. Empty/whitespace → [].
export function tokenize(text: string | undefined | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9]+/g)) {
    const s = stem(m[0]);
    if (s) out.push(s);
  }
  return out;
}

// --- HTML escaping + highlight ----------------------------------------------------------------------

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE[c]!);
}

// Escape `text` for HTML and wrap every whole word whose stem is in `qstems` with <mark>…</mark>.
// Non-word gaps are escaped as-is. Because query stems are alphanumeric and HTML-escaping only touches
// &<>"' (never alphanumerics), word boundaries survive escaping — no <mark> can straddle an entity.
function escapeAndHighlight(text: string, qstems: Set<string>): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(/[A-Za-z0-9]+/g)) {
    const word = m[0];
    const start = m.index ?? 0;
    out += escapeHtml(text.slice(last, start)); // the gap before this word
    const esc = escapeHtml(word);
    out += qstems.has(stem(word)) ? `<mark>${esc}</mark>` : esc;
    last = start + word.length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

// Build an HTML snippet: a window of context around the first matched term in `source`, with matches
// wrapped in <mark>. Falls back to the head of `source` when nothing matches (defensive — a hit always
// has a match somewhere across its fields, but the chosen source field may not be the one that hit).
function makeSnippet(source: string, qstems: Set<string>): string {
  if (!source) return '';
  let firstMatch = -1;
  for (const m of source.matchAll(/[A-Za-z0-9]+/g)) {
    if (qstems.has(stem(m[0]))) {
      firstMatch = m.index ?? 0;
      break;
    }
  }
  let start = 0;
  let end = Math.min(source.length, SNIPPET_LEN);
  if (firstMatch >= 0) {
    start = Math.max(0, firstMatch - SNIPPET_BEFORE);
    end = Math.min(source.length, start + SNIPPET_LEN);
  }
  // Snap the window to word boundaries so we don't cut a word in half.
  if (start > 0) {
    const sp = source.indexOf(' ', start);
    if (sp >= 0 && sp < end) start = sp + 1;
  }
  if (end < source.length) {
    const sp = source.lastIndexOf(' ', end);
    if (sp > start) end = sp;
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  return prefix + escapeAndHighlight(source.slice(start, end), qstems) + suffix;
}

// Pick the field to snippet from: prefer the body when it contains a match, else the title (which a
// hit's terms may live in), else whatever body/title text exists.
function snippetSource(doc: SearchDocument, qstems: Set<string>): string {
  const bodyHasMatch = tokenize(doc.body).some((t) => qstems.has(t));
  if (doc.body && bodyHasMatch) return doc.body;
  return doc.title || doc.body || '';
}

// --- ranking ----------------------------------------------------------------------------------------

interface Scored {
  doc: SearchDocument;
  weightedTf: Map<string, number>; // stem -> weighted term frequency across title/tags/body
  length: number; // weighted document length (sum of weightedTf)
}

// Weighted term-frequency + length for one document (title terms count TITLE_WEIGHT, etc.).
function indexDoc(doc: SearchDocument): Scored {
  const tf = new Map<string, number>();
  const add = (text: string | undefined, w: number): void => {
    for (const term of tokenize(text)) tf.set(term, (tf.get(term) ?? 0) + w);
  };
  add(doc.title, TITLE_WEIGHT);
  for (const tag of doc.tags ?? []) add(tag, TAG_WEIGHT);
  add(doc.body, BODY_WEIGHT);
  let length = 0;
  for (const v of tf.values()) length += v;
  return { doc, weightedTf: tf, length };
}

// A doc's created_at falls within [from, to] (inclusive, ISO-8601 lexical compare). A missing
// created_at is EXCLUDED when any bound is set (it cannot be placed in the range).
function inDateRange(doc: SearchDocument, from?: string, to?: string): boolean {
  if (!from && !to) return true;
  const at = doc.created_at;
  if (!at) return false;
  if (from && at < from) return false;
  if (to && at > to) return false;
  return true;
}

export interface RankOptions {
  q: string;
  types?: string[];
  date_from?: string;
  date_to?: string;
  limit: number;
  offset: number;
}

// Rank an already-owner-scoped document set against the query. Applies `types` + date filters, scores
// with BM25(F)-lite, sorts by (score desc, updated_at desc, id asc), pages by offset/limit, and builds
// a <mark> snippet per hit. `total` is the pre-paging match count. Never throws on ordinary input.
export function rankDocuments(docs: SearchDocument[], opts: RankOptions): SearchResponse {
  const qterms = tokenize(opts.q);
  const qstems = new Set(qterms);
  if (qstems.size === 0) return { hits: [], total: 0 };

  const typeSet = opts.types && opts.types.length > 0 ? new Set(opts.types) : null;
  const candidates: Scored[] = [];
  for (const doc of docs) {
    if (typeSet && !typeSet.has(doc.type)) continue;
    if (!inDateRange(doc, opts.date_from, opts.date_to)) continue;
    candidates.push(indexDoc(doc));
  }
  if (candidates.length === 0) return { hits: [], total: 0 };

  // Corpus stats over the (owner+type+date) filtered candidate set.
  const N = candidates.length;
  let totalLen = 0;
  for (const c of candidates) totalLen += c.length;
  const avgdl = totalLen / N || 1;

  // Document frequency per query stem.
  const df = new Map<string, number>();
  for (const term of qstems) {
    let n = 0;
    for (const c of candidates) if (c.weightedTf.has(term)) n++;
    df.set(term, n);
  }
  // Smoothed IDF (always ≥ 0, so a common term never subtracts score).
  const idf = new Map<string, number>();
  for (const [term, n] of df) idf.set(term, Math.log(1 + (N - n + 0.5) / (n + 0.5)));

  const scored: Array<{ doc: SearchDocument; score: number }> = [];
  for (const c of candidates) {
    let score = 0;
    for (const term of qstems) {
      const tf = c.weightedTf.get(term);
      if (!tf) continue;
      const denom = tf + K1 * (1 - B + (B * c.length) / avgdl);
      score += (idf.get(term) ?? 0) * ((tf * (K1 + 1)) / denom);
    }
    if (score > 0) scored.push({ doc: c.doc, score });
  }

  // Deterministic order: score desc, then updated_at desc (missing sorts last), then id asc.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const au = a.doc.updated_at ?? '';
    const bu = b.doc.updated_at ?? '';
    if (au !== bu) return au < bu ? 1 : -1;
    return a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0;
  });

  const total = scored.length;
  const page = scored.slice(opts.offset, opts.offset + opts.limit);
  const hits: SearchHit[] = page.map(({ doc, score }) => ({
    type: doc.type,
    id: doc.id,
    title: doc.title,
    snippet: makeSnippet(snippetSource(doc, qstems), qstems),
    score,
    ...(doc.attrs !== undefined ? { attrs: doc.attrs } : {}),
    ...(doc.created_at !== undefined ? { created_at: doc.created_at } : {}),
  }));
  return { hits, total };
}
