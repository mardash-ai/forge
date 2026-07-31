/**
 * Cloud Logging provider.
 *
 * Rate limit note that shapes the design: `entries:list` allows ~60 requests/minute/project, which
 * is by far the tightest quota in this estate. So logs are NEVER polled in the background — they
 * are fetched only in response to a user action, and results are never persisted (log bodies can
 * contain secrets).
 */
import type { LogEntry, Severity } from '../../console/domain';
import type { Feature, LogQuery, LogsProvider, ProviderContext, ProviderHealth } from '../../console/providers/types';
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
function buildFilter(q: LogQuery): string {
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
  if (q.trace_id) parts.push(`trace:"${clean(q.trace_id)}"`);
  if (q.text) parts.push(`"${clean(q.text)}"`);
  return parts.join(' AND ');
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
        return { ok: false, detail: (e as Error).message.slice(0, 200), checked_at: new Date().toISOString() };
      }
    },

    async query(q, r, ctx): Promise<LogEntry[]> {
      const base = buildFilter(q);
      const window =
        `timestamp>="${r.start.toISOString()}" AND timestamp<="${r.end.toISOString()}"`;
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
          (jp && (jp['message'] ?? jp['msg'] ?? jp['event']) as string) ||
          (jp ? JSON.stringify(jp) : '') ||
          '';
        return {
          timestamp: e.timestamp,
          severity: mapSeverity(e.severity),
          message: String(message).slice(0, 4000),
          labels: {
            ...(e.resource?.labels ?? {}),
            ...(e.labels ?? {}),
          },
          ...(e.trace ? { trace_id: String(e.trace).split('/').pop()! } : {}),
          insert_id: e.insertId ?? `${e.timestamp}`,
        };
      });
    },
  };
}

export { SEVERITY_ORDER };
