// Control-plane-only eval-results store — TypeScript contract types.
//
// This is the single contract that the UI (t1), read API/MCP tools (t4), publisher (t3), and
// Terraform (t6) build against. Nothing in dorinda-prod's serving path reads these tables;
// they live exclusively on the forge control-plane Cloud SQL instance.

// ---------------------------------------------------------------------------
// Domain shapes (what callers get back)
// ---------------------------------------------------------------------------

export interface EvalRun {
  run_id: string;
  tenant_id: string;
  canonical_url: string | null;
  provider: string | null;
  trigger_source: string | null;
  workflows_attempted: number;
  workflows_passed: number;
  workflows_failed: number;
  pass_rate: number | null; // 0.0–1.0; null until at least one workflow completes
  withheld_count: number;
  rejected_count: number;
  spend_cents: number; // total token spend in cents (stored, not computed)
  p50_duration_ms: number | null; // forge-hat duration bucket (p50)
  p99_duration_ms: number | null; // forge-hat duration bucket (p99)
  total_input_tokens: number;
  total_output_tokens: number;
  status: EvalRunStatus;
  started_at: string; // ISO-8601
  completed_at: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type EvalRunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export interface EvalWorkflow {
  id: string;
  run_id: string;
  workflow_id: string;
  tenant_id: string;
  verdict: WorkflowVerdict;
  integrity_class: IntegrityClass | null;
  prompt: string | null;
  duration_ms: number | null; // forge-hat duration capture
  started_at: string | null;
  completed_at: string | null;
  input_tokens: number;
  output_tokens: number;
  provider: string | null;
  lanes: string[]; // which provider(s) ran this workflow (e.g. ['openai', 'anthropic'])
  trials_total: number; // total trial attempts (0 if withheld before any trial ran)
  trials_passed: number; // passed trial count
  failing_bar: string | null; // key failing assertion text for the summary column
  meta: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * ⛔ `withheld` is not a failure. forge-hat's UNARMED / INFRA-FAIL mean the RIG failed and nothing
 * was tested, so no verdict exists. Collapsing it into `error` made the console display a blind run
 * as "✗ rejected" — telling the operator the product broke when the harness did.
 */
export type WorkflowVerdict = 'pass' | 'fail' | 'error' | 'skip' | 'withheld';
export type IntegrityClass = 'clean' | 'degraded' | 'corrupted' | 'unknown';

export interface EvalScene {
  id: string;
  workflow_id: string;
  run_id: string;
  scene_index: number;
  /** Which trial produced this scene. Scenes repeat per trial; the index alone is not unique. */
  trial: number;
  scene_name: string | null;
  assertions: SceneAssertion[];
  observed_values: ObservedValue[];
  passed: boolean | null;
  created_at: string;
}

export interface SceneAssertion {
  name: string;
  expected: unknown;
  operator: string; // e.g. 'eq', 'contains', 'matches', 'gt'
}

/**
 * One conversational turn — what was asked, and what the assistant visibly replied.
 *
 * ⛔ This is the CASSETTE. Before it existed, forge-hat captured the reply in every `host.turn` and
 * dropped it inside the container, so the console's cassette panel had no transcript to show and
 * displayed a hardcoded "Use Dorinda." with nothing beneath it — a fabricated prompt presented as a
 * record. An acceptance harness whose transcript is a mock cannot be used to judge a verdict.
 */
export interface EvalTurn {
  id: string;
  workflow_id: string;
  run_id: string;
  turn_index: number;
  /** Which attempt (conversation) this turn belongs to, 1-based. */
  attempt: number;
  scene: string | null;
  prompt: string;
  reply: string;
  tool_calls: TurnToolCall[];
  /**
   * The tool trace could not be READ — an expired session, an unparseable timeline. Distinct from
   * an empty trace: "the assistant called nothing" and "nobody could see what it called" are
   * opposite facts, and conflating them is how a blind run reads as a clean one.
   */
  tool_trace_unreadable: boolean;
  created_at: string;
}

export interface TurnToolCall {
  tool: string;
  ok?: boolean;
  summary?: string;
}

export interface EvalTurnInput {
  id: string;
  workflow_id: string;
  run_id: string;
  turn_index: number;
  attempt?: number;
  scene?: string;
  prompt: string;
  reply: string;
  tool_calls?: TurnToolCall[];
  tool_trace_unreadable?: boolean;
}

export interface ObservedValue {
  name: string;
  value: unknown;
}

export interface EvalMcpCall {
  id: string;
  workflow_id: string;
  run_id: string;
  call_index: number;
  tool_name: string;
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  duration_ms: number | null; // forge-hat duration capture per call
  error: string | null;
  called_at: string | null;
  created_at: string;
}

export interface EvalClaim {
  id: string;
  workflow_id: string;
  run_id: string;
  claim_index: number;
  claim_type: string | null;
  claim_text: string | null;
  verdict: ClaimVerdict | null;
  evidence: Record<string, unknown>;
  cassette: Record<string, unknown>; // structured cassette content
  created_at: string;
}

export type ClaimVerdict = 'verified' | 'refuted' | 'unverifiable';

export interface TenantLease {
  holder: string; // identifier of the process/host that holds the lease
  source: string; // human-readable source tag (hostname, pod name, etc.)
  since: string; // ISO-8601 — when this holder acquired the lease
  heartbeat: string; // ISO-8601 — last heartbeat from the holder
}

// ---------------------------------------------------------------------------
// Input types (what callers pass in)
// ---------------------------------------------------------------------------

export interface EvalRunInput {
  run_id: string;
  tenant_id: string;
  canonical_url?: string;
  provider?: string;
  trigger_source?: string;
  started_at?: string; // defaults to now()
  meta?: Record<string, unknown>;
}

export interface EvalRunUpdate {
  workflows_attempted?: number;
  workflows_passed?: number;
  workflows_failed?: number;
  pass_rate?: number;
  withheld_count?: number;
  rejected_count?: number;
  spend_cents?: number;
  p50_duration_ms?: number;
  p99_duration_ms?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  status?: EvalRunStatus;
  completed_at?: string;
  meta?: Record<string, unknown>;
}

export interface EvalWorkflowInput {
  id: string;
  run_id: string;
  workflow_id: string;
  tenant_id: string;
  verdict: WorkflowVerdict;
  integrity_class?: IntegrityClass;
  prompt?: string;
  duration_ms?: number;
  started_at?: string;
  completed_at?: string;
  input_tokens?: number;
  output_tokens?: number;
  provider?: string;
  lanes?: string[];
  trials_total?: number;
  trials_passed?: number;
  failing_bar?: string;
  meta?: Record<string, unknown>;
}

export interface EvalSceneInput {
  id: string;
  workflow_id: string;
  run_id: string;
  scene_index: number;
  trial?: number;
  scene_name?: string;
  assertions?: SceneAssertion[];
  observed_values?: ObservedValue[];
  passed?: boolean;
}

export interface EvalMcpCallInput {
  id: string;
  workflow_id: string;
  run_id: string;
  call_index: number;
  tool_name: string;
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  duration_ms?: number;
  error?: string;
  called_at?: string;
}

export interface EvalClaimInput {
  id: string;
  workflow_id: string;
  run_id: string;
  claim_index: number;
  claim_type?: string;
  claim_text?: string;
  verdict?: ClaimVerdict;
  evidence?: Record<string, unknown>;
  cassette?: Record<string, unknown>;
}

export interface TenantLeaseInput {
  holder: string;
  source: string;
  /** Seconds before a stale heartbeat can be stolen. Default: 60. */
  staleAfterSeconds?: number;
}

// ---------------------------------------------------------------------------
// Backend interface (the stable contract all tiers depend on)
// ---------------------------------------------------------------------------

/**
 * One offerable workflow.
 *
 * `requires` is forge-hat's OWN answer about which providers can run it — computed by the same
 * `providerRequirement` that `providerPlansFor` uses to build the run plans. It is deliberately NOT
 * the raw `ai:` declaration: re-deriving that rule on this side would put the two halves of one
 * contract in different repositories, which is where drift is hardest to see and most expensive.
 *
 *   'any'        runs on whichever providers are selected
 *   'openai'     only on openai      (`ai: chatgpt`)
 *   'anthropic'  only on anthropic   (`ai: claude`)
 *   'both'       cross-host — needs BOTH selected, executes as one spanning plan
 */
export type CatalogueEntry = {
  workflow_id: string;
  name: string;
  requires: 'any' | 'openai' | 'anthropic' | 'both';
  tags: string[];
  suites: string[];
  family: string | null;
  /** Present in the repo at the configured ref — "this workflow exists". */
  in_main: boolean;
  /**
   * Present at the commit the running e2e-runner image was built from — "this can execute now".
   *
   * ⛔ TRI-STATE. `null` means undetermined (the job carries no HAT_COMMIT, or a read failed), and
   * the picker treats that as selectable-with-a-caveat. Collapsing null into false would block
   * every workflow the moment one job spec became unreadable.
   */
  in_runner: boolean | null;
  updated_at: Date;
};

/** What the last catalogue sync saw. One row; `error` set means it failed and the rows are stale. */
export type CatalogueSync = {
  repo: string | null;
  main_ref: string | null;
  main_commit: string | null;
  runner_commit: string | null;
  runner_version: string | null;
  workflows_main: number | null;
  workflows_runner: number | null;
  synced_at: Date | null;
  error: string | null;
};

export type CatalogueSyncInput = Partial<Omit<CatalogueSync, 'synced_at'>>;

export type CatalogueEntryInput = {
  workflow_id: string;
  name?: string;
  requires?: 'any' | 'openai' | 'anthropic' | 'both';
  tags?: string[];
  suites?: string[];
  family?: string | null;
  in_main?: boolean;
  /** Omit (undefined) for "undetermined" — deliberately distinct from false. */
  in_runner?: boolean;
};

export interface CpResultsBackend {
  // --- The catalogue ------------------------------------------------------

  /**
   * Replace the whole catalogue with a freshly published manifest. Returns rows written.
   * An EMPTY manifest is ignored — see the implementation for why that is deliberate.
   */
  replaceCatalogue(entries: CatalogueEntryInput[]): Promise<number>;

  /** Every offerable workflow, ordered by id. */
  listCatalogue(): Promise<CatalogueEntry[]>;

  /** What the last sync saw; null when none has ever run. */
  getCatalogueSync(): Promise<CatalogueSync | null>;

  /** Record a sync outcome — including a failure, which must be visible rather than silent. */
  setCatalogueSync(s: CatalogueSyncInput): Promise<void>;

  /** Operator-owned settings only. Provisioned values come from the environment, read-only. */
  getSettings(): Promise<Record<string, string>>;
  setSetting(key: string, value: string, updatedBy: string): Promise<void>;

  // --- Run-level metrics --------------------------------------------------

  /** Insert or update a run row (idempotent on run_id). */
  upsertRun(input: EvalRunInput): Promise<EvalRun>;

  /** Patch run-level aggregate metrics. Returns null if run_id not found. */
  updateRun(runId: string, update: EvalRunUpdate): Promise<EvalRun | null>;

  /** Fetch a single run by run_id. */
  getRun(runId: string): Promise<EvalRun | null>;

  /** List runs for a tenant, newest-first. */
  listRuns(tenantId: string, limit?: number): Promise<EvalRun[]>;

  /**
   * Delete a run and ALL child records (workflows, scenes, MCP calls, claims) atomically.
   *
   * Child tables carry ON DELETE CASCADE FKs so a single DELETE on forge_cp_eval_runs is the
   * whole transaction. Returns true when the run existed and was deleted; false when it was not
   * found. The caller is responsible for refusing a run whose status is 'running' BEFORE calling
   * this — the store deletes without checking state.
   */
  deleteRun(runId: string): Promise<boolean>;

  // --- Per-workflow drilldown ---------------------------------------------

  /** Insert a workflow row. Idempotent on id (ON CONFLICT DO NOTHING). */
  insertWorkflow(input: EvalWorkflowInput): Promise<EvalWorkflow>;

  /** Fetch a single workflow row. */
  getWorkflow(id: string): Promise<EvalWorkflow | null>;

  /** List all workflows for a run, by insertion order. */
  listWorkflows(runId: string): Promise<EvalWorkflow[]>;

  // --- Scenes (assertions + observed values) ------------------------------

  /** Insert a scene row. Idempotent on (workflow_id, scene_index). */
  insertScene(input: EvalSceneInput): Promise<EvalScene>;

  /** List all scenes for a workflow, ordered by scene_index. */
  listScenes(workflowId: string): Promise<EvalScene[]>;

  // --- Conversation turns (the cassette) ----------------------------------

  /** Insert a turn row. Idempotent on (workflow_id, turn_index). */
  insertTurn(input: EvalTurnInput): Promise<EvalTurn>;

  /** List all turns for a workflow, ordered by turn_index. */
  listTurns(workflowId: string): Promise<EvalTurn[]>;

  // --- MCP tool calls + responses -----------------------------------------

  /** Insert an MCP call row. Idempotent on (workflow_id, call_index). */
  insertMcpCall(input: EvalMcpCallInput): Promise<EvalMcpCall>;

  /** List all MCP calls for a workflow, ordered by call_index. */
  listMcpCalls(workflowId: string): Promise<EvalMcpCall[]>;

  // --- Extracted claims / cassette content --------------------------------

  /** Insert a claim row. Idempotent on (workflow_id, claim_index). */
  insertClaim(input: EvalClaimInput): Promise<EvalClaim>;

  /** List all claims for a workflow, ordered by claim_index. */
  listClaims(workflowId: string): Promise<EvalClaim[]>;

  // --- Tenant lease (single-row cross-host lock) --------------------------

  /**
   * Attempt to acquire the single tenant-lease row.
   * Returns the lease if acquired; null if a live holder already owns it.
   * Steals the lease only when the current holder's heartbeat is stale
   * (older than `input.staleAfterSeconds`, default 60 s).
   */
  acquireLease(input: TenantLeaseInput): Promise<TenantLease | null>;

  /**
   * Renew the heartbeat timestamp.
   * Returns true if the caller is the current holder; false otherwise.
   */
  renewLease(holder: string): Promise<boolean>;

  /**
   * Release the lease (only succeeds if caller is the current holder).
   * Returns true if released; false if caller is not the holder.
   */
  releaseLease(holder: string): Promise<boolean>;

  /** Read the current lease row (null if no lease exists). */
  getLease(): Promise<TenantLease | null>;

  // --- Utilities ----------------------------------------------------------
  __truncateAllForTests(): Promise<void>;
  close?(): Promise<void>;
}
