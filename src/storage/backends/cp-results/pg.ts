import type { Pool } from 'pg';
import { nowIso } from '../../../shared/time';
import type {
  CpResultsBackend,
  EvalRun,
  EvalRunInput,
  EvalRunUpdate,
  EvalWorkflow,
  EvalWorkflowInput,
  EvalScene,
  EvalSceneInput,
  EvalMcpCall,
  EvalMcpCallInput,
  EvalClaim,
  EvalClaimInput,
  TenantLease,
  TenantLeaseInput,
} from './types';

// Control-plane-only Postgres results store.
//
// Five tables:
//   forge_cp_eval_runs       — run-level metrics (one row per suite run)
//   forge_cp_eval_workflows  — per-workflow drilldown (verdict, integrity, prompt, duration)
//   forge_cp_eval_scenes     — scene assertions + observed values per workflow
//   forge_cp_eval_mcp_calls  — every MCP tool call and response per workflow
//   forge_cp_eval_claims     — extracted claims / structured cassette content per workflow
//
// Plus the single-row cross-host lock:
//   forge_cp_tenant_lease    — one row (id = 1); the lease holder heartbeats to keep it.
//
// All inserts into the drilldown / scene / call / claim tables are idempotent via ON CONFLICT DO NOTHING.
// Run upserts use ON CONFLICT (run_id) DO UPDATE. The lease acquire uses a conditional ON CONFLICT
// UPDATE that only steals when the heartbeat is older than `stale_after_seconds`.
//
// Schema is the single contract: UI (t1), read API/MCP tools (t4), publisher (t3), and Terraform (t6)
// build against these table shapes. This database is control-plane only — nothing in dorinda-prod's
// serving path reads it.

export async function ensureCpResultsSchema(pool: Pool): Promise<void> {
  await pool.query(`
    -- -----------------------------------------------------------------------
    -- Run-level metrics: one row per eval suite run.
    -- Aggregates (pass_rate, p50/p99, token spend, withheld/rejected) are
    -- written by the publisher (t3) after all workflows complete.
    -- -----------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS forge_cp_eval_runs (
      run_id              text PRIMARY KEY,
      tenant_id           text NOT NULL,
      canonical_url       text,
      provider            text,
      trigger_source      text,
      workflows_attempted int         NOT NULL DEFAULT 0,
      workflows_passed    int         NOT NULL DEFAULT 0,
      workflows_failed    int         NOT NULL DEFAULT 0,
      pass_rate           numeric(7,4),               -- 0.0000–1.0000; null until first workflow completes
      withheld_count      int         NOT NULL DEFAULT 0,
      rejected_count      int         NOT NULL DEFAULT 0,
      p50_duration_ms     bigint,                     -- forge-hat duration bucket (p50), milliseconds
      p99_duration_ms     bigint,                     -- forge-hat duration bucket (p99), milliseconds
      total_input_tokens  bigint      NOT NULL DEFAULT 0,
      total_output_tokens bigint      NOT NULL DEFAULT 0,
      status              text        NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running','completed','failed','aborted')),
      started_at          timestamptz NOT NULL DEFAULT now(),
      completed_at        timestamptz,
      meta                jsonb       NOT NULL DEFAULT '{}',
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS forge_cp_eval_runs_tenant_at
      ON forge_cp_eval_runs (tenant_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS forge_cp_eval_runs_running
      ON forge_cp_eval_runs (status) WHERE status = 'running';

    -- -----------------------------------------------------------------------
    -- Per-workflow drilldown: verdict, integrity class, prompt, duration.
    -- Duration fields receive forge-hat's per-workflow timing.
    -- -----------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS forge_cp_eval_workflows (
      id                text        PRIMARY KEY,
      run_id            text        NOT NULL REFERENCES forge_cp_eval_runs(run_id) ON DELETE CASCADE,
      workflow_id       text        NOT NULL,
      tenant_id         text        NOT NULL,
      verdict           text        NOT NULL
                          CHECK (verdict IN ('pass','fail','error','skip')),
      integrity_class   text
                          CHECK (integrity_class IN ('clean','degraded','corrupted','unknown')),
      prompt            text,
      duration_ms       bigint,                       -- forge-hat duration capture (wall-clock, ms)
      started_at        timestamptz,
      completed_at      timestamptz,
      input_tokens      bigint      NOT NULL DEFAULT 0,
      output_tokens     bigint      NOT NULL DEFAULT 0,
      provider          text,
      meta              jsonb       NOT NULL DEFAULT '{}',
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS forge_cp_eval_workflows_run
      ON forge_cp_eval_workflows (run_id, created_at);
    CREATE INDEX IF NOT EXISTS forge_cp_eval_workflows_tenant_at
      ON forge_cp_eval_workflows (tenant_id, created_at DESC);

    -- -----------------------------------------------------------------------
    -- Per-scene assertions + observed values.
    -- Unique on (workflow_id, scene_index) — re-inserting the same scene is
    -- safe (idempotent ON CONFLICT DO NOTHING).
    -- -----------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS forge_cp_eval_scenes (
      id               text        PRIMARY KEY,
      workflow_id      text        NOT NULL REFERENCES forge_cp_eval_workflows(id) ON DELETE CASCADE,
      run_id           text        NOT NULL,
      scene_index      int         NOT NULL,
      scene_name       text,
      assertions       jsonb       NOT NULL DEFAULT '[]',  -- [{name, expected, operator}]
      observed_values  jsonb       NOT NULL DEFAULT '[]',  -- [{name, value}]
      passed           boolean,
      created_at       timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workflow_id, scene_index)
    );
    CREATE INDEX IF NOT EXISTS forge_cp_eval_scenes_workflow
      ON forge_cp_eval_scenes (workflow_id, scene_index);

    -- -----------------------------------------------------------------------
    -- Every MCP tool call and response per workflow (the interaction log).
    -- duration_ms receives forge-hat's per-call timing.
    -- Unique on (workflow_id, call_index) — idempotent re-insert is safe.
    -- -----------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS forge_cp_eval_mcp_calls (
      id            text        PRIMARY KEY,
      workflow_id   text        NOT NULL REFERENCES forge_cp_eval_workflows(id) ON DELETE CASCADE,
      run_id        text        NOT NULL,
      call_index    int         NOT NULL,
      tool_name     text        NOT NULL,
      request       jsonb       NOT NULL DEFAULT '{}',
      response      jsonb,
      duration_ms   bigint,                             -- forge-hat per-call timing, ms
      error         text,
      called_at     timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workflow_id, call_index)
    );
    CREATE INDEX IF NOT EXISTS forge_cp_eval_mcp_calls_workflow
      ON forge_cp_eval_mcp_calls (workflow_id, call_index);

    -- -----------------------------------------------------------------------
    -- Extracted claims and structured cassette content per workflow.
    -- cassette column holds the structured VCR-style cassette: full prompt +
    -- model response sequence (the "cassette content" the task requires).
    -- Unique on (workflow_id, claim_index) — idempotent re-insert is safe.
    -- -----------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS forge_cp_eval_claims (
      id            text        PRIMARY KEY,
      workflow_id   text        NOT NULL REFERENCES forge_cp_eval_workflows(id) ON DELETE CASCADE,
      run_id        text        NOT NULL,
      claim_index   int         NOT NULL,
      claim_type    text,
      claim_text    text,
      verdict       text
                      CHECK (verdict IN ('verified','refuted','unverifiable')),
      evidence      jsonb       NOT NULL DEFAULT '{}',
      cassette      jsonb       NOT NULL DEFAULT '{}',  -- structured cassette content
      created_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workflow_id, claim_index)
    );
    CREATE INDEX IF NOT EXISTS forge_cp_eval_claims_workflow
      ON forge_cp_eval_claims (workflow_id, claim_index);

    -- -----------------------------------------------------------------------
    -- Tenant lease — single row (id = 1 always).
    -- A runner acquires this row before starting tenant work. The conditional
    -- ON CONFLICT UPDATE in acquireLease() only steals the row when the
    -- heartbeat is stale, making this row the cross-host lock's authority.
    -- -----------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS forge_cp_tenant_lease (
      id        int         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      holder    text        NOT NULL,
      source    text        NOT NULL,
      since     timestamptz NOT NULL DEFAULT now(),
      heartbeat timestamptz NOT NULL DEFAULT now()
    );

    -- -----------------------------------------------------------------------
    -- Additive migrations: add new columns to existing tables if missing.
    -- These run every startup — IF NOT EXISTS / IF NOT COLUMN EXISTS guards
    -- against re-running on fresh databases that already have the columns.
    -- -----------------------------------------------------------------------
    ALTER TABLE forge_cp_eval_workflows
      ADD COLUMN IF NOT EXISTS lanes         text[]  NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS trials_total  int     NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS trials_passed int     NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS failing_bar   text;

    ALTER TABLE forge_cp_eval_runs
      ADD COLUMN IF NOT EXISTS spend_cents bigint NOT NULL DEFAULT 0;
  `);
}

// ---------------------------------------------------------------------------
// Row → domain-type converters
// ---------------------------------------------------------------------------

interface RunRow {
  run_id: string;
  tenant_id: string;
  canonical_url: string | null;
  provider: string | null;
  trigger_source: string | null;
  workflows_attempted: number | string;
  workflows_passed: number | string;
  workflows_failed: number | string;
  pass_rate: string | null;
  withheld_count: number | string;
  rejected_count: number | string;
  spend_cents: string | null;
  p50_duration_ms: string | null;
  p99_duration_ms: string | null;
  total_input_tokens: string | null;
  total_output_tokens: string | null;
  status: string;
  started_at: Date | string;
  completed_at: Date | string | null;
  meta: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(v: Date | string | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

function toBigInt(v: string | number | null | undefined): number {
  if (v == null) return 0;
  return Number(v);
}

function rowToRun(r: RunRow): EvalRun {
  return {
    run_id: r.run_id,
    tenant_id: r.tenant_id,
    canonical_url: r.canonical_url,
    provider: r.provider,
    trigger_source: r.trigger_source,
    workflows_attempted: Number(r.workflows_attempted),
    workflows_passed: Number(r.workflows_passed),
    workflows_failed: Number(r.workflows_failed),
    pass_rate: r.pass_rate != null ? Number(r.pass_rate) : null,
    withheld_count: Number(r.withheld_count),
    rejected_count: Number(r.rejected_count),
    spend_cents: r.spend_cents != null ? Number(r.spend_cents) : 0,
    p50_duration_ms: r.p50_duration_ms != null ? Number(r.p50_duration_ms) : null,
    p99_duration_ms: r.p99_duration_ms != null ? Number(r.p99_duration_ms) : null,
    total_input_tokens: toBigInt(r.total_input_tokens),
    total_output_tokens: toBigInt(r.total_output_tokens),
    status: r.status as EvalRun['status'],
    started_at: toIso(r.started_at)!,
    completed_at: toIso(r.completed_at),
    meta: (r.meta as Record<string, unknown>) ?? {},
    created_at: toIso(r.created_at)!,
    updated_at: toIso(r.updated_at)!,
  };
}

interface WorkflowRow {
  id: string;
  run_id: string;
  workflow_id: string;
  tenant_id: string;
  verdict: string;
  integrity_class: string | null;
  prompt: string | null;
  duration_ms: string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  provider: string | null;
  lanes: string[] | null;
  trials_total: number | string | null;
  trials_passed: number | string | null;
  failing_bar: string | null;
  meta: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function rowToWorkflow(r: WorkflowRow): EvalWorkflow {
  return {
    id: r.id,
    run_id: r.run_id,
    workflow_id: r.workflow_id,
    tenant_id: r.tenant_id,
    verdict: r.verdict as EvalWorkflow['verdict'],
    integrity_class: (r.integrity_class as EvalWorkflow['integrity_class']) ?? null,
    prompt: r.prompt,
    duration_ms: r.duration_ms != null ? Number(r.duration_ms) : null,
    started_at: toIso(r.started_at),
    completed_at: toIso(r.completed_at),
    input_tokens: toBigInt(r.input_tokens),
    output_tokens: toBigInt(r.output_tokens),
    provider: r.provider,
    lanes: Array.isArray(r.lanes) ? r.lanes : [],
    trials_total: r.trials_total != null ? Number(r.trials_total) : 0,
    trials_passed: r.trials_passed != null ? Number(r.trials_passed) : 0,
    failing_bar: r.failing_bar ?? null,
    meta: (r.meta as Record<string, unknown>) ?? {},
    created_at: toIso(r.created_at)!,
    updated_at: toIso(r.updated_at)!,
  };
}

interface SceneRow {
  id: string;
  workflow_id: string;
  run_id: string;
  scene_index: number | string;
  scene_name: string | null;
  assertions: unknown;
  observed_values: unknown;
  passed: boolean | null;
  created_at: Date | string;
}

function rowToScene(r: SceneRow): EvalScene {
  return {
    id: r.id,
    workflow_id: r.workflow_id,
    run_id: r.run_id,
    scene_index: Number(r.scene_index),
    scene_name: r.scene_name,
    assertions: (r.assertions as EvalScene['assertions']) ?? [],
    observed_values: (r.observed_values as EvalScene['observed_values']) ?? [],
    passed: r.passed,
    created_at: toIso(r.created_at)!,
  };
}

interface McpCallRow {
  id: string;
  workflow_id: string;
  run_id: string;
  call_index: number | string;
  tool_name: string;
  request: unknown;
  response: unknown | null;
  duration_ms: string | null;
  error: string | null;
  called_at: Date | string | null;
  created_at: Date | string;
}

function rowToMcpCall(r: McpCallRow): EvalMcpCall {
  return {
    id: r.id,
    workflow_id: r.workflow_id,
    run_id: r.run_id,
    call_index: Number(r.call_index),
    tool_name: r.tool_name,
    request: (r.request as Record<string, unknown>) ?? {},
    response: r.response != null ? (r.response as Record<string, unknown>) : null,
    duration_ms: r.duration_ms != null ? Number(r.duration_ms) : null,
    error: r.error,
    called_at: toIso(r.called_at),
    created_at: toIso(r.created_at)!,
  };
}

interface ClaimRow {
  id: string;
  workflow_id: string;
  run_id: string;
  claim_index: number | string;
  claim_type: string | null;
  claim_text: string | null;
  verdict: string | null;
  evidence: unknown;
  cassette: unknown;
  created_at: Date | string;
}

function rowToClaim(r: ClaimRow): EvalClaim {
  return {
    id: r.id,
    workflow_id: r.workflow_id,
    run_id: r.run_id,
    claim_index: Number(r.claim_index),
    claim_type: r.claim_type,
    claim_text: r.claim_text,
    verdict: (r.verdict as EvalClaim['verdict']) ?? null,
    evidence: (r.evidence as Record<string, unknown>) ?? {},
    cassette: (r.cassette as Record<string, unknown>) ?? {},
    created_at: toIso(r.created_at)!,
  };
}

interface LeaseRow {
  holder: string;
  source: string;
  since: Date | string;
  heartbeat: Date | string;
}

function rowToLease(r: LeaseRow): TenantLease {
  return {
    holder: r.holder,
    source: r.source,
    since: toIso(r.since)!,
    heartbeat: toIso(r.heartbeat)!,
  };
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

const DEFAULT_STALE_SECONDS = 60;
const DEFAULT_RUN_LIST_LIMIT = 100;

export class PgCpResultsBackend implements CpResultsBackend {
  constructor(private readonly pool: Pool) {}

  // --- Run-level -----------------------------------------------------------

  async upsertRun(input: EvalRunInput): Promise<EvalRun> {
    const now = nowIso();
    const r = await this.pool.query<RunRow>(
      `INSERT INTO forge_cp_eval_runs
         (run_id, tenant_id, canonical_url, provider, trigger_source, started_at, meta, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now()),$7::jsonb,$8::timestamptz,$9::timestamptz)
       ON CONFLICT (run_id) DO UPDATE
         SET canonical_url  = COALESCE(EXCLUDED.canonical_url, forge_cp_eval_runs.canonical_url),
             provider       = COALESCE(EXCLUDED.provider,      forge_cp_eval_runs.provider),
             trigger_source = COALESCE(EXCLUDED.trigger_source,forge_cp_eval_runs.trigger_source),
             meta           = forge_cp_eval_runs.meta || EXCLUDED.meta,
             updated_at     = now()
       RETURNING *`,
      [
        input.run_id,
        input.tenant_id,
        input.canonical_url ?? null,
        input.provider ?? null,
        input.trigger_source ?? null,
        input.started_at ?? null,
        JSON.stringify(input.meta ?? {}),
        now,
        now,
      ],
    );
    return rowToRun(r.rows[0]!);
  }

  async updateRun(runId: string, update: EvalRunUpdate): Promise<EvalRun | null> {
    // Build a CASE-based partial UPDATE so null fields don't overwrite good data.
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [runId];
    let i = 2;

    function addSet(col: string, val: unknown, cast?: string) {
      if (val === undefined) return;
      sets.push(`${col} = $${i}${cast ? `::${cast}` : ''}`);
      params.push(val);
      i++;
    }

    addSet('workflows_attempted', update.workflows_attempted);
    addSet('workflows_passed', update.workflows_passed);
    addSet('workflows_failed', update.workflows_failed);
    addSet('pass_rate', update.pass_rate);
    addSet('withheld_count', update.withheld_count);
    addSet('rejected_count', update.rejected_count);
    addSet('spend_cents', update.spend_cents);
    addSet('p50_duration_ms', update.p50_duration_ms);
    addSet('p99_duration_ms', update.p99_duration_ms);
    addSet('total_input_tokens', update.total_input_tokens);
    addSet('total_output_tokens', update.total_output_tokens);
    addSet('status', update.status);
    addSet('completed_at', update.completed_at ?? null, 'timestamptz');
    if (update.meta !== undefined) {
      sets.push(`meta = meta || $${i}::jsonb`);
      params.push(JSON.stringify(update.meta));
      i++;
    }

    const r = await this.pool.query<RunRow>(
      `UPDATE forge_cp_eval_runs SET ${sets.join(', ')} WHERE run_id = $1 RETURNING *`,
      params,
    );
    return r.rows[0] ? rowToRun(r.rows[0]) : null;
  }

  async getRun(runId: string): Promise<EvalRun | null> {
    const r = await this.pool.query<RunRow>('SELECT * FROM forge_cp_eval_runs WHERE run_id = $1', [runId]);
    return r.rows[0] ? rowToRun(r.rows[0]) : null;
  }

  async listRuns(tenantId: string, limit: number = DEFAULT_RUN_LIST_LIMIT): Promise<EvalRun[]> {
    const r = await this.pool.query<RunRow>(
      'SELECT * FROM forge_cp_eval_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT $2',
      [tenantId, limit],
    );
    return r.rows.map(rowToRun);
  }

  /**
   * List runs across ALL tenants (operator / console read-path).
   *
   * Not part of the `CpResultsBackend` interface (which is per-tenant): this method is for the
   * forge-console read API and MCP tools that serve the OPERATOR view across the entire estate.
   * Optional tenant / status filters narrow the result; limit is capped at 100.
   */
  async listAllRuns(opts: { tenant?: string; status?: string; limit?: number } = {}): Promise<EvalRun[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (opts.tenant) {
      conditions.push(`tenant_id = $${i++}`);
      params.push(opts.tenant);
    }
    if (opts.status) {
      conditions.push(`status = $${i++}`);
      params.push(opts.status);
    }
    params.push(Math.min(opts.limit ?? 20, 100));
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const r = await this.pool.query<RunRow>(
      `SELECT * FROM forge_cp_eval_runs${where} ORDER BY started_at DESC LIMIT $${i}`,
      params,
    );
    return r.rows.map(rowToRun);
  }

  // --- Per-workflow drilldown ----------------------------------------------

  async insertWorkflow(input: EvalWorkflowInput): Promise<EvalWorkflow> {
    const now = nowIso();
    const r = await this.pool.query<WorkflowRow>(
      `INSERT INTO forge_cp_eval_workflows
         (id, run_id, workflow_id, tenant_id, verdict, integrity_class, prompt,
          duration_ms, started_at, completed_at, input_tokens, output_tokens,
          provider, meta, lanes, trials_total, trials_passed, failing_bar, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19::timestamptz,$20::timestamptz)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [
        input.id,
        input.run_id,
        input.workflow_id,
        input.tenant_id,
        input.verdict,
        input.integrity_class ?? null,
        input.prompt ?? null,
        input.duration_ms ?? null,
        input.started_at ?? null,
        input.completed_at ?? null,
        input.input_tokens ?? 0,
        input.output_tokens ?? 0,
        input.provider ?? null,
        JSON.stringify(input.meta ?? {}),
        input.lanes ?? [],
        input.trials_total ?? 0,
        input.trials_passed ?? 0,
        input.failing_bar ?? null,
        now,
        now,
      ],
    );
    // If row already existed (DO NOTHING), fetch it.
    if (!r.rows[0]) {
      const existing = await this.pool.query<WorkflowRow>(
        'SELECT * FROM forge_cp_eval_workflows WHERE id = $1',
        [input.id],
      );
      return rowToWorkflow(existing.rows[0]!);
    }
    return rowToWorkflow(r.rows[0]);
  }

  async getWorkflow(id: string): Promise<EvalWorkflow | null> {
    const r = await this.pool.query<WorkflowRow>('SELECT * FROM forge_cp_eval_workflows WHERE id = $1', [id]);
    return r.rows[0] ? rowToWorkflow(r.rows[0]) : null;
  }

  async listWorkflows(runId: string): Promise<EvalWorkflow[]> {
    const r = await this.pool.query<WorkflowRow>(
      'SELECT * FROM forge_cp_eval_workflows WHERE run_id = $1 ORDER BY created_at',
      [runId],
    );
    return r.rows.map(rowToWorkflow);
  }

  // --- Scenes --------------------------------------------------------------

  async insertScene(input: EvalSceneInput): Promise<EvalScene> {
    const now = nowIso();
    const r = await this.pool.query<SceneRow>(
      `INSERT INTO forge_cp_eval_scenes
         (id, workflow_id, run_id, scene_index, scene_name, assertions, observed_values, passed, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9::timestamptz)
       ON CONFLICT (workflow_id, scene_index) DO NOTHING
       RETURNING *`,
      [
        input.id,
        input.workflow_id,
        input.run_id,
        input.scene_index,
        input.scene_name ?? null,
        JSON.stringify(input.assertions ?? []),
        JSON.stringify(input.observed_values ?? []),
        input.passed ?? null,
        now,
      ],
    );
    if (!r.rows[0]) {
      const existing = await this.pool.query<SceneRow>(
        'SELECT * FROM forge_cp_eval_scenes WHERE workflow_id = $1 AND scene_index = $2',
        [input.workflow_id, input.scene_index],
      );
      return rowToScene(existing.rows[0]!);
    }
    return rowToScene(r.rows[0]);
  }

  async listScenes(workflowId: string): Promise<EvalScene[]> {
    const r = await this.pool.query<SceneRow>(
      'SELECT * FROM forge_cp_eval_scenes WHERE workflow_id = $1 ORDER BY scene_index',
      [workflowId],
    );
    return r.rows.map(rowToScene);
  }

  // --- MCP calls -----------------------------------------------------------

  async insertMcpCall(input: EvalMcpCallInput): Promise<EvalMcpCall> {
    const now = nowIso();
    const r = await this.pool.query<McpCallRow>(
      `INSERT INTO forge_cp_eval_mcp_calls
         (id, workflow_id, run_id, call_index, tool_name, request, response,
          duration_ms, error, called_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::timestamptz,$11::timestamptz)
       ON CONFLICT (workflow_id, call_index) DO NOTHING
       RETURNING *`,
      [
        input.id,
        input.workflow_id,
        input.run_id,
        input.call_index,
        input.tool_name,
        JSON.stringify(input.request),
        input.response != null ? JSON.stringify(input.response) : null,
        input.duration_ms ?? null,
        input.error ?? null,
        input.called_at ?? null,
        now,
      ],
    );
    if (!r.rows[0]) {
      const existing = await this.pool.query<McpCallRow>(
        'SELECT * FROM forge_cp_eval_mcp_calls WHERE workflow_id = $1 AND call_index = $2',
        [input.workflow_id, input.call_index],
      );
      return rowToMcpCall(existing.rows[0]!);
    }
    return rowToMcpCall(r.rows[0]);
  }

  async listMcpCalls(workflowId: string): Promise<EvalMcpCall[]> {
    const r = await this.pool.query<McpCallRow>(
      'SELECT * FROM forge_cp_eval_mcp_calls WHERE workflow_id = $1 ORDER BY call_index',
      [workflowId],
    );
    return r.rows.map(rowToMcpCall);
  }

  // --- Claims / cassette ---------------------------------------------------

  async insertClaim(input: EvalClaimInput): Promise<EvalClaim> {
    const now = nowIso();
    const r = await this.pool.query<ClaimRow>(
      `INSERT INTO forge_cp_eval_claims
         (id, workflow_id, run_id, claim_index, claim_type, claim_text,
          verdict, evidence, cassette, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::timestamptz)
       ON CONFLICT (workflow_id, claim_index) DO NOTHING
       RETURNING *`,
      [
        input.id,
        input.workflow_id,
        input.run_id,
        input.claim_index,
        input.claim_type ?? null,
        input.claim_text ?? null,
        input.verdict ?? null,
        JSON.stringify(input.evidence ?? {}),
        JSON.stringify(input.cassette ?? {}),
        now,
      ],
    );
    if (!r.rows[0]) {
      const existing = await this.pool.query<ClaimRow>(
        'SELECT * FROM forge_cp_eval_claims WHERE workflow_id = $1 AND claim_index = $2',
        [input.workflow_id, input.claim_index],
      );
      return rowToClaim(existing.rows[0]!);
    }
    return rowToClaim(r.rows[0]);
  }

  async listClaims(workflowId: string): Promise<EvalClaim[]> {
    const r = await this.pool.query<ClaimRow>(
      'SELECT * FROM forge_cp_eval_claims WHERE workflow_id = $1 ORDER BY claim_index',
      [workflowId],
    );
    return r.rows.map(rowToClaim);
  }

  // --- Tenant lease --------------------------------------------------------

  async acquireLease(input: TenantLeaseInput): Promise<TenantLease | null> {
    const stale = input.staleAfterSeconds ?? DEFAULT_STALE_SECONDS;
    // Conditional upsert: steal the row only when the current heartbeat is stale.
    // If another runner holds a live lease the WHERE clause fails → 0 rows → null.
    const r = await this.pool.query<LeaseRow>(
      `INSERT INTO forge_cp_tenant_lease (id, holder, source, since, heartbeat)
       VALUES (1, $1, $2, now(), now())
       ON CONFLICT (id) DO UPDATE
         SET holder    = EXCLUDED.holder,
             source    = EXCLUDED.source,
             since     = now(),
             heartbeat = now()
         WHERE forge_cp_tenant_lease.heartbeat < now() - ($3::int * interval '1 second')
       RETURNING holder, source, since, heartbeat`,
      [input.holder, input.source, stale],
    );
    return r.rows[0] ? rowToLease(r.rows[0]) : null;
  }

  async renewLease(holder: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE forge_cp_tenant_lease
          SET heartbeat = now()
        WHERE id = 1 AND holder = $1`,
      [holder],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async releaseLease(holder: string): Promise<boolean> {
    const r = await this.pool.query(`DELETE FROM forge_cp_tenant_lease WHERE id = 1 AND holder = $1`, [
      holder,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  async getLease(): Promise<TenantLease | null> {
    const r = await this.pool.query<LeaseRow>(
      'SELECT holder, source, since, heartbeat FROM forge_cp_tenant_lease WHERE id = 1',
    );
    return r.rows[0] ? rowToLease(r.rows[0]) : null;
  }

  // --- Test utilities ------------------------------------------------------

  async __truncateAllForTests(): Promise<void> {
    // Order matters: children before parents (FK cascade would handle it, but explicit is cleaner).
    await this.pool.query(`
      TRUNCATE forge_cp_eval_claims,
               forge_cp_eval_mcp_calls,
               forge_cp_eval_scenes,
               forge_cp_eval_workflows,
               forge_cp_eval_runs,
               forge_cp_tenant_lease
    `);
  }
}
