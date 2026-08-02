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
    const { REGISTERED_ROUTES } = await import('../src/console/server');
    const app = buildServer();
    await app.ready();
    const declared = new Set<string>(WRITE_ROUTES);
    /*
     * Read from Fastify's onRoute hook, NOT from printRoutes().
     *
     * printRoutes() renders a tree for humans and collapses shared prefixes: six routes under
     * /api/tenants/... print as `/comp`, `/lock`, `/purge`. Parsing that worked while every write
     * route was top-level and broke loudly once they nested. The dangerous case is the quiet one —
     * a collapsed fragment that happens to match a declared entry would pass this guard while
     * checking a different route than the one actually registered.
     */
    const mutating = REGISTERED_ROUTES.filter((r) => {
      const [method, path] = r.split(' ');
      return /^(POST|PUT|PATCH|DELETE)$/.test(method!) && !declared.has(path!);
    });
    expect(mutating).toEqual([]);
    // And the enumeration itself must be real — an empty list would make this vacuous.
    expect(REGISTERED_ROUTES.length).toBeGreaterThan(10);
    expect(REGISTERED_ROUTES).toContain('POST /api/tenants/accounts/purge');
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
    const doc = extractDoc(page, 'platform', 'gcp', 'fallback');
    expect(doc.html).not.toContain('alert(1)');
    expect(doc.html).not.toContain('<script');
  });

  it('rewrites portal links to console routes and images to the proxied path', () => {
    // The portal's images sit behind its basic auth, so a raw <img src="/x.svg"> would 401 in the
    // browser and render as a broken image with no explanation.
    const doc = extractDoc(page, 'platform', 'gcp', 'fallback');
    expect(doc.html).toContain('src="/docs/asset/platform/gcp-topology.svg"');
    expect(doc.html).toContain('href="?s=docs&p=platform:runbooks"');
  });

  it('takes only <main>, so a page cannot inject its own nav into the console shell', () => {
    // The page's CSS is kept (scoped — see the scoping suite below), but its STRUCTURE is not:
    // a fetched <nav> rendered inside the console would give the reader a second, competing
    // navigation that goes nowhere.
    const doc = extractDoc(page, 'platform', 'gcp', 'fallback');
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

describe('cloud logging — a request log must not render as a blank row', () => {
  it('renders a Cloud Run request log as method, path, status and latency', async () => {
    const { describeHttpRequest } = await import('../src/plugins/console-gcp/logs');
    // The EXACT entry the acceptance run found rendering blank: the admin purge. A request log has
    // no textPayload and no jsonPayload, so a message extractor that reads only those produces "".
    expect(
      describeHttpRequest({
        requestMethod: 'POST',
        requestUrl: 'https://api.dorinda.ai/api/admin/accounts/purge',
        status: 200,
        latency: '0.914489501s',
      }),
    ).toBe('POST api.dorinda.ai/api/admin/accounts/purge → 200 (914ms)');
  });

  it('drops the query string, which routinely carries tokens and ids', () => {
    // Log lines end up in screenshots and pasted incident notes; a query string is where a secret
    // most often rides along.
    return import('../src/plugins/console-gcp/logs').then(({ describeHttpRequest }) => {
      const out = describeHttpRequest({
        requestMethod: 'GET',
        requestUrl: 'https://api.dorinda.ai/connect/google/callback?code=SECRET&state=xyz',
        status: 302,
      });
      expect(out).not.toContain('SECRET');
      expect(out).toBe('GET api.dorinda.ai/connect/google/callback → 302');
    });
  });

  it('returns empty for an entry with no httpRequest, so ordinary logs are unaffected', async () => {
    const { describeHttpRequest, describeProtoPayload } = await import('../src/plugins/console-gcp/logs');
    expect(describeHttpRequest(undefined)).toBe('');
    expect(describeProtoPayload(undefined)).toBe('');
  });

  it('renders an audit log from protoPayload rather than blank', async () => {
    const { describeProtoPayload } = await import('../src/plugins/console-gcp/logs');
    expect(describeProtoPayload({ methodName: 'google.cloud.run.v2.Services.UpdateService',
                                  resourceName: 'projects/p/services/dorinda-api' }))
      .toBe('google.cloud.run.v2.Services.UpdateService projects/p/services/dorinda-api');
  });
});

describe('log truncation — a narrower answer than the question must say so', () => {
  it('flags when the row limit made the result cover less time than requested', async () => {
    // Live during the acceptance run: a 190-minute query returned 400 rows covering 20 minutes, and
    // "no 5xx in the last 190 minutes" was about to be recorded as a pass from data that never
    // reached back that far. Silence here manufactures confident all-clears.
    const { envelope } = await import('../src/console/domain');
    const env = envelope([1, 2, 3], [], { note: 'showing the newest 3 lines — they cover back to X, NOT the full 190m requested.' });
    expect(env.note).toContain('NOT the full');
  });

  it('carries no note when the result actually spans the window', async () => {
    const { envelope } = await import('../src/console/domain');
    expect(envelope([1], []).note).toBeUndefined();
  });
});

describe('CI pin adoption — a shipped fix nobody pins is a fix nobody has (F-15)', () => {
  it('ranks how many releases behind a pin is, so "old" is a number not a vibe', () => {
    const rank = ['v0.93.0', 'v0.92.0', 'v0.91.0', 'v0.90.0', 'v0.89.0'];
    const behind = (pinned: string) => (rank.indexOf(pinned) < 0 ? rank.length : rank.indexOf(pinned));
    expect(behind('v0.93.0')).toBe(0);
    expect(behind('v0.90.0')).toBe(3);
    // A pin so old it has fallen off the tag page is MAXIMALLY behind, never silently 0 — which is
    // the exact case that mattered: v0.79.24 was fourteen releases back and off the first page.
    expect(behind('v0.79.24')).toBe(rank.length);
  });

  it('matches a forge checkout ref, not unrelated action pins', () => {
    // A workflow pins many things. Only the forge checkout is adoption drift; treating every
    // `ref:` as forge would flood the screen and train the operator to ignore it.
    const wf = `
      - uses: actions/checkout@v4
        with:
          repository: mardash-ai/forge
          ref: v0.79.24
          path: .forge
      - uses: google-github-actions/auth@v2
        with:
          ref: v9.9.9
    `;
    const m = /mardash-ai\/forge[\s\S]{0,120}?ref:\s*(v[0-9][0-9.]*)/.exec(wf);
    expect(m?.[1]).toBe('v0.79.24');
    expect(m?.[1]).not.toBe('v9.9.9');
  });
});

describe('docs — many sources, one pane', () => {
  it('namespaces page ids, so two sources publishing `index` cannot collide', async () => {
    const { qualify, unqualify } = await import('../src/console/docs');
    expect(qualify('app', 'admin-purge')).toBe('app:admin-purge');
    expect(unqualify('platform:topology')).toEqual({ sourceId: 'platform', pageId: 'topology' });
    // A bare id is REFUSED rather than defaulted to a source — defaulting would silently serve one
    // source's page under another's link, which is the exact failure namespacing exists to prevent.
    expect(unqualify('topology')).toBeNull();
    expect(unqualify('../etc/passwd')).toBeNull();
  });

  it('scopes assets to their own source — a path from one must not resolve against another', async () => {
    const { extractDoc } = await import('../src/console/docs');
    const html = '<main><img src="/topology.svg"><a href="/runbooks">R</a></main>';
    const a = extractDoc(html, 'platform', 'x', 'x');
    const b = extractDoc(html, 'app', 'x', 'x');
    expect(a.html).toContain('src="/docs/asset/platform/topology.svg"');
    expect(b.html).toContain('src="/docs/asset/app/topology.svg"');
    expect(a.html).toContain('href="?s=docs&p=platform:runbooks"');
    expect(b.html).toContain('href="?s=docs&p=app:runbooks"');
  });

  it('reads a page that uses <body> rather than <main>, confining its <style> to the embed', async () => {
    const { extractDoc } = await import('../src/console/docs');
    // dorinda-web's help pages wrap content in a plain <div class="wrap"> with a <style> block and
    // no <main>. Falling back to the raw string would let that CSS reach the console shell and
    // restyle the whole pane — which is what a naive "just render it" would do.
    const page = `<title>Flow · purge</title><style>body{background:red}</style>
      <body><div class="wrap"><h1>Purge an account</h1><p>body</p></div></body>`;
    const doc = extractDoc(page, 'app', 'admin-purge', 'fallback');
    expect(doc.title).toBe('Purge an account');
    expect(doc.html).toContain('Purge an account');
    // The rule survives, CONFINED. `body{background:red}` reaching the shell would repaint the
    // whole console; `.doc-embed{background:red}` paints only the embedded document.
    expect(doc.html).toContain('.doc-embed{background:red}');
    expect(doc.html).not.toMatch(/(^|[^-\w.])body\s*\{/);
  });

  it('titles the built-in pages from their own <h1>, so the index cannot disagree with the page', async () => {
    const { builtinSource } = await import('../src/console/docs');
    const { join } = await import('node:path');
    const src = builtinSource(join(process.cwd(), 'src', 'console', 'docs', 'content'));
    const pages = await src.listPages(AbortSignal.timeout(5_000));
    const byId = new Map(pages.map((p) => [p.id, p.title]));
    expect(byId.get('topology')).toBe('System Topology');
    expect(byId.get('ci')).toBe('CI/CD — how everything ships');
    // The two hand-transcribed cloud snapshots were DROPPED, not imported. The console answers
    // those questions live; a stale snapshot beside a live view is worse than no snapshot.
    expect(byId.has('gcp')).toBe(false);
  });

  it('every asset a bundled page references is actually bundled', async () => {
    // A moved page whose diagram did not move renders as a broken image with no explanation.
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), 'src', 'console', 'docs', 'content');
    const files = await readdir(dir);
    const missing: string[] = [];
    for (const f of files.filter((x) => x.endsWith('.html'))) {
      const html = await readFile(join(dir, f), 'utf8');
      for (const m of html.matchAll(/(?:src|data)="\/?([a-zA-Z0-9._-]+\.svg)"/g)) {
        if (!files.includes(m[1]!)) missing.push(`${f} → ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('one unreachable source reports itself and does NOT blank the others', async () => {
    const { indexAll } = await import('../src/console/docs');
    const ok = {
      id: 'ok', label: 'Fine', origin: 'x', configured: () => true,
      listPages: async () => [{ id: 'a', title: 'A' }],
      getPage: async () => ({ id: 'ok:a', title: 'A', html: '', styled: false }),
      getAsset: async () => ({ body: Buffer.from(''), contentType: 'x' }),
    };
    const down = { ...ok, id: 'down', label: 'Down', listPages: async () => { throw new Error('502'); } };
    const unset = { ...ok, id: 'unset', label: 'Unset', configured: () => false };

    const out = await indexAll([ok, down, unset], AbortSignal.timeout(5_000));
    expect(out.find((s) => s.id === 'ok')?.pages).toHaveLength(1);
    // Reported, not swallowed — an empty Docs screen with no explanation is the failure here.
    expect(out.find((s) => s.id === 'down')?.error).toContain('502');
    expect(out.find((s) => s.id === 'unset')?.error).toBe('not configured');
  });

  it('a live source serves ONLY ids its manifest publishes', async () => {
    const { webManifestSource } = await import('../src/console/docs');
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string) => {
      calls.push(String(u));
      if (String(u).endsWith('manifest.json')) {
        return new Response(JSON.stringify([{ slug: 'login', title: 'Log in', file: 'login.html' }]));
      }
      return new Response('<body><h1>Log in</h1></body>');
    }) as never;
    try {
      const src = webManifestSource({ id: 'app', label: 'App', origin: 'https://app.example' });
      expect((await src.getPage('login', AbortSignal.timeout(5_000))).title).toBe('Log in');
      // An unpublished id is refused — otherwise this proxy becomes a fetch-anything primitive
      // pointed at our own hosts, reachable by anyone who can reach the console.
      await expect(src.getPage('secret', AbortSignal.timeout(5_000))).rejects.toThrow(/unknown page/);
      expect(calls.some((c) => c.includes('secret.html'))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('docs — a page keeps its own CSS but cannot restyle the console', () => {
  it('confines every selector to the embed scope', async () => {
    const { scopeCss } = await import('../src/console/docs');
    const out = scopeCss('.card{color:red} h1,h2{margin:0}');
    expect(out).toContain('.doc-embed .card{color:red}');
    expect(out).toContain('.doc-embed h1,.doc-embed h2{margin:0}');
  });

  it('neutralises the selectors that would otherwise own the whole page', async () => {
    const { scopeCss } = await import('../src/console/docs');
    // `body{background:#fff}` unscoped repaints the console. `:root{--ink:...}` unscoped overrides
    // the console's OWN design tokens — the more dangerous of the two, because it looks like it
    // worked while quietly changing every other screen's colours.
    const out = scopeCss(':root{--ink:#000}body{background:#fff}html.dark{color:#eee}');
    expect(out).toContain('.doc-embed{--ink:#000}');
    expect(out).toContain('.doc-embed{background:#fff}');
    expect(out).toContain('.doc-embed.dark{color:#eee}');
    expect(out).not.toMatch(/(^|[^-\w.])body\s*\{/);
    expect(out).not.toMatch(/:root\s*\{/);
  });

  it('recurses into @media and passes @keyframes / @font-face through untouched', async () => {
    const { scopeCss } = await import('../src/console/docs');
    const out = scopeCss('@media (max-width:600px){.card{padding:4px}} @keyframes spin{from{opacity:0}to{opacity:1}}');
    expect(out).toContain('@media (max-width:600px){.doc-embed .card{padding:4px}}');
    // Prefixing `from`/`to` would not scope the animation — it would break it, silently.
    expect(out).toContain('@keyframes spin{from{opacity:0}to{opacity:1}}');
    expect(out).not.toContain('.doc-embed from');
  });

  it('collects styles from the HEAD, where these pages actually put them', async () => {
    const { extractDoc, DOC_SCOPE } = await import('../src/console/docs');
    // Reading only the extracted <body> would find no <style> and produce a silently unstyled
    // document — which is exactly what shipped before this was fixed.
    const page = `<title>T</title><style>.wrap{max-width:820px}</style><body><div class="wrap"><h1>T</h1></div></body>`;
    const doc = extractDoc(page, 'app', 'x', 'x');
    expect(doc.html).toContain(`.${DOC_SCOPE} .wrap{max-width:820px}`);
    expect(doc.html).toContain('<h1>T</h1>');
  });

  it('still strips scripts and handlers — keeping CSS is not keeping behaviour', async () => {
    const { extractDoc } = await import('../src/console/docs');
    const doc = extractDoc(
      `<style>.a{color:red}</style><body><p onclick="steal()">x</p><script>alert(1)</script></body>`,
      'app', 'x', 'x',
    );
    expect(doc.html).toContain('.doc-embed .a{color:red}');
    expect(doc.html).not.toContain('alert(1)');
    expect(doc.html).not.toContain('onclick');
  });

  it('scopes the REAL purge page, whose SVG diagram is entirely class-positioned', async () => {
    // The page that exposed this: ~70 KB with an inline sequence diagram where every label's
    // position and colour comes from a .seq-* class. Unscoped-and-stripped it renders as text
    // piled at the origin, indistinguishable from a broken page.
    const { readFile } = await import('node:fs/promises');
    const { extractDoc } = await import('../src/console/docs');
    const src = await readFile(
      new URL('../../dorinda-web/public/docs/admin-purge.html', import.meta.url).pathname,
      'utf8',
    ).catch(() => null);
    if (!src) return; // dorinda-web not checked out beside forge — skip rather than fail.
    const doc = extractDoc(src, 'app', 'admin-purge', 'x');
    expect(doc.html).toContain('.doc-embed .seq-lbl');
    expect(doc.html).not.toMatch(/(^|[^-\w.])body\s*\{/);
  });
});

describe('docs — a document\'s own chrome must not become the embed\'s layout', () => {
  it('drops box layout from html/body/:root rules but keeps their look', async () => {
    const { scopeCss } = await import('../src/console/docs');
    // The devs portal sets `body{display:flex}` so a fixed sidebar sits beside its content. Mapped
    // onto the embed that made the container a flex ROW, and every heading, paragraph and table
    // laid out as a narrow vertical strip — unreadable, and it looked like a content bug.
    const out = scopeCss('body{display:flex;min-height:100vh;background:#0b1220;color:#e6edf7;font:15px sans-serif}');
    expect(out).toContain('background:#0b1220');
    expect(out).toContain('color:#e6edf7');
    expect(out).not.toContain('display:flex');
    expect(out).not.toContain('min-height');
  });

  it('keeps custom properties declared on :root — they are the page\'s design tokens', async () => {
    const { scopeCss } = await import('../src/console/docs');
    const out = scopeCss(':root{--ink:#e6edf7;--bg:#0b1220;padding:40px}');
    expect(out).toContain('--ink:#e6edf7');
    expect(out).toContain('--bg:#0b1220');
    expect(out).not.toContain('padding:40px');
  });

  it('leaves layout on NON-document selectors alone', async () => {
    const { scopeCss } = await import('../src/console/docs');
    // Only the container rule is special. A page's own `.grid{display:grid}` is its content's
    // layout and must survive, or the document loses its structure.
    const out = scopeCss('.grid{display:grid;gap:14px}');
    expect(out).toContain('.doc-embed .grid{display:grid;gap:14px}');
  });

  it('drops a document rule that is ONLY layout, rather than emitting an empty one', async () => {
    const { scopeCss } = await import('../src/console/docs');
    expect(scopeCss('body{display:flex;margin:0}').trim()).toBe('');
  });

  it('the REAL bundled portal pages no longer flex the embed', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { extractDoc } = await import('../src/console/docs');
    const dir = join(process.cwd(), 'src', 'console', 'docs', 'content');
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.html'))) {
      const doc = extractDoc(await readFile(join(dir, f), 'utf8'), 'platform', f, f);
      const containerRule = /\.doc-embed\{([^}]*)\}/.exec(doc.html)?.[1] ?? '';
      expect(containerRule, `${f} pushes layout onto the embed`).not.toMatch(/display\s*:/);
    }
  });
});

describe('tenant provider — two credentials, two surfaces', () => {
  const ctx = { env: 'prod-a' as never, signal: AbortSignal.timeout(5_000), now: new Date() };

  function stubFetch(handler: (url: string, init: RequestInit) => unknown) {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown; method: string }> = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        headers,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        method: init.method ?? 'GET',
      });
      const out = handler(String(url), init);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out ?? {}), { headers: { 'content-type': 'application/json' } });
    }) as never;
    return { calls, restore: () => { globalThis.fetch = real; } };
  }

  it('sends the ADMIN token to /api/admin and the TEST token to /api/test — never the reverse', async () => {
    // The separation that bounds the blast radius: AUTH-style tokens leak, and the admin token can
    // erase a real account while the test token structurally cannot touch one.
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({ origin: 'https://api.test', adminToken: 'ADMIN', testToken: 'TEST' });
    const f = stubFetch((url) => (url.includes('/api/admin/accounts') ? { accounts: [] } : {}));
    try {
      await p.listAccounts(ctx);
      await p.reset(ctx, 'owner_1');
      const admin = f.calls.find((c) => c.url.includes('/api/admin/'))!;
      const test = f.calls.find((c) => c.url.includes('/api/test/'))!;
      expect(admin.headers['x-admin-token']).toBe('ADMIN');
      expect(admin.headers['x-dorinda-test-token']).toBeUndefined();
      expect(test.headers['x-dorinda-test-token']).toBe('TEST');
      expect(test.headers['x-admin-token']).toBeUndefined();
    } finally {
      f.restore();
    }
  });

  it('reports UNCONFIGURED per credential rather than falling back to the other', async () => {
    // A fallback is exactly how a reset would one day arrive at the purge surface.
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({ origin: 'https://api.test', adminToken: 'ADMIN' });
    expect(p.supports('accounts.purge')).toBe(true);
    expect(p.supports('test.reset')).toBe(false);
    const f = stubFetch(() => ({}));
    try {
      await expect(p.reset(ctx, 'o')).rejects.toMatchObject({ code: 'not_configured' });
      expect(f.calls).toHaveLength(0); // it did not try the admin token instead
    } finally {
      f.restore();
    }
  });

  it("carries the APP's status and code through — a refusal must read as a refusal", async () => {
    // `403 not_a_test_tenant` and `503 platform_teardown_incomplete` are the two answers an operator
    // most needs exactly. Flattened to 502 "upstream error" they become a shrug.
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({ origin: 'https://api.test', testToken: 'TEST' });
    const f = stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'not_a_test_tenant', message: 'owner x is NOT flagged' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    try {
      await expect(p.reset(ctx, 'x')).rejects.toMatchObject({ status: 403, code: 'not_a_test_tenant' });
    } finally {
      f.restore();
    }
  });

  it('refuses a purge whose confirmation does not match what the console displayed', async () => {
    // Checked HERE as well as in the app. The app checks against the identity forge holds; this
    // checks against the row the operator was looking at, which closes the stale-list case where
    // the email they can SEE belongs to a different owner id.
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({ origin: 'https://api.test', adminToken: 'ADMIN' });
    const f = stubFetch((url) =>
      url.includes('/api/admin/accounts?owner=')
        ? { owner: 'owner_1', email: 'real@x.test', household: {}, connectionCount: 0 }
        : { accounts: [{ owner: 'owner_1', email: 'real@x.test' }] },
    );
    try {
      await expect(p.purge(ctx, 'owner_1', 'typo@x.test')).rejects.toMatchObject({ code: 'confirmation_mismatch' });
      // …and it never reached the purge endpoint.
      expect(f.calls.some((c) => c.url.includes('/purge'))).toBe(false);
    } finally {
      f.restore();
    }
  });

  it('translates lock to the app\'s inverse `active` flag', async () => {
    // The app models this as active/inactive. Translating in the provider means no screen has to
    // remember which polarity a given app uses.
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({ origin: 'https://api.test', adminToken: 'ADMIN' });
    const f = stubFetch(() => ({ subscription_status: 'paused', active: false }));
    try {
      const out = await p.setLocked(ctx, 'owner_1', true);
      expect(f.calls[0]!.body).toEqual({ owner: 'owner_1', active: false });
      expect(out.locked).toBe(true);
    } finally {
      f.restore();
    }
  });

  it('derives the test-tenant list from the ONE account list', async () => {
    // Two endpoints could disagree about which owners are test tenants; one cannot.
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({ origin: 'https://api.test', adminToken: 'ADMIN' });
    const f = stubFetch(() => ({
      accounts: [
        { owner: 'real', email: 'a@b.com', test_tenant: false },
        { owner: 'test', email: 'r@dorinda.test', test_tenant: true },
      ],
    }));
    try {
      expect((await p.listTestTenants(ctx)).map((t) => t.owner)).toEqual(['test']);
      const all = await p.listAccounts(ctx);
      // …and the flag is on the ordinary list too, so an operator about to purge can see it.
      expect(all.find((a) => a.owner === 'test')?.isTest).toBe(true);
    } finally {
      f.restore();
    }
  });
});

describe('metric catalog — one definition, read from the dashboard', () => {
  it('extracts a queryable metric from each panel, ignoring rows and text', async () => {
    const { extractCatalog } = await import('../src/console/metrics-catalog');
    const doc = {
      dashboard: {
        title: 'Product — top-line',
        panels: [
          { type: 'row', title: 'Group', panels: [{ title: 'Nested', targets: [{ expr: 'up' }] }] },
          { title: 'Tool calls / min', type: 'timeseries', description: 'why it matters', fieldConfig: { defaults: { unit: 'cpm' } }, targets: [{ expr: 'sum(rate(x[5m]))' }] },
          { title: 'Just prose', type: 'text' },
          { title: 'No expr', type: 'timeseries', targets: [{}] },
        ],
      },
    };
    const out = extractCatalog(doc);
    expect(out.map((m) => m.id)).toEqual(['nested', 'tool-calls-min']);
    const calls = out.find((m) => m.id === 'tool-calls-min')!;
    expect(calls.expr).toBe('sum(rate(x[5m]))');
    expect(calls.unit).toBe('cpm');
    // The description rides along, so the EXPLANATION cannot drift from the query either.
    expect(calls.description).toBe('why it matters');
  });

  it('gives colliding panel titles distinct ids', async () => {
    const { extractCatalog } = await import('../src/console/metrics-catalog');
    const out = extractCatalog({
      panels: [
        { title: 'Rate', targets: [{ expr: 'a' }] },
        { title: 'Rate', targets: [{ expr: 'b' }] },
      ],
    });
    // Without this, the second panel silently shadows the first and one metric becomes unreachable.
    expect(out.map((m) => m.id)).toEqual(['rate', 'rate-2']);
    expect(out.map((m) => m.expr)).toEqual(['a', 'b']);
  });

  it('reports a failure and returns NO metrics — never a stale local copy', async () => {
    const { createGrafanaCatalog } = await import('../src/console/metrics-catalog');
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as never;
    try {
      const c = createGrafanaCatalog({ origin: 'https://g.test', user: 'u', pass: 'p', dashboardUid: 'd' });
      const out = await c.get(AbortSignal.timeout(5_000));
      expect(out.metrics).toEqual([]);
      expect(out.error).toContain('503');
      // A bundled fallback copy would render happily while disagreeing with the dashboard — which is
      // the precise failure a shared definition exists to prevent. Absence must stay visible.
    } finally {
      globalThis.fetch = real;
    }
  });

  it('treats a dashboard with no queryable panels as an ERROR, not an empty catalog', async () => {
    const { createGrafanaCatalog } = await import('../src/console/metrics-catalog');
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ dashboard: { title: 'T', panels: [{ title: 'text only' }] } }), {
        headers: { 'content-type': 'application/json' },
      })) as never;
    try {
      const c = createGrafanaCatalog({ origin: 'https://g.test', user: 'u', pass: 'p', dashboardUid: 'd' });
      const out = await c.get(AbortSignal.timeout(5_000));
      // "The dashboard changed shape" and "there are no metrics" look identical otherwise.
      expect(out.error).toContain('no queryable panels');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('caches, so Grafana is not in the hot path of every render', async () => {
    const { createGrafanaCatalog } = await import('../src/console/metrics-catalog');
    let calls = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ dashboard: { title: 'T', panels: [{ title: 'A', targets: [{ expr: 'x' }] }] } }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as never;
    try {
      const c = createGrafanaCatalog({ origin: 'https://g.test', user: 'u', pass: 'p', dashboardUid: 'd' }, 60_000);
      let t = 1_000;
      await c.get(AbortSignal.timeout(5_000), () => t);
      await c.get(AbortSignal.timeout(5_000), () => t);
      expect(calls).toBe(1);
      t += 61_000;
      await c.get(AbortSignal.timeout(5_000), () => t);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('is unconfigured, not broken, when Grafana details are absent', async () => {
    const { createGrafanaCatalog, catalogConfigured } = await import('../src/console/metrics-catalog');
    expect(catalogConfigured({})).toBe(false);
    const c = createGrafanaCatalog({});
    const out = await c.get(AbortSignal.timeout(5_000));
    expect(out.error).toContain('not configured');
  });
});

describe('the top-line dashboard is the definition, and it must stay honest', () => {
  it('never queries mcp_tool_errors_total — a metric that is NEVER emitted', async () => {
    /*
     * The bug that motivated the shared catalog. dorinda-api records errors as
     * mcp_tool_calls_total{outcome="error"}; there is no mcp_tool_errors_total, and enumerating
     * __name__ in Managed Prometheus on 2026-08-02 confirmed it. Both Grafana and the console used
     * to query that name — Grafana via a regex that matched nothing silently, the console directly —
     * so error rate read as zero on two surfaces at once, with nothing to compare against.
     */
    const { readFile } = await import('node:fs/promises');
    const path = new URL('../../dorinda-metrics/dashboards/dorinda-product-topline.json', import.meta.url).pathname;
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (!raw) return; // dorinda-metrics not checked out beside forge — skip rather than fail.
    // Assert against the QUERIES, not the file. A panel description explains this very bug and names
    // the metric; matching raw text flagged that prose and would have pressured the explanation to
    // get vaguer to satisfy a test. Same lesson as the docs boundary check.
    const dash = JSON.parse(raw) as { panels: Array<{ title: string; targets: Array<{ expr: string }> }> };
    const exprs = dash.panels.flatMap((p) => p.targets.map((t) => t.expr));
    expect(exprs.length).toBeGreaterThan(4);
    for (const e of exprs) expect(e, `panel query uses a metric that is never emitted: ${e}`).not.toContain('mcp_tool_errors');
    expect(exprs.some((e) => e.includes('outcome="error"'))).toBe(true);
  });

  it('carries a heartbeat panel — without it every other panel can lie', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = new URL('../../dorinda-metrics/dashboards/dorinda-product-topline.json', import.meta.url).pathname;
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (!raw) return;
    // A dead pipeline makes "no traffic" and "no telemetry" identical. Absence must mean BROKEN,
    // which only a heartbeat can express — an event-driven metric cannot.
    const dash = JSON.parse(raw) as { panels: Array<{ targets: Array<{ expr: string }> }> };
    const exprs = dash.panels.flatMap((p) => p.targets.map((t) => t.expr));
    expect(exprs.some((e) => e.includes('pipeline_heartbeat_total'))).toBe(true);
  });
});
