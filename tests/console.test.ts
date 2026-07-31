import { describe, it, expect } from 'vitest';
import { buildServiceGraph } from '../src/console/correlate/graph';
import { runFindings } from '../src/console/findings';
import { aggregate, createRegistry, type InventoryProvider, type Provider } from '../src/console/providers/types';
import { buildServer, WRITE_ROUTES, createAuth } from '../src/console/server';
import type { InfraResource } from '../src/console/domain';

/**
 * forge-console — the properties that must hold no matter which providers are plugged in.
 *
 * Everything here is pure or uses fakes: no cloud, no network. The correlation graph and the
 * findings engine are the two pieces where a subtle bug would quietly mislead an operator, so they
 * get the most attention.
 */

const r = (p: Partial<InfraResource> & { name: string; kind: InfraResource['kind'] }): InfraResource => ({
  provider_id: 'fake',
  env: 'prod-a',
  native_type: 'fake/Type',
  external_id: `id:${p.name}`,
  scope: 'regional',
  billable: false,
  labels: {},
  attributes: {},
  ...p,
});

describe('correlation — discovery-first, never a declared catalogue', () => {
  it('joins a runtime to its image repo, backend and host with full confidence', () => {
    const g = buildServiceGraph({
      resources: [
        r({ name: 'dorinda-api', kind: 'compute.service' }),
        r({ name: 'dorinda-api', kind: 'registry.repo' }),
        r({ name: 'dorinda-api-backend', kind: 'net.backend', scope: 'global' }),
      ],
      pipelines: [],
      repos: ['mardash-ai/dorinda-api'],
      hostBackends: { 'api.dorinda.ai': 'dorinda-api-backend' },
    });
    const svc = g.services.find((s) => s.key === 'dorinda-api')!;
    expect(svc).toBeTruthy();
    const kinds = svc.bindings.map((b) => b.kind).sort();
    expect(kinds).toContain('runtime');
    expect(kinds).toContain('image_repo');
    expect(kinds).toContain('backend');
    expect(kinds).toContain('host');
    expect(svc.bindings.find((b) => b.kind === 'host')!.confidence).toBe(1);
  });

  it('every binding carries the RULE that produced it — a wrong join must be explainable', () => {
    const g = buildServiceGraph({
      resources: [r({ name: 'dorinda-web', kind: 'compute.service' })],
      pipelines: [],
      repos: [],
      hostBackends: {},
    });
    for (const b of g.services[0]!.bindings) {
      expect(b.evidence.length).toBeGreaterThan(0);
      expect(b.evidence[0]!.rule).toBeTruthy();
      expect(b.evidence[0]!.detail).toBeTruthy();
    }
  });

  it('does NOT merge two services that merely share a name prefix', () => {
    const g = buildServiceGraph({
      resources: [
        r({ name: 'dorinda-api', kind: 'compute.service' }),
        r({ name: 'dorinda-api-worker', kind: 'compute.service' }),
      ],
      pipelines: [],
      repos: [],
      hostBackends: {},
    });
    expect(g.services.map((s) => s.key).sort()).toEqual(['dorinda-api', 'dorinda-api-worker']);
  });

  it('assigns a prefixed secret to the LONGEST matching service, not the first', () => {
    // 'dorinda-api-auth-session-secret' belongs to dorinda-api, never to a hypothetical 'dorinda'.
    const g = buildServiceGraph({
      resources: [
        r({ name: 'dorinda', kind: 'compute.service' }),
        r({ name: 'dorinda-api', kind: 'compute.service' }),
        r({ name: 'dorinda-api-auth-session-secret', kind: 'secret', scope: 'global' }),
      ],
      pipelines: [],
      repos: [],
      hostBackends: {},
    });
    const api = g.services.find((s) => s.key === 'dorinda-api')!;
    expect(api.bindings.some((b) => b.kind === 'secret')).toBe(true);
    expect(g.services.find((s) => s.key === 'dorinda')!.bindings.some((b) => b.kind === 'secret')).toBe(false);
  });

  it('a peripheral secret guess does not drag the service confidence down', () => {
    // dorinda-api's runtime/backend/host are all certain; a 0.6 name-prefix secret match must not
    // make the whole service read as uncertain, or the number stops meaning anything.
    const g = buildServiceGraph({
      resources: [
        r({ name: 'dorinda-api', kind: 'compute.service' }),
        r({ name: 'dorinda-api-backend', kind: 'net.backend', scope: 'global' }),
        r({ name: 'dorinda-api-some-secret', kind: 'secret', scope: 'global' }),
      ],
      pipelines: [],
      repos: [],
      hostBackends: {},
    });
    const svc = g.services.find((s) => s.key === 'dorinda-api')!;
    expect(svc.confidence).toBe(1);
    // …but the weak binding still reports its OWN confidence honestly.
    expect(svc.bindings.find((b) => b.kind === 'secret')!.confidence).toBe(0.6);
  });

  it('reports what it could not place instead of hiding it', () => {
    const g = buildServiceGraph({
      resources: [
        r({ name: 'dorinda-api', kind: 'compute.service' }),
        r({ name: 'mystery-bucket', kind: 'bucket' }),
      ],
      pipelines: [],
      repos: [],
      hostBackends: {},
    });
    expect(g.unbound.map((u) => u.name)).toContain('mystery-bucket');
  });

  it('a stale override yields NO phantom service — the Backstage failure mode, refused', () => {
    const input = {
      resources: [r({ name: 'dorinda-api', kind: 'compute.service' })],
      pipelines: [],
      repos: [],
      hostBackends: {},
      overrides: [
        { service_key: 'service-that-never-existed', op: 'attach' as const, value: 'x', reason: 'stale' },
      ],
    };
    const g = buildServiceGraph(input);
    expect(g.services.map((s) => s.key)).not.toContain('service-that-never-existed');
  });
});

describe('findings — report-only, and driven by things that actually happened', () => {
  const base = {
    resources: [] as InfraResource[],
    graph: { services: [], unbound: [], conflicts: [] },
    credentials: [],
    runs: [],
    metricsIngesting: true,
    now: new Date('2026-08-01T00:00:00Z'),
  };

  it('raises a CRITICAL when no metrics are being ingested', () => {
    const f = runFindings({ ...base, metricsIngesting: false });
    const hit = f.find((x) => x.rule === 'metrics-pipeline-dead');
    expect(hit?.severity).toBe('critical');
  });

  it('catches a push-based collector that can scale to zero', () => {
    const f = runFindings({
      ...base,
      resources: [r({ name: 'otel-collector', kind: 'compute.service', attributes: { min_instances: 0 } })],
    });
    expect(f.some((x) => x.rule === 'collector-scales-to-zero')).toBe(true);
  });

  it('does NOT flag a collector already pinned to one instance', () => {
    const f = runFindings({
      ...base,
      resources: [r({ name: 'otel-collector', kind: 'compute.service', attributes: { min_instances: 1 } })],
    });
    expect(f.some((x) => x.rule === 'collector-scales-to-zero')).toBe(false);
  });

  it('flags a database with no backups as critical, and single-zone as info', () => {
    const f = runFindings({
      ...base,
      resources: [
        r({ name: 'pg', kind: 'db.instance', scope: 'zonal', location: 'us-east1-d', attributes: { backups: false } }),
      ],
    });
    expect(f.find((x) => x.rule === 'db-no-backups')?.severity).toBe('critical');
    expect(f.find((x) => x.rule === 'db-single-zone')?.severity).toBe('info');
  });

  it('escalates an expiring credential as the date approaches', () => {
    const soon = new Date('2026-08-04T00:00:00Z').toISOString(); // 3 days out
    const later = new Date('2026-08-20T00:00:00Z').toISOString(); // 19 days out
    const mk = (expires_at: string) => [
      { id: 'c', env: 'prod-a', kind: 'api_token' as const, name: 'runner-pat', expires_at, auto_renews: false, source: 'declared' as const },
    ];
    expect(runFindings({ ...base, credentials: mk(soon) }).find((x) => x.rule === 'credential-expiring')?.severity).toBe('critical');
    expect(runFindings({ ...base, credentials: mk(later) }).find((x) => x.rule === 'credential-expiring')?.severity).toBe('warn');
  });

  it('ignores an auto-renewing credential', () => {
    const f = runFindings({
      ...base,
      credentials: [
        { id: 'c', env: 'prod-a', kind: 'tls_certificate', name: 'cert', expires_at: new Date('2026-08-02').toISOString(), auto_renews: true, source: 'discovered' },
      ],
    });
    expect(f.some((x) => x.rule === 'credential-expiring')).toBe(false);
  });

  it('flags a service-account key as CRITICAL — this platform should have none', () => {
    const fnd = runFindings({
      ...base,
      credentials: [
        { id: 'k1', env: 'prod-a', kind: 'service_account_key', name: 'deployer key', auto_renews: false, source: 'discovered' },
      ],
    });
    expect(fnd.find((x) => x.rule === 'service-account-key-exists')?.severity).toBe('critical');
  });

  it('cannot mutate the snapshot it inspects — report-only is structural', () => {
    const snap = { ...base, resources: [r({ name: 'x', kind: 'bucket' })] };
    runFindings(snap);
    expect(snap.resources.length).toBe(1);
  });
});

describe('provider aggregation — one dead source must not blank the page', () => {
  const fake = (id: string, fail: boolean): InventoryProvider => ({
    id,
    type: 'fake.inventory',
    kind: 'inventory',
    label: id,
    envs: ['prod-a'],
    supports: () => true,
    health: async () => ({ ok: !fail, detail: '', checked_at: '' }),
    list: async () => {
      if (fail) throw new Error('boom');
      return [r({ name: `${id}-res`, kind: 'bucket' })];
    },
  });

  it('keeps the healthy provider’s rows and reports the failed one', async () => {
    const { items, sources } = await aggregate([fake('good', false), fake('bad', true)], (p) => p.list({} as never));
    expect(items).toHaveLength(1);
    expect(sources.find((s) => s.provider_id === 'bad')!.ok).toBe(false);
    expect(sources.find((s) => s.provider_id === 'bad')!.error).toContain('boom');
  });

  it('registry selects by kind and environment', () => {
    const reg = createRegistry([fake('a', false) as Provider]);
    expect(reg.byKind('inventory', 'prod-a')).toHaveLength(1);
    expect(reg.byKind('inventory', 'other-env')).toHaveLength(0);
    expect(reg.byKind('metrics', 'prod-a')).toHaveLength(0);
  });
});

describe('server — auth and the write surface', () => {
  it('fails CLOSED when no credential is configured', () => {
    const prevU = process.env.CONSOLE_BASIC_USER;
    const prevP = process.env.CONSOLE_BASIC_PASS;
    delete process.env.CONSOLE_BASIC_USER;
    delete process.env.CONSOLE_BASIC_PASS;
    const auth = createAuth();
    // A control plane with no credential must serve NOTHING, not everything.
    expect(auth.check({ headers: {} } as never).ok).toBe(false);
    if (prevU) process.env.CONSOLE_BASIC_USER = prevU;
    if (prevP) process.env.CONSOLE_BASIC_PASS = prevP;
  });

  it('rejects a wrong credential and accepts the right one', () => {
    process.env.CONSOLE_BASIC_USER = 'u';
    process.env.CONSOLE_BASIC_PASS = 'p';
    const auth = createAuth();
    const ok = 'Basic ' + Buffer.from('u:p').toString('base64');
    const bad = 'Basic ' + Buffer.from('u:wrong').toString('base64');
    expect(auth.check({ headers: { authorization: ok } } as never).ok).toBe(true);
    expect(auth.check({ headers: { authorization: bad } } as never).ok).toBe(false);
  });

  it('EVERY mutating route is declared in the audited write table', async () => {
    // The guard that matters: adding a POST/PUT/DELETE route without registering it as an audited
    // write action breaks the build, rather than shipping an unaudited way to change production.
    const app = buildServer();
    await app.ready();
    const declared = new Set<string>(WRITE_ROUTES);
    const mutating: string[] = [];
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      const m = /^\s*[│└├─\s]*(\/\S*)\s+\((.+)\)/.exec(line);
      if (!m) continue;
      const [, path, methods] = m;
      if (/POST|PUT|PATCH|DELETE/.test(methods!) && !declared.has(path!)) mutating.push(`${methods} ${path}`);
    }
    expect(mutating).toEqual([]);
    await app.close();
  });

  it('a dispatch without a reason is refused — the audit row must mean something', async () => {
    process.env.CONSOLE_BASIC_USER = 'u';
    process.env.CONSOLE_BASIC_PASS = 'p';
    const app = buildServer();
    const auth = 'Basic ' + Buffer.from('u:p').toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/api/actions/dispatch',
      headers: { authorization: auth },
      payload: { pipeline_id: 'dorinda-api:1' },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('an /api 404 stays a 404 and is never swallowed by the SPA shell', async () => {
    process.env.CONSOLE_BASIC_USER = 'u';
    process.env.CONSOLE_BASIC_PASS = 'p';
    const app = buildServer();
    const auth = 'Basic ' + Buffer.from('u:p').toString('base64');
    const res = await app.inject({ method: 'GET', url: '/api/nope', headers: { authorization: auth } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ── The unified timeline ───────────────────────────────────────────────────────────────────────

import { buildTimeline } from '../src/console/timeline';
import { computeQuotas } from '../src/console/quota';
import { extractDoc, parseDocIndex } from '../src/console/docs';
import type { PipelineRun, Revision } from '../src/console/domain';

const run = (p: Partial<PipelineRun> & { id: string }): PipelineRun => ({
  pipeline_id: 'wf1',
  pipeline_name: 'release',
  repo: 'mardash-ai/dorinda-api',
  number: 1,
  status: 'completed',
  conclusion: 'success',
  event: 'push',
  branch: 'main',
  commit_sha: 'abc',
  actor: 'mark',
  url: 'https://github.com/x',
  ...p,
});

const rev = (p: Partial<Revision> & { id: string }): Revision => ({
  image_digest: 'sha256:' + 'a'.repeat(64),
  image_ref: 'repo/img@sha256:' + 'a'.repeat(64),
  created_at: '2026-07-31T10:00:00Z',
  traffic_percent: 100,
  ready: true,
  ...p,
});

describe('timeline — the "what changed" axis', () => {
  const since = new Date('2026-07-31T00:00:00Z');

  it('interleaves deploys and CI runs on one axis, newest first', () => {
    const events = buildTimeline({
      runs: [run({ id: 'r1', started_at: '2026-07-31T09:00:00Z' })],
      revisions: [{ service: 'dorinda-api', revisions: [rev({ id: 'rev-2', created_at: '2026-07-31T11:00:00Z' })] }],
      findings: [],
      audit: [{ at: '2026-07-31T10:00:00Z', actor: 'mark', action: 'pipeline.dispatch', target: 'wf1', outcome: 'succeeded' }],
      since,
    });
    expect(events.map((e) => e.kind)).toEqual(['deploy', 'action', 'pipeline']);
  });

  it('drops everything older than the window, so a backlog cannot bury today', () => {
    const events = buildTimeline({
      runs: [run({ id: 'old', started_at: '2026-07-01T09:00:00Z' })],
      revisions: [{ service: 'api', revisions: [rev({ id: 'old-rev', created_at: '2026-06-01T09:00:00Z' })] }],
      findings: [],
      audit: [],
      since,
    });
    expect(events).toEqual([]);
  });

  it('marks a revision that never became ready as failed, not as a normal deploy', () => {
    // A revision that exists but is not Ready is the single most misleading state in Cloud Run: the
    // deploy "happened", and traffic is still on the old one.
    const [e] = buildTimeline({
      runs: [],
      revisions: [{ service: 'api', revisions: [rev({ id: 'bad', ready: false, traffic_percent: 0, created_at: '2026-07-31T12:00:00Z' })] }],
      findings: [],
      audit: [],
      since,
    });
    expect(e?.outcome).toBe('failed');
  });
});

describe('quota headroom — a limit is never invented', () => {
  const svc = (name: string, max: number | null) =>
    r({ name, kind: 'compute.service', attributes: { max_instances: max } });

  it('computes headroom only when both the peak and the ceiling are known', () => {
    const gauges = computeQuotas({
      resources: [svc('api', 10)],
      peakInstances: new Map([['api', 3]]),
      peakDbConnections: null,
      providerGauges: [],
    });
    expect(gauges[0]?.headroom_percent).toBe(70);
  });

  it('reports unknown headroom rather than a confident wrong number', () => {
    // Cloud SQL does not publish max_connections, and the tier formula is a guess. A percentage
    // computed against a guessed ceiling looks precise, which is worse than saying "unknown".
    const gauges = computeQuotas({
      resources: [r({ name: 'pg', kind: 'db.instance' })],
      peakInstances: new Map(),
      peakDbConnections: 12,
      providerGauges: [],
    });
    const db = gauges.find((g) => g.scope === 'cloud-sql');
    expect(db?.used).toBe(12);
    expect(db?.limit).toBeNull();
    expect(db?.headroom_percent).toBeNull();
  });

  it('sorts the tightest headroom first and never drops the unknowns', () => {
    const gauges = computeQuotas({
      resources: [svc('tight', 10), svc('loose', 100), svc('nolimit', null)],
      peakInstances: new Map([
        ['tight', 9],
        ['loose', 5],
      ]),
      peakDbConnections: null,
      providerGauges: [],
    });
    expect(gauges.map((g) => g.name)).toEqual(['tight instances', 'loose instances', 'nolimit instances']);
  });
});

describe('docs — absorbed by reference, never copied', () => {
  const page = `<html><head><style>:root{--x:1}</style></head><body>
    <nav><div class="logo">x</div><a href="/index">Overview</a><a href="/gcp">Google Cloud</a></nav>
    <main><h1>Google Cloud</h1><p>body</p>
    <img src="/gcp-topology.svg" alt="t">
    <a href="/runbooks">Runbooks &amp; Links</a>
    <script>alert(1)</script></main></body></html>`;

  it("derives the page index from the portal's own nav, so it cannot drift", () => {
    expect(parseDocIndex(page)).toEqual([
      { id: 'index', title: 'Overview' },
      { id: 'gcp', title: 'Google Cloud' },
    ]);
  });

  it('strips scripts and inline handlers from fetched content', () => {
    const doc = extractDoc(page, 'gcp', 'fallback');
    expect(doc.html).not.toContain('alert(1)');
    expect(doc.html).not.toContain('<script');
  });

  it('rewrites portal links to console routes and images to the proxied path', () => {
    // The portal's images sit behind its basic auth, so a raw <img src="/x.svg"> would 401 in the
    // browser and render as a broken image with no explanation.
    const doc = extractDoc(page, 'gcp', 'fallback');
    expect(doc.html).toContain('src="/docs/asset/gcp-topology.svg"');
    expect(doc.html).toContain('href="?s=docs&p=runbooks"');
  });

  it('takes only <main>, so the portal cannot restyle the console from its own <head>', () => {
    const doc = extractDoc(page, 'gcp', 'fallback');
    expect(doc.html).not.toContain('<style');
    expect(doc.html).not.toContain('<nav');
    expect(doc.title).toBe('Google Cloud');
  });
});

describe('cloud run traffic — “what is serving?” must not answer “nothing”', () => {
  it('resolves a LATEST traffic target to the latest ready revision', async () => {
    const { resolveTraffic } = await import('../src/plugins/console-gcp/runtime');
    // The shape EVERY service in this estate actually returns: a LATEST target with no revision
    // name on it. Reading t.revision alone gives an empty map, and the Deploys screen then reports
    // that production is serving nothing.
    const t = resolveTraffic({
      trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }],
      latestReadyRevision: 'projects/p/locations/us-east1/services/api/revisions/api-00013-v8t',
    });
    expect(t.get('api-00013-v8t')).toBe(100);
  });

  it('still honours an explicit pinned revision split', async () => {
    const { resolveTraffic } = await import('../src/plugins/console-gcp/runtime');
    const t = resolveTraffic({
      trafficStatuses: [
        { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: 'api-1', percent: 90 },
        { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: 'api-2', percent: 10 },
      ],
      latestReadyRevision: 'projects/p/l/r/s/api/revisions/api-3',
    });
    expect([...t]).toEqual([
      ['api-1', 90],
      ['api-2', 10],
    ]);
  });
});
