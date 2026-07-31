/**
 * Two metrics providers, because there are genuinely two stores with INDEPENDENT failure modes.
 *
 *   Cloud Monitoring  — GCP → GCP, no moving parts. Essentially cannot break.
 *   Managed Prometheus — app → OTLP → collector → GMP. Any hop dies silently.
 *
 * On 2026-07-31 the second was empty for days behind a five-fault chain while the first was
 * perfectly healthy, and every dashboard drew a flat line at zero. So:
 *
 *   ⛔ EMPTY IS NEVER RENDERED AS ZERO. Every result carries an `empty_reason` distinguishing
 *      "quiet" from "this pipeline is dead", and the UI is required to print it.
 *
 * That single rule is the difference between this console and the dashboards it replaces.
 */
import type { MetricIntent, MetricResult, Series } from '../../console/domain';
import type {
  Feature,
  MetricRange,
  MetricTarget,
  MetricsProvider,
  ProviderContext,
  ProviderHealth,
} from '../../console/providers/types';
import { gcpJson } from './http';

const MON = 'https://monitoring.googleapis.com';

function iso(d: Date): string {
  return d.toISOString();
}

// ── Cloud Monitoring (infrastructure) ──────────────────────────────────────────────────────────

/** Intent → the GCP metric type and aligner that answers it. */
const CM_INTENTS: Partial<Record<MetricIntent, { metric: string; aligner: string; reducer?: string }>> = {
  request_rate: { metric: 'run.googleapis.com/request_count', aligner: 'ALIGN_RATE' },
  error_rate: { metric: 'run.googleapis.com/request_count', aligner: 'ALIGN_RATE' },
  latency_p95: { metric: 'run.googleapis.com/request_latencies', aligner: 'ALIGN_PERCENTILE_95' },
  instance_count: { metric: 'run.googleapis.com/container/instance_count', aligner: 'ALIGN_MEAN' },
  cpu_utilization: { metric: 'run.googleapis.com/container/cpu/utilizations', aligner: 'ALIGN_PERCENTILE_95' },
  memory_utilization: { metric: 'run.googleapis.com/container/memory/utilizations', aligner: 'ALIGN_PERCENTILE_95' },
  db_connections: { metric: 'cloudsql.googleapis.com/database/postgresql/num_backends', aligner: 'ALIGN_MEAN' },
  db_disk_used: { metric: 'cloudsql.googleapis.com/database/disk/bytes_used', aligner: 'ALIGN_MEAN' },
};

export function createCloudMonitoringProvider(opts: {
  id: string;
  envs: string[];
  scope: { project_id: string };
}): MetricsProvider {
  const project = opts.scope.project_id;
  const supported = new Set<Feature>(['metrics.intent']);

  return {
    id: opts.id,
    type: 'gcp.cloud-monitoring',
    kind: 'metrics',
    label: 'Cloud Monitoring',
    envs: opts.envs,
    supports: (f) => supported.has(f),
    supportsIntent: (i) => i in CM_INTENTS,

    async health(ctx: ProviderContext): Promise<ProviderHealth> {
      try {
        const end = new Date();
        await gcpJson({
          url:
            `${MON}/v3/projects/${project}/timeSeries?` +
            `filter=${encodeURIComponent('metric.type="run.googleapis.com/request_count"')}` +
            `&interval.endTime=${iso(end)}&interval.startTime=${iso(new Date(end.getTime() - 600_000))}` +
            `&pageSize=1`,
          signal: ctx.signal,
        });
        return { ok: true, detail: 'reachable', checked_at: iso(new Date()) };
      } catch (e) {
        return { ok: false, detail: (e as Error).message.slice(0, 200), checked_at: iso(new Date()) };
      }
    },

    async query(i: MetricIntent, t: MetricTarget, r: MetricRange, ctx: ProviderContext): Promise<MetricResult> {
      const spec = CM_INTENTS[i];
      if (!spec) {
        return { series: [], provider_id: opts.id, empty_reason: 'not_supported', detail: `Cloud Monitoring cannot answer "${i}"` };
      }
      const isDb = spec.metric.startsWith('cloudsql');
      const filter = isDb
        ? `metric.type="${spec.metric}"`
        : `metric.type="${spec.metric}" AND resource.labels.service_name="${t.runtime_id}"` +
          (i === 'error_rate' ? ' AND metric.labels.response_code_class="5xx"' : '');

      const url =
        `${MON}/v3/projects/${project}/timeSeries?` +
        `filter=${encodeURIComponent(filter)}` +
        `&interval.startTime=${iso(r.start)}&interval.endTime=${iso(r.end)}` +
        `&aggregation.alignmentPeriod=${r.step_seconds}s` +
        `&aggregation.perSeriesAligner=${spec.aligner}` +
        `&aggregation.crossSeriesReducer=REDUCE_SUM`;

      try {
        const body = await gcpJson<{ timeSeries?: any[] }>({ url, signal: ctx.signal });
        const series: Series[] = (body.timeSeries ?? []).map((ts) => ({
          labels: { ...(ts.metric?.labels ?? {}), ...(ts.resource?.labels ?? {}) },
          points: (ts.points ?? [])
            .map((p: any) => ({
              t: Math.floor(new Date(p.interval.endTime).getTime() / 1000),
              v: numeric(p.value),
            }))
            .reverse(), // GCP returns newest-first; charts want oldest-first
        }));
        if (series.length === 0) {
          return {
            series: [],
            provider_id: opts.id,
            empty_reason: 'no_data_in_window',
            detail: `no ${spec.metric} samples for ${t.runtime_id} in this window`,
          };
        }
        return { series, provider_id: opts.id };
      } catch (e) {
        return { series: [], provider_id: opts.id, empty_reason: 'query_failed', detail: (e as Error).message.slice(0, 200) };
      }
    },
  };
}

function numeric(v: Record<string, unknown>): number | null {
  if (v['doubleValue'] !== undefined) return Number(v['doubleValue']);
  if (v['int64Value'] !== undefined) return Number(v['int64Value']);
  if (v['distributionValue'] !== undefined) {
    const d = v['distributionValue'] as { mean?: number };
    return d.mean ?? null;
  }
  return null;
}

// ── Managed Prometheus (application) ───────────────────────────────────────────────────────────

const GMP_INTENTS: Partial<Record<MetricIntent, (svc: string) => string>> = {
  request_rate: () => 'sum(rate(mcp_tool_calls_total[5m])) * 60',
  error_rate: () => 'sum(rate(mcp_tool_errors_total[5m])) * 60',
  latency_p95: () =>
    'histogram_quantile(0.95, sum by (le) (rate(mcp_tool_duration_ms_milliseconds_bucket[5m])))',
};

export function createManagedPrometheusProvider(opts: {
  id: string;
  envs: string[];
  scope: { project_id: string };
}): MetricsProvider {
  const project = opts.scope.project_id;
  const base = `${MON}/v1/projects/${project}/location/global/prometheus/api/v1`;
  const supported = new Set<Feature>(['metrics.intent', 'metrics.native']);

  /**
   * Distinguish "nothing happened recently" from "nothing EVER arrived".
   *
   * This is the check that would have saved a week: an instant query against a sparse gauge looks
   * identical to an empty store, and I chased exactly that confusion for hours before range-querying.
   */
  async function classifyEmpty(expr: string, signal: AbortSignal): Promise<{ reason: MetricResult['empty_reason']; detail: string }> {
    try {
      const end = Math.floor(Date.now() / 1000);
      const body = await gcpJson<{ data?: { result?: unknown[] } }>({
        url:
          `${base}/query_range?query=${encodeURIComponent(expr)}` +
          `&start=${end - 7 * 24 * 3600}&end=${end}&step=3600`,
        signal,
      });
      const any = (body.data?.result ?? []).length > 0;
      // Scope the claim to THIS metric. "No data for mcp_tool_calls_total" means nobody called a
      // tool, which is a perfectly healthy Sunday — it does NOT mean the pipeline is down, and
      // saying so would be the same over-claiming this console exists to stop. Pipeline health is
      // a separate question, answered by the metrics-pipeline-dead finding across ALL metrics.
      return any
        ? { reason: 'no_data_in_window', detail: 'no samples in this window; this metric has data within the last 7 days' }
        : { reason: 'never_ingested', detail: 'this metric has no samples in the last 7 days' };
    } catch {
      return { reason: 'no_data_in_window', detail: 'no samples in this window' };
    }
  }

  async function run(expr: string, r: MetricRange, ctx: ProviderContext): Promise<MetricResult> {
    try {
      const body = await gcpJson<{ data?: { result?: any[] } }>({
        url:
          `${base}/query_range?query=${encodeURIComponent(expr)}` +
          `&start=${Math.floor(r.start.getTime() / 1000)}&end=${Math.floor(r.end.getTime() / 1000)}` +
          `&step=${r.step_seconds}`,
        signal: ctx.signal,
      });
      const result = body.data?.result ?? [];
      const series: Series[] = result.map((s) => ({
        labels: s.metric ?? {},
        points: (s.values ?? []).map((v: [number, string]) => ({ t: v[0], v: Number(v[1]) })),
      }));
      if (series.length === 0) {
        const c = await classifyEmpty(expr, ctx.signal);
        return { series: [], provider_id: opts.id, empty_reason: c.reason, detail: c.detail };
      }
      return { series, provider_id: opts.id };
    } catch (e) {
      return { series: [], provider_id: opts.id, empty_reason: 'query_failed', detail: (e as Error).message.slice(0, 200) };
    }
  }

  return {
    id: opts.id,
    type: 'gcp.managed-prometheus',
    kind: 'metrics',
    label: 'Managed Prometheus',
    envs: opts.envs,
    supports: (f) => supported.has(f),
    supportsIntent: (i) => i in GMP_INTENTS,

    async health(ctx: ProviderContext): Promise<ProviderHealth> {
      try {
        // Note: this queries GMP DIRECTLY with a service-account token. Grafana needs the
        // `gmp-frontend` proxy only because it cannot refresh OAuth2 tokens; the console can.
        await gcpJson({ url: `${base}/query?query=up`, signal: ctx.signal });
        return { ok: true, detail: 'reachable', checked_at: iso(new Date()) };
      } catch (e) {
        return { ok: false, detail: (e as Error).message.slice(0, 200), checked_at: iso(new Date()) };
      }
    },

    async query(i: MetricIntent, _t: MetricTarget, r: MetricRange, ctx: ProviderContext): Promise<MetricResult> {
      const build = GMP_INTENTS[i];
      if (!build) {
        return { series: [], provider_id: opts.id, empty_reason: 'not_supported', detail: `Managed Prometheus cannot answer "${i}"` };
      }
      return run(build(_t.runtime_id), r, ctx);
    },

    async queryNative(expr: string, r: MetricRange, ctx: ProviderContext): Promise<MetricResult> {
      return run(expr, r, ctx);
    },

    /**
     * Is the pipeline ingesting ANYTHING?
     *
     * Deliberately not "does metric X have data": `mcp_tool_calls_total` is empty whenever nobody
     * has called a tool, which is most of a normal Sunday. Using one quiet metric as a proxy for
     * pipeline health raised a CRITICAL on a perfectly healthy system the first time this shipped —
     * and a false alarm on day one is how an operator learns to ignore the console.
     *
     * Range-query, never instant: sparse gauges (emitted once at registration) are invisible to an
     * instant query and look identical to an empty store. That confusion cost hours.
     */
    async isIngesting(ctx: ProviderContext): Promise<boolean> {
      try {
        const end = Math.floor(Date.now() / 1000);
        const body = await gcpJson<{ data?: { result?: unknown[] } }>({
          url:
            `${base}/query_range?query=${encodeURIComponent('count({__name__=~".+"})')}` +
            `&start=${end - 6 * 3600}&end=${end}&step=300`,
          signal: ctx.signal,
        });
        return (body.data?.result ?? []).length > 0;
      } catch {
        // Unreachable is a provider-health problem, reported separately. Do not turn it into a
        // false "pipeline dead".
        return true;
      }
    },
  };
}
