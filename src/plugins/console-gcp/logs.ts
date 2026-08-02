/**
 * Cloud Logging provider.
 *
 * Rate limit note that shapes the design: `entries:list` allows ~60 requests/minute/project, which
 * is by far the tightest quota in this estate. So logs are NEVER polled in the background — they
 * are fetched only in response to a user action, and results are never persisted (log bodies can
 * contain secrets).
 */
import type { LogEntry, Severity } from '../../console/domain';
import type {
  Feature,
  LogQuery,
  LogsProvider,
  ProviderContext,
  ProviderHealth,
} from '../../console/providers/types';
import { gcpJson } from './http';

const SEVERITY_ORDER: Severity[] = ['debug', 'info', 'warning', 'error', 'critical'];

function mapSeverity(s: string | undefined): Severity {
  const v = (s ?? 'INFO').toUpperCase();
  if (v === 'DEBUG' || v === 'DEFAULT') return 'debug';
  if (v === 'WARNING') return 'warning';
  if (v === 'ERROR') return 'error';
  if (v === 'CRITICAL' || v === 'ALERT' || v === 'EMERGENCY') return 'critical';
  return 'info';
}

/**
 * Build a Cloud Logging filter. Values are quoted and any embedded quote is stripped, because a
 * service name is user-influenced input and an unescaped one would let a caller rewrite the filter.
 */
export function buildFilter(q: LogQuery): string {
  if (q.native) return q.native;
  const clean = (v: string) => v.replace(/["\\\n]/g, '');
  const parts: string[] = [];
  if (q.runtime_id) {
    parts.push(`resource.type="cloud_run_revision"`);
    parts.push(`resource.labels.service_name="${clean(q.runtime_id)}"`);
  }
  if (q.severity_at_least) {
    parts.push(`severity>=${q.severity_at_least.toUpperCase()}`);
  }
  /*
   * BOTH fields, because the same trace id lives in two places and matching one returns a subset.
   *
   * `trace` is the LogEntry's OWN field. Cloud Run stamps it on its REQUEST logs (adopting the
   * inbound `traceparent`), and an app can populate it for its own lines only by writing the magic
   * `logging.googleapis.com/trace` key into a structured payload.
   *
   * `jsonPayload.trace_id` is the plain field an app writes when it is not doing anything
   * GCP-specific — the normal case, and the one this console must not punish.
   *
   * Matching only `trace` is why the pivot returned exactly ONE entry per request: the ids were
   * correct and identical, and the app's lines simply lived in the other field. A console that
   * silently returns a SUBSET is worse than one that returns nothing — the operator concludes the
   * request really did only do one thing, and stops looking.
   */
  if (q.trace_id) {
    const t = clean(q.trace_id);
    parts.push(`(trace:"${t}" OR jsonPayload.trace_id="${t}")`);
  }
  // A first-class clause rather than a `native` override, so "this user's errors in dorinda-api"
  // is expressible. Routing owner through `native` would have silently discarded the service and
  // severity filters, which is the sort of narrowing that answers a different question than asked.
  if (q.owner) parts.push(`jsonPayload.owner="${clean(q.owner)}"`);
  if (q.text) parts.push(`"${clean(q.text)}"`);
  return parts.join(' AND ');
}

/**
 * Render a Cloud Run **request log** as a readable line.
 *
 * ⛔ WHY THIS EXISTS: a request log carries NO `textPayload` and NO `jsonPayload` — the whole entry
 * is `httpRequest` plus metadata. The extractor above looks only at those two payloads, so every
 * request log rendered as a COMPLETELY BLANK ROW. On a live acceptance run that was 26 of 40 lines
 * in the pane, and the blank ones were the HTTP entries — precisely what you need to trace a flow
 * end to end. The admin purge was searchable by URL and yet displayed as an empty row.
 *
 * For an operations console, `POST /api/admin/accounts/purge → 200 (914ms)` IS the log line.
 */
export function describeHttpRequest(h: Record<string, unknown> | undefined): string {
  if (!h) return '';
  const method = String(h['requestMethod'] ?? 'REQ');
  const raw = String(h['requestUrl'] ?? '');
  let path = raw;
  try {
    // Show host+path, never the query string: it routinely carries tokens and ids, and log bodies
    // are the one place a secret most often leaks into a screenshot.
    const u = new URL(raw);
    path = u.host + u.pathname;
  } catch {
    path = raw.split('?')[0] ?? raw;
  }
  if (!path) return '';
  const status = h['status'] !== undefined ? ` → ${h['status']}` : '';
  const lat = typeof h['latency'] === 'string' ? h['latency'] : '';
  const ms = lat ? ` (${Math.round(parseFloat(lat) * 1000)}ms)` : '';
  return `${method} ${path}${status}${ms}`;
}

/** Audit logs put everything in protoPayload; without this they render blank for the same reason. */
export function describeProtoPayload(p: Record<string, unknown> | undefined): string {
  if (!p) return '';
  const name = p['methodName'] ?? p['serviceName'];
  const resource = p['resourceName'];
  if (!name && !resource) return '';
  return [name, resource].filter(Boolean).join(' ');
}

export function createCloudLoggingProvider(opts: {
  id: string;
  envs: string[];
  scope: { project_id: string };
}): LogsProvider {
  const project = opts.scope.project_id;
  const supported = new Set<Feature>(['logs.query']);

  return {
    id: opts.id,
    type: 'gcp.cloud-logging',
    kind: 'logs',
    label: 'Cloud Logging',
    envs: opts.envs,
    supports: (f) => supported.has(f),

    async health(ctx: ProviderContext): Promise<ProviderHealth> {
      try {
        await gcpJson({
          url: 'https://logging.googleapis.com/v2/entries:list',
          method: 'POST',
          body: { resourceNames: [`projects/${project}`], pageSize: 1, orderBy: 'timestamp desc' },
          signal: ctx.signal,
        });
        return { ok: true, detail: 'reachable', checked_at: new Date().toISOString() };
      } catch (e) {
        return {
          ok: false,
          detail: (e as Error).message.slice(0, 200),
          checked_at: new Date().toISOString(),
        };
      }
    },

    async query(q, r, ctx): Promise<LogEntry[]> {
      const base = buildFilter(q);
      const window = `timestamp>="${r.start.toISOString()}" AND timestamp<="${r.end.toISOString()}"`;
      const filter = base ? `${base} AND ${window}` : window;

      const body = await gcpJson<{ entries?: any[] }>({
        url: 'https://logging.googleapis.com/v2/entries:list',
        method: 'POST',
        body: {
          resourceNames: [`projects/${project}`],
          filter,
          orderBy: 'timestamp desc',
          pageSize: Math.min(r.limit, 1000),
        },
        signal: ctx.signal,
      });

      return (body.entries ?? []).map((e) => {
        // A structured payload is far more useful than the raw line; fall back gracefully.
        const jp = e.jsonPayload as Record<string, unknown> | undefined;
        const message =
          (typeof e.textPayload === 'string' && e.textPayload) ||
          (jp && ((jp['message'] ?? jp['msg'] ?? jp['event']) as string)) ||
          (jp ? JSON.stringify(jp) : '') ||
          describeHttpRequest(e.httpRequest) ||
          describeProtoPayload(e.protoPayload) ||
          '';
        return {
          timestamp: e.timestamp,
          severity: mapSeverity(e.severity),
          message: String(message).slice(0, 4000),
          labels: {
            ...(e.resource?.labels ?? {}),
            ...(e.labels ?? {}),
          },
          /*
           * The id the UI's Trace pivot is built from. Read from the LogEntry's `trace` field when
           * present, and otherwise from the payload — the same two-places problem as `buildFilter`.
           *
           * Reading only `e.trace` meant a line that plainly CARRIES a trace id showed no Trace
           * link at all, because the id sat in `jsonPayload.trace_id` where nothing looked. The
           * filter and the extractor have to agree on where a trace id can live, or the console can
           * find entries it cannot offer to pivot from.
           */
          ...(e.trace
            ? { trace_id: String(e.trace).split('/').pop()! }
            : typeof jp?.['trace_id'] === 'string'
              ? { trace_id: jp['trace_id'] as string }
              : {}),
          insert_id: e.insertId ?? `${e.timestamp}`,
        };
      });
    },
  };
}

export { SEVERITY_ORDER };
