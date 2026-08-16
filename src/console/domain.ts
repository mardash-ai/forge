/**
 * forge-console — the provider-neutral domain model.
 *
 * Nothing in this file may mention GCP, GitHub, Grafana or any other vendor. Providers translate
 * their own shapes into these types; every screen and every route speaks only this vocabulary.
 * That is what makes a future AWS/GitLab implementation a new directory rather than a rewrite.
 *
 * The model is DISCOVERY-FIRST. Entities are found by asking providers what exists — never by
 * reading a hand-maintained catalogue. Backstage's `catalog-info.yaml` per service is the reason
 * its adopters report most of their platform time going on catalogue upkeep, and why the catalogue
 * drifts from reality. Here, when correlation cannot explain something, it becomes a visible
 * FINDING rather than a silent omission.
 */

export type EnvKey = string; // 'prod-a'
export type ServiceKey = string; // 'dorinda-api'

/** Where a resource lives, exactly as the cloud scopes it. Never flattened. */
export type Scope = 'global' | 'regional' | 'zonal';

/**
 * Neutral resource kinds. Deliberately coarse: a UI grouping, not a vendor taxonomy.
 * `native_type` on the resource carries the provider's own name for it.
 */
export type ResourceKind =
  | 'compute.service' // Cloud Run service, ECS service…
  /**
   * A Cloud Run JOB — runs to completion, no traffic, no revisions.
   *
   * ⛔ Added because the deploys screen enumerated services only, so `e2e-runner` — the thing that
   * executes every acceptance run, and whose version mattered most on 2026-08-16 — could not be
   * seen anywhere in the console. "It's live on v0.38.0" was a claim only gcloud could check.
   */
  | 'compute.job'
  | 'compute.instance'
  | 'compute.instance_group'
  | 'db.instance'
  | 'net.load_balancer'
  | 'net.backend'
  | 'net.network'
  | 'net.subnet'
  | 'net.address'
  | 'net.nat'
  | 'net.dns_zone'
  | 'secret'
  | 'certificate'
  | 'bucket'
  | 'registry.repo'
  | 'identity.service_account'
  | 'identity.federation'
  | 'observability.metric_store'
  | 'other';

export interface InfraResource {
  provider_id: string;
  env: EnvKey;
  kind: ResourceKind;
  /** The provider's own type name, shown verbatim so the console never lies about what a thing is. */
  native_type: string;
  external_id: string;
  name: string;
  scope: Scope;
  location?: string; // 'us-east1' | 'us-east1-d' | undefined for global
  /** True when this line costs money. Surfaced everywhere; see the cost screen. */
  billable: boolean;
  labels: Record<string, string>;
  state?: string;
  created_at?: string;
  /** Generic key/value detail rendered as a definition list. Never contains a secret VALUE. */
  attributes: Record<string, string | number | boolean | null>;
  /** Deep link into the provider's own console, so the user can always go verify. */
  link?: string;
  service_key?: ServiceKey; // filled by the correlator, never by the provider
}

// ── Correlation ────────────────────────────────────────────────────────────────────────────────

/**
 * Why the console believes two things belong together. Rendered in the UI — when correlation is
 * wrong you can see the rule that did it, which turns a mystery into a one-line fix.
 */
export interface Evidence {
  rule: string;
  detail: string;
  confidence: number; // 0..1, this rule's contribution
}

export type BindingKind =
  | 'runtime'
  | 'repo'
  | 'pipeline'
  | 'image_repo'
  | 'host'
  | 'database'
  | 'secret'
  | 'certificate'
  | 'backend'
  | 'stack';

export interface Binding {
  kind: BindingKind;
  env: EnvKey;
  external_id: string;
  display: string;
  confidence: number; // 1.0 = deterministic
  source: 'discovered' | 'override';
  evidence: Evidence[];
}

/** The correlation anchor. One logical service, however many provider objects make it up. */
export interface Service {
  key: ServiceKey;
  display_name: string;
  envs: EnvKey[];
  bindings: Binding[];
  /** Lowest confidence across bindings — the honest summary of how sure we are. */
  confidence: number;
}

export interface ServiceGraph {
  services: Service[];
  /** Resources that attached to nothing. A feature: this is the ops queue, not a gap. */
  unbound: InfraResource[];
  /** Two services claiming one resource. Reported, never silently resolved. */
  conflicts: Array<{ external_id: string; claimants: ServiceKey[] }>;
}

// ── Runtime / deploys ──────────────────────────────────────────────────────────────────────────

export interface Revision {
  id: string;
  image_digest: string;
  image_ref: string;
  /**
   * The release this digest was published as, resolved from the registry.
   *
   * Services are rolled BY DIGEST on purpose — a tag is a label someone can move. The cost is that
   * a screen showing only `app@sha256:abf3cd1…` cannot answer "is v1.40.2 live?", which is how this
   * console ran two releases behind for two days unnoticed. `null` means we could not resolve one;
   * it is rendered as unknown and never guessed.
   */
  image_version?: string | null;
  /** The registry tag as published — a commit sha for most services, a semver for forge-*. */
  source_ref?: string | null;
  /** Where to read what changed, pinned to the deployed commit. */
  changelog_url?: string | null;
  created_at: string;
  traffic_percent: number;
  ready: boolean;
  ready_detail?: string;
  min_instances?: number;
  max_instances?: number;
}

// ── Pipelines ──────────────────────────────────────────────────────────────────────────────────

export interface Pipeline {
  id: string;
  repo: string;
  name: string;
  path: string;
  dispatchable: boolean;
}

export type RunStatus = 'queued' | 'in_progress' | 'completed';
export type RunConclusion = 'success' | 'failure' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';

export interface PipelineRun {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  repo: string;
  number: number;
  status: RunStatus;
  conclusion?: RunConclusion;
  event: string;
  branch: string;
  commit_sha: string;
  actor: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  url: string;
}

// ── Observability ──────────────────────────────────────────────────────────────────────────────

/**
 * What a caller WANTS, not how to get it. A provider compiles an intent into its own query
 * language. This is the extensibility hinge: a new metrics backend implements ~8 compilations and
 * every existing screen works, because no screen ever writes PromQL.
 */
export type MetricIntent =
  | 'request_rate'
  | 'error_rate'
  | 'latency_p95'
  | 'instance_count'
  | 'cpu_utilization'
  | 'memory_utilization'
  | 'db_connections'
  | 'db_disk_used';

export interface Series {
  labels: Record<string, string>;
  points: Array<{ t: number; v: number | null }>;
}

/**
 * A metrics answer ALWAYS carries why it might be empty.
 *
 * This type exists because of a real week-long outage: Managed Prometheus held zero series while
 * every dashboard drew a flat line at zero, which reads as "healthy and quiet" rather than "this
 * pipeline is dead". Empty must be self-describing.
 */
export interface MetricResult {
  series: Series[];
  /** The provider that answered, so the UI can say WHICH store it is reading. */
  provider_id: string;
  /** Set when there is no data, explaining the difference between quiet and broken. */
  empty_reason?: 'no_data_in_window' | 'never_ingested' | 'not_supported' | 'query_failed';
  detail?: string;
}

export type Severity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

export interface LogEntry {
  timestamp: string;
  severity: Severity;
  message: string;
  labels: Record<string, string>;
  trace_id?: string;
  insert_id: string;
}

// ── Findings ───────────────────────────────────────────────────────────────────────────────────

export type FindingSeverity = 'critical' | 'warn' | 'info';

/**
 * Something the console noticed. REPORT-ONLY by construction — a finding carries a suggested action
 * and a route to the right workflow, and the console never acts on it by itself.
 */
export interface Finding {
  id: string;
  rule: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  env?: EnvKey;
  service_key?: ServiceKey;
  subject: string;
  /** Plain-language next step. Never performed automatically. */
  suggested_action: string;
  /** Where to go to actually do it, if there is a workflow for it. */
  action_pipeline?: { repo: string; pipeline_id: string };
  first_seen_at: string;
}

// ── The unified timeline ───────────────────────────────────────────────────────────────────────

/**
 * One event on one time axis.
 *
 * This type exists to answer the only question anybody actually asks during an incident: *what
 * changed just before this started?* Today answering it means opening GitHub, Cloud Run's revision
 * list and the log explorer in three tabs and comparing timestamps by eye. Every provider already
 * emits timestamped facts; the timeline is just the refusal to keep them in separate screens.
 */
export type TimelineKind = 'deploy' | 'pipeline' | 'finding' | 'infra_apply' | 'incident' | 'action';

export interface TimelineEvent {
  at: string;
  kind: TimelineKind;
  title: string;
  detail?: string;
  service_key?: ServiceKey;
  /** ok / failed / neutral — drives the colour, and nothing else. */
  outcome?: 'ok' | 'failed' | 'neutral';
  link?: string;
}

// ── Quota headroom ─────────────────────────────────────────────────────────────────────────────

/**
 * A ceiling somebody set once and nobody watches. Cloud Run `max_instances` was hardcoded to 10 in
 * forge's own service module — a limit that is invisible until the day traffic reaches it and
 * requests start queuing behind a cap nobody remembers choosing.
 *
 * `limit: null` is a first-class answer: when an API does not publish the ceiling, the console says
 * so. Inventing a plausible limit would make the headroom percentage a lie.
 */
export interface QuotaGauge {
  name: string;
  scope: string;
  used: number | null;
  limit: number | null;
  unit: string;
  detail: string;
  /** Only computable when both used and limit are known. */
  headroom_percent: number | null;
}

// ── Credentials / expiry ───────────────────────────────────────────────────────────────────────

export interface Credential {
  id: string;
  env: EnvKey;
  kind: 'secret' | 'tls_certificate' | 'api_token' | 'oauth_client' | 'service_account_key';
  name: string;
  created_at?: string;
  expires_at?: string;
  auto_renews: boolean;
  /** Some expiries no API exposes (a GitHub PAT). Those are declared, and marked as such. */
  source: 'discovered' | 'declared';
  detail?: string;
}

// ── Envelope ───────────────────────────────────────────────────────────────────────────────────

/**
 * Every API response carries freshness and per-source health. A console that shows stale data as if
 * it were live is the same failure class as a green check over a dead pipeline.
 */
export interface Envelope<T> {
  data: T;
  freshness: { as_of: string; source: 'live' | 'cache'; stale: boolean };
  sources: Array<{ provider_id: string; ok: boolean; error?: string }>;
  /**
   * Set when the answer is NARROWER than the question — e.g. a log query that hit its row limit and
   * therefore covers less time than was asked for. Rendered prominently, because a result silently
   * scoped to a fraction of the requested window produces confident, wrong all-clears.
   */
  note?: string;
}

export function envelope<T>(
  data: T,
  sources: Array<{ provider_id: string; ok: boolean; error?: string }> = [],
  opts: { as_of?: string; source?: 'live' | 'cache'; stale?: boolean; note?: string } = {},
): Envelope<T> {
  return {
    data,
    freshness: {
      as_of: opts.as_of ?? new Date().toISOString(),
      source: opts.source ?? 'live',
      stale: opts.stale ?? false,
    },
    sources,
    ...(opts.note ? { note: opts.note } : {}),
  };
}
