import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { setSecret } from '../src/plugins/secrets-local/index';
import { tick } from '../src/plugins/scheduler-node/index';
import type { Application, ScheduledJob } from '../src/resources/types';
import { nowIso } from '../src/shared/time';

// C10 §5 — the C2 scheduler must authenticate its /api/cron/* callback as a SERVICE
// (not a user session). This proves it attaches the C5 service token so the app's
// gate can accept the request — closing today's fully-open cron endpoints.
const prevKey = process.env.FORGE_SECRETS_KEY;
let dir: string;
let prevState: string | undefined;
const prevHost = process.env.FORGE_APP_CALLBACK_HOST;
const prevPort = process.env.FORGE_APP_CALLBACK_PORT;

beforeAll(() => {
  process.env.FORGE_SECRETS_KEY = 'test-master-key-not-for-production';
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
});

async function seedAppAndJob(): Promise<Application> {
  const now = nowIso();
  const app: Application = {
    id: 'app_cron', type: 'Application', app_id: 'app_cron', created_at: now, updated_at: now,
    name: 'cron-app', repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web',
    language: 'typescript', package_manager: 'npm',
  };
  await store.saveResource(app);
  const job: ScheduledJob = {
    id: 'job_cron', type: 'ScheduledJob', app_id: app.id, created_at: now, updated_at: now,
    name: 'reminders', schedule: 'every:1h', target: { method: 'POST', path: '/api/cron/reminders' },
    enabled: true, next_run_at: new Date(Date.now() - 60_000).toISOString(), last_status: 'never',
    run_count: 0, fail_count: 0,
  };
  await store.saveResource(job);
  return app;
}

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-cron-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_APP_CALLBACK_HOST = 'web';
  process.env.FORGE_APP_CALLBACK_PORT = '3000';
  await store.init();
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevState;
  if (prevHost === undefined) delete process.env.FORGE_APP_CALLBACK_HOST;
  else process.env.FORGE_APP_CALLBACK_HOST = prevHost;
  if (prevPort === undefined) delete process.env.FORGE_APP_CALLBACK_PORT;
  else process.env.FORGE_APP_CALLBACK_PORT = prevPort;
  await rm(dir, { recursive: true, force: true });
});

describe('scheduler service-token (C10 §5)', () => {
  it('attaches the C5 service token to the cron callback', async () => {
    const app = await seedAppAndJob();
    await setSecret(app.id, 'AUTH_SERVICE_TOKEN', 's3rvice-t0ken');

    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return { ok: true, status: 200 } as Response;
    }));

    await tick(store, new Date());

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('http://web:3000/api/cron/reminders');
    expect(calls[0]!.headers['x-forge-service-token']).toBe('s3rvice-t0ken');
    expect(calls[0]!.headers['authorization']).toBe('Bearer s3rvice-t0ken');
  });

  it('sends no service header when none is configured (app gate then rejects — detectable)', async () => {
    await seedAppAndJob(); // no AUTH_SERVICE_TOKEN secret set

    const calls: Array<{ headers: Record<string, string> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ headers: (init?.headers ?? {}) as Record<string, string> });
      return { ok: true, status: 200 } as Response;
    }));

    await tick(store, new Date());

    expect(calls.length).toBe(1);
    expect(calls[0]!.headers['x-forge-service-token']).toBeUndefined();
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });
});
