/**
 * forge-console — e2e read API: shared query functions + MCP tool definitions.
 *
 * SINGLE SOURCE OF TRUTH. Both the REST endpoints (GET /api/e2e/*) and the
 * MCP tools (list_e2e_runs, get_e2e_run, get_workflow_result, diff_e2e_runs)
 * call these functions. The human view and the agent view are identical — there
 * is no separate "agent copy" that can drift.
 *
 * All functions return plain objects (no Fastify/HTTP concerns here). Callers
 * wrap them in JSON responses or MCP tool results as needed.
 */

import type { PgCpResultsBackend } from '../storage/backends/cp-results/pg';
import type {
  EvalRun,
  EvalWorkflow,
  EvalScene,
  EvalMcpCall,
  EvalClaim,
} from '../storage/backends/cp-results/types';

export type { EvalRun, EvalWorkflow, EvalScene, EvalMcpCall, EvalClaim };

// ── Response shapes ─────────────────────────────────────────────────────────

/** Run top-line + failure list — the "run detail" view. */
export interface RunDetail {
  run: EvalRun;
  /** Workflows where verdict is 'fail' or 'error', ordered by created_at. */
  failures: EvalWorkflow[];
  failure_count: number;
  /** All workflows in the run (ordered by creation), including passes and skips. */
  all_workflows: EvalWorkflow[];
}

/** Full per-workflow drilldown — assertions, scenes, prompts, tool calls, claims, integrity. */
export interface WorkflowResult {
  workflow: EvalWorkflow;
  scenes: EvalScene[];
  mcp_calls: EvalMcpCall[];
  claims: EvalClaim[];
}

/** Run-over-run regression analysis. */
export interface DiffResult {
  run_id: string;
  baseline_run_id: string;
  /** Workflows passing in baseline but failing (verdict != 'pass') in run. */
  regressions: EvalWorkflow[];
  /** Workflows failing in baseline but passing in run. */
  improvements: EvalWorkflow[];
  /** New workflows in run (not in baseline) with verdict != 'pass'. */
  new_failures: EvalWorkflow[];
  /** New workflows in run (not in baseline) with verdict == 'pass'. */
  new_passes: EvalWorkflow[];
}

// ── Query functions ─────────────────────────────────────────────────────────

export async function queryListRuns(
  store: PgCpResultsBackend,
  opts: { tenant?: string; limit?: number; status?: string } = {},
): Promise<EvalRun[]> {
  return store.listAllRuns(opts);
}

export async function queryGetRun(store: PgCpResultsBackend, runId: string): Promise<RunDetail | null> {
  const run = await store.getRun(runId);
  if (!run) return null;
  const allWorkflows = await store.listWorkflows(runId);
  const failures = allWorkflows.filter((w) => w.verdict === 'fail' || w.verdict === 'error');
  return { run, failures, failure_count: failures.length, all_workflows: allWorkflows };
}

export async function queryGetWorkflow(
  store: PgCpResultsBackend,
  workflowRowId: string,
): Promise<WorkflowResult | null> {
  const workflow = await store.getWorkflow(workflowRowId);
  if (!workflow) return null;
  const [scenes, mcp_calls, claims] = await Promise.all([
    store.listScenes(workflowRowId),
    store.listMcpCalls(workflowRowId),
    store.listClaims(workflowRowId),
  ]);
  return { workflow, scenes, mcp_calls, claims };
}

export async function queryDiffRuns(
  store: PgCpResultsBackend,
  runId: string,
  baselineRunId: string,
): Promise<DiffResult | null> {
  const [runExists, baselineExists] = await Promise.all([store.getRun(runId), store.getRun(baselineRunId)]);
  if (!runExists || !baselineExists) return null;

  const [runWorkflows, baselineWorkflows] = await Promise.all([
    store.listWorkflows(runId),
    store.listWorkflows(baselineRunId),
  ]);

  // Keyed by workflow_id (the suite-level identifier, not the database row id).
  const baselineMap = new Map<string, EvalWorkflow>(baselineWorkflows.map((w) => [w.workflow_id, w]));

  const regressions: EvalWorkflow[] = [];
  const improvements: EvalWorkflow[] = [];
  const new_failures: EvalWorkflow[] = [];
  const new_passes: EvalWorkflow[] = [];

  for (const wf of runWorkflows) {
    const baseline = baselineMap.get(wf.workflow_id);
    if (baseline) {
      if (wf.verdict !== 'pass' && baseline.verdict === 'pass') regressions.push(wf);
      else if (wf.verdict === 'pass' && baseline.verdict !== 'pass') improvements.push(wf);
      // both passing or both failing → not a regression or improvement, skip
    } else {
      // Not in baseline — new workflow
      if (wf.verdict !== 'pass') new_failures.push(wf);
      else new_passes.push(wf);
    }
  }

  return {
    run_id: runId,
    baseline_run_id: baselineRunId,
    regressions,
    improvements,
    new_failures,
    new_passes,
  };
}

// ── MCP surface ─────────────────────────────────────────────────────────────

/**
 * Standing triage instruction block (guardrail 2).
 *
 * Returned in the MCP `initialize` response `instructions` field so every
 * connected agent receives it at session start, before any tool is called.
 * This is the immutable triage protocol — do NOT modify without also updating
 * the console docs and the CHANGELOG.
 */
export const TRIAGE_INSTRUCTIONS = `\
FORGE E2E CONSOLE — Triage Protocol (guardrail 2)

These tools surface the live e2e eval store on the forge control plane. Use them to
diagnose failures and regressions. Do NOT use them to drive or trigger the product.

SEQUENCE:
1. list_e2e_runs — get the last N runs; look at pass_rate trend and status.
2. diff_e2e_runs — compare the failing run against the last clean baseline
   (status=completed, pass_rate=1.0) to isolate regressions from pre-existing failures.
3. get_e2e_run — read the top-line for the failing run: pass_rate, withheld_count,
   rejected_count, failure_count, and canonical_url.
4. get_workflow_result — for each workflow where verdict != 'pass': read integrity_class
   BEFORE drawing conclusions.

GUARDRAILS (non-negotiable):
- integrity_class = 'corrupted' → eval infrastructure failure, NOT a product bug.
  Do NOT file a bug, do NOT re-run, do NOT alert on-call. Escalate to forge-hat.
- integrity_class = 'degraded' → partial eval; results may be unreliable. Note this
  in any report and do not treat the run as conclusive.
- withheld_count > 0 → workflows budget-capped, timed out, or provider-errored.
  These are NOT product failures unless the product caused the error.
- rejected_count > 0 → workflows where the product actively refused (policy/auth).
  May or may not be bugs — check the mcp_calls for the rejection reason.
- NEVER treat a single run as conclusive. diff_e2e_runs confirms a regression;
  a one-off failure is noise until confirmed across multiple runs.
- canonical_url is the stable reference for each run. Always include it in reports
  and escalations so engineers can navigate to the run without re-running the query.
- This surface is READ-ONLY. No tool here modifies the eval store or triggers runs.`;

/** Canonical MCP tool definitions for the console e2e surface. */
export const E2E_MCP_TOOLS = [
  {
    name: 'list_e2e_runs',
    description:
      'List e2e eval runs from the forge control-plane store, newest-first. ' +
      'Returns run-level metrics: run_id, status, pass_rate, workflow counts (attempted/passed/failed), ' +
      'withheld_count, rejected_count, token spend, canonical_url, and timestamps. ' +
      'Use this first to orient: see the trend, find the failing run, locate a clean baseline. ' +
      'Filter by tenant and/or status to narrow the scope. ' +
      'max limit is 100 (default 20).',
    inputSchema: {
      type: 'object',
      properties: {
        tenant: {
          type: 'string',
          description: 'Filter by tenant_id (e.g. "dorinda-prod"). Omit to see all tenants.',
        },
        limit: {
          type: 'number',
          description: 'Max number of runs to return. Default 20, max 100.',
        },
        status: {
          type: 'string',
          enum: ['running', 'completed', 'failed', 'aborted'],
          description: 'Filter by run status. Omit to see all statuses.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_e2e_run',
    description:
      'Get a single e2e run by run_id: top-line metrics plus the full list of failing workflows ' +
      '(verdict = fail or error). This is the starting point for diagnosing a specific run. ' +
      'Read integrity_class on each failing workflow BEFORE drawing conclusions: ' +
      'corrupted means an eval infrastructure failure, not a product bug. ' +
      'canonical_url is the stable link for this run — include it in any report.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'The run_id (from list_e2e_runs).',
        },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_workflow_result',
    description:
      'Full drilldown for a single workflow: the workflow verdict + integrity_class, ' +
      'every scene (assertion name, expected value, operator, observed value, passed flag), ' +
      'every MCP tool call and response (tool_name, request, response, duration_ms, error), ' +
      'and all extracted claims with their cassette content. ' +
      'Use this to understand exactly what the model did and why it failed. ' +
      'The workflow row id comes from get_e2e_run failures[].id.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: {
          type: 'string',
          description:
            'The workflow row id (the "id" field from get_e2e_run failures list, NOT workflow_id).',
        },
      },
      required: ['workflow_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'diff_e2e_runs',
    description:
      'Compare two e2e runs to identify regressions, improvements, and new workflows. ' +
      'regressions: workflows that passed in the baseline but fail in run_id — these are the bugs to investigate. ' +
      'improvements: workflows that failed in the baseline but pass in run_id — fixes confirmed. ' +
      'new_failures / new_passes: workflows not in the baseline at all. ' +
      'Use this after list_e2e_runs to confirm a regression rather than treating a single run as conclusive.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'The run to analyze (the one you suspect has regressions).',
        },
        baseline_run_id: {
          type: 'string',
          description:
            'The baseline run to compare against (ideally the last clean run: status=completed, pass_rate=1.0).',
        },
      },
      required: ['run_id', 'baseline_run_id'],
      additionalProperties: false,
    },
  },
] as const;
