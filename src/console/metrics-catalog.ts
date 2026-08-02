/**
 * THE METRIC CATALOG — read from the Grafana dashboard, never redefined here.
 *
 * ## Why this exists
 *
 * Top-line product metrics have to be reachable from both surfaces: the console for an operator
 * already looking at deploys and logs, and Grafana for anyone who wants a wall chart or an ad-hoc
 * drill-down. The obvious way to do that is to write the queries twice. That is also the way they
 * start disagreeing, and the disagreement is invisible — a dashboard does not announce that its
 * definition of "error rate" no longer matches the console's.
 *
 * This is not hypothetical. Before this module, BOTH surfaces computed tool errors from
 * `mcp_tool_errors_total`, a metric that is **never emitted** — errors are recorded as
 * `mcp_tool_calls_total{outcome="error"}`. Grafana used a regex form that silently matched nothing;
 * the console queried the name directly and reported "no data". Two independently-maintained copies
 * of one definition, both wrong the same way, on a panel whose whole job is to say when something is
 * broken. Neither noticed, because there was nothing to compare against.
 *
 * So the dashboard is the definition and the console is a READER of it. Edit a panel in
 * `dorinda-metrics/dashboards/dorinda-product-topline.json`, redeploy Grafana, and the console's
 * Explore list changes with it — no forge release, no second edit, no drift.
 *
 * ## Why the Grafana API rather than the file
 *
 * The file is the ultimate source, but it lives in another repo that the console cannot read. Grafana
 * serves exactly what was provisioned from that file, so fetching the dashboard over its API gets the
 * same bytes with an HTTP hop instead of a build-time dependency between two services.
 *
 * ## What happens when Grafana is down
 *
 * The catalog reports the failure and the Explore screen keeps its built-in infrastructure intents.
 * It does NOT fall back to a bundled copy of the product queries: a stale copy that renders happily
 * while disagreeing with the dashboard is the exact failure this module exists to prevent. Better a
 * named absence than a confident wrong answer.
 */

/**
 * Substitute Grafana's built-in time macros with concrete durations.
 *
 * A dashboard panel legitimately writes `[$__range]` or `[$__rate_interval]`; Grafana resolves those
 * at render time from the selected window. The console has its own window, so it resolves them the
 * same way — passing them through verbatim would send Prometheus a query it cannot parse, and the
 * panel would fail for a reason that has nothing to do with the metric.
 *
 * This is not cosmetic. `$__range` is the ONLY practical form for a quantile over sparse data: at a
 * few calls an hour, `rate(...[5m])` is zero in every window, `histogram_quantile` of an all-zero
 * histogram is NaN, and the series vanishes — a panel that reads "no data" while the histogram
 * beneath it is healthy.
 */
export function resolveGrafanaMacros(expr: string, rangeSeconds: number): string {
  const range = `${Math.max(60, Math.round(rangeSeconds))}s`;
  // Grafana's own rule of thumb: at least 4x the scrape interval, and never below the step.
  const rateInterval = `${Math.max(60, Math.round(rangeSeconds / 120) * 4)}s`;
  return expr
    .replace(/\$__range_s\b/g, String(Math.round(rangeSeconds)))
    .replace(/\$__range\b/g, range)
    .replace(/\$__rate_interval\b/g, rateInterval)
    .replace(/\$__interval\b/g, rateInterval);
}

export interface CatalogMetric {
  /** Stable id derived from the panel, used in URLs. */
  id: string;
  title: string;
  /** The PromQL, verbatim from the dashboard panel. */
  expr: string;
  /** Grafana's unit string (`cpm`, `ms`, `percentunit`, `short`), passed through for formatting. */
  unit?: string;
  /** The panel's description — why the metric matters, written once, in the dashboard. */
  description?: string;
}

export interface MetricCatalog {
  /** Where these came from, so the UI can say so and link out. */
  source: { dashboardUid: string; title: string; url?: string };
  metrics: CatalogMetric[];
  /** Set when the catalog could not be read. Never accompanied by a stale metric list. */
  error?: string;
}

export interface GrafanaCatalogConfig {
  /** e.g. https://grafana.dorinda.ai */
  origin?: string;
  user?: string;
  pass?: string;
  /** Which dashboard defines the top-line set. */
  dashboardUid?: string;
}

export function catalogConfigured(c: GrafanaCatalogConfig): boolean {
  return Boolean(c.origin && c.user && c.pass && c.dashboardUid);
}

/** Turn a panel title into a URL-safe id: "Tool calls / min" → "tool-calls-min". */
export function panelId(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'panel'
  );
}

/**
 * Extract the queryable panels from a Grafana dashboard document.
 *
 * Pure, so the mapping is testable without a Grafana. Panels that carry no PromQL — rows, text
 * panels, and anything using a Grafana expression/datasource we cannot execute — are skipped rather
 * than surfaced as broken entries.
 */
export function extractCatalog(doc: unknown): CatalogMetric[] {
  const d = (doc ?? {}) as { dashboard?: Record<string, unknown> } & Record<string, unknown>;
  const dash = (d.dashboard ?? d) as { panels?: unknown[] };
  const out: CatalogMetric[] = [];
  const seen = new Set<string>();

  const walk = (panels: unknown[]) => {
    for (const raw of panels) {
      const p = raw as {
        title?: string;
        type?: string;
        description?: string;
        panels?: unknown[];
        fieldConfig?: { defaults?: { unit?: string } };
        targets?: Array<{ expr?: string; datasource?: { type?: string } }>;
      };
      // Rows nest their children; a row itself is never queryable.
      if (Array.isArray(p.panels)) walk(p.panels);

      const expr = p.targets?.find((t) => typeof t.expr === 'string' && t.expr.trim())?.expr?.trim();
      if (!expr || !p.title) continue;

      let id = panelId(p.title);
      // Two panels can legitimately share a title; ids must still be unique or one shadows the other.
      if (seen.has(id)) {
        let n = 2;
        while (seen.has(`${id}-${n}`)) n++;
        id = `${id}-${n}`;
      }
      seen.add(id);

      out.push({
        id,
        title: p.title,
        expr,
        unit: p.fieldConfig?.defaults?.unit,
        description: p.description,
      });
    }
  };

  walk(Array.isArray(dash.panels) ? dash.panels : []);
  return out;
}

/**
 * Fetch the catalog from Grafana.
 *
 * Short-cached: the dashboard changes on a deploy, not on a page load, and re-fetching per request
 * would put Grafana in the hot path of every Explore render.
 */
export function createGrafanaCatalog(cfg: GrafanaCatalogConfig, ttlMs = 60_000) {
  let cached: { at: number; value: MetricCatalog } | null = null;

  return {
    async get(signal: AbortSignal, now: () => number = Date.now): Promise<MetricCatalog> {
      const uid = cfg.dashboardUid ?? '';
      const head = { dashboardUid: uid, title: 'Product — top-line', url: cfg.origin ? `${cfg.origin}/d/${uid}` : undefined };

      if (!catalogConfigured(cfg)) {
        return { source: head, metrics: [], error: 'grafana catalog is not configured' };
      }
      if (cached && now() - cached.at < ttlMs) return cached.value;

      try {
        const auth = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');
        const res = await fetch(`${cfg.origin}/api/dashboards/uid/${encodeURIComponent(uid)}`, {
          headers: { authorization: auth, accept: 'application/json' },
          signal,
        });
        if (!res.ok) throw new Error(`grafana returned ${res.status} for dashboard ${uid}`);
        const doc = (await res.json()) as { dashboard?: { title?: string } };
        const metrics = extractCatalog(doc);
        if (metrics.length === 0) {
          // An empty catalog from a dashboard that DOES exist means the panels changed shape.
          // Reported, because silently showing nothing looks identical to "no metrics defined".
          throw new Error(`dashboard ${uid} yielded no queryable panels`);
        }
        const value: MetricCatalog = {
          source: { ...head, title: doc.dashboard?.title ?? head.title },
          metrics,
        };
        cached = { at: now(), value };
        return value;
      } catch (e) {
        // No stale-copy fallback, deliberately — see the module note.
        return { source: head, metrics: [], error: (e as Error).message };
      }
    },
  };
}
