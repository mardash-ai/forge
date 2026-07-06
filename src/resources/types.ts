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
  'Analysis',
  'Plan',
  'Secret',
  'ScheduledJob',
  'Deployment',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export interface BaseResource {
  id: string;
  type: ResourceType;
  app_id?: string;
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
  status: 'set';
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

export type AnyResource =
  | Application
  | Environment
  | DependencyInstall
  | DevServer
  | Build
  | TestRun
  | CheckRun
  | Inspection
  | Analysis
  | Plan
  | Secret
  | ScheduledJob
  | Deployment;
