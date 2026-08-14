/**
 * Cloud Run Jobs trigger — start a job execution as the console Workload Identity.
 *
 * REST-only; no gcloud CLI. Auth via the same accessToken() helper used by every other GCP call in
 * this plugin. The executing identity is the Cloud Run service account the console runs under
 * (Workload Identity) — no additional SA key is needed or accepted.
 *
 * Cloud Run Jobs v2 REST reference:
 *   POST /v2/projects/{project}/locations/{region}/jobs/{job}:run
 *   Response: google.longrunning.Operation whose metadata carries the Execution resource.
 */
import { gcpJson } from './http';

const RUN_V2 = 'https://run.googleapis.com/v2';

export interface JobRunRequest {
  project: string;
  region: string;
  /** The Cloud Run Job name (short form, e.g. "forge-e2e-runner"). */
  job: string;
  /** Environment variable overrides passed to the job task at invocation time. */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface JobExecution {
  /** The LRO operation name returned by Cloud Run. */
  operation_name: string;
  /**
   * The execution resource name extracted from the operation metadata, if present.
   * Format: projects/{project}/locations/{region}/jobs/{job}/executions/{id}
   */
  execution_name: string | null;
}

/**
 * Run a Cloud Run Job once, with optional environment variable overrides.
 *
 * Returns as soon as the job execution is accepted (HTTP 200 from the API). The operation is
 * long-running; call `GET /v2/.../operations/{id}` to poll for completion, or observe the
 * Cloud Run execution directly.
 */
export async function triggerCloudRunJob(opts: JobRunRequest): Promise<JobExecution> {
  const { project, region, job, env = {}, signal } = opts;
  const url = `${RUN_V2}/projects/${project}/locations/${region}/jobs/${job}:run`;

  const envEntries = Object.entries(env).map(([name, value]) => ({ name, value }));
  const body = envEntries.length > 0 ? { overrides: { containerOverrides: [{ env: envEntries }] } } : {};

  const op = await gcpJson<{
    name: string;
    metadata?: { name?: string };
  }>({ url, method: 'POST', body, signal });

  return {
    operation_name: op.name,
    execution_name: op.metadata?.name ?? null,
  };
}

/**
 * Build a GCP Console URL for ONE Cloud Run execution.
 *
 * ⛔ The previous URL was a route that does not exist. It built
 *     /run/jobs/details/{region}/{job}/executions/{id}
 * by pattern-matching the job page's own path, and the Console answered "URL not found" — so the
 * one link an operator clicks when a run has failed took them to a dead end (Mark, 2026-08-14).
 *
 * This shape is not guessed: it is the `Log URI` that `gcloud run jobs executions describe` prints
 * for the same execution, so it is Google's own answer to "where do I look at this execution",
 * reproduced field for field. It is also the more useful destination — the link only ever renders on
 * a FAILED or STOPPED run, and what you want then is what the container actually said, not a status
 * page restating the failure you already know about.
 *
 * The advancedFilter is newline-separated (%0A) and pins all four identifiers, so the view is scoped
 * to this execution alone rather than the job's whole history.
 *
 * Returns null when the name does not match the expected 8-segment path.
 */
export function buildExecutionConsoleUrl(executionName: string, project: string): string | null {
  // Format: projects/{project}/locations/{region}/jobs/{job}/executions/{id}
  const parts = executionName.split('/');
  if (parts.length !== 8) return null;
  const region = parts[3];
  const jobName = parts[5];
  const id = parts[7];
  if (!region || !jobName || !id) return null;
  const filter = [
    'resource.type="cloud_run_job"',
    `resource.labels.job_name="${jobName}"`,
    `resource.labels.location="${region}"`,
    `labels."run.googleapis.com/execution_name"="${id}"`,
  ].join('\n');
  return (
    `https://console.cloud.google.com/logs/viewer?project=${encodeURIComponent(project)}` +
    `&advancedFilter=${encodeURIComponent(filter)}`
  );
}

/**
 * The job's executions LIST page — a stable fallback when there is no single execution to point at.
 *
 * Verified by Mark against the live Console on 2026-08-14; this is the route that loads.
 */
export function buildJobExecutionsUrl(region: string, jobName: string, project: string): string {
  return `https://console.cloud.google.com/run/jobs/details/${region}/${jobName}/executions?project=${encodeURIComponent(project)}`;
}

/** Terminal-or-not state of a Cloud Run Job execution, as the console needs it. */
export interface ExecutionState {
  /** 'running' while in flight; otherwise the outcome. 'unknown' when the API cannot say. */
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  completed_at?: string;
  message?: string;
}

/**
 * Read an execution's current state.
 *
 * This exists because a pre-created run row is only ever finalised by the RUNNER, and a runner that
 * dies before it can publish leaves the row saying "running" forever — which is what happened on
 * 2026-08-13: the container could not exec, Cloud Run failed the execution in seconds, and the
 * console kept showing a run in progress with no way to ever learn otherwise. The execution is the
 * source of truth; the row must be reconciled against it rather than trusted.
 */
export async function getExecutionState(
  executionName: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ExecutionState> {
  try {
    const res = (await gcpJson({
      url: `${RUN_V2}/${executionName}`,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })) as {
      completionTime?: string;
      succeededCount?: number;
      failedCount?: number;
      cancelledCount?: number;
      conditions?: Array<{ type?: string; state?: string; message?: string }>;
    };
    if (!res.completionTime) return { state: 'running' };
    const completed_at = res.completionTime;
    if ((res.cancelledCount ?? 0) > 0) return { state: 'cancelled', completed_at };
    if ((res.failedCount ?? 0) > 0) {
      const failure = res.conditions?.find((c) => c.state === 'CONDITION_FAILED');
      return {
        state: 'failed',
        completed_at,
        ...(failure?.message ? { message: failure.message } : {}),
      };
    }
    if ((res.succeededCount ?? 0) > 0) return { state: 'succeeded', completed_at };
    // Completed with no counters is not something to guess about.
    return { state: 'unknown', completed_at };
  } catch (e) {
    // A read failure must never rewrite a row — 'unknown' leaves it alone.
    return { state: 'unknown', message: (e as Error).message };
  }
}

/**
 * Cancel a running Cloud Run job execution.
 *
 * ⛔ This is a SPEND control, not a convenience. Before it existed, a run started by mistake — the
 * wrong scope, a full catalogue when one workflow was meant — could only be watched until it
 * finished, burning provider credit the whole way (Mark, 2026-08-14: "I'm wasting money right now").
 * The only way to stop one was an operator with gcloud access, which is not a product.
 *
 * Cancellation is idempotent from the caller's side: an execution that has already finished returns
 * an error from the API, and the caller treats that as "nothing left to stop" rather than a failure.
 */
export async function cancelExecution(
  executionName: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ cancelled: boolean; reason?: string }> {
  try {
    await gcpJson({
      url: `${RUN_V2}/${executionName}:cancel`,
      method: 'POST',
      body: {},
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { cancelled: true };
  } catch (e) {
    return { cancelled: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
