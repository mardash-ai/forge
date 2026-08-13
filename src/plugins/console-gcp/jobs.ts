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
  const body =
    envEntries.length > 0
      ? { overrides: { containerOverrides: [{ env: envEntries }] } }
      : {};

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
 * Build a GCP Console URL for a Cloud Run execution, given the execution resource name.
 *
 * The URL opens the execution detail page where logs and job output are visible.
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
  return `https://console.cloud.google.com/run/jobs/details/${region}/${jobName}/executions/${id}?project=${encodeURIComponent(project)}`;
}
