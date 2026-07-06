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
  | Secret;
