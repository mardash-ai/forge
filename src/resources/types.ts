// Resource definitions — durable STATE. Resources own no behavior (Capabilities
// do). Every Resource shares a base envelope; typed shapes below document the
// fields each Resource carries. See 02_FORGE_DOMAIN_MODEL.md / agent-context.md.

export const RESOURCE_TYPES = [
  'Application',
  'Environment',
  'DependencyInstall',
  'DevServer',
  'Build',
  'TestRun',
  'CheckRun',
  'Inspection',
  'Verification',
  'Analysis',
  'Plan',
  'Secret',
  'ScheduledJob',
  'Deployment',
  'ProductionArtifacts',
  'Release',
  'AgentTask',
  'Artifact',
  'EmailDelivery',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export interface BaseResource {
  id: string;
  type: ResourceType;
  app_id?: string;
  // Owner (C11) — the opaque user id (e.g. C10's session `userId`) a per-user resource belongs to.
  // Set only by the owner-scoped stores (currently C1's AgentTask + Artifact); resources that are
  // platform/dev-time state (Build, TestRun, …) leave it absent. A `listResources` query passing an
  // owner filters to `resource.owner === owner`, so per-user resources never leak across users.
  // Absent = legacy/app-scoped (pre-C11 or a C10-less app).
  owner?: string;
  created_at: string;
  updated_at: string;
}

export type Status = 'queued' | 'running' | 'succeeded' | 'failed';

export interface Application extends BaseResource {
  type: 'Application';
  name: string;
  repo_path: string;
  platform: string;
  framework: string;
  template: string;
  language: string;
  package_manager: string;
}

export interface Environment extends BaseResource {
  type: 'Environment';
  env_type: 'docker-compose';
  status: 'provisioned' | 'unavailable';
  services: string[];
  ports: Record<string, number>;
  compose_file: string;
}

export interface DependencyInstall extends BaseResource {
  type: 'DependencyInstall';
  status: Status;
  implementation: string;
  duration_ms: number;
  log_path: string;
  summary: string;
}

export interface DevServer extends BaseResource {
  type: 'DevServer';
  status: 'running' | 'stopped' | 'failed';
  url: string;
  port: number;
  container_id: string;
  health: 'healthy' | 'starting' | 'unhealthy' | 'unknown';
  log_path: string;
}

export interface Build extends BaseResource {
  type: 'Build';
  status: Status;
  implementation: string;
  started_at: string;
  finished_at?: string;
  duration_ms: number;
  log_path: string;
  artifact_refs: string[];
  error_summary?: string;
}

export interface TestRun extends BaseResource {
  type: 'TestRun';
  status: Status;
  implementation: string;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number;
  log_path: string;
  failure_summary?: string;
}

export interface CheckRun extends BaseResource {
  type: 'CheckRun';
  check_type: 'lint' | 'typecheck';
  status: Status;
  implementation: string;
  duration_ms: number;
  problems: number;
  log_path: string;
  summary: string;
}

export interface Inspection extends BaseResource {
  type: 'Inspection';
  inspection_type: string;
  summary: string;
  data: unknown;
}

// A Verification — the durable record of ONE post-deploy contract smoke run (C14):
// the read-only HTTP assertions `forge verify` made against a deployed app's public
// host, checking the platform contracts it adopted (C6 health + the C10 auth gates +
// /auth/config). State only; behavior lives in the Verify Capability. `passed` is the
// overall gate (true iff no assertion failed; skips don't fail). Non-destructive:
// records only status codes + which contract each assertion checked, never any body
// or credential.
export interface Verification extends BaseResource {
  type: 'Verification';
  // The public host/base URL that was probed (normalized, e.g. https://app.example.com).
  host: string;
  passed: boolean;
  summary: string;
  total: number;
  failed: number;
  skipped: number;
  // Each contract assertion's outcome (name, title, pass/fail/skip, target, expected, actual, detail).
  assertions: VerificationAssertion[];
  checked_at: string;
}

export interface VerificationAssertion {
  name: string;
  title: string;
  status: 'pass' | 'fail' | 'skip';
  target: string;
  expected: string;
  actual: string;
  detail?: string;
}

export interface Analysis extends BaseResource {
  type: 'Analysis';
  source_resource_id: string;
  source_resource_type: string;
  likely_cause: string;
  evidence: string[];
  file_refs: string[];
  suggested_actions: string[];
}

export interface Plan extends BaseResource {
  type: 'Plan';
  goal: string;
  proposed_resources: string[];
  proposed_files: string[];
  capability_sequence: string[];
  validation_steps: string[];
  risks: Array<{ risk: string; severity: 'low' | 'medium' | 'high' }>;
}

// A named secret an Application needs. Durable STATE only — metadata that the
// secret is set, never the material. The encrypted value lives in the secrets
// backend (plugins/secrets-local), never in this Resource or any API response.
export interface Secret extends BaseResource {
  type: 'Secret';
  name: string;
  // 'set' while the encrypted value is in the vault; 'unset' once revoked (UnsetSecret). The
  // Resource never carries the material — only that a secret by this name is/was configured.
  status: 'set' | 'unset';
  algo: string;
}

// A durable scheduled job: recurring or one-shot work Forge fires on cadence by
// calling back into the app. State only — the scheduler-node Implementation owns
// the behavior. Survives restart (next_run_at is persisted), so the scheduler
// resumes from where it left off.
export interface ScheduledJob extends BaseResource {
  type: 'ScheduledJob';
  name: string;
  // Canonical schedule string: "every:<dur>" | "cron:<expr>" | "once:<iso>".
  schedule: string;
  // What Forge invokes on the app when the job fires.
  target: { method: 'GET' | 'POST'; path: string };
  enabled: boolean;
  next_run_at: string;
  last_run_at?: string;
  last_status: 'never' | 'succeeded' | 'failed';
  run_count: number;
  fail_count: number;
}

// A deployment of the app's PRODUCTION stack. Durable STATE only — the
// deploy-compose-rollout Implementation owns the zero-downtime roll behavior.
// Records what rolled (old→new container ids), which services reconciled, and the
// outcome. A failed roll auto-discards the new replica and keeps the old serving
// (status:'failed' + a DeploymentRolledBack fact) — the deploy is never a partial
// outage.
export interface Deployment extends BaseResource {
  type: 'Deployment';
  status: Status;
  implementation: string;
  // The public service rolled start-first (default "web"); other services reconcile in place.
  service: string;
  strategy?: 'first-deploy' | 'rolled';
  // Docker context of the target daemon; undefined = the local daemon.
  context?: string;
  compose_file: string;
  reconciled_services: string[];
  old_container_ids: string[];
  new_container_ids: string[];
  started_at: string;
  finished_at?: string;
  duration_ms: number;
  log_path: string;
  error_summary?: string;
}

// ProductionArtifacts — the durable record of the app's CANONICAL production
// artifacts generated by Productionize (C8): the standalone Dockerfile, its
// .dockerignore, `output:'standalone'` in the Next config, compose.prod.yaml, and
// .env.prod.example. State only — the productionize-nextjs-compose Implementation
// owns the generation. Records the inputs it converged from (host, readiness path,
// the digest-pinned web + data-plane images) and what it wrote, so a re-run
// reproduces it. The compose it names is exactly what Deploy (C7) rolls.
export interface ProductionArtifacts extends BaseResource {
  type: 'ProductionArtifacts';
  status: 'generated';
  host: string;
  readiness_path: string;
  // Digest-pinned image refs written into compose.prod.yaml (R1 — never `latest`).
  web_image: string;
  data_plane_image: string;
  // Services present in the generated compose.prod.yaml (web + data-plane [+ postgres/redis]).
  services: string[];
  // The files written/updated (relative to the app repo).
  files: string[];
  compose_file: string;
}

// A Release — the durable record of ONE end-to-end `forge release` run (C18): the capstone
// that takes a committed app to DEPLOYED + VERIFIED through publish → repin → deploy → verify.
// State only; the release-orchestrator Implementation owns the fail-safe, idempotent sequencing.
// Records the commit released, the resolved digest pin, the ordered per-phase outcome (so a
// re-run's skips are visible), and links to the Deployment (C7) + Verification (C14) it
// produced. A failed release names the phase it stopped at — prod is on the last-good version.
export interface Release extends BaseResource {
  type: 'Release';
  status: 'succeeded' | 'failed';
  app: string;
  // The commit whose build was released, and the tagged ref for it.
  commit: string;
  image_ref: string;
  // The R1 digest pin repinned into compose.prod.yaml (once publish resolved it).
  web_image_pin?: string;
  host?: string;
  publish_mode: 'ci' | 'build';
  dry_run: boolean;
  implementation: string;
  // The ordered phase log — assess/publish/repin/deploy/verify, each ran|skipped|failed.
  phases: ReleasePhaseRecord[];
  // Cross-links to the Resources the release created (present when those phases ran).
  deployment_id?: string;
  verification_id?: string;
  // On failure: the phase that stopped the release + the actionable reason.
  failed_phase?: string;
  error_summary?: string;
  duration_ms: number;
}

export interface ReleasePhaseRecord {
  phase: 'assess' | 'publish' | 'repin' | 'deploy' | 'verify';
  status: 'ran' | 'skipped' | 'failed';
  detail: string;
  duration_ms: number;
}

// An Artifact — the durable, first-class RESULT produced by an agent run (C1). State
// only. Holds the parsed structured output (conforming to the run's schema) plus the
// schema it was enforced against, echoed so the consumer can POST-VALIDATE the untrusted
// model output before use. Referenced by its producing AgentTask.
export interface Artifact extends BaseResource {
  type: 'Artifact';
  // Free-form kind/label mirrored from the producing AgentTask (e.g. "planner").
  kind: string;
  // The AgentTask that produced this artifact.
  produced_by: string;
  model: string;
  // The parsed structured result. UNTRUSTED model output — the consumer post-validates.
  result: unknown;
  // The JSON Schema the result was enforced against (for the consumer's post-validation).
  schema: unknown;
}

// An AgentTask — the durable, inspectable record of ONE model invocation (C1), persisted
// for success AND failure. State only; behavior lives in the AgentRun Capability. Survives
// restart (a JSON doc under the state dir), so past runs stay queryable/inspectable. The
// run's `id` is the caller's runId; `created_at` is its timestamp.
export interface AgentTask extends BaseResource {
  type: 'AgentTask';
  // Free-form label/kind the caller supplies to categorize the run (e.g. "planner").
  label: string;
  status: 'succeeded' | 'failed';
  model: string;
  // The produced Artifact's id (success only) + the inline parsed result, so a single
  // response gives the consumer the result without a second fetch. null/absent on failure.
  artifact_id?: string;
  artifact?: unknown;
  // Populated on failure (model/API error, or output that didn't conform to the schema).
  error?: string;
  implementation: string;
}

// An EmailDelivery — the durable, inspectable record of ONE transactional-email send attempt (C12),
// persisted for success AND failure once a send was attempted. State only; behavior lives in the
// SendEmail Capability. Deliberately CARRIES NO PII/secrets: `to` is a REDACTED recipient (e.g.
// "j***@example.com"), never the full address; there is NO message body and NO credential here — only
// the subject + status + (on failure) a scrubbed provider error. Survives restart (a JSON doc under the
// state dir), so past sends stay queryable via `forge inspect email`.
export interface EmailDelivery extends BaseResource {
  type: 'EmailDelivery';
  status: 'sent' | 'failed';
  // Redacted recipient — never the full address (no PII at rest).
  to: string;
  subject: string;
  // The built-in template used (verify-email | reset-password), if any; absent for an inline body.
  template?: string;
  implementation: string;
  // The transport's message id (success only).
  message_id?: string;
  // Populated on failure (provider/transport error), scrubbed of any recipient address.
  error?: string;
}

export type AnyResource =
  | Application
  | Environment
  | DependencyInstall
  | DevServer
  | Build
  | TestRun
  | CheckRun
  | Inspection
  | Verification
  | Analysis
  | Plan
  | Secret
  | ScheduledJob
  | Deployment
  | ProductionArtifacts
  | Release
  | AgentTask
  | Artifact
  | EmailDelivery;
