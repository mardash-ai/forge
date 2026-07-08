import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { store } from '../src/storage/store';
import { uptimeStore } from '../src/storage/uptime-store';
import { nowIso } from '../src/shared/time';
import { uptimeRawFile } from '../src/shared/paths';
import type { Application } from '../src/resources/types';
import type { HealthSnapshot } from '../src/shared/uptime';
import {
  sampleApp,
  sampleAll,
  startHealthSampler,
  isSamplingEnabled,
  sampleIntervalMs,
} from '../src/plugins/scheduler-node/health-sampler';

// C15 Phase 2 — the health sampler (a C2 periodic probe) + the durable uptime store's
// record/retention path, driven against a THROWAWAY in-process health server.

const APP = 'demo';
const APP_ID = `app_${APP}`;

let dir: string;
let repo: string;
let health: http.Server | undefined;
const saved: Record<string, string | undefined> = {};

function snapshot(at: string): HealthSnapshot {
  return { at, overall: 'operational', components: [{ name: `${APP} (web)`, state: 'operational' }] };
}

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

async function seedApp(): Promise<Application> {
  const now = nowIso();
  const app: Application = {
    id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
    name: APP, repo_path: repo, platform: 'web', framework: 'nextjs', template: 'nextjs-web',
    language: 'typescript', package_manager: 'npm',
  };
  await store.saveResource(app);
  await writeFile(path.join(repo, 'forge.app.json'), JSON.stringify({ port: 3000 }, null, 2));
  return app;
}

beforeEach(async () => {
  for (const k of ['FORGE_STATE_DIR', 'FORGE_APP_CALLBACK_HOST', 'FORGE_APP_CALLBACK_PORT', 'FORGE_STATUS_SAMPLE', 'FORGE_STATUS_SAMPLE_INTERVAL']) {
    saved[k] = process.env[k];
  }
  dir = await mkdtemp(path.join(tmpdir(), 'forge-sampler-'));
  repo = await mkdtemp(path.join(tmpdir(), 'forge-sampler-repo-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_APP_CALLBACK_HOST = '127.0.0.1';
  delete process.env.FORGE_STATUS_SAMPLE;
  delete process.env.FORGE_STATUS_SAMPLE_INTERVAL;
  await store.init();
});

afterEach(async () => {
  if (health) await new Promise<void>((r) => health!.close(() => r()));
  health = undefined;
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  await rm(dir, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe('sampleApp — reuses probeHealth + computeStatus, records a snapshot', () => {
  it('records an operational snapshot from a healthy app', async () => {
    const port = await startHealth(200, { status: 'ok', service: APP, time: nowIso(), checks: [{ name: 'db', status: 'ok' }] });
    process.env.FORGE_APP_CALLBACK_PORT = String(port);
    const app = await seedApp();

    const snap = await sampleApp(store, app, { planeLabel: 'Forge data plane' });
    expect(snap.overall).toBe('operational');
    expect(snap.components.map((c) => c.name)).toEqual([`${APP} (web)`, 'db', 'Forge data plane']);

    const h = await uptimeStore.getHistory(APP_ID, { windowDays: 90 });
    expect(h.sample_count).toBe(1);
    const web = h.components.find((c) => c.name === `${APP} (web)`)!;
    expect(web.uptime_pct).toBe(100);
    expect(web.days.at(-1)!.state).toBe('operational'); // today
    expect(h.components.find((c) => c.name === 'db')!.days.at(-1)!.state).toBe('operational');
  });

  it('records the outage (web down) when the app is unreachable — never throws', async () => {
    process.env.FORGE_APP_CALLBACK_PORT = '1'; // closed port
    const app = await seedApp();
    const snap = await sampleApp(store, app, { planeLabel: 'Forge data plane' });
    expect(snap.overall).toBe('major_outage');
    const h = await uptimeStore.getHistory(APP_ID, { windowDays: 90 });
    expect(h.components.find((c) => c.name === `${APP} (web)`)!.days.at(-1)!.state).toBe('down');
  });

  it('sampleAll samples every known Application', async () => {
    const port = await startHealth(200, { status: 'ok', service: APP, time: nowIso(), checks: [] });
    process.env.FORGE_APP_CALLBACK_PORT = String(port);
    await seedApp();
    await sampleAll(store, { planeLabel: 'Forge data plane' });
    expect((await uptimeStore.getHistory(APP_ID, { windowDays: 90 })).sample_count).toBe(1);
  });
});

describe('sampler enablement (opt-in, safe by default)', () => {
  it('is disabled unless FORGE_STATUS_SAMPLE is truthy; startHealthSampler is then a no-op', () => {
    expect(isSamplingEnabled()).toBe(false);
    const stop = startHealthSampler(store, { planeLabel: 'Forge data plane' });
    expect(typeof stop).toBe('function');
    stop(); // no throw
    process.env.FORGE_STATUS_SAMPLE = '1';
    expect(isSamplingEnabled()).toBe(true);
    const stop2 = startHealthSampler(store, { planeLabel: 'Forge data plane', intervalMs: 3_600_000 });
    stop2();
  });

  it('interval defaults to 5m and floors fast values at 30s', () => {
    expect(sampleIntervalMs()).toBe(300_000);
    process.env.FORGE_STATUS_SAMPLE_INTERVAL = '1m';
    expect(sampleIntervalMs()).toBe(60_000);
    process.env.FORGE_STATUS_SAMPLE_INTERVAL = '5s'; // below the floor
    expect(sampleIntervalMs()).toBe(30_000);
    process.env.FORGE_STATUS_SAMPLE_INTERVAL = 'garbage';
    expect(sampleIntervalMs()).toBe(300_000); // falls back to default
  });
});

describe('uptime store — record folds + prunes so storage stays bounded', () => {
  it('keeps only the raw window on disk and rolls older days up', async () => {
    // Record across three days (each record prunes relative to its own timestamp).
    await uptimeStore.record(APP_ID, snapshot('2026-07-03T00:00:00.000Z')); // -5d
    await uptimeStore.record(APP_ID, snapshot('2026-07-07T00:00:00.000Z')); // -1d
    await uptimeStore.record(APP_ID, snapshot('2026-07-08T00:00:00.000Z')); // today

    // Raw file holds only the last 2 days (window); the old day was folded away.
    const rawLines = (await readFile(uptimeRawFile(APP_ID), 'utf8')).trim().split('\n').filter(Boolean);
    expect(rawLines.length).toBe(2);
    expect(rawLines.map((l) => (JSON.parse(l) as HealthSnapshot).at.slice(0, 10)).sort()).toEqual(['2026-07-07', '2026-07-08']);

    // History (as of that "today") still shows all three days — the old one from the rollup.
    const h = await uptimeStore.getHistory(APP_ID, { windowDays: 90, now: new Date('2026-07-08T12:00:00.000Z') });
    const web = h.components.find((c) => c.name === `${APP} (web)`)!;
    const byDate = new Map(web.days.map((d) => [d.date, d.state]));
    expect(byDate.get('2026-07-03')).toBe('operational'); // rolled up
    expect(byDate.get('2026-07-07')).toBe('operational'); // raw
    expect(byDate.get('2026-07-08')).toBe('operational'); // raw
    expect(web.uptime_pct).toBe(100);
  });
});
