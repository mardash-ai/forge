import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { store } from '../src/storage/store';
import { executeCapability } from '../src/core/runtime';
import { SYSTEM_ACTOR } from '../src/shared/domain';
import { nowIso } from '../src/shared/time';
import type { Application, Verification } from '../src/resources/types';
import { runContractChecks } from '../src/shared/contract-checks';

// C14 — `forge verify`. The parameterized contract checks (runContractChecks) are
// driven against a THROWAWAY in-process app that either honors or violates each
// platform contract; then the real Verify Capability is exercised through the runtime
// against the same fixture. No Docker, no sibling — just the contract, over the wire.

// A configurable fake "deployed forge app". Each contract behaves compliantly unless a
// flag flips it to a violation, so a single fixture proves both pass and fail paths.
interface FakeAppConfig {
  healthStatus?: number;              // default 200
  healthBody?: unknown;               // default a valid C6 body
  healthRedirect?: string;            // if set, /api/health 302s here (gated — a violation)
  pageStatus?: number;                // default 302
  pageLocation?: string;              // default /auth/login?next=/
  apiStatus?: number;                 // default 401 for /api/protected
  cronStatus?: number;                // default 403 for /api/cron/job
  authConfig?: unknown;               // default a valid {methods,configured}
  authConfigStatus?: number;          // default 200
  refreshStatus?: number;             // default 401
}

const C6_OK = { status: 'ok', service: 'demo', time: '2026-01-01T00:00:00.000Z', checks: [{ name: 'db', status: 'ok' }] };
const AUTH_CONFIG_OK = {
  methods: { password: true, password_signup: true, google: true },
  configured: { session_key: true, google: true, email: true, service_token: true },
};

let server: http.Server | undefined;

async function startFakeApp(cfg: FakeAppConfig = {}): Promise<string> {
  server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    const method = req.method ?? 'GET';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url === '/api/health') {
      if (cfg.healthRedirect) {
        res.writeHead(302, { location: cfg.healthRedirect });
        return res.end();
      }
      return json(cfg.healthStatus ?? 200, cfg.healthBody ?? C6_OK);
    }
    if (url === '/') {
      res.writeHead(cfg.pageStatus ?? 302, { location: cfg.pageLocation ?? '/auth/login?next=%2F' });
      return res.end();
    }
    if (url === '/api/protected') return json(cfg.apiStatus ?? 401, { error: { code: 'unauthenticated' } });
    if (url === '/api/cron/job') return json(cfg.cronStatus ?? 403, { error: { code: 'forbidden' } });
    if (url === '/auth/config') return json(cfg.authConfigStatus ?? 200, cfg.authConfig ?? AUTH_CONFIG_OK);
    if (url === '/auth/refresh' && method === 'POST') return json(cfg.refreshStatus ?? 401, { error: { code: 'unauthenticated' } });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

// ---- unit: runContractChecks -------------------------------------------------

describe('C14 runContractChecks — contract assertions', () => {
  it('passes every assertion against a fully compliant app', async () => {
    const base = await startFakeApp();
    const report = await runContractChecks({
      baseUrl: base,
      apiPaths: ['/api/protected'],
      cronPath: '/api/cron/job',
      expect: { google: true, email: true, passwordSignup: true },
      checkRefresh: true,
    });
    expect(report.passed).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(0);
    const byName = Object.fromEntries(report.assertions.map((a) => [a.name, a.status]));
    expect(byName['health']).toBe('pass');
    expect(byName['page-gate']).toBe('pass');
    expect(byName['api-gate:/api/protected']).toBe('pass');
    expect(byName['service-gate']).toBe('pass');
    expect(byName['auth-config']).toBe('pass');
    expect(byName['refresh']).toBe('pass');
  });

  it('fails health when /api/health is behind an auth redirect (not public)', async () => {
    const base = await startFakeApp({ healthRedirect: '/auth/login?next=%2Fapi%2Fhealth' });
    const report = await runContractChecks({ baseUrl: base });
    const health = report.assertions.find((a) => a.name === 'health')!;
    expect(health.status).toBe('fail');
    expect(health.detail).toMatch(/public/i);
    expect(report.passed).toBe(false);
  });

  it('fails health when the body does not match the C6 schema', async () => {
    const base = await startFakeApp({ healthBody: { status: 'ok' } }); // missing service/time/checks
    const report = await runContractChecks({ baseUrl: base });
    const health = report.assertions.find((a) => a.name === 'health')!;
    expect(health.status).toBe('fail');
    expect(health.actual).toMatch(/C6 schema/);
  });

  it('fails the page gate when an unauthenticated page does not redirect to /auth/login', async () => {
    const base = await startFakeApp({ pageStatus: 200, pageLocation: '' });
    const report = await runContractChecks({ baseUrl: base });
    expect(report.assertions.find((a) => a.name === 'page-gate')!.status).toBe('fail');
  });

  it('fails the API gate when a protected route returns 200 unauthenticated', async () => {
    const base = await startFakeApp({ apiStatus: 200 });
    const report = await runContractChecks({ baseUrl: base, apiPaths: ['/api/protected'] });
    const a = report.assertions.find((x) => x.name === 'api-gate:/api/protected')!;
    expect(a.status).toBe('fail');
    expect(a.detail).toMatch(/not gated/i);
  });

  it('distinguishes the service gate: 401 is a FAIL, 403 is the pass', async () => {
    const base = await startFakeApp({ cronStatus: 401 });
    const report = await runContractChecks({ baseUrl: base, cronPath: '/api/cron/job' });
    const a = report.assertions.find((x) => x.name === 'service-gate')!;
    expect(a.status).toBe('fail');
    expect(a.detail).toMatch(/403/);
  });

  it('skips API + service gates (with a note) when no paths are given, without failing', async () => {
    const base = await startFakeApp();
    const report = await runContractChecks({ baseUrl: base });
    const api = report.assertions.find((a) => a.name === 'api-gate')!;
    const svc = report.assertions.find((a) => a.name === 'service-gate')!;
    expect(api.status).toBe('skip');
    expect(svc.status).toBe('skip');
    expect(report.passed).toBe(true); // skips do not fail the run
    expect(report.skipped).toBe(2);
  });

  it('fails /auth/config when an expected method is not enabled', async () => {
    const base = await startFakeApp({
      authConfig: { methods: { password: true, password_signup: false, google: false }, configured: { session_key: true, google: false, email: false, service_token: true } },
    });
    const report = await runContractChecks({ baseUrl: base, expect: { google: true } });
    const a = report.assertions.find((x) => x.name === 'auth-config')!;
    expect(a.status).toBe('fail');
    expect(a.detail).toMatch(/google/);
  });

  it('passes /auth/config shape-only when no expectations are declared', async () => {
    const base = await startFakeApp({
      authConfig: { methods: { password: true, password_signup: false, google: false }, configured: { session_key: true, google: false, email: false, service_token: false } },
    });
    const report = await runContractChecks({ baseUrl: base });
    expect(report.assertions.find((a) => a.name === 'auth-config')!.status).toBe('pass');
  });

  it('fails /auth/config when the body is not the {methods,configured} shape', async () => {
    const base = await startFakeApp({ authConfig: { hello: 'world' } });
    const report = await runContractChecks({ baseUrl: base });
    expect(report.assertions.find((a) => a.name === 'auth-config')!.status).toBe('fail');
  });

  it('degrades gracefully (no throw) when the host is unreachable', async () => {
    const report = await runContractChecks({ baseUrl: 'http://127.0.0.1:1', apiPaths: ['/api/x'] });
    expect(report.passed).toBe(false);
    expect(report.assertions.find((a) => a.name === 'health')!.actual).toMatch(/unreachable/);
  });
});

// ---- capability through the runtime -----------------------------------------

let dir: string;
let prevState: string | undefined;

async function seedApp(): Promise<Application> {
  const now = nowIso();
  const app: Application = {
    id: 'app_demo', type: 'Application', app_id: 'app_demo', created_at: now, updated_at: now,
    name: 'demo', repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web',
    language: 'typescript', package_manager: 'npm',
  };
  await store.saveResource(app);
  return app;
}

describe('C14 Verify Capability (through the runtime)', () => {
  beforeEach(async () => {
    prevState = process.env.FORGE_STATE_DIR;
    dir = await mkdtemp(path.join(tmpdir(), 'forge-verify-'));
    process.env.FORGE_STATE_DIR = dir;
    await store.init();
    await seedApp();
  });

  afterEach(async () => {
    if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
    else process.env.FORGE_STATE_DIR = prevState;
    await rm(dir, { recursive: true, force: true });
  });

  it('produces a passing Verification against a compliant app + emits the fact', async () => {
    const base = await startFakeApp();
    const { resource } = await executeCapability(
      'verify',
      { app: 'demo', host: base, api_paths: ['/api/protected'], cron_path: '/api/cron/job', expect_google: true, check_refresh: true },
      SYSTEM_ACTOR,
    );
    const v = resource as Verification;
    expect(v.type).toBe('Verification');
    expect(v.passed).toBe(true);
    expect(v.failed).toBe(0);
    expect(v.host).toBe(base);
    expect(v.summary).toContain('passed');

    const events = await store.listEvents({ app_id: 'app_demo' });
    expect(events.some((e) => e.type === 'VerificationCompleted')).toBe(true);

    const saved = (await store.listResources({ type: 'Verification', app_id: 'app_demo' })) as Verification[];
    expect(saved).toHaveLength(1);
    expect(saved[0]!.passed).toBe(true);
  });

  it('produces a FAILING Verification (passed:false) when a contract is violated', async () => {
    const base = await startFakeApp({ apiStatus: 200 }); // protected route not gated
    const { resource } = await executeCapability(
      'verify',
      { app: 'demo', host: base, api_paths: ['/api/protected'] },
      SYSTEM_ACTOR,
    );
    const v = resource as Verification;
    expect(v.passed).toBe(false);
    expect(v.failed).toBeGreaterThan(0);
    expect(v.summary).toMatch(/FAILED/);
  });

  it('assumes https for a bare host (normalizes host → base URL)', async () => {
    const { resource } = await executeCapability(
      'verify',
      { app: 'demo', host: 'app.example.com/' },
      SYSTEM_ACTOR,
    );
    expect((resource as Verification).host).toBe('https://app.example.com');
  });
});
