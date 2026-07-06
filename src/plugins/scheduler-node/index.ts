import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../../storage/store';
import type { Application, ScheduledJob } from '../../resources/types';
import { SYSTEM_ACTOR } from '../../shared/domain';
import { isDue, advanceJob } from './schedule';

// Plugin: scheduler-node.
//
// The first Implementation of the Scheduler Capability — an in-process ticker in
// the (always-on) control plane. It's a real technology boundary: a future
// scheduler-temporal / scheduler-cron Implementation could replace it without
// touching the ScheduleJob contract. Jobs are durable ScheduledJob Resources, so
// the ticker resumes across restarts; a job due while the plane was down fires on
// the next tick after boot.

export const IMPLEMENTATION = 'scheduler-node';

const TICK_MS = 20_000;
const INVOKE_TIMEOUT_MS = 30_000;

// Where the control plane reaches a Builder app's HTTP server. The app is
// port-mapped to the host; from inside the control-plane container the host is
// `host.docker.internal` (overridable for Linux/CI). The port is the app's web
// host port (persisted infra, else the manifest port).
async function appCallbackBase(store: Store, appId?: string): Promise<string | null> {
  const host = process.env.FORGE_APP_CALLBACK_HOST ?? 'host.docker.internal';
  // Prod sidecar mode: the app's address is given by env (host + port), so the
  // scheduler needs no provisioned Resource/manifest — e.g. FORGE_APP_CALLBACK_HOST=web
  // FORGE_APP_CALLBACK_PORT=3000 on the deploy compose network.
  const envPort = process.env.FORGE_APP_CALLBACK_PORT;
  if (process.env.FORGE_APP_CALLBACK_HOST && envPort) {
    return `http://${host}:${envPort}`;
  }
  // Dev mode: resolve the app's web host port from its provisioned manifest.
  if (!appId) return null;
  const app = (await store.getResource('Application', appId)) as Application | null;
  if (!app) return null;
  let port = 3000;
  try {
    const manifest = JSON.parse(await readFile(path.join(app.repo_path, 'forge.app.json'), 'utf8'));
    const webPort = manifest?.infra?.ports?.web;
    port = typeof webPort === 'number' ? webPort : typeof manifest.port === 'number' ? manifest.port : 3000;
  } catch {
    /* default */
  }
  return `http://${host}:${port}`;
}

async function invokeTarget(
  base: string,
  target: ScheduledJob['target'],
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(`${base}${target.path}`, {
      method: target.method,
      signal: AbortSignal.timeout(INVOKE_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

// One scheduler pass: fire every enabled job whose time has come, record the
// outcome as a fact, and persist the advanced job. Exported for tests.
export async function tick(store: Store, now: Date = new Date()): Promise<void> {
  const jobs = (await store.listResources({ type: 'ScheduledJob' })) as ScheduledJob[];
  for (const job of jobs) {
    if (!job.enabled || !isDue(job.next_run_at, now)) continue;

    const base = await appCallbackBase(store, job.app_id);
    const outcome = base
      ? await invokeTarget(base, job.target)
      : { ok: false, error: 'app is not resolvable (never provisioned?)' };

    const updated = advanceJob(job, outcome.ok, now);
    await store.saveResource(updated);
    await store.appendEvent({
      type: outcome.ok ? 'JobRan' : 'JobRunFailed',
      resource_type: 'ScheduledJob',
      resource_id: job.id,
      app_id: job.app_id,
      actor: SYSTEM_ACTOR,
      data: {
        name: job.name,
        target: job.target,
        ...(outcome.status !== undefined ? { response_status: outcome.status } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        fail_count: updated.fail_count,
      },
    });
  }
}

// Start the background ticker. Returns a stop function. Ticks don't overlap.
export function startScheduler(store: Store, opts: { tickMs?: number } = {}): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick(store);
    } catch {
      /* a bad tick must never crash the control plane */
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, opts.tickMs ?? TICK_MS);
  // Don't keep the process alive just for the scheduler.
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
