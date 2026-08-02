/**
 * forge-console — the provider contracts.
 *
 * ⛔ NO VENDOR TYPE MAY APPEAR ABOVE THIS LINE. Everything here is expressed in the neutral domain
 * model; `src/plugins/console-gcp/*` and `src/plugins/console-github/*` are the only files allowed
 * to know what a Cloud Run service or a GitHub workflow is.
 *
 * Each interface is small and separately implementable, so a provider can serve one capability
 * without pretending to serve the rest. `supports()` is how a provider says so HONESTLY — the UI
 * greys out what a provider cannot do rather than showing an empty screen.
 */
import type {
  Credential,
  EnvKey,
  InfraResource,
  LogEntry,
  MetricIntent,
  MetricResult,
  Pipeline,
  PipelineRun,
  QuotaGauge,
  Revision,
  Severity,
} from '../domain';

export type ProviderKind =
  'inventory' | 'runtime' | 'metrics' | 'logs' | 'pipelines' | 'credentials' | 'cost' | 'alerts' | 'drift';

export type Feature =
  | 'inventory.list'
  | 'runtime.revisions'
  | 'runtime.rollback_targets'
  | 'metrics.intent'
  | 'metrics.native'
  | 'logs.query'
  | 'pipelines.list'
  | 'pipelines.runs'
  | 'pipelines.dispatch'
  | 'credentials.list'
  | 'cost.actuals'
  | 'cost.budgets'
  | 'alerts.policies'
  | 'alerts.incidents'
  | 'drift.stacks';

export interface ProviderContext {
  env: EnvKey;
  /** Deadline propagation — a slow provider must never hang a page. */
  signal: AbortSignal;
  now: Date;
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
  checked_at: string;
}

export interface Provider {
  readonly id: string; // instance id: 'gcp-prod-a'
  readonly type: string; // factory type: 'gcp.inventory'
  readonly kind: ProviderKind;
  readonly label: string;
  readonly envs: EnvKey[];
  supports(f: Feature): boolean;
  health(ctx: ProviderContext): Promise<ProviderHealth>;
  /**
   * Ceilings this provider knows about its own plane (API rate budget, CI minutes). Optional
   * because most providers have none — a provider volunteers only what it can measure, so the
   * quota screen never has to guess a limit on a provider's behalf.
   */
  quotas?(ctx: ProviderContext): Promise<QuotaGauge[]>;
}

/** Providers throw this so the aggregator can degrade one source without blanking the page. */
export class ProviderError extends Error {
  constructor(
    readonly provider_id: string,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

// ── Inventory ──────────────────────────────────────────────────────────────────────────────────

export interface InventoryProvider extends Provider {
  kind: 'inventory';
  list(ctx: ProviderContext): Promise<InfraResource[]>;
}

// ── Runtime (READ-ONLY BY DESIGN) ──────────────────────────────────────────────────────────────

/**
 * There is deliberately NO mutate method here.
 *
 * "The console must not mutate the cloud directly" is enforced two ways: this interface offers no
 * way to, and the console's cloud identity holds only viewer roles. A rollback is a PIPELINE
 * dispatch — which means it goes through CI, gets the read-back and behaviour gate, and leaves a
 * real run URL as its receipt.
 */
export interface RuntimeProvider extends Provider {
  kind: 'runtime';
  listRevisions(runtimeId: string, ctx: ProviderContext): Promise<Revision[]>;
}

// ── Metrics ────────────────────────────────────────────────────────────────────────────────────

export interface MetricTarget {
  /** The runtime object being measured, e.g. a Cloud Run service name. */
  runtime_id: string;
  env: EnvKey;
}

export interface MetricRange {
  start: Date;
  end: Date;
  step_seconds: number;
}

export interface MetricsProvider extends Provider {
  kind: 'metrics';
  /** Honest capability reporting: not every store can answer every intent. */
  supportsIntent(i: MetricIntent, t: MetricTarget): boolean;
  query(i: MetricIntent, t: MetricTarget, r: MetricRange, ctx: ProviderContext): Promise<MetricResult>;
  /** Escape hatch for the explore screen, gated by `metrics.native`. */
  queryNative?(expr: string, r: MetricRange, ctx: ProviderContext): Promise<MetricResult>;
  /**
   * Is this store receiving anything at all? Distinct from any single metric being empty — a quiet
   * metric is normal, an empty STORE is an outage. Optional: a store with no pipeline in front of
   * it (Cloud Monitoring) has nothing to answer.
   */
  isIngesting?(ctx: ProviderContext): Promise<boolean>;
}

// ── Logs ───────────────────────────────────────────────────────────────────────────────────────

export interface LogQuery {
  runtime_id?: string;
  text?: string;
  severity_at_least?: Severity;
  trace_id?: string;
  /**
   * The account this work belongs to — an opaque OWNER ID, never an email.
   *
   * Apps write only the id into their logs, because log stores retain entries outside the app's
   * database and an email written there would survive the account being deleted. The console shows
   * a list of emails and resolves the chosen one to an id before asking, so the operator experience
   * is identical while the durable artefact carries no personal data.
   */
  owner?: string;
  native?: string;
}

export interface LogsProvider extends Provider {
  kind: 'logs';
  query(q: LogQuery, r: { start: Date; end: Date; limit: number }, ctx: ProviderContext): Promise<LogEntry[]>;
}

// ── Pipelines — the ONLY interface with writes ─────────────────────────────────────────────────

export interface PipelinesProvider extends Provider {
  kind: 'pipelines';
  listPipelines(ctx: ProviderContext): Promise<Pipeline[]>;
  listRuns(o: { pipeline_id?: string; limit: number }, ctx: ProviderContext): Promise<PipelineRun[]>;
  /**
   * The single write in the whole provider surface. Callers must go through
   * `performWriteAction()` so the audit row is written BEFORE the attempt.
   */
  dispatch(
    pipelineId: string,
    o: { ref: string; inputs: Record<string, string> },
    ctx: ProviderContext,
  ): Promise<{ url: string; accepted_at: string }>;
}

// ── Credentials / expiry ───────────────────────────────────────────────────────────────────────

export interface CredentialsProvider extends Provider {
  kind: 'credentials';
  list(ctx: ProviderContext): Promise<Credential[]>;
}

// ── Registry ───────────────────────────────────────────────────────────────────────────────────

export interface ProviderRegistry {
  all(): Provider[];
  byKind<K extends ProviderKind>(kind: K, env?: EnvKey): Provider[];
  byId(id: string): Provider | undefined;
}

export function createRegistry(providers: Provider[]): ProviderRegistry {
  return {
    all: () => providers.slice(),
    byKind: (kind, env) =>
      providers.filter((p) => p.kind === kind && (env === undefined || p.envs.includes(env))),
    byId: (id) => providers.find((p) => p.id === id),
  };
}

/**
 * Run the same call across every provider of a kind, degrading rather than failing.
 *
 * One dead provider must cost you that provider's rows, never the whole page — the console's job is
 * to keep telling you what it DOES know while being explicit about what it does not.
 */
export async function aggregate<P extends Provider, T>(
  providers: P[],
  fn: (p: P) => Promise<T[]>,
): Promise<{ items: T[]; sources: Array<{ provider_id: string; ok: boolean; error?: string }> }> {
  const settled = await Promise.allSettled(providers.map((p) => fn(p)));
  const items: T[] = [];
  const sources: Array<{ provider_id: string; ok: boolean; error?: string }> = [];
  settled.forEach((r, i) => {
    const p = providers[i]!;
    if (r.status === 'fulfilled') {
      items.push(...r.value);
      sources.push({ provider_id: p.id, ok: true });
    } else {
      sources.push({ provider_id: p.id, ok: false, error: String(r.reason?.message ?? r.reason) });
    }
  });
  return { items, sources };
}
