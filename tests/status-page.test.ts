import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { store } from '../src/storage/store';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';
import { registerStatusRoutes, computeStatus } from '../src/api/status-routes';
import type { HealthProbeResult } from '../src/shared/health-probe';
import { uptimeStore } from '../src/storage/uptime-store';
import type { SnapshotComponent } from '../src/shared/uptime';

// C15 — the public status page. computeStatus() (the banner/aggregation logic) is
// unit-tested directly; the /status + /status.json routes are driven through Fastify
// against a THROWAWAY in-process health server (no Docker, no sibling).

const APP = 'demo';

describe('C15 computeStatus — banner + component aggregation', () => {
  const opts = { appName: APP, planeLabel: 'Forge data plane', now: new Date('2026-01-01T00:00:00Z') };

  it('all checks ok → All Systems Operational', () => {
    const probe: HealthProbeResult = {
      url: 'x', reachable: true, httpStatus: 200, conforms: true,
      health: { status: 'ok', service: APP, time: 'x', checks: [{ name: 'db', status: 'ok' }] },
    };
    const r = computeStatus(probe, opts);
    expect(r.overall).toBe('operational');
    expect(r.banner).toBe('All Systems Operational');
    // web + db + platform plane rows
    expect(r.components.map((c) => c.name)).toEqual([`${APP} (web)`, 'db', 'Forge data plane']);
    expect(r.components.every((c) => c.state === 'operational')).toBe(true);
  });

  it('a non-required check down (C6 degraded) → Degraded Performance', () => {
    const probe: HealthProbeResult = {
      url: 'x', reachable: true, httpStatus: 200, conforms: true,
      health: { status: 'degraded', service: APP, time: 'x', checks: [{ name: 'cache', status: 'unavailable', detail: 'timeout' }] },
    };
    const r = computeStatus(probe, opts);
    expect(r.overall).toBe('degraded');
    expect(r.banner).toBe('Degraded Performance');
    expect(r.components.find((c) => c.name === 'cache')).toMatchObject({ state: 'down', detail: 'timeout' });
  });

  it('a required check down among several → Partial Outage', () => {
    const probe: HealthProbeResult = {
      url: 'x', reachable: true, httpStatus: 503, conforms: true,
      health: { status: 'unavailable', service: APP, time: 'x', checks: [{ name: 'db', status: 'unavailable' }, { name: 'cache', status: 'ok' }] },
    };
    expect(computeStatus(probe, opts).overall).toBe('partial_outage');
  });

  it('every check down → Major Outage', () => {
    const probe: HealthProbeResult = {
      url: 'x', reachable: true, httpStatus: 503, conforms: true,
      health: { status: 'unavailable', service: APP, time: 'x', checks: [{ name: 'db', status: 'unavailable' }] },
    };
    expect(computeStatus(probe, opts).overall).toBe('major_outage');
  });

  it('unreachable app → Major Outage with web down', () => {
    const r = computeStatus({ url: 'x', reachable: false, error: 'ECONNREFUSED' }, opts);
    expect(r.overall).toBe('major_outage');
    expect(r.components[0]).toMatchObject({ name: `${APP} (web)`, state: 'down' });
  });

  it('non-conforming health → Degraded with an unknown web state', () => {
    const r = computeStatus({ url: 'x', reachable: true, httpStatus: 200, conforms: false, parseError: 'bad' }, opts);
    expect(r.overall).toBe('degraded');
    expect(r.components[0]).toMatchObject({ name: `${APP} (web)`, state: 'unknown' });
  });

  it('always appends the serving platform plane as an operational component', () => {
    const r = computeStatus({ url: 'x', reachable: false, error: 'x' }, opts);
    expect(r.components.at(-1)).toMatchObject({ name: 'Forge data plane', state: 'operational' });
  });
});

// ---- route-level, with a live health server ---------------------------------

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
    id: `app_${APP}`, type: 'Application', app_id: `app_${APP}`, created_at: now, updated_at: now,
    name: APP, repo_path: repo, platform: 'web', framework: 'nextjs', template: 'nextjs-web',
    language: 'typescript', package_manager: 'npm',
  };
  await store.saveResource(app);
  await writeFile(path.join(repo, 'forge.app.json'), JSON.stringify({ port: 3000 }, null, 2));
}

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  prevHost = process.env.FORGE_APP_CALLBACK_HOST;
  prevPort = process.env.FORGE_APP_CALLBACK_PORT;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-status-'));
  repo = await mkdtemp(path.join(tmpdir(), 'forge-status-repo-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_APP_CALLBACK_HOST = '127.0.0.1';
  await store.init();
  server = Fastify({ logger: false });
  registerStatusRoutes(server, { defaultApp: () => APP, planeLabel: 'Forge data plane' });
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

describe('C15 /status route (public, no auth, live C6)', () => {
  it('renders a themed operational dashboard from a healthy app', async () => {
    const port = await startHealth(200, { status: 'ok', service: APP, time: nowIso(), checks: [{ name: 'db', status: 'ok' }] });
    process.env.FORGE_APP_CALLBACK_PORT = String(port);
    await seedApp();

    const res = await server.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('All Systems Operational');
    expect(res.body).toContain('db');
    // themed: the --forge-* tokens are inlined
    expect(res.body).toContain('--forge-color-success');
    expect(res.body).toContain('color-scheme:light dark');
  });

  it('banner degrades when a health check is forced to fail', async () => {
    const port = await startHealth(503, {
      status: 'unavailable', service: APP, time: nowIso(),
      checks: [{ name: 'db', status: 'unavailable', detail: 'ECONNREFUSED' }],
    });
    process.env.FORGE_APP_CALLBACK_PORT = String(port);
    await seedApp();

    const json = await server.inject({ method: 'GET', url: '/status.json' });
    expect(json.statusCode).toBe(200);
    const body = json.json();
    expect(body.overall).toBe('major_outage');
    expect(body.app).toBe(APP);
    expect(body.components.find((c: { name: string }) => c.name === 'db')).toMatchObject({ state: 'down' });

    const html = await server.inject({ method: 'GET', url: '/status' });
    expect(html.body).toContain('Major Outage');
  });

  it('reports Major Outage (web down) when the app is unreachable', async () => {
    process.env.FORGE_APP_CALLBACK_PORT = '1'; // closed port
    await seedApp();
    const res = await server.inject({ method: 'GET', url: '/status' });
    expect(res.statusCode).toBe(200); // the status PAGE is up even if the app is down
    expect(res.body).toContain('Major Outage');
  });

  it('/status.json is 404 for an unknown app', async () => {
    // no seeded app, and clear the default so resolution fails
    server = Fastify({ logger: false });
    registerStatusRoutes(server, { planeLabel: 'Forge control plane' });
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/status.json' });
    expect(res.statusCode).toBe(404);
  });
});

// ---- Phase 2 (uptime history) ------------------------------------------------

describe('C15 Phase 2 — uptime history on /status(.json)', () => {
  const liveComps: SnapshotComponent[] = [
    { name: `${APP} (web)`, state: 'operational' },
    { name: 'db', state: 'operational' },
    { name: 'Forge data plane', state: 'operational' },
  ];

  it('/status.json gains an additive uptime section; Phase-1 fields are unchanged', async () => {
    const port = await startHealth(200, { status: 'ok', service: APP, time: nowIso(), checks: [{ name: 'db', status: 'ok' }] });
    process.env.FORGE_APP_CALLBACK_PORT = String(port);
    await seedApp();

    const body = (await server.inject({ method: 'GET', url: '/status.json' })).json();
    // Phase-1 shape intact (additive only).
    expect(body).toMatchObject({ app: APP, overall: 'operational', banner: 'All Systems Operational' });
    expect(Array.isArray(body.components)).toBe(true);
    expect(typeof body.checked_at).toBe('string');
    // No sampling yet → an empty, "collecting" uptime section.
    expect(body.uptime).toMatchObject({ sampling: false, window_days: 90 });
    expect(body.uptime.overall_uptime_pct).toBeNull();
    expect(body.uptime.components).toEqual([]);
  });

  it('the live page (no history) is byte-for-byte the Phase-1 page — no timeline markup', async () => {
    const port = await startHealth(200, { status: 'ok', service: APP, time: nowIso(), checks: [{ name: 'db', status: 'ok' }] });
    process.env.FORGE_APP_CALLBACK_PORT = String(port);
    await seedApp();
    const html = (await server.inject({ method: 'GET', url: '/status' })).body;
    expect(html).toContain('All Systems Operational');
    expect(html).not.toContain('class="tick"'); // no bars until sampling runs
  });

  it('renders a themed per-component uptime timeline once history exists', async () => {
    const port = await startHealth(200, { status: 'ok', service: APP, time: nowIso(), checks: [{ name: 'db', status: 'ok' }] });
    process.env.FORGE_APP_CALLBACK_PORT = String(port);
    await seedApp();
    // Two samples today for the live components (shares the temp state dir).
    await uptimeStore.record(`app_${APP}`, { at: nowIso(), overall: 'operational', components: liveComps });
    await uptimeStore.record(`app_${APP}`, { at: nowIso(), overall: 'operational', components: liveComps });

    const json = (await server.inject({ method: 'GET', url: '/status.json' })).json();
    expect(json.uptime.sampling).toBe(true);
    expect(json.uptime.overall_uptime_pct).toBe(100);
    // Ordered to match the live components (web first).
    expect(json.uptime.components[0].name).toBe(`${APP} (web)`);
    const web = json.uptime.components.find((c: { name: string }) => c.name === `${APP} (web)`);
    expect(web.uptime_pct).toBe(100);
    expect(web.days.length).toBe(90);
    expect(web.days.at(-1)).toMatchObject({ state: 'operational' });
    expect(web.days.at(-1).uptime_pct).toBe(100);

    const html = (await server.inject({ method: 'GET', url: '/status' })).body;
    expect(html).toContain('class="tick"'); // the per-day bar
    expect(html).toContain('% uptime'); // the windowed uptime label
    expect(html).toContain('--forge-color-success'); // themed tick colour
  });
});
