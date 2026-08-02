/**
 * GRAFANA BOARDS, EMBEDDED — the console shows the real dashboards, it does not redraw them.
 *
 * ## Why embed rather than render
 *
 * The console previously offered one metric at a time as a bare sparkline: no axes, no legend, no
 * shared time range. That is a fine primitive and a poor answer to "how is the product doing",
 * which is a question you answer by looking at a BOARD. Grafana already draws boards well, so the
 * console frames them instead of reimplementing charting — and gets axes, legends, tooltips, zoom
 * and the time picker for free, permanently in step with whatever the dashboard says.
 *
 * ## How the embed is authorised, and what that costs
 *
 * An iframe is loaded BY THE BROWSER, so it cannot carry the console's server-side credential.
 * Grafana's answer is a public dashboard: a per-board, read-only, unguessable 32-character token
 * that needs no login. Two consequences worth stating plainly:
 *
 *   · A published board IS reachable by anyone holding its token URL. That is a deliberate posture
 *     choice, not an oversight. Nothing else in Grafana becomes readable.
 *   · Tokens live in Grafana's DATABASE. Here that is SQLite on Cloud Run's ephemeral filesystem,
 *     so **every redeploy wipes them**. Nothing may hold a token as configuration; it would rot
 *     silently and the console would frame a dead URL.
 *
 * So this module resolves tokens LIVE and re-publishes any board whose token has gone. That makes
 * the feature self-healing across a Grafana redeploy without anyone remembering to republish —
 * because a fix that depends on someone remembering is not a fix.
 */

export interface BoardSummary {
  uid: string;
  title: string;
  /** Grafana's own URL, for the "open the full board" link. */
  url: string;
  /** Present once published; absent means it could not be published (reason in `error`). */
  embedUrl?: string;
  error?: string;
}

export interface BoardsView {
  folder: string;
  origin: string;
  boards: BoardSummary[];
  error?: string;
}

export interface GrafanaBoardsConfig {
  origin?: string;
  user?: string;
  pass?: string;
  /** Only dashboards in this folder are offered — the console is not a Grafana file browser. */
  folder?: string;
}

export function boardsConfigured(c: GrafanaBoardsConfig): boolean {
  return Boolean(c.origin && c.user && c.pass);
}

interface SearchHit {
  uid: string;
  title: string;
  url?: string;
  folderTitle?: string;
  type?: string;
}

export function createGrafanaBoards(cfg: GrafanaBoardsConfig, ttlMs = 120_000) {
  let cached: { at: number; value: BoardsView } | null = null;

  function auth(): string {
    return 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');
  }

  async function api<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${cfg.origin}${path}`, {
      ...init,
      headers: { authorization: auth(), accept: 'application/json', ...(init.headers ?? {}) },
      signal,
    });
    if (!res.ok) throw new Error(`grafana ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  /**
   * Get this board's public token, publishing it if there is not one.
   *
   * The GET-then-POST shape is deliberate. A redeploy wipes the token, and if the console only ever
   * read, every board would quietly become unembeddable until a human noticed and republished. This
   * is the self-healing half.
   */
  async function ensureToken(uid: string, signal?: AbortSignal): Promise<string> {
    try {
      const existing = await api<{ accessToken?: string; isEnabled?: boolean }>(
        `/api/dashboards/uid/${encodeURIComponent(uid)}/public-dashboards`,
        {},
        signal,
      );
      if (existing.accessToken && existing.isEnabled) return existing.accessToken;
    } catch {
      // 404 simply means "never published" — fall through and publish it.
    }
    const created = await api<{ accessToken?: string }>(
      `/api/dashboards/uid/${encodeURIComponent(uid)}/public-dashboards`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          isEnabled: true,
          // Annotations can carry free text an author never intended to publish; a public board
          // should show measurements, not commentary.
          annotationsEnabled: false,
          // The reason the old Explore screen was unusable: no way to widen the window.
          timeSelectionEnabled: true,
          share: 'public',
        }),
      },
      signal,
    );
    if (!created.accessToken) throw new Error('grafana published the board but returned no token');
    return created.accessToken;
  }

  return {
    async list(signal: AbortSignal, now: () => number = Date.now): Promise<BoardsView> {
      const folder = cfg.folder ?? 'Dorinda';
      const head = { folder, origin: cfg.origin ?? '' };
      if (!boardsConfigured(cfg)) {
        return { ...head, boards: [], error: 'grafana is not configured' };
      }
      if (cached && now() - cached.at < ttlMs) return cached.value;

      let hits: SearchHit[];
      try {
        hits = await api<SearchHit[]>('/api/search?type=dash-db', {}, signal);
      } catch (e) {
        // No cached fallback: a stale board list would offer boards that may no longer exist.
        return { ...head, boards: [], error: (e as Error).message };
      }

      const inFolder = hits.filter((h) => (h.folderTitle ?? 'General') === folder);
      const boards = await Promise.all(
        inFolder.map(async (h): Promise<BoardSummary> => {
          const base: BoardSummary = {
            uid: h.uid,
            title: h.title,
            url: `${cfg.origin}${h.url ?? `/d/${h.uid}`}`,
          };
          try {
            const token = await ensureToken(h.uid, signal);
            return { ...base, embedUrl: `${cfg.origin}/public-dashboards/${token}` };
          } catch (e) {
            // One unpublishable board must not blank the rest — it reports itself and the others
            // still render, the same rule the console applies to every degraded provider.
            return { ...base, error: (e as Error).message };
          }
        }),
      );

      // Stable, useful order: the product board first, then alphabetical. An operator opening this
      // screen is asking "how is the product", not "what is alphabetically first".
      boards.sort((a, b) => {
        const score = (t: string) => (/product/i.test(t) ? 0 : 1);
        return score(a.title) - score(b.title) || a.title.localeCompare(b.title);
      });

      const value: BoardsView = { ...head, boards };
      cached = { at: now(), value };
      return value;
    },

    /** Drop the cache — used after a Grafana redeploy invalidates every token. */
    invalidate() {
      cached = null;
    },
  };
}
