import type { Store } from '../../storage/store';
import type { ScheduledJob } from '../../resources/types';
import { SYSTEM_ACTOR } from '../../shared/domain';
import { appCallbackBase, serviceAuthHeaders } from '../../shared/app-callback';
import { resolveServiceToken } from '../auth-identity/index';
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

async function invokeTarget(
  base: string,
  target: ScheduledJob['target'],
  serviceToken: string | null,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    // C10 §5 — authenticate as a SERVICE (not a user session). The app's session gate lets `/api/cron/*`
    // through only when it carries the valid service token, closing what used to be fully-open cron
    // endpoints.
    const res = await fetch(`${base}${target.path}`, {
      method: target.method,
      headers: serviceAuthHeaders(serviceToken),
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
    // Resolve the app's service token (C5) so the callback authenticates as a service.
    const serviceToken = job.app_id ? await resolveServiceToken(job.app_id) : null;
    const outcome = base
      ? await invokeTarget(base, job.target, serviceToken)
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
