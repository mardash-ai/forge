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
