import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { store } from '../src/storage/store';
import { executeCapability } from '../src/core/runtime';
import { SYSTEM_ACTOR } from '../src/shared/domain';
import { nowIso } from '../src/shared/time';
import type { Application, Inspection } from '../src/resources/types';

// C6 — `forge inspect health`. Drives the real Inspect Capability through the runtime
// against a THROWAWAY in-process app serving a standard /health, using a throwaway
// FORGE_STATE_DIR. No Docker, no sibling — just the contract.

let dir: string;
let repo: string;
let prevState: string | undefined;
let prevHost: string | undefined;
let prevPort: string | undefined;
let server: http.Server | undefined;

// Start a one-route health server that returns the given HTTP status + JSON body.
async function startHealthServer(routePath: string, status: number, body: unknown): Promise<number> {
  server = http.createServer((req, res) => {
    if (req.url === routePath) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server!.address() as AddressInfo).port;
}

async function seedApp(readinessPath?: string): Promise<Application> {
  const now = nowIso();
  const app: Application = {
    id: 'app_demo',
    type: 'Application',
    app_id: 'app_demo',
    created_at: now,
    updated_at: now,
    name: 'demo',
    repo_path: repo,
    platform: 'web',
    framework: 'nextjs',
    template: 'nextjs-web',
    language: 'typescript',
    package_manager: 'npm',
  };
  await store.saveResource(app);
  const manifest: Record<string, unknown> = { port: 3000 };
  if (readinessPath) manifest.production = { readiness_path: readinessPath };
  await writeFile(path.join(repo, 'forge.app.json'), JSON.stringify(manifest, null, 2));
  return app;
}

async function inspectHealth(): Promise<Inspection> {
  const { resource } = await executeCapability('inspect', { app: 'demo', type: 'health' }, SYSTEM_ACTOR);
  return resource as Inspection;
}

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  prevHost = process.env.FORGE_APP_CALLBACK_HOST;
  prevPort = process.env.FORGE_APP_CALLBACK_PORT;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-health-'));
  repo = await mkdtemp(path.join(tmpdir(), 'forge-health-repo-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_APP_CALLBACK_HOST = '127.0.0.1';
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('FORGE_STATE_DIR', prevState);
  restore('FORGE_APP_CALLBACK_HOST', prevHost);
  restore('FORGE_APP_CALLBACK_PORT', prevPort);
  await rm(dir, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe('forge inspect health (C6)', () => {
  it('renders a healthy app (200 ok) and reads production.readiness_path from the manifest', async () => {
    const port = await startHealthServer('/healthz', 200, {
      status: 'ok',
      service: 'demo',
      time: '2026-01-01T00:00:00.000Z',
      checks: [{ name: 'db', status: 'ok' }],
    });
    process.env.FORGE_APP_CALLBACK_PORT = String(port);
    await seedApp('/healthz'); // custom readiness path -> proves the manifest field is read

    const r = await inspectHealth();
    const d = r.data as Record<string, unknown>;
    expect(d.reachable).toBe(true);
    expect(d.http_status).toBe(200);
    expect(d.conforms).toBe(true);
    expect(d.status).toBe('ok');
    expect(d.service).toBe('demo');
    expect(String(d.url)).toContain('/healthz');
    expect(r.summary).toContain('health: ok');
  });

  it('renders a not-ready app (503 unavailable) — surfaces the failing check', async () => {
    const port = await startHealthServer('/api/health', 503, {
      status: 'unavailable',
      service: 'demo',
      time: '2026-01-01T00:00:00.000Z',
      checks: [{ name: 'db', status: 'unavailable', detail: 'ECONNREFUSED' }],
    });
    process.env.FORGE_APP_CALLBACK_PORT = String(port);
    await seedApp(); // no manifest production block -> defaults to /api/health

    const r = await inspectHealth();
    const d = r.data as Record<string, unknown>;
    expect(d.http_status).toBe(503);
    expect(d.status).toBe('unavailable');
    expect(d.conforms).toBe(true);
    expect(String(d.url)).toContain('/api/health'); // the default readiness path
    expect(r.summary).toContain('unavailable');
    expect(r.summary).toContain('db');
  });

  it('flags a reachable-but-non-conforming endpoint instead of guessing', async () => {
    const port = await startHealthServer('/api/health', 200, { status: 'ok' }); // missing service/time/checks
    process.env.FORGE_APP_CALLBACK_PORT = String(port);
    await seedApp();

    const r = await inspectHealth();
    const d = r.data as Record<string, unknown>;
    expect(d.reachable).toBe(true);
    expect(d.conforms).toBe(false);
    expect(String(d.error)).toMatch(/service|time|checks/);
    expect(r.summary).toContain('does not conform');
  });

  it('flags a convention mismatch (200 body says unavailable)', async () => {
    const port = await startHealthServer('/api/health', 200, {
      status: 'unavailable',
      service: 'demo',
      time: '2026-01-01T00:00:00.000Z',
      checks: [{ name: 'db', status: 'unavailable' }],
    });
    process.env.FORGE_APP_CALLBACK_PORT = String(port);
    await seedApp();

    const r = await inspectHealth();
    const d = r.data as Record<string, unknown>;
    expect(d.conforms).toBe(true);
    expect(d.convention_warning).toBeDefined();
    expect(r.summary).toContain('convention mismatch');
  });

  it('degrades gracefully when the endpoint is unreachable (no throw)', async () => {
    // No server started; point at a closed port.
    process.env.FORGE_APP_CALLBACK_PORT = '1';
    await seedApp();

    const r = await inspectHealth();
    const d = r.data as Record<string, unknown>;
    expect(d.reachable).toBe(false);
    expect(d.error).toBeDefined();
    expect(r.summary).toContain('unreachable');
  });
});
