import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { store } from '../src/storage/store';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';
import { registerStatusRoutes, statusPageHtml, computeStatus } from '../src/api/status-routes';
import { registerIncidentRoutes } from '../src/api/incident-routes';
import { incidentStore } from '../src/storage/incident-store';
import { DEFAULT_THEME } from '../src/shared/theme';
import type { HealthProbeResult } from '../src/shared/health-probe';
import type { HistoryReport } from '../src/shared/uptime';
import {
  createIncident,
  appendUpdate,
  resolveIncident,
  pruneIncidents,
  incidentOverallFloor,
  applyIncidentFloor,
  incidentsJson,
  orderActive,
  orderResolved,
  type Incident,
} from '../src/incidents/types';

// C15 Phase 3 — operator-declared incidents. The PURE lifecycle/retention/precedence
// (incidents/types.ts) is unit-tested directly; the operator routes + the public
// /status rendering are driven through Fastify against a throwaway health server.

const APP = 'demo';
const APP_ID = `app_${APP}`;

// ============================================================================
// PURE — lifecycle / retention / banner precedence / json
// ============================================================================

describe('C15 Phase 3 — incident lifecycle (pure)', () => {
  const t0 = new Date('2026-03-01T00:00:00Z');
  const t1 = new Date('2026-03-01T01:00:00Z');
  const t2 = new Date('2026-03-01T02:00:00Z');

  it('create seeds the first timeline entry and stamps created_at', () => {
    const inc = createIncident('inc_1', { title: 'DB slow', status: 'investigating', impact: 'major', body: 'looking' }, t0);
    expect(inc).toMatchObject({ id: 'inc_1', title: 'DB slow', status: 'investigating', impact: 'major', created_at: t0.toISOString() });
    expect(inc.resolved_at).toBeUndefined();
    expect(inc.updates).toEqual([{ timestamp: t0.toISOString(), status: 'investigating', body: 'looking' }]);
    expect(inc.affected_components).toEqual([]);
  });

  it('create → update → resolve moves status, appends updates, stamps resolved_at once', () => {
    const a = createIncident('inc_1', { title: 'DB slow', status: 'investigating', impact: 'major' }, t0);
    const b = appendUpdate(a, { status: 'identified', body: 'bad query' }, t1);
    expect(b.status).toBe('identified');
    expect(b.updates).toHaveLength(2);
    expect(a.updates).toHaveLength(1); // input not mutated
    expect(b.resolved_at).toBeUndefined();

    const c = resolveIncident(b, { body: 'fixed the query' }, t2);
    expect(c.status).toBe('resolved');
    expect(c.resolved_at).toBe(t2.toISOString());
    expect(c.updates).toHaveLength(3);
    expect(c.updates.at(-1)).toEqual({ timestamp: t2.toISOString(), status: 'resolved', body: 'fixed the query' });

    // resolving again keeps the ORIGINAL resolved_at
    const d = resolveIncident(c, {}, new Date('2026-03-02T00:00:00Z'));
    expect(d.resolved_at).toBe(t2.toISOString());
  });

  it('resolve with no body records a default note', () => {
    const a = createIncident('inc_1', { title: 'x', status: 'monitoring', impact: 'minor' }, t0);
    const b = resolveIncident(a, {}, t1);
    expect(b.updates.at(-1)).toMatchObject({ status: 'resolved', body: 'Resolved.' });
  });

  it('creating directly as resolved stamps resolved_at immediately', () => {
    const inc = createIncident('inc_1', { title: 'backfill', status: 'resolved', impact: 'none' }, t0);
    expect(inc.status).toBe('resolved');
    expect(inc.resolved_at).toBe(t0.toISOString());
  });
});

describe('C15 Phase 3 — retention (pure)', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const mk = (id: string, status: Incident['status'], resolvedDaysAgo?: number): Incident => {
    const resolved_at = resolvedDaysAgo === undefined ? undefined : new Date(now.getTime() - resolvedDaysAgo * 86_400_000).toISOString();
    return { id, title: id, status, impact: 'minor', affected_components: [], updates: [], created_at: '2026-01-01T00:00:00Z', ...(resolved_at ? { resolved_at } : {}) };
  };

  it('keeps every active incident and drops resolved ones past the window', () => {
    const kept = pruneIncidents([mk('a', 'investigating'), mk('r_recent', 'resolved', 10), mk('r_old', 'resolved', 200)], { now });
    const ids = kept.map((i) => i.id).sort();
    expect(ids).toEqual(['a', 'r_recent']);
  });

  it('caps the resolved history to the most-recent N', () => {
    const resolved = Array.from({ length: 60 }, (_, i) => mk(`r${i}`, 'resolved', i)); // resolved i days ago (0 newest)
    const kept = pruneIncidents([mk('a', 'monitoring'), ...resolved], { now, maxResolved: 50 });
    const resolvedKept = kept.filter((i) => i.status === 'resolved');
    expect(resolvedKept).toHaveLength(50);
    // the 10 oldest (r50..r59) are dropped; r0 (newest) is kept
    expect(kept.find((i) => i.id === 'r0')).toBeTruthy();
    expect(kept.find((i) => i.id === 'r59')).toBeFalsy();
    expect(kept.find((i) => i.id === 'a')).toBeTruthy();
  });
});

describe('C15 Phase 3 — banner precedence (pure)', () => {
  const okProbe: HealthProbeResult = {
    url: 'x', reachable: true, httpStatus: 200, conforms: true,
    health: { status: 'ok', service: APP, time: 'x', checks: [{ name: 'db', status: 'ok' }] },
  };
  const now = new Date('2026-03-01T00:00:00Z');
  const report = () => computeStatus(okProbe, { appName: APP, planeLabel: 'Forge data plane', now });
  const inc = (impact: Incident['impact'], status: Incident['status'] = 'investigating'): Incident =>
    createIncident('i', { title: 't', status, impact }, now);

  it('an unresolved critical forces at least Major Outage even when probes are green', () => {
    expect(report().overall).toBe('operational');
    const floored = applyIncidentFloor(report(), [inc('critical')]);
    expect(floored.overall).toBe('major_outage');
    expect(floored.banner).toBe('Major Outage');
  });

  it('major → partial_outage, minor → degraded, none → no floor', () => {
    expect(applyIncidentFloor(report(), [inc('major')]).overall).toBe('partial_outage');
    expect(applyIncidentFloor(report(), [inc('minor')]).overall).toBe('degraded');
    expect(applyIncidentFloor(report(), [inc('none')]).overall).toBe('operational');
  });

  it('the floor only elevates — a declared minor never improves a real major outage', () => {
    const downProbe: HealthProbeResult = { url: 'x', reachable: false, error: 'ECONNREFUSED' };
    const downReport = computeStatus(downProbe, { appName: APP, planeLabel: 'Forge data plane', now });
    expect(downReport.overall).toBe('major_outage');
    expect(applyIncidentFloor(downReport, [inc('minor')]).overall).toBe('major_outage');
  });

  it('a resolved incident imposes no floor (banner recovers, report untouched)', () => {
    const resolved = resolveIncident(inc('critical'), {}, now);
    expect(incidentOverallFloor([resolved])).toBeNull();
    const r = report();
    // No floor ⇒ the SAME report object is returned (proves the no-op path).
    expect(applyIncidentFloor(r, [resolved])).toBe(r);
    expect(applyIncidentFloor(r, [resolved]).overall).toBe('operational');
  });

  it('takes the strongest floor across several active incidents', () => {
    expect(incidentOverallFloor([inc('minor'), inc('critical'), inc('major')])).toBe('major_outage');
  });
});

describe('C15 Phase 3 — /status.json incident shaping (pure)', () => {
  const now = new Date('2026-03-01T00:00:00Z');
  it('orders active (newest-first) then recent-resolved, and nulls resolved_at while active', () => {
    const a1 = createIncident('a1', { title: 'a1', status: 'investigating', impact: 'major' }, new Date('2026-03-01T00:00:00Z'));
    const a2 = createIncident('a2', { title: 'a2', status: 'identified', impact: 'minor' }, new Date('2026-03-01T05:00:00Z'));
    const r1 = resolveIncident(createIncident('r1', { title: 'r1', status: 'investigating', impact: 'minor' }, now), {}, new Date('2026-03-02T00:00:00Z'));
    const json = incidentsJson([a1, r1, a2]);
    expect(json.map((i) => i.id)).toEqual(['a2', 'a1', 'r1']); // a2 newer active, then a1, then resolved
    expect(json[0]!.resolved_at).toBeNull();
    expect(json[2]!.resolved_at).toBe('2026-03-02T00:00:00.000Z');
    expect(json[0]).toHaveProperty('updates');
    expect(json[0]).toHaveProperty('affected_components');
  });
});

// ============================================================================
// STORE — file-backed roundtrip + retention on write
// ============================================================================

describe('C15 Phase 3 — incident store (file-backed)', () => {
  let dir: string;
  let prevState: string | undefined;
  beforeEach(async () => {
    prevState = process.env.FORGE_STATE_DIR;
    dir = await mkdtemp(path.join(tmpdir(), 'forge-inc-'));
    process.env.FORGE_STATE_DIR = dir;
    await store.init();
  });
  afterEach(async () => {
    if (prevState === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prevState;
    await rm(dir, { recursive: true, force: true });
  });

  it('create → update → resolve roundtrips and list reflects it', async () => {
    const created = await incidentStore.create(APP_ID, { title: 'DB slow', status: 'investigating', impact: 'major', affected_components: ['db'] });
    expect(created.id).toMatch(/^inc_/);
    expect(created.affected_components).toEqual(['db']);
    const updated = await incidentStore.update(APP_ID, created.id, { status: 'identified', body: 'bad query' });
    expect(updated?.status).toBe('identified');
    const resolved = await incidentStore.resolve(APP_ID, created.id, { body: 'done' });
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolved_at).toBeTruthy();
    const list = await incidentStore.list(APP_ID);
    expect(list).toHaveLength(1);
    expect(list[0]!.updates).toHaveLength(3);
  });

  it('update/resolve of a missing incident returns null', async () => {
    expect(await incidentStore.update(APP_ID, 'inc_nope', { status: 'monitoring' })).toBeNull();
    expect(await incidentStore.resolve(APP_ID, 'inc_nope', {})).toBeNull();
  });

  it('prunes an old resolved incident on the next write', async () => {
    const longAgo = new Date('2025-01-01T00:00:00Z'); // ~1.5 years before the fresh write
    const old = await incidentStore.create(APP_ID, { title: 'old', status: 'investigating', impact: 'minor' }, longAgo);
    await incidentStore.resolve(APP_ID, old.id, { body: 'done' }, longAgo);
    expect(await incidentStore.list(APP_ID)).toHaveLength(1); // still there (its own writes don't prune it — it was current then)

    // a fresh write with a much-later clock prunes the now-stale resolved incident
    await incidentStore.create(APP_ID, { title: 'live', status: 'investigating', impact: 'none' }, new Date());
    const list = await incidentStore.list(APP_ID);
    expect(list.map((i) => i.title).sort()).toEqual(['live']);
  });
});

// ============================================================================
// ROUTES — operator surface + public /status rendering
// ============================================================================

let dir: string;
let repo: string;
let server: FastifyInstance;
let health: http.Server | undefined;
let prevState: string | undefined;
let prevHost: string | undefined;
let prevPort: string | undefined;

async function startHealth(status: number, body: unknown): Promise<number> {
  health = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => health!.listen(0, '127.0.0.1', r));
  return (health!.address() as AddressInfo).port;
}

async function seedApp(): Promise<void> {
  const now = nowIso();
  const app: Application = {
    id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
    name: APP, repo_path: repo, platform: 'web', framework: 'nextjs', template: 'nextjs-web',
    language: 'typescript', package_manager: 'npm',
  };
  await store.saveResource(app);
  await writeFile(path.join(repo, 'forge.app.json'), JSON.stringify({ port: 3000 }, null, 2));
}

async function healthyApp(): Promise<void> {
  const port = await startHealth(200, { status: 'ok', service: APP, time: nowIso(), checks: [{ name: 'db', status: 'ok' }] });
  process.env.FORGE_APP_CALLBACK_PORT = String(port);
  await seedApp();
}

describe('C15 Phase 3 — incident routes + public rendering', () => {
  beforeEach(async () => {
    prevState = process.env.FORGE_STATE_DIR;
    prevHost = process.env.FORGE_APP_CALLBACK_HOST;
    prevPort = process.env.FORGE_APP_CALLBACK_PORT;
    dir = await mkdtemp(path.join(tmpdir(), 'forge-inc-routes-'));
    repo = await mkdtemp(path.join(tmpdir(), 'forge-inc-repo-'));
    process.env.FORGE_STATE_DIR = dir;
    process.env.FORGE_APP_CALLBACK_HOST = '127.0.0.1';
    await store.init();
    server = Fastify({ logger: false });
    registerStatusRoutes(server, { defaultApp: () => APP, planeLabel: 'Forge data plane' });
    registerIncidentRoutes(server, { defaultApp: () => APP });
    await server.ready();
  });
  afterEach(async () => {
    await server.close();
    if (health) await new Promise<void>((r) => health!.close(() => r()));
    health = undefined;
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('FORGE_STATE_DIR', prevState);
    restore('FORGE_APP_CALLBACK_HOST', prevHost);
    restore('FORGE_APP_CALLBACK_PORT', prevPort);
    await rm(dir, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  it('create → list → /status.json gains incidents + floors the banner; /status shows the section', async () => {
    await healthyApp();

    // baseline: green, no incidents
    const before = (await server.inject({ method: 'GET', url: '/status.json' })).json();
    expect(before.overall).toBe('operational');
    expect(before.incidents).toEqual([]);

    // declare a critical incident (public, no cookie needed)
    const created = await server.inject({
      method: 'POST', url: '/status/incidents',
      payload: { title: 'Checkout down', status: 'investigating', impact: 'critical', components: ['db'], body: 'Investigating elevated errors.' },
    });
    expect(created.statusCode).toBe(200);
    const inc = created.json().incident;
    expect(inc.id).toMatch(/^inc_/);
    expect(inc.resolved_at).toBeNull();

    // list shows it
    const list = (await server.inject({ method: 'GET', url: '/status/incidents' })).json();
    expect(list.incidents).toHaveLength(1);
    expect(list.incidents[0].title).toBe('Checkout down');

    // /status.json: additive incidents + banner floored to major_outage despite green probes
    const json = (await server.inject({ method: 'GET', url: '/status.json' })).json();
    expect(json.overall).toBe('major_outage');
    expect(json.banner).toBe('Major Outage');
    expect(json.incidents).toHaveLength(1);
    expect(json.incidents[0]).toMatchObject({ title: 'Checkout down', status: 'investigating', impact: 'critical', affected_components: ['db'] });
    // Phase-1/2 fields still present
    expect(json.components.find((c: { name: string }) => c.name === 'db')).toBeTruthy();
    expect(json.uptime).toBeTruthy();

    // /status HTML: Active Incidents section, themed incident style, escaped content
    const html = (await server.inject({ method: 'GET', url: '/status' })).body;
    expect(html).toContain('Active Incidents');
    expect(html).toContain('forge-incidents');
    expect(html).toContain('Checkout down');
    expect(html).toContain('Major Outage');
  });

  it('resolve moves the incident to history and the banner recovers', async () => {
    await healthyApp();
    const created = (await server.inject({
      method: 'POST', url: '/status/incidents',
      payload: { title: 'API errors', status: 'investigating', impact: 'major' },
    })).json().incident;

    // update then resolve
    const upd = await server.inject({ method: 'POST', url: '/status/incidents/update', payload: { id: created.id, status: 'monitoring', body: 'mitigation in place' } });
    expect(upd.json().incident.status).toBe('monitoring');

    const res = await server.inject({ method: 'POST', url: '/status/incidents/resolve', payload: { id: created.id, body: 'all clear' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().incident.status).toBe('resolved');
    expect(res.json().incident.resolved_at).toBeTruthy();

    // banner recovered; incident now in history disclosure, still in the incidents array
    const json = (await server.inject({ method: 'GET', url: '/status.json' })).json();
    expect(json.overall).toBe('operational');
    expect(json.incidents).toHaveLength(1);
    expect(json.incidents[0].status).toBe('resolved');

    const html = (await server.inject({ method: 'GET', url: '/status' })).body;
    expect(html).toContain('Past incidents');
    expect(html).not.toContain('Active Incidents');
  });

  it('with NO incidents, /status is byte-identical to the Phase-2 render', async () => {
    await healthyApp();
    // the route render with no incidents…
    const routeHtml = (await server.inject({ method: 'GET', url: '/status' })).body;
    expect(routeHtml).not.toContain('forge-incidents');
    expect(routeHtml).not.toContain('Active Incidents');
    expect(routeHtml).not.toContain('class="inc"');
    expect(routeHtml).not.toContain('Past incidents');

    // …equals the pure renderer called with the Phase-2 signature (4 args) AND with an
    // explicit empty incidents list (5 args) — so the incidents param, when empty, is a
    // no-op on the output.
    const probe: HealthProbeResult = {
      url: 'x', reachable: true, httpStatus: 200, conforms: true,
      health: { status: 'ok', service: APP, time: 'x', checks: [{ name: 'db', status: 'ok' }] },
    };
    const report = computeStatus(probe, { appName: APP, planeLabel: 'Forge data plane', now: new Date('2026-01-01T00:00:00Z') });
    const history: HistoryReport = { window_days: 90, overall_uptime_pct: null, sample_count: 0, components: [] };
    const phase2 = statusPageHtml(DEFAULT_THEME, APP, report, history);
    const explicitEmpty = statusPageHtml(DEFAULT_THEME, APP, report, history, []);
    expect(explicitEmpty).toBe(phase2);
    // and adding an incident DOES change the output (guards against a dead code path)
    const withInc = statusPageHtml(DEFAULT_THEME, APP, report, history, [createIncident('inc_x', { title: 'X', status: 'investigating', impact: 'major' }, new Date())]);
    expect(withInc).not.toBe(phase2);
    expect(withInc).toContain('Active Incidents');
  });

  it('emits IncidentOpened / IncidentUpdated / IncidentResolved facts', async () => {
    await healthyApp();
    const created = (await server.inject({
      method: 'POST', url: '/status/incidents',
      payload: { title: 'Cache cold', status: 'investigating', impact: 'minor' },
    })).json().incident;
    await server.inject({ method: 'POST', url: '/status/incidents/update', payload: { id: created.id, status: 'identified', body: 'x' } });
    await server.inject({ method: 'POST', url: '/status/incidents/resolve', payload: { id: created.id } });

    const events = await store.listEvents({ app_id: APP_ID, limit: 50 });
    const types = events.map((e) => e.type);
    expect(types).toContain('IncidentOpened');
    expect(types).toContain('IncidentUpdated');
    expect(types).toContain('IncidentResolved');
    const opened = events.find((e) => e.type === 'IncidentOpened');
    expect(opened).toMatchObject({ resource_type: 'Incident', resource_id: created.id, app_id: APP_ID });
  });

  it('an update whose status is resolved emits IncidentResolved (not IncidentUpdated)', async () => {
    await healthyApp();
    const created = (await server.inject({
      method: 'POST', url: '/status/incidents',
      payload: { title: 'quick blip', status: 'investigating', impact: 'minor' },
    })).json().incident;
    await server.inject({ method: 'POST', url: '/status/incidents/update', payload: { id: created.id, status: 'resolved', body: 'over' } });
    const json = (await server.inject({ method: 'GET', url: '/status.json' })).json();
    expect(json.incidents[0].status).toBe('resolved');
    const events = await store.listEvents({ app_id: APP_ID, limit: 50 });
    expect(events.map((e) => e.type)).toContain('IncidentResolved');
  });

  it('validates input and unknown ids/apps', async () => {
    await healthyApp();
    // bad status
    expect((await server.inject({ method: 'POST', url: '/status/incidents', payload: { title: 't', status: 'bogus', impact: 'minor' } })).statusCode).toBe(422);
    // bad impact
    expect((await server.inject({ method: 'POST', url: '/status/incidents', payload: { title: 't', status: 'investigating', impact: 'nope' } })).statusCode).toBe(422);
    // missing title
    expect((await server.inject({ method: 'POST', url: '/status/incidents', payload: { status: 'investigating', impact: 'minor' } })).statusCode).toBe(422);
    // unknown incident
    expect((await server.inject({ method: 'POST', url: '/status/incidents/update', payload: { id: 'inc_nope', status: 'monitoring' } })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/status/incidents/resolve', payload: { id: 'inc_nope' } })).statusCode).toBe(404);
  });

  it('unknown app → 404 on create and list', async () => {
    // no seeded app + no default
    const s2 = Fastify({ logger: false });
    registerIncidentRoutes(s2); // no defaultApp
    await s2.ready();
    expect((await s2.inject({ method: 'POST', url: '/status/incidents', payload: { title: 't', status: 'investigating', impact: 'minor' } })).statusCode).toBe(404);
    expect((await s2.inject({ method: 'GET', url: '/status/incidents' })).statusCode).toBe(404);
    await s2.close();
  });
});

// ============================================================================
// P25 — store-less box (Application store EMPTY; resolved via app/forge.app.json)
// ============================================================================
//
// The exact prod condition: a box provisioned via `forge deploy`/`productionize` (never
// `forge init app`), so the control-plane Application store is empty. Before the fix, the
// operator write path used the STRICT `findAppByName` and 404'd `not_found` even with
// FORGE_APP_NAME set. The fix switches it to the store-OPTIONAL `resolveAppLenient` (the same
// resolver `forge release` uses), inferring the app from the single-app layout + the committed
// `app/forge.app.json`. These also prove the incident store is the ONE data-plane-resident
// store: what `create` writes is exactly what a subsequent read (the same store `/status` reads)
// returns — keyed by the app name when store-less, no second store.
describe('C15 Phase 3 — P25 store-less box (empty Application store → app/forge.app.json)', () => {
  let sdir: string;
  let wdir: string;
  let server2: FastifyInstance;
  let prevState2: string | undefined;
  let prevWs: string | undefined;
  let prevLayout: string | undefined;

  beforeEach(async () => {
    prevState2 = process.env.FORGE_STATE_DIR;
    prevWs = process.env.FORGE_WORKSPACE;
    prevLayout = process.env.FORGE_APP_LAYOUT;
    sdir = await mkdtemp(path.join(tmpdir(), 'forge-p25-state-'));
    wdir = await mkdtemp(path.join(tmpdir(), 'forge-p25-ws-'));
    process.env.FORGE_STATE_DIR = sdir;
    process.env.FORGE_WORKSPACE = wdir;
    process.env.FORGE_APP_LAYOUT = 'single'; // one repo == one app, living at <ws>/app
    // The committed app manifest — the SAME file `forge deploy` reads — carries the app name.
    // No Application record is ever saved to the store (the store-less box condition).
    await mkdir(path.join(wdir, 'app'), { recursive: true });
    await writeFile(path.join(wdir, 'app', 'forge.app.json'), JSON.stringify({ name: 'forge-os' }));
    await store.init();
    server2 = Fastify({ logger: false });
    registerIncidentRoutes(server2, { defaultApp: () => process.env.FORGE_APP_NAME });
    await server2.ready();
  });
  afterEach(async () => {
    await server2.close();
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('FORGE_STATE_DIR', prevState2);
    restore('FORGE_WORKSPACE', prevWs);
    restore('FORGE_APP_LAYOUT', prevLayout);
    await rm(sdir, { recursive: true, force: true });
    await rm(wdir, { recursive: true, force: true });
  });

  it('create/list resolve an app that exists ONLY via app/forge.app.json (was not_found)', async () => {
    // the store genuinely has no Application record — the exact box condition
    expect(await store.findAppByName('forge-os')).toBeNull();

    // create — previously 404 not_found; now 200 and persisted
    const created = await server2.inject({
      method: 'POST',
      url: '/status/incidents',
      payload: { app: 'forge-os', title: 'Partner API down', status: 'investigating', impact: 'major', body: 'upstream 5xx' },
    });
    expect(created.statusCode).toBe(200);
    const inc = created.json().incident;
    expect(inc.id).toMatch(/^inc_/);
    expect(inc.title).toBe('Partner API down');

    // list resolves the SAME store-less app and shows it
    const list = (await server2.inject({ method: 'GET', url: '/status/incidents?app=forge-os' })).json();
    expect(list.incidents).toHaveLength(1);
    expect(list.incidents[0].title).toBe('Partner API down');

    // …and the write landed in the ONE incident store `/status` reads (`incidentStore.list`),
    // keyed by the app name when store-less — proving there is no separate control-plane store.
    const direct = await incidentStore.list('forge-os');
    expect(direct.map((i) => i.title)).toEqual(['Partner API down']);
  });

  it('create → resolve moves the store-less incident to resolved history', async () => {
    const inc = (await server2.inject({
      method: 'POST',
      url: '/status/incidents',
      payload: { app: 'forge-os', title: 'Cache cold', status: 'investigating', impact: 'minor' },
    })).json().incident;

    const res = await server2.inject({
      method: 'POST',
      url: '/status/incidents/resolve',
      payload: { app: 'forge-os', id: inc.id, body: 'recovered' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().incident.status).toBe('resolved');
    expect(res.json().incident.resolved_at).toBeTruthy();

    const after = (await server2.inject({ method: 'GET', url: '/status/incidents?app=forge-os' })).json();
    expect(after.incidents).toHaveLength(1);
    expect(after.incidents[0].status).toBe('resolved');
  });

  it('FORGE_APP_NAME is honored when --app is omitted (single-app operator)', async () => {
    process.env.FORGE_APP_NAME = 'forge-os';
    try {
      const created = await server2.inject({
        method: 'POST',
        url: '/status/incidents',
        payload: { title: 'No --app needed', status: 'investigating', impact: 'minor' },
      });
      expect(created.statusCode).toBe(200);
      const list = (await server2.inject({ method: 'GET', url: '/status/incidents' })).json();
      expect(list.incidents.map((i: { title: string }) => i.title)).toEqual(['No --app needed']);
    } finally {
      delete process.env.FORGE_APP_NAME;
    }
  });

  it('still 404s when NEITHER a store record NOR app/forge.app.json resolves the app', async () => {
    process.env.FORGE_APP_LAYOUT = 'multi'; // apps/<name>/forge.app.json — none exists for "ghost"
    const s3 = Fastify({ logger: false });
    registerIncidentRoutes(s3, { defaultApp: () => 'ghost' });
    await s3.ready();
    const r = await s3.inject({
      method: 'POST',
      url: '/status/incidents',
      payload: { app: 'ghost', title: 't', status: 'investigating', impact: 'minor' },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('not_found');
    expect((await s3.inject({ method: 'GET', url: '/status/incidents?app=ghost' })).statusCode).toBe(404);
    await s3.close();
  });
});
