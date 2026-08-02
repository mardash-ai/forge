import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

/**
 * Docs — every source, one pane.
 *
 * The console is the single pane of glass, so it is where documentation is READ. That is not the
 * same as where documentation is STORED, and conflating the two is how docs start disagreeing with
 * the code they describe — the failure that produced the login-host firefight. So this module
 * aggregates from several sources and renders them in one shell, and a page lives with whatever it
 * documents unless that thing is going away.
 *
 * Two source kinds, and the rule for choosing between them:
 *
 *   · BUILT-IN (`builtinSource`) — pages bundled in this repo. Correct only when the content has no
 *     other home: the `dorinda-devs` portal is being decommissioned, so its pages moved here. This
 *     module used to fetch that portal live and its own comment said the content would "move once
 *     and this module points somewhere else" when the service was retired. This is that.
 *
 *   · LIVE (`webManifestSource`) — fetched from a service that still exists, on every request.
 *     dorinda-web's help pages document dorinda-web's own flows, so they stay in dorinda-web and are
 *     read through here. There is exactly one copy; it cannot drift, because there is nothing to
 *     drift from.
 *
 * ⚠️ WHAT DID **NOT** MOVE FROM THE PORTAL, and why it matters. Two artefacts were dropped rather
 * than imported: `gcp.html` (a section-by-section transcription of the GCP console, hand-copied from
 * live reads on one night) and `gcp-topology.svg` (rendered from hardcoded Python constants, not
 * from the cloud). The console already answers those questions LIVE on its Inventory, Cost,
 * Credentials and Headroom screens. Keeping a snapshot beside a live view is worse than not having
 * it: the portal claimed "5 public hosts", named four, and had never heard of `forge.dorinda.ai` —
 * a host that has been serving for days. A reader cannot tell which pane is lying.
 */

export interface DocPage {
  id: string;
  title: string;
}

/** A group of pages under one origin, so the reader can see WHERE a page came from. */
export interface DocSourceIndex {
  id: string;
  label: string;
  /** Human-readable provenance, shown in the UI ("bundled with forge", "live from app.dorinda.ai"). */
  origin: string;
  pages: DocPage[];
  /** Present when this source could not be reached — reported, never silently an empty list. */
  error?: string;
}

export interface DocContent {
  id: string;
  title: string;
  /** Sanitised inner HTML of the page body, with links and assets rewritten for this console. */
  html: string;
  /**
   * True when the page shipped its own (now scoped) stylesheet.
   *
   * The console has fallback typography for documents that arrive as bare semantic HTML. Applying
   * it to a page that styles ITSELF makes the two fight: the console's dark-theme heading colour
   * won over a light document's, and the `<h1>` rendered nearly invisible on its own background.
   * So the client uses one or the other, never both, and this is how it knows which.
   */
  styled: boolean;
}

const MAIN = /<main[^>]*>([\s\S]*?)<\/main>/i;
const NAV = /<nav[^>]*>([\s\S]*?)<\/nav>/i;
const BODY = /<body[^>]*>([\s\S]*?)<\/body>/i;

/**
 * A page id, namespaced by source: `devs:topology`, `app:admin-purge`.
 *
 * Namespacing is not cosmetic — two sources may both publish an `index`, and an un-namespaced id
 * would silently serve one source's page under another's link.
 */
export function qualify(sourceId: string, pageId: string): string {
  return `${sourceId}:${pageId}`;
}

export function unqualify(qualified: string): { sourceId: string; pageId: string } | null {
  const m = /^([a-z0-9_-]+):([a-zA-Z0-9._-]+)$/.exec(qualified);
  return m ? { sourceId: m[1]!, pageId: m[2]! } : null;
}

/** Parse a portal-style `<nav>` into a page list, so an index cannot drift from the nav it renders. */
export function parseDocIndex(html: string): DocPage[] {
  const nav = NAV.exec(html)?.[1] ?? '';
  const out: DocPage[] = [];
  for (const m of nav.matchAll(/<a\s+href="\/([a-z0-9_-]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const id = m[1]!;
    const title = m[2]!
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .trim();
    if (id && title) out.push({ id, title });
  }
  return out;
}

/**
 * Pull the body out of a page and make it safe and navigable inside the console.
 *
 * - `<script>` and inline `on*=` handlers are stripped. Some of this content arrives over the
 *   network; content injected as HTML is sanitised regardless of who sent it.
 * - Absolute links (`/gcp`, `admin-purge.html`) become console routes, so a click stays in the
 *   console instead of landing on the SPA's 404 shell or navigating away from the pane entirely.
 * - Images become proxied asset URLs, since a remote source may be credentialed and a built-in one
 *   is not web-rooted at all.
 *
 * `sourceId` scopes every rewritten link and asset to the source the page came from — without it, a
 * relative link in one source would resolve against another's namespace.
 */
/** The class the console wraps embedded documents in. Every rule from a page is confined to it. */
export const DOC_SCOPE = 'doc-embed';

/**
 * Confine a page's own CSS to the embedded container instead of throwing it away.
 *
 * STRIPPING `<style>` IS SAFE AND WRONG. It is safe because a fetched page must not be able to
 * restyle the console shell. It is wrong because these documents carry their entire visual language
 * in CSS: dorinda-web's help pages render section numbers, meta strips and — worst — inline SVG
 * sequence diagrams whose every label is positioned and coloured by a class. Dropped, a diagram
 * becomes unpositioned text piled at the origin, and the reader cannot tell a broken page from a
 * page that says nothing. Verified in the browser before changing this: the purge page rendered as
 * a run-on blob with a bare "01" floating in it.
 *
 * So each selector is prefixed with `.doc-embed`, which keeps the document's design and still makes
 * it structurally incapable of reaching the shell — `body{...}` becomes `.doc-embed body{...}`,
 * which matches nothing outside the container.
 *
 * At-rules are handled rather than mangled:
 *   · `@media` — recurse into its block, so responsive rules survive scoped.
 *   · `@keyframes` / `@font-face` — pass through unscoped; their bodies are not selectors, and
 *     prefixing `from`/`to` or `src:` would silently break the animation instead of scoping it.
 *   · `:root` — rewritten to the scope itself, since custom properties declared on `:root` would
 *     otherwise leak to the whole document and override the console's own tokens.
 */
/**
 * Properties dropped when a `html`/`body`/`:root` rule is mapped onto the embed container.
 *
 * These pages were authored as WHOLE DOCUMENTS with their own chrome. The devs portal sets
 * `body{display:flex}` to sit a fixed sidebar next to its content — mapped onto the embed, that
 * turned the container into a flex row and laid every heading, paragraph and table out as a
 * narrow vertical strip. It rendered as gibberish, and it looked like a content bug rather than a
 * CSS one. Caught by looking at the page, not by reading the rule.
 *
 * Colours, fonts and custom properties are exactly what SHOULD carry over; box layout is what the
 * console owns. So the split is by property, not by rule.
 */
const DOCUMENT_LAYOUT_PROPS =
  /^(display|position|top|right|bottom|left|float|clear|width|min-width|max-width|height|min-height|max-height|margin|margin-[a-z]+|padding|padding-[a-z]+|flex|flex-[a-z]+|grid|grid-[a-z-]+|gap|row-gap|column-gap|align-[a-z]+|justify-[a-z]+|place-[a-z]+|overflow|overflow-[xy])$/i;

/** Keep the declarations that describe how a document LOOKS; drop the ones that lay out its box. */
function documentSafeDecls(body: string): string {
  return body
    .split(';')
    .filter((d) => {
      const prop = d.split(':')[0]?.trim() ?? '';
      if (!prop) return false;
      if (prop.startsWith('--')) return true; // custom properties are the page's design tokens
      return !DOCUMENT_LAYOUT_PROPS.test(prop);
    })
    .join(';');
}

export function scopeCss(css: string, scope = `.${DOC_SCOPE}`): string {
  const out: string[] = [];
  let i = 0;

  while (i < css.length) {
    const braceAt = css.indexOf('{', i);
    if (braceAt === -1) break;
    const prelude = css.slice(i, braceAt).trim();

    // Find the matching close brace, counting nesting (an @media block contains rules).
    let depth = 0;
    let j = braceAt;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = css.slice(braceAt + 1, j);

    if (/^@(keyframes|font-face|supports|charset|import)/i.test(prelude)) {
      out.push(`${prelude}{${body}}`);
    } else if (/^@media/i.test(prelude)) {
      out.push(`${prelude}{${scopeCss(body, scope)}}`);
    } else {
      // `:root`, `html` and `body` all mean "the document" — inside an embed that IS the scope,
      // so those rules land on the container and their box layout has to be dropped with them.
      let isDocumentRule = false;
      const selectors = prelude
        .split(',')
        .map((sel) => {
          const s = sel.trim();
          if (!s) return '';
          if (/^(:root|html|body)$/i.test(s)) {
            isDocumentRule = true;
            return scope;
          }
          if (/^(:root|html|body)\b/i.test(s)) {
            isDocumentRule = true;
            return `${scope}${s.replace(/^(:root|html|body)/i, '')}`;
          }
          return `${scope} ${s}`;
        })
        .filter(Boolean);
      const decls = isDocumentRule ? documentSafeDecls(body) : body;
      if (selectors.length && decls.trim()) out.push(`${selectors.join(',')}{${decls}}`);
    }
    i = j + 1;
  }

  return out.join('\n');
}

export function extractDoc(html: string, sourceId: string, id: string, fallbackTitle: string): DocContent {
  // Prefer <main>; fall back to <body> for sources that do not use it (dorinda-web's pages wrap
  // their content in a plain <div class="wrap">). Falling back to the raw string would inject the
  // page's <style> and <title> into the console shell.
  const body = MAIN.exec(html)?.[1] ?? BODY.exec(html)?.[1] ?? html;
  const title =
    /<h1[^>]*>([\s\S]*?)<\/h1>/i
      .exec(body)?.[1]
      ?.replace(/<[^>]+>/g, '')
      .trim() ||
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ||
    fallbackTitle;

  const asset = (p: string) => `/docs/asset/${sourceId}/${p.replace(/^\/+/, '')}`;

  /*
   * The page's own CSS, confined to the embed. Collected from the WHOLE document, not just the
   * body slice: these pages put their <style> in the head, so reading only the extracted body would
   * find nothing and silently produce an unstyled document — the bug this exists to fix.
   */
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => scopeCss(m[1] ?? ''))
    .filter(Boolean)
    .join('\n');

  const cleaned = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\son[a-z]+="[^"]*"/gi, '')
    .replace(/<img([^>]*?)src="\/?([^":]+)"/gi, (_m, a: string, p: string) => `<img${a}src="${asset(p)}"`)
    .replace(
      /<object([^>]*?)data="\/?([^":]+)"/gi,
      (_m, a: string, p: string) => `<object${a}data="${asset(p)}"`,
    )
    // Portal-style absolute links (`/gcp`) and dorinda-web-style relative ones (`admin-purge.html`).
    .replace(
      /<a\s+href="\/?([a-z0-9_-]+)(?:\.html)?"([^>]*)>([\s\S]*?)<\/a>/gi,
      (_m, target: string, attrs: string, text: string) =>
        `<a href="?s=docs&p=${qualify(sourceId, target)}"${attrs.replace(/\starget="[^"]*"/gi, '')}>${text}</a>`,
    );

  // The scoped stylesheet rides WITH the markup, so the client injects nothing of its own and a
  // page is always rendered with exactly the CSS it shipped — never a stale block from the page
  // viewed before it.
  const scoped = styles ? `<style>${styles}</style>${cleaned}` : cleaned;

  return { id: qualify(sourceId, id), title, html: scoped, styled: Boolean(styles) };
}

// ── Sources ────────────────────────────────────────────────────────────────────────────────────

export interface DocSource {
  id: string;
  label: string;
  origin: string;
  /** False when the source has no credentials/config — a STATE the UI reports, not an error. */
  configured(): boolean;
  listPages(signal: AbortSignal): Promise<DocPage[]>;
  getPage(id: string, signal: AbortSignal): Promise<DocContent>;
  getAsset(path: string, signal: AbortSignal): Promise<{ body: Buffer; contentType: string }>;
}

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.html': 'text/html; charset=utf-8',
};

/** Reject anything that could escape the source's own namespace. */
function safeSegment(s: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(s) && !s.includes('..');
}

/**
 * Pages bundled in this repo (`src/console/docs/content`).
 *
 * Titles come from each page's own `<h1>` rather than a hand-written list, so the index cannot
 * disagree with the page it links to — the smallest possible version of the drift this whole module
 * is arranged to prevent.
 */
export function builtinSource(dir: string): DocSource {
  return {
    id: 'platform',
    label: 'Platform internals',
    origin: 'bundled with forge (was devs.dorinda.ai)',
    configured: () => true,
    async listPages() {
      const files = (await readdir(dir)).filter((f) => f.endsWith('.html')).sort();
      const pages: DocPage[] = [];
      for (const f of files) {
        const id = f.replace(/\.html$/, '');
        const html = await readFile(join(dir, f), 'utf8');
        const title =
          /<h1[^>]*>([\s\S]*?)<\/h1>/i
            .exec(html)?.[1]
            ?.replace(/<[^>]+>/g, '')
            .trim() ||
          /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.split('·')[0]?.trim() ||
          id;
        pages.push({ id, title });
      }
      return pages;
    },
    async getPage(id) {
      if (!safeSegment(id)) throw new Error(`invalid doc id: ${id}`);
      const html = await readFile(join(dir, `${id}.html`), 'utf8');
      return extractDoc(html, 'platform', id, id);
    },
    async getAsset(path) {
      if (!safeSegment(path)) throw new Error('invalid asset path');
      return {
        body: await readFile(join(dir, path)),
        contentType: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      };
    },
  };
}

/**
 * A live source that publishes a `manifest.json` describing its pages — dorinda-web's `/docs/`.
 *
 * Driven by the manifest rather than a list kept here, so a page added in dorinda-web appears in the
 * console with no change to this repo. That is the whole argument for reading it live instead of
 * copying it.
 */
export function webManifestSource(opts: {
  id: string;
  label: string;
  origin: string;
  base?: string;
}): DocSource {
  const base = opts.base ?? '/docs';
  const url = (p: string) => `${opts.origin}${base}/${p.replace(/^\/+/, '')}`;

  async function get(path: string, signal: AbortSignal): Promise<Response> {
    const res = await fetch(url(path), { signal });
    if (!res.ok) throw new Error(`${opts.label} returned ${res.status} for ${path}`);
    return res;
  }

  return {
    id: opts.id,
    label: opts.label,
    origin: opts.origin,
    configured: () => Boolean(opts.origin),
    async listPages(signal) {
      const manifest = (await (await get('manifest.json', signal)).json()) as Array<{
        slug?: string;
        title?: string;
        file?: string;
      }>;
      return manifest
        .filter((e) => e.slug && e.file)
        .map((e) => ({ id: e.slug!, title: e.title ?? e.slug! }));
    },
    async getPage(id, signal) {
      // Only ids the manifest publishes are reachable — never an arbitrary path from a query string,
      // which would turn this proxy into a fetch-anything primitive pointed at our own hosts.
      if (!safeSegment(id)) throw new Error(`invalid doc id: ${id}`);
      const pages = await this.listPages(signal);
      if (!pages.some((p) => p.id === id)) throw new Error(`unknown page: ${id}`);
      return extractDoc(await (await get(`${id}.html`, signal)).text(), opts.id, id, id);
    },
    async getAsset(path, signal) {
      if (!safeSegment(path)) throw new Error('invalid asset path');
      const res = await get(path, signal);
      return {
        body: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      };
    },
  };
}

/**
 * Index every source, tolerating any of them being down.
 *
 * One unreachable source must not blank the whole Docs screen — it reports its own error next to
 * the sources that did answer, the same rule the rest of the console follows for a failed provider.
 */
export async function indexAll(sources: DocSource[], signal: AbortSignal): Promise<DocSourceIndex[]> {
  return Promise.all(
    sources.map(async (s): Promise<DocSourceIndex> => {
      const head = { id: s.id, label: s.label, origin: s.origin };
      if (!s.configured()) return { ...head, pages: [], error: 'not configured' };
      try {
        return { ...head, pages: await s.listPages(signal) };
      } catch (e) {
        return { ...head, pages: [], error: (e as Error).message };
      }
    }),
  );
}

/** Resolve a qualified page id against the registry. */
export function findSource(sources: DocSource[], sourceId: string): DocSource | undefined {
  return sources.find((s) => s.id === sourceId);
}
