/**
 * forge-console — the server. Fastify, serving the API and the built SPA from one process.
 *
 * Auth is one interface with two implementations so the interim swap is configuration, not code:
 * basic auth today, Google OAuth (domain-restricted) the moment its client secret is populated.
 * Every mutating route is registered in a table with a required role, and a test asserts that no
 * mutating route exists outside it.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';

import { envelope, type Finding, type MetricIntent, type QuotaGauge, type Revision } from './domain';
import { aggregate, createRegistry, type ProviderContext, type ProviderRegistry } from './providers/types';
import type {
  CredentialsProvider,
  InventoryProvider,
  LogsProvider,
  MetricsProvider,
  PipelinesProvider,
  RuntimeProvider,
} from './providers/types';
import { buildServiceGraph } from './correlate/graph';
import { runFindings } from './findings';
import { buildTimeline } from './timeline';
import { computeQuotas } from './quota';
import { builtinSource, webManifestSource, indexAll, findSource, unqualify, type DocSource } from './docs';
import { createGrafanaCatalog, resolveGrafanaMacros } from './metrics-catalog';
import { createGcpInventoryProvider } from '../plugins/console-gcp/inventory';
import { createCloudMonitoringProvider, createManagedPrometheusProvider } from '../plugins/console-gcp/metrics';
import { createCloudLoggingProvider } from '../plugins/console-gcp/logs';
import { createGcpCredentialsProvider } from '../plugins/console-gcp/credentials';
import { createCloudRunRuntimeProvider } from '../plugins/console-gcp/runtime';
import {
  createGcpAlertsProvider,
  createGcpCostProvider,
  createGcsDriftProvider,
  type AlertsProvider,
  type CostProvider,
  type DriftProvider,
} from '../plugins/console-gcp/ops';
import { createGitHubPipelinesProvider } from '../plugins/console-github/pipelines';
import { createDorindaTenantProvider, TenantAppError } from '../plugins/console-dorinda/tenants';
import type { TenantProvider } from './providers/tenants';

const PORT = Number(process.env.PORT ?? 3000);
const PROJECT = process.env.CONSOLE_GCP_PROJECT ?? 'dorinda-prod';
const REGION = process.env.CONSOLE_GCP_REGION ?? 'us-east1';
const ENV: string = process.env.CONSOLE_ENV ?? 'prod-a';
const GH_OWNER = process.env.CONSOLE_GITHUB_OWNER ?? 'mardash-ai';
const GH_REPOS = (process.env.CONSOLE_GITHUB_REPOS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const UI_DIR = process.env.CONSOLE_UI_DIR ?? join(process.cwd(), 'console', 'dist');
const STATE_BUCKET = process.env.CONSOLE_STATE_BUCKET ?? 'dorinda-tf-state';
const BILLING_ACCOUNT = process.env.CONSOLE_BILLING_ACCOUNT ?? '';
/** Which Cloud Run services carry the deploy axis. Discovered from inventory, capped for latency. */
const DEPLOY_SAMPLE = 8;

// ── Providers ──────────────────────────────────────────────────────────────────────────────────

export function buildRegistry(): ProviderRegistry {
  const scope = { project_id: PROJECT, region: REGION };
  const providers = [
    createGcpInventoryProvider({ id: 'gcp-inventory', envs: [ENV], scope }),
    createCloudMonitoringProvider({ id: 'cloud-monitoring', envs: [ENV], scope: { project_id: PROJECT } }),
    createManagedPrometheusProvider({ id: 'managed-prometheus', envs: [ENV], scope: { project_id: PROJECT } }),
    createCloudLoggingProvider({ id: 'cloud-logging', envs: [ENV], scope: { project_id: PROJECT } }),
    createGcpCredentialsProvider({
      id: 'gcp-credentials',
      envs: [ENV],
      scope: { project_id: PROJECT },
      // Expiries no API exposes. Configured rather than coded so adding one is not a release.
      declared: (process.env.CONSOLE_DECLARED_EXPIRIES ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((entry) => {
          // "name|kind|iso8601|detail"
          const [name, kind, expires_at, detail] = entry.split('|');
          return {
            name: name ?? 'unknown',
            kind: (kind ?? 'api_token') as never,
            expires_at: expires_at ?? '',
            ...(detail ? { detail } : {}),
          };
        })
        .filter((d) => d.expires_at),
    }),
    createGitHubPipelinesProvider({
      id: 'github-actions',
      envs: [ENV],
      owner: GH_OWNER,
      repos: GH_REPOS,
      ...(process.env.CONSOLE_GITHUB_TOKEN ? { token: process.env.CONSOLE_GITHUB_TOKEN } : {}),
    }),
    createCloudRunRuntimeProvider({ id: 'cloud-run', envs: [ENV], scope }),
    createGcpAlertsProvider({ id: 'gcp-alerts', envs: [ENV], scope: { project_id: PROJECT } }),
    createGcsDriftProvider({
      id: 'gcs-drift',
      envs: [ENV],
      scope: { bucket: STATE_BUCKET },
      ...(process.env.CONSOLE_GITHUB_TOKEN ? { githubToken: process.env.CONSOLE_GITHUB_TOKEN } : {}),
      owner: GH_OWNER,
      repos: GH_REPOS,
    }),
    createGcpCostProvider({
      id: 'gcp-billing',
      envs: [ENV],
      scope: { billing_account: BILLING_ACCOUNT, project_id: PROJECT },
    }),
  ];
  return createRegistry(providers);
}

function ctx(): ProviderContext {
  return { env: ENV, signal: AbortSignal.timeout(28_000), now: new Date() };
}

// ── Auth ───────────────────────────────────────────────────────────────────────────────────────

export interface ConsoleAuth {
  readonly mode: 'basic' | 'google' | 'open';
  check(req: FastifyRequest): { ok: true; actor: string } | { ok: false; challenge?: string };
}

/**
 * Basic auth is the INTERIM. Google OAuth restricted to the workspace domain is built behind the
 * same interface and switches on when its secret is populated — no code change.
 *
 * Fails CLOSED: with neither credential configured the console serves nothing rather than serving
 * a production control plane to the internet.
 */
export function createAuth(): ConsoleAuth {
  const user = process.env.CONSOLE_BASIC_USER ?? '';
  const pass = process.env.CONSOLE_BASIC_PASS ?? '';
  if (!user || !pass) {
    return {
      mode: 'basic',
      check: () => ({ ok: false, challenge: 'Basic realm="forge console"' }),
    };
  }
  const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  const expectedHash = createHash('sha256').update(expected).digest();
  return {
    mode: 'basic',
    check(req) {
      const got = req.headers.authorization ?? '';
      const gotHash = createHash('sha256').update(got).digest();
      // Constant-time compare over fixed-length hashes: a length-varying compare leaks the prefix.
      if (got && timingSafeEqual(gotHash, expectedHash)) return { ok: true, actor: user };
      return { ok: false, challenge: 'Basic realm="forge console"' };
    },
  };
}

// ── Write actions — the audited surface ────────────────────────────────────────────────────────

export const WRITE_ROUTES = [
  '/api/actions/dispatch',
  // ── The Data section. Every one of these changes a real account or a real tenant's data, so
  // every one of them is audited BY CONSTRUCTION: this list is what the guard test checks a
  // mutating route against, and an unlisted POST/DELETE fails the build rather than shipping.
  '/api/tenants/accounts/comp',
  '/api/tenants/accounts/lock',
  '/api/tenants/accounts/purge',
  '/api/tenants/test/seed',
  '/api/tenants/test/reset',
  '/api/tenants/test/clock',
] as const;

interface AuditRow {
  at: string;
  actor: string;
  action: string;
  target: string;
  outcome: 'attempted' | 'succeeded' | 'failed';
  detail?: string;
}
const auditLog: AuditRow[] = [];

/**
 * The audit row is written BEFORE the attempt and updated after.
 *
 * Auditing only on success loses exactly the interesting cases: the crash mid-write, the provider
 * timeout, the permission denial. Those are the rows you want at 3am.
 */
async function audited<T>(
  actor: string,
  action: string,
  target: string,
  fn: () => Promise<T>,
): Promise<T> {
  const row: AuditRow = { at: new Date().toISOString(), actor, action, target, outcome: 'attempted' };
  auditLog.unshift(row);
  if (auditLog.length > 500) auditLog.pop();
  try {
    const out = await fn();
    row.outcome = 'succeeded';
    return out;
  } catch (e) {
    row.outcome = 'failed';
    row.detail = (e as Error).message.slice(0, 300);
    throw e;
  }
}

// ── Server ─────────────────────────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Every route this server registers, as `METHOD /full/path`.
 *
 * Recorded from Fastify's own `onRoute` hook rather than parsed out of `printRoutes()`, which
 * renders a tree for humans and COLLAPSES shared prefixes: six routes under `/api/tenants/...`
 * print as `/comp`, `/lock`, `/purge`.
 *
 * That was survivable while every write route sat at the top level and printed in full — the audit
 * guard worked, and it failed loudly the moment routes nested. The reason to fix it properly rather
 * than adjust the parser is the case that would NOT fail loudly: a nested path whose collapsed
 * fragment happens to match a declared entry would pass the guard while checking a different route
 * than the one registered.
 */
export const REGISTERED_ROUTES: string[] = [];

export function buildServer(registry = buildRegistry(), auth = createAuth()): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  REGISTERED_ROUTES.length = 0;
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) REGISTERED_ROUTES.push(`${m} ${r.url}`);
  });

  // Health is public — a probe cannot hold a credential, and it reveals nothing.
  app.get('/healthz', async () => ({ status: 'ok', service: 'forge-console', env: ENV }));

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url === '/healthz') return;
    const r = auth.check(req);
    if (!r.ok) {
      reply.header('WWW-Authenticate', r.challenge ?? 'Basic realm="forge console"');
      reply.code(401).send({ error: { code: 'unauthorized', message: 'authentication required' } });
    }
  });

  const actorOf = (req: FastifyRequest): string => {
    const r = auth.check(req);
    return r.ok ? r.actor : 'anonymous';
  };

  // ── Reads ──

  app.get('/api/bootstrap', async () => {
    const c = ctx();
    const health = await Promise.all(
      registry.all().map(async (p) => ({
        provider_id: p.id,
        label: p.label,
        kind: p.kind,
        ...(await p.health(c)),
      })),
    );
    return envelope({ env: ENV, project: PROJECT, region: REGION, auth: auth.mode, providers: health });
  });

  app.get('/api/inventory', async () => {
    const c = ctx();
    const provs = registry.byKind('inventory', ENV) as InventoryProvider[];
    const { items, sources } = await aggregate(provs, (p) => p.list(c));
    return envelope(items, sources);
  });

  app.get('/api/services', async () => {
    const c = ctx();
    const inv = registry.byKind('inventory', ENV) as InventoryProvider[];
    const pipes = registry.byKind('pipelines', ENV) as PipelinesProvider[];
    const [invRes, pipeRes] = await Promise.all([
      aggregate(inv, (p) => p.list(c)),
      aggregate(pipes, (p) => (p.supports('pipelines.list') ? p.listPipelines(c) : Promise.resolve([]))),
    ]);
    const graph = buildServiceGraph({
      resources: invRes.items,
      pipelines: pipeRes.items,
      repos: GH_REPOS.map((r) => `${GH_OWNER}/${r}`),
      hostBackends: {},
    });
    return envelope(graph, [...invRes.sources, ...pipeRes.sources]);
  });

  app.get('/api/pipelines/runs', async (req) => {
    const q = req.query as { limit?: string };
    const c = ctx();
    const provs = registry.byKind('pipelines', ENV) as PipelinesProvider[];
    const { items, sources } = await aggregate(provs, (p) =>
      p.supports('pipelines.runs') ? p.listRuns({ limit: Number(q.limit ?? 20) }, c) : Promise.resolve([]),
    );
    return envelope(items, sources);
  });

  app.get('/api/pipelines', async () => {
    const c = ctx();
    const provs = registry.byKind('pipelines', ENV) as PipelinesProvider[];
    const { items, sources } = await aggregate(provs, (p) =>
      p.supports('pipelines.list') ? p.listPipelines(c) : Promise.resolve([]),
    );
    return envelope(items, sources);
  });

  /*
   * The top-line product metrics are DEFINED in a Grafana dashboard and read from it here — see
   * metrics-catalog.ts for why they are not also written down in this repo. The short answer: they
   * were, in both places, and both copies computed tool errors from a metric that is never emitted.
   */
  const catalog = createGrafanaCatalog({
    origin: process.env.CONSOLE_GRAFANA_URL,
    user: process.env.CONSOLE_GRAFANA_USER,
    pass: process.env.CONSOLE_GRAFANA_PASS,
    dashboardUid: process.env.CONSOLE_TOPLINE_DASHBOARD ?? 'dorinda-product-topline',
  });

  app.get('/api/metrics/catalog', async () => envelope(await catalog.get(AbortSignal.timeout(10_000))));

  app.get('/api/metrics', async (req) => {
    const q = req.query as { intent?: string; service?: string; minutes?: string; metric?: string };
    const intent = (q.intent ?? 'request_rate') as MetricIntent;
    const end = new Date();
    const minutes = Number(q.minutes ?? 60);
    const range = { start: new Date(end.getTime() - minutes * 60_000), end, step_seconds: Math.max(60, Math.floor((minutes * 60) / 120)) };
    const c = ctx();
    const provs = registry.byKind('metrics', ENV) as MetricsProvider[];

    /*
     * A CATALOG metric runs the dashboard's own PromQL, verbatim.
     *
     * Resolved by id against the catalog rather than taking an expression from the query string:
     * accepting arbitrary PromQL from a URL would make this an open query proxy into the metrics
     * store, and the id indirection means the only expressions this can ever run are ones a human
     * put on the dashboard.
     */
    if (q.metric) {
      const cat = await catalog.get(AbortSignal.timeout(10_000));
      if (cat.error) {
        return envelope({ series: [], provider_id: 'grafana-catalog', empty_reason: 'not_supported', detail: cat.error });
      }
      const m = cat.metrics.find((x) => x.id === q.metric);
      if (!m) {
        return envelope({ series: [], provider_id: 'grafana-catalog', empty_reason: 'not_supported', detail: `no catalog metric "${q.metric}"` });
      }
      const native = provs.find((p) => p.supports('metrics.native') && p.queryNative);
      if (!native) {
        return envelope({ series: [], provider_id: 'none', empty_reason: 'not_supported', detail: 'no provider can run raw PromQL' });
      }
      // Grafana macros are resolved against the console's OWN window, exactly as Grafana resolves
      // them against the dashboard's. Passing `[$__range]` through would be a parse error at
      // Prometheus, and the panel would fail for a reason unrelated to the metric.
      const expr = resolveGrafanaMacros(m.expr, minutes * 60);
      const r = await native.queryNative!(expr, range, c);
      return envelope(r, [{ provider_id: native.id, ok: true }]);
    }
    const target = { runtime_id: q.service ?? 'dorinda-api', env: ENV };
    const usable = provs.filter((p) => p.supportsIntent(intent, target));
    if (usable.length === 0) {
      return envelope({ series: [], provider_id: 'none', empty_reason: 'not_supported', detail: `no provider answers "${intent}"` });
    }
    const results = await Promise.all(usable.map((p) => p.query(intent, target, range, c)));
    // Prefer a provider that actually returned data; otherwise keep the first result SO THAT its
    // empty_reason survives — that explanation is the whole point.
    const withData = results.find((r) => r.series.length > 0);
    return envelope(withData ?? results[0]!, usable.map((p) => ({ provider_id: p.id, ok: true })));
  });

  app.get('/api/logs', async (req) => {
    const q = req.query as { service?: string; text?: string; severity?: string; minutes?: string; limit?: string };
    const end = new Date();
    const minutes = Number(q.minutes ?? 60);
    const c = ctx();
    const provs = registry.byKind('logs', ENV) as LogsProvider[];
    const limit = Number(q.limit ?? 100);
    const { items, sources } = await aggregate(provs, (p) =>
      p.query(
        {
          ...(q.service ? { runtime_id: q.service } : {}),
          ...(q.text ? { text: q.text } : {}),
          ...(q.severity ? { severity_at_least: q.severity as never } : {}),
        },
        { start: new Date(end.getTime() - minutes * 60_000), end, limit },
        c,
      ),
    );
    /*
     * ⛔ SAY WHEN THE ANSWER IS SHORTER THAN THE QUESTION.
     *
     * Logs come back newest-first, so hitting the row limit means the response covers a WINDOW
     * SMALLER than the one asked for — and silently so. During the 2026-07-31 acceptance run a
     * 190-minute query returned 400 rows spanning 20 minutes, and "no 5xx in the last 190 minutes"
     * was about to be recorded as a pass from data that never reached back that far. An all-clear
     * derived from an unstated truncation is exactly the false green this console exists to end.
     */
    const oldest = items.length ? items[items.length - 1]!.timestamp : null;
    const truncated = items.length >= limit;
    return envelope(items, sources, {
      ...(truncated && oldest
        ? {
            note:
              `showing the newest ${items.length} lines — they cover back to ${oldest}, ` +
              `NOT the full ${minutes}m requested. Narrow the filter or raise the limit to see further back.`,
          }
        : {}),
    });
  });

  app.get('/api/findings', async () => {
    const c = ctx();
    const inv = registry.byKind('inventory', ENV) as InventoryProvider[];
    const pipes = registry.byKind('pipelines', ENV) as PipelinesProvider[];
    const creds = registry.byKind('credentials', ENV) as CredentialsProvider[];
    const metrics = registry.byKind('metrics', ENV) as MetricsProvider[];

    const [invRes, runRes, credRes] = await Promise.all([
      aggregate(inv, (p) => p.list(c)),
      aggregate(pipes, (p) => (p.supports('pipelines.runs') ? p.listRuns({ limit: 30 }, c) : Promise.resolve([]))),
      aggregate(creds, (p) => p.list(c)),
    ]);

    // Certificates carry their own expiry; fold them into the credential list so one rule covers both.
    const certCreds = invRes.items
      .filter((r) => r.kind === 'certificate' && r.attributes['expires_at'])
      .map((r) => ({
        id: r.external_id,
        env: r.env,
        kind: 'tls_certificate' as const,
        name: r.name,
        expires_at: String(r.attributes['expires_at']),
        auto_renews: true,
        source: 'discovered' as const,
      }));

    // Ask the STORE whether it is ingesting, never a single metric — see isIngesting().
    const gmp = metrics.find((p) => p.type === 'gcp.managed-prometheus');
    const ingesting = gmp?.isIngesting ? await gmp.isIngesting(c) : true;

    const graph = buildServiceGraph({
      resources: invRes.items,
      pipelines: [],
      repos: GH_REPOS.map((r) => `${GH_OWNER}/${r}`),
      hostBackends: {},
    });

    const findings: Finding[] = runFindings({
      resources: invRes.items,
      graph,
      credentials: [...credRes.items, ...certCreds],
      runs: runRes.items,
      metricsIngesting: ingesting,
      now: new Date(),
    });
    return envelope(findings, [...invRes.sources, ...runRes.sources]);
  });

  app.get('/api/credentials', async () => {
    const c = ctx();
    const provs = registry.byKind('credentials', ENV) as CredentialsProvider[];
    const { items, sources } = await aggregate(provs, (p) => p.list(c));
    // Soonest expiry first: the whole point of this view is "what bites me next".
    const sorted = items.slice().sort((a, b) => {
      if (a.expires_at && b.expires_at) return a.expires_at.localeCompare(b.expires_at);
      if (a.expires_at) return -1;
      if (b.expires_at) return 1;
      return a.name.localeCompare(b.name);
    });
    return envelope(sorted, sources);
  });

  app.get('/api/audit', async () => envelope(auditLog.slice(0, 100)));

  // ── Runtime: what is serving, and what you could roll back to ──

  app.get('/api/runtime/revisions', async (req) => {
    const q = req.query as { service?: string };
    if (!q.service) return envelope([] as Revision[], [], {});
    const c = ctx();
    const provs = registry.byKind('runtime', ENV) as RuntimeProvider[];
    const { items, sources } = await aggregate(provs, (p) => p.listRevisions(q.service!, c));
    return envelope(items, sources);
  });

  // ── Alerts: is anything watching, and does it reach a human? ──

  app.get('/api/alerts', async () => {
    const c = ctx();
    const provs = registry.byKind('alerts', ENV) as AlertsProvider[];
    const [pol, inc] = await Promise.all([
      aggregate(provs, (p) => p.listPolicies(c)),
      aggregate(provs, (p) => p.listFiring(c)),
    ]);
    return envelope({ policies: pol.items, firing: inc.items }, pol.sources);
  });

  // ── Drift: all three axes ──

  app.get('/api/drift', async () => {
    const c = ctx();
    const provs = registry.byKind('drift', ENV) as DriftProvider[];
    const { items, sources } = await aggregate(provs, (p) => p.listStacks(c));
    const latest = await Promise.all(provs.map((p) => p.latestRelease(c).catch(() => null)));
    // CI pin drift: the axis that let a shipped fix sit unadopted in twelve of fourteen workflows.
    const pins = (await Promise.all(provs.map((p) => p.listPinDrift(c).catch(() => [])))).flat();
    return envelope(
      { stacks: items, latest_release: latest.find(Boolean) ?? null, pin_drift: pins },
      sources,
    );
  });

  // ── Cost ──

  app.get('/api/cost', async () => {
    const c = ctx();
    const provs = registry.byKind('cost', ENV) as CostProvider[];
    const { items, sources } = await aggregate(provs, (p) => p.listBudgets(c));
    const inv = registry.byKind('inventory', ENV) as InventoryProvider[];
    const invRes = await aggregate(inv, (p) => p.list(c));
    // No BigQuery billing export exists, so there are no actuals to show. Saying that plainly beats
    // an empty chart, which reads as "you spent nothing".
    return envelope(
      {
        budgets: items,
        actuals: null as null,
        actuals_detail:
          'Actual spend needs a BigQuery billing export, which is not configured. Budgets and the ' +
          'billable-resource inventory below are what the console can prove.',
        billable: invRes.items.filter((r) => r.billable),
      },
      [...sources, ...invRes.sources],
    );
  });

  // ── Quota headroom ──

  app.get('/api/quota', async () => {
    const c = ctx();
    const inv = registry.byKind('inventory', ENV) as InventoryProvider[];
    const metrics = registry.byKind('metrics', ENV) as MetricsProvider[];
    const invRes = await aggregate(inv, (p) => p.list(c));

    const end = new Date();
    const range = { start: new Date(end.getTime() - 24 * 3600_000), end, step_seconds: 300 };
    const cm = metrics.find((p) => p.type === 'gcp.cloud-monitoring');

    const peakInstances = new Map<string, number>();
    let peakDb: number | null = null;
    if (cm) {
      const services = invRes.items.filter((r) => r.kind === 'compute.service').slice(0, DEPLOY_SAMPLE);
      await Promise.all(
        services.map(async (s) => {
          const r = await cm.query('instance_count', { runtime_id: s.name, env: ENV }, range, c);
          const peak = Math.max(0, ...r.series.flatMap((x) => x.points.map((p) => p.v ?? 0)));
          if (r.series.length > 0) peakInstances.set(s.name, peak);
        }),
      );
      const db = await cm.query('db_connections', { runtime_id: '', env: ENV }, range, c);
      if (db.series.length > 0) peakDb = Math.max(0, ...db.series.flatMap((x) => x.points.map((p) => p.v ?? 0)));
    }

    const providerGauges: QuotaGauge[] = (
      await Promise.all(registry.all().map((p) => (p.quotas ? p.quotas(c).catch(() => []) : Promise.resolve([]))))
    ).flat();

    return envelope(computeQuotas({ resources: invRes.items, peakInstances, peakDbConnections: peakDb, providerGauges }), invRes.sources);
  });

  // ── The unified "what changed" timeline ──

  app.get('/api/timeline', async (req) => {
    const q = req.query as { hours?: string };
    const hours = Math.min(720, Math.max(1, Number(q.hours ?? 48)));
    const since = new Date(Date.now() - hours * 3600_000);
    const c = ctx();

    const pipes = registry.byKind('pipelines', ENV) as PipelinesProvider[];
    const inv = registry.byKind('inventory', ENV) as InventoryProvider[];
    const runtime = registry.byKind('runtime', ENV) as RuntimeProvider[];

    const [runRes, invRes] = await Promise.all([
      aggregate(pipes, (p) => (p.supports('pipelines.runs') ? p.listRuns({ limit: 50 }, c) : Promise.resolve([]))),
      aggregate(inv, (p) => p.list(c)),
    ]);

    const services = invRes.items.filter((r) => r.kind === 'compute.service').slice(0, DEPLOY_SAMPLE);
    const revisions = await Promise.all(
      services.map(async (s) => ({
        service: s.name,
        revisions: await Promise.all(runtime.map((p) => p.listRevisions(s.name, c).catch(() => [])))
          .then((all) => all.flat()),
      })),
    );

    const events = buildTimeline({
      runs: runRes.items,
      revisions,
      // Findings carry `first_seen_at = now` on every sweep (they are recomputed, not stored), so
      // including them here would stamp every finding onto this second and drown the real changes.
      findings: [],
      audit: auditLog,
      since,
    });
    return envelope(events, [...runRes.sources, ...invRes.sources]);
  });

  // ── Docs, aggregated from every source (see docs.ts for the built-in vs live rule) ──

  /*
   * Registry order is READING order in the UI: platform internals first (the architecture you need
   * to hold the system in your head), then each app's own help pages.
   *
   * `dorinda-devs` is absent on purpose — it is being decommissioned, and its durable pages are now
   * the built-in source. Its two hand-transcribed cloud snapshots were dropped rather than imported;
   * the Inventory, Cost, Credentials and Headroom screens answer those questions from the live API.
   */
  const docSources: DocSource[] = [
    builtinSource(join(process.cwd(), 'src', 'console', 'docs', 'content')),
    webManifestSource({
      id: 'app',
      label: 'Dorinda app flows',
      origin: process.env.CONSOLE_APP_DOCS_ORIGIN ?? 'https://app.dorinda.ai',
    }),
  ];

  app.get('/api/docs', async () => {
    // Never 501 as a whole: one unreachable source reports itself and the others still render.
    return envelope({ sources: await indexAll(docSources, AbortSignal.timeout(15_000)) });
  });

  app.get('/api/docs/page', async (req, reply) => {
    const q = req.query as { p?: string };
    const ref = unqualify(q.p ?? '');
    if (!ref) {
      return reply.code(400).send({ error: { code: 'invalid_page', message: 'page id must be `source:page`' } });
    }
    const source = findSource(docSources, ref.sourceId);
    if (!source) {
      return reply.code(404).send({ error: { code: 'unknown_source', message: `no doc source ${ref.sourceId}` } });
    }
    try {
      return envelope(await source.getPage(ref.pageId, AbortSignal.timeout(15_000)));
    } catch (e) {
      return reply.code(502).send({ error: { code: 'docs_unavailable', message: (e as Error).message } });
    }
  });

  // Assets are namespaced by source: a built-in SVG and a remote one must not collide, and a path
  // from one source must never resolve against another's origin.
  app.get('/docs/asset/*', async (req, reply) => {
    const raw = (req.params as Record<string, string>)['*'] ?? '';
    const slash = raw.indexOf('/');
    const sourceId = slash === -1 ? '' : raw.slice(0, slash);
    const path = slash === -1 ? '' : raw.slice(slash + 1);
    const source = findSource(docSources, sourceId);
    if (!source) return reply.code(404).send('unknown doc source');
    try {
      const a = await source.getAsset(path, AbortSignal.timeout(15_000));
      return reply.type(a.contentType).header('cache-control', 'private, max-age=300').send(a.body);
    } catch (e) {
      return reply.code(502).send((e as Error).message);
    }
  });

  // ── Data — accounts and test tenants ──────────────────────────────────────────────────────────

  /*
   * The console reaches an app's data through the APP's own HTTP surface, never its database.
   *
   * That is slower than a query and it is the point: the app keeps its invariants — dorinda's
   * transactional local delete, the tombstone that signs a deleted user out, the two-marker
   * test-tenant guard — and the console never becomes a second, unaudited way to mutate a
   * datastore. Forge reaching into a consumer schema would also break the boundary its own tenant
   * cascade is deliberately careful to respect.
   */
  const tenants: TenantProvider[] = [
    createDorindaTenantProvider({
      origin: process.env.CONSOLE_DORINDA_API_ORIGIN ?? 'https://api.dorinda.ai',
      adminToken: process.env.CONSOLE_DORINDA_ADMIN_TOKEN,
      testToken: process.env.CONSOLE_DORINDA_TEST_TOKEN,
    }),
  ];
  const tenantProvider = (app_?: string): TenantProvider | undefined =>
    app_ ? tenants.find((t) => t.app === app_) : tenants[0];

  /** Map the APP's own error through, so a refusal reads as a refusal and not as "upstream error". */
  function tenantFail(reply: FastifyReply, e: unknown) {
    if (e instanceof TenantAppError) {
      return reply.code(e.status).send({ error: { code: e.code, message: e.message } });
    }
    return reply.code(502).send({ error: { code: 'tenant_unavailable', message: (e as Error).message } });
  }

  /** Resolve the provider or answer 501 — an unconfigured app is a STATE, not a failure. */
  function withTenants(
    req: FastifyRequest,
    reply: FastifyReply,
  ): TenantProvider | null {
    const t = tenantProvider((req.query as { app?: string })?.app ?? (req.body as { app?: string })?.app);
    if (!t) {
      reply.code(501).send({ error: { code: 'not_configured', message: 'no tenant provider is configured' } });
      return null;
    }
    return t;
  }

  app.get('/api/tenants/accounts', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    if (!t.supports('accounts.list')) {
      return reply.code(501).send({
        error: {
          code: 'not_configured',
          // Named precisely: "not configured" with no name sends an operator hunting.
          message: 'no CONSOLE_DORINDA_ADMIN_TOKEN configured, so accounts cannot be read',
        },
      });
    }
    try {
      return envelope(await t.listAccounts(ctx()));
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.get('/api/tenants/accounts/detail', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const owner = (req.query as { owner?: string }).owner ?? '';
    if (!owner) return reply.code(400).send({ error: { code: 'bad_request', message: 'owner is required' } });
    try {
      return envelope(await t.getAccount(ctx(), owner));
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.post('/api/tenants/accounts/comp', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { owner?: string; comped?: boolean };
    if (!body?.owner || typeof body.comped !== 'boolean') {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'owner and comped are required' } });
    }
    try {
      return envelope(
        await audited(actorOf(req), `account.comp.${body.comped ? 'grant' : 'revoke'}`, body.owner, () =>
          t.setComp(ctx(), body.owner!, body.comped!),
        ),
      );
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.post('/api/tenants/accounts/lock', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { owner?: string; locked?: boolean };
    if (!body?.owner || typeof body.locked !== 'boolean') {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'owner and locked are required' } });
    }
    try {
      return envelope(
        await audited(actorOf(req), `account.${body.locked ? 'lock' : 'unlock'}`, body.owner, () =>
          t.setLocked(ctx(), body.owner!, body.locked!),
        ),
      );
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.post('/api/tenants/accounts/purge', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { owner?: string; confirm_email?: string; reason?: string };
    if (!body?.owner || !body.confirm_email) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: 'owner and confirm_email are required' },
      });
    }
    /*
     * A REASON is required, exactly as it is for a pipeline dispatch — and more so.
     *
     * This is the one console action that destroys a person's account. The audit row is the only
     * record of WHY it happened, and "someone with the operator password did it at 03:12" is not an
     * answer anybody can act on later.
     */
    if (!body.reason || body.reason.trim().length < 3) {
      return reply.code(422).send({
        error: { code: 'reason_required', message: 'a reason is required to purge an account' },
      });
    }
    try {
      const out = await audited(actorOf(req), 'account.purge', `${body.owner} · ${body.reason.trim()}`, () =>
        t.purge(ctx(), body.owner!, body.confirm_email!),
      );
      return envelope(out);
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.get('/api/tenants/connections', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    if (!t.supports('connections.read')) {
      return reply.code(501).send({
        error: { code: 'not_configured', message: 'no CONSOLE_DORINDA_ADMIN_TOKEN configured, so connectors cannot be read' },
      });
    }
    const hours = Number((req.query as { hours?: string }).hours ?? 24);
    try {
      return envelope(await t.connections(ctx(), Number.isFinite(hours) && hours > 0 ? hours : 24));
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.get('/api/tenants/test', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    try {
      return envelope({ tenants: await t.listTestTenants(ctx()), canWrite: t.supports('test.reset') });
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.post('/api/tenants/test/reset', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { owner?: string };
    if (!body?.owner) return reply.code(400).send({ error: { code: 'bad_request', message: 'owner is required' } });
    try {
      return envelope(await audited(actorOf(req), 'test.reset', body.owner, () => t.reset(ctx(), body.owner!)));
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.post('/api/tenants/test/seed', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { owner?: string; fixture?: unknown };
    if (!body?.owner) return reply.code(400).send({ error: { code: 'bad_request', message: 'owner is required' } });
    try {
      return envelope(
        await audited(actorOf(req), 'test.seed', body.owner, () => t.seed(ctx(), body.owner!, body.fixture ?? {})),
      );
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.get('/api/tenants/test/clock', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const owner = (req.query as { owner?: string }).owner ?? '';
    if (!owner) return reply.code(400).send({ error: { code: 'bad_request', message: 'owner is required' } });
    try {
      return envelope(await t.getClock(ctx(), owner));
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.post('/api/tenants/test/clock', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { owner?: string; at?: string; advance_ms?: number; settle?: boolean; clear?: boolean };
    if (!body?.owner) return reply.code(400).send({ error: { code: 'bad_request', message: 'owner is required' } });
    try {
      if (body.clear) {
        await audited(actorOf(req), 'test.clock.clear', body.owner, () => t.clearClock(ctx(), body.owner!));
        return envelope({ owner: body.owner, cleared: true });
      }
      return envelope(
        await audited(actorOf(req), 'test.clock.set', body.owner, () =>
          t.setClock(ctx(), body.owner!, { at: body.at, advanceMs: body.advance_ms, settle: body.settle }),
        ),
      );
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  // ── The single write ──

  app.post('/api/actions/dispatch', async (req, reply) => {
    const body = req.body as { pipeline_id?: string; ref?: string; inputs?: Record<string, string>; reason?: string };
    if (!body?.pipeline_id) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'pipeline_id is required' } });
    }
    // A production action must carry a stated reason — it lands in the audit row.
    if (!body.reason || body.reason.trim().length < 3) {
      return reply.code(422).send({ error: { code: 'reason_required', message: 'a reason is required for any dispatch' } });
    }
    const provs = registry.byKind('pipelines', ENV) as PipelinesProvider[];
    const p = provs.find((x) => x.supports('pipelines.dispatch'));
    if (!p) {
      return reply.code(501).send({
        error: { code: 'not_supported', message: 'no pipeline provider can dispatch — is the GitHub token configured?' },
      });
    }
    const actor = actorOf(req);
    const receipt = await audited(actor, 'pipeline.dispatch', body.pipeline_id, () =>
      p.dispatch(body.pipeline_id!, { ref: body.ref ?? 'main', inputs: body.inputs ?? {} }, ctx()),
    );
    return envelope(receipt);
  });

  // ── SPA ──

  app.setNotFoundHandler(async (req, reply) => {
    // API 404s must stay 404s — swallowing them into the SPA shell turns a typo'd route into a
    // blank page instead of an error.
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: req.url } });
    }
    const rel = normalize(decodeURIComponent(req.url.split('?')[0] ?? '/'));
    if (rel.includes('..')) return reply.code(400).send('bad path');
    const ext = extname(rel);
    try {
      if (ext) {
        const buf = await readFile(join(UI_DIR, rel));
        return reply.type(MIME[ext] ?? 'application/octet-stream').send(buf);
      }
      const html = await readFile(join(UI_DIR, 'index.html'));
      return reply.type('text/html; charset=utf-8').send(html);
    } catch {
      return reply.code(404).type('text/html').send('<h1>forge console</h1><p>UI bundle not built.</p>');
    }
  });

  return app;
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const app = buildServer();
  app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
    process.stdout.write(`forge-console listening on :${PORT} (env=${ENV}, project=${PROJECT})\n`);
  });
}
