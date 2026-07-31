/**
 * Docs, absorbed from the developer portal WITHOUT copying it.
 *
 * The obvious way to "absorb" devs.dorinda.ai is to copy its 100 KB of HTML into this repo. That
 * would create a second copy of every fact about the platform, and a doc that disagrees with
 * reality is the failure mode that produced the login-host firefight. So the console FETCHES the
 * portal's pages, extracts their content, and renders them in its own shell: one pane, one login,
 * and exactly one source of truth — which stays in `dorinda-devs` until that service is retired,
 * at which point the content moves once and this module points somewhere else.
 *
 * The extraction is pure and tested; only the fetch is not.
 */

export interface DocPage {
  id: string;
  title: string;
}

export interface DocContent {
  id: string;
  title: string;
  /** Sanitised inner HTML of the portal page's <main>, with links rewritten for this console. */
  html: string;
}

const MAIN = /<main[^>]*>([\s\S]*?)<\/main>/i;
const NAV = /<nav[^>]*>([\s\S]*?)<\/nav>/i;
const LINK = /<a\s+href="\/([a-z0-9_-]+)"([^>]*)>([\s\S]*?)<\/a>/gi;

/** Parse the portal's own nav into the console's page list, so the index cannot drift from it. */
export function parseDocIndex(html: string): DocPage[] {
  const nav = NAV.exec(html)?.[1] ?? '';
  const out: DocPage[] = [];
  for (const m of nav.matchAll(/<a\s+href="\/([a-z0-9_-]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const id = m[1]!;
    const title = m[2]!.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    if (id && title) out.push({ id, title });
  }
  return out;
}

/**
 * Pull the body out of a portal page and make it safe and navigable inside the console.
 *
 * - `<script>` is stripped. The source is our own portal over TLS behind basic auth, but content
 *   that arrives over the network and is injected as HTML gets stripped regardless of who sent it.
 * - Absolute links (`/gcp`) become console routes, so clicking one stays in the console instead of
 *   silently landing on the SPA's 404 shell.
 * - Images (`/topology.svg`) become proxied asset URLs — the portal is credentialed, so the
 *   browser cannot fetch them directly.
 */
export function extractDoc(html: string, id: string, fallbackTitle: string): DocContent {
  const body = MAIN.exec(html)?.[1] ?? '';
  const title = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1]?.replace(/<[^>]+>/g, '').trim() || fallbackTitle;

  const cleaned = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+="[^"]*"/gi, '')
    .replace(/<img([^>]*?)src="\/([^"]+)"/gi, '<img$1src="/docs/asset/$2"')
    .replace(/<object([^>]*?)data="\/([^"]+)"/gi, '<object$1data="/docs/asset/$2"')
    .replace(LINK, (_m, target: string, attrs: string, text: string) =>
      `<a href="?s=docs&p=${target}"${attrs.replace(/\starget="[^"]*"/gi, '')}>${text}</a>`,
    );

  return { id, title, html: cleaned };
}

export interface DocsSource {
  origin: string;
  user: string;
  pass: string;
}

export function docsConfigured(s: DocsSource): boolean {
  return Boolean(s.origin && s.user && s.pass);
}

async function fetchPortal(s: DocsSource, path: string, signal: AbortSignal): Promise<Response> {
  const auth = 'Basic ' + Buffer.from(`${s.user}:${s.pass}`).toString('base64');
  const res = await fetch(`${s.origin}${path}`, { headers: { authorization: auth }, signal });
  if (!res.ok) throw new Error(`docs portal ${res.status} for ${path}`);
  return res;
}

export async function fetchDocIndex(s: DocsSource, signal: AbortSignal): Promise<DocPage[]> {
  const res = await fetchPortal(s, '/index', signal);
  return parseDocIndex(await res.text());
}

export async function fetchDocPage(
  s: DocsSource,
  id: string,
  signal: AbortSignal,
): Promise<DocContent> {
  // Only the portal's own page ids are reachable — never an arbitrary path taken from a query
  // string, which would turn this proxy into a credentialed fetch-anything primitive.
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`invalid doc id: ${id}`);
  const res = await fetchPortal(s, `/${id}`, signal);
  return extractDoc(await res.text(), id, id);
}

export async function fetchDocAsset(
  s: DocsSource,
  path: string,
  signal: AbortSignal,
): Promise<{ body: Buffer; contentType: string }> {
  if (!/^[a-zA-Z0-9._\-/]+$/.test(path) || path.includes('..')) throw new Error('invalid asset path');
  const res = await fetchPortal(s, `/${path}`, signal);
  return {
    body: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  };
}
