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
  EvalTurn,
  EvalMcpCall,
  EvalClaim,
  WorkflowVerdict,
} from '../storage/backends/cp-results/types';

export type { EvalRun, EvalWorkflow, EvalScene, EvalTurn, EvalMcpCall, EvalClaim, WorkflowVerdict };

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
  /** The conversation — what the console's cassette panel renders. */
  turns: EvalTurn[];
  mcp_calls: EvalMcpCall[];
  claims: EvalClaim[];
}

/**
 * ⛔ A WITHHELD VERDICT IS NEVER A REGRESSION — the rule this module used to break.
 *
 * `WorkflowVerdict` carries the warning on its own declaration: *"withheld is not a failure.
 * forge-hat's UNARMED / INFRA-FAIL mean the RIG failed and nothing was tested, so no verdict
 * exists."* `queryDiffRuns` nonetheless bucketed on `verdict !== 'pass'`, so **every withheld row
 * counted as a regression** — and `diff_e2e_runs` puts that in front of a triage agent. That is
 * HAT-F-065's defect exactly: a rig failure reported as a product failure, which on 2026-08-16 cost
 * three releases and four paid live runs before anyone disbelieved it.
 *
 * The rule now lives in named exported functions instead of inline in a loop — the other half of
 * what that incident taught: a rule no test can call is a rule nobody checks.
 *
 * ⚠️ These mirror `forge-hat/src/results/diff.ts` and live in a different repo, so they can drift.
 * forge computes the diff because only forge has BOTH runs: the Cloud Run job mounts no artifacts
 * volume, so the runner cannot see its own history.
 */

/**
 * A verdict that actually graded the product — `pass` or `fail`, and nothing else.
 *
 * ⛔ `error` IS NOT A GRADED VERDICT, and this is easy to get wrong. It does not mean "the product
 * errored"; `toStoreVerdict` assigns it when the sender used a word the receiver does not know:
 * *"an unknown word is not a licence to guess which of the three outcomes was meant."* So `error`
 * is a BROKEN CONTRACT between runner and store. Counting it as red would report a sender/receiver
 * mismatch as a product regression — the same false conclusion as scoring a withheld row, one
 * verdict over.
 *
 * ⚠️ Note this disagrees with `queryGetRun`, which counts `error` among `failures`. That is
 * pre-existing and NOT changed here (silently moving run failure counts is a separate decision);
 * it is filed as a finding. The diff takes the conservative reading, because the diff is the
 * surface that tells a human what to go and debug.
 */
export function isVerdictBearing(verdict: WorkflowVerdict | null | undefined): boolean {
  return verdict === 'pass' || verdict === 'fail';
}

/** ⛔ No verdict exists — never a product signal, in either direction. */
export function isWithheldVerdict(verdict: WorkflowVerdict | null | undefined): boolean {
  return verdict === 'withheld' || verdict === 'skip' || verdict === 'error';
}

function isFailing(verdict: WorkflowVerdict): boolean {
  return verdict === 'fail';
}

export type DiffChangeKind =
  | 'newly-red'
  | 'newly-green'
  | 'still-red'
  | 'still-green'
  | 'became-withheld'
  | 'became-graded'
  | 'withheld-both'
  | 'added'
  | 'removed';

/** ⛔ The single decision, exported so a test can assert it by name. */
export function classifyChange(
  before: WorkflowVerdict | null,
  after: WorkflowVerdict | null,
): DiffChangeKind {
  if (before === null) return 'added';
  if (after === null) return 'removed';

  const beforeGraded = isVerdictBearing(before);
  const afterGraded = isVerdictBearing(after);
  if (!beforeGraded && !afterGraded) return 'withheld-both';
  if (beforeGraded && !afterGraded) return 'became-withheld';
  if (!beforeGraded && afterGraded) return 'became-graded';

  if (before === 'pass' && isFailing(after)) return 'newly-red';
  if (isFailing(before) && after === 'pass') return 'newly-green';
  return before === 'pass' ? 'still-green' : 'still-red';
}

/** ⛔ Exactly one kind is a regression. `became-withheld` is deliberately excluded. */
export function isRegression(kind: DiffChangeKind): boolean {
  return kind === 'newly-red';
}

/**
 * The provider-qualified row key.
 *
 * ⛔ Keying on bare `workflow_id` collapsed a dual-provider run into one entry, so **an anthropic
 * regression could hide behind an openai pass** — the exact shape of HAT-F-065's blast radius,
 * where one lane was blind for weeks while the other stayed green.
 */
export function diffRowKey(wf: Pick<EvalWorkflow, 'workflow_id' | 'provider'>): string {
  return wf.provider ? `${wf.workflow_id}:${wf.provider}` : wf.workflow_id;
}

export interface DiffChange {
  key: string;
  workflow_id: string;
  provider: string | null;
  kind: DiffChangeKind;
  before: WorkflowVerdict | null;
  after: WorkflowVerdict | null;
}

/** Run-over-run regression analysis. */
export interface DiffResult {
  run_id: string;
  baseline_run_id: string;
  /** ⛔ GRADED green → GRADED red only. A withheld row is never here. */
  regressions: EvalWorkflow[];
  /** Graded failing in baseline, passing in run. */
  improvements: EvalWorkflow[];
  /** Not in baseline, graded failing in run. */
  new_failures: EvalWorkflow[];
  /** Not in baseline, passing in run. */
  new_passes: EvalWorkflow[];
  /** Had a verdict, has none now — the rig stopped observing. An alarm, never a regression. */
  withheld_now: EvalWorkflow[];
  /** Was withheld, now graded. Evidence arrived; the verdict itself may still be red. */
  became_graded: EvalWorkflow[];
  /** Every row's classification, for a UI that wants the whole picture. */
  changes: DiffChange[];
  counts: Record<DiffChangeKind, number>;
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
  const [scenes, turns, mcp_calls, claims] = await Promise.all([
    store.listScenes(workflowRowId),
    store.listTurns(workflowRowId),
    store.listMcpCalls(workflowRowId),
    store.listClaims(workflowRowId),
  ]);
  return { workflow, scenes, turns, mcp_calls, claims };
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

  // ⛔ Provider-qualified, so a dual-provider run does not collapse two lanes into one row.
  const baselineMap = new Map<string, EvalWorkflow>(baselineWorkflows.map((w) => [diffRowKey(w), w]));
  const runMap = new Map<string, EvalWorkflow>(runWorkflows.map((w) => [diffRowKey(w), w]));

  const regressions: EvalWorkflow[] = [];
  const improvements: EvalWorkflow[] = [];
  const new_failures: EvalWorkflow[] = [];
  const new_passes: EvalWorkflow[] = [];
  const withheld_now: EvalWorkflow[] = [];
  const became_graded: EvalWorkflow[] = [];
  const changes: DiffChange[] = [];
  const counts: Record<DiffChangeKind, number> = {
    'newly-red': 0,
    'newly-green': 0,
    'still-red': 0,
    'still-green': 0,
    'became-withheld': 0,
    'became-graded': 0,
    'withheld-both': 0,
    added: 0,
    removed: 0,
  };

  for (const key of [...new Set([...baselineMap.keys(), ...runMap.keys()])].sort()) {
    const before = baselineMap.get(key) ?? null;
    const after = runMap.get(key) ?? null;
    const kind = classifyChange(before?.verdict ?? null, after?.verdict ?? null);
    counts[kind] += 1;

    const anchor = (after ?? before) as EvalWorkflow;
    changes.push({
      key,
      workflow_id: anchor.workflow_id,
      provider: anchor.provider,
      kind,
      before: before?.verdict ?? null,
      after: after?.verdict ?? null,
    });

    // ⛔ `regressions` admits ONE kind. Everything else has its own home, so a rig failure can
    // never arrive dressed as a product regression.
    if (kind === 'newly-red' && after) regressions.push(after);
    else if (kind === 'newly-green' && after) improvements.push(after);
    else if (kind === 'became-withheld' && after) withheld_now.push(after);
    else if (kind === 'became-graded' && after) became_graded.push(after);
    else if (kind === 'added' && after) {
      if (after.verdict === 'pass') new_passes.push(after);
      else if (isVerdictBearing(after.verdict)) new_failures.push(after);
      // A brand-new row that is withheld is neither a pass nor a failure — nothing was tested.
    }
  }

  return {
    run_id: runId,
    baseline_run_id: baselineRunId,
    regressions,
    improvements,
    new_failures,
    new_passes,
    withheld_now,
    became_graded,
    changes,
    counts,
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
- This surface is READ-ONLY. No tool here modifies the eval store or triggers runs.
  Run deletion is an operator action only — available via the console UI or
  DELETE /api/e2e/runs/:run_id with an authenticated OIDC session. Irreversible.`;

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

// ── INSTABILITY ─────────────────────────────────────────────────────────────
//
// How often a workflow's verdict FLIPS, and therefore how much confidence a single red deserves.
//
// A diff answers "what changed since the baseline". It cannot answer "is this workflow one that
// changes all the time anyway" — and against a stochastic system driven by low trial counts, a
// coin-flip red and a real regression are the same row. This module reads the history the store has
// been recording all along and counts, per workflow, how often the verdict CHANGED between
// consecutive GRADED runs. `diff` then carries it as a noise floor: an operator's attention goes to
// the reds that are actually new information.
//
// ⛔ THIS NEVER CHANGES A VERDICT. A red stays red. Instability annotates how surprised to be — the
// ranking of attention, never the grade.
//
// ⚠️ Ported from `forge-hat/src/results/instability.ts` and living in a different repo, so the two
// can drift. forge computes it because only forge has the history: the Cloud Run job mounts no
// artifacts volume, so the runner cannot see its own past runs.

/**
 * How many runs back to look. Ten is a deliberate compromise: long enough that a genuine coin-flip
 * shows up (a 50/50 workflow flips ~4-5 times in 10), short enough that a workflow FIXED a month ago
 * is not branded unstable forever by history it has outgrown.
 */
export const DEFAULT_INSTABILITY_WINDOW = 10;

/**
 * ⛔ "Unstable" is a flip RATE with a sample floor, not an absolute count (retuned 2026-08-18
 * against the acceptance machine's real store — the first version was `flips >= 2` regardless of
 * sample count). Measured on 88 known remote-lane workflows the absolute rule branded 27 (31%)
 * unstable; since unstable suppresses a row's regression trust, a real regression in a third of
 * the catalogue was silenced. At rate ≥ 0.4 with ≥ 4 graded samples the same history brands
 * 8/88 (9%) — exactly the genuine flappers.
 *
 * ⛔ MIRRORED in forge-hat/src/results/instability.ts (the CLI-side classifier — the duplication is
 * an accepted cost, constant drift is not). Change them TOGETHER; the counterpart's pinning test
 * names this file right back.
 */
export const UNSTABLE_AT_FLIP_RATE = 0.4;
/** Below this many graded samples a flip rate is an anecdote, not a measurement. */
export const UNSTABLE_MIN_SAMPLES = 4;

export interface Instability {
  /** Provider-qualified, keyed exactly as `diffRowKey` keys a diff row, so the two join directly. */
  key: string;
  /** Graded samples in the window, oldest first. Withheld/skip rows are already dropped. */
  samples: WorkflowVerdict[];
  /** Consecutive-pair changes among graded samples. */
  flips: number;
  /** flips / (samples-1), or 0 when fewer than two graded samples exist. */
  flipRate: number;
  /** Runs in the window whose verdict was withheld or skipped — context, never a sample. */
  withheldRuns: number;
  /** ⛔ False whenever fewer than two GRADED samples exist: unknown is not stable. */
  known: boolean;
  unstable: boolean;
}

/**
 * ⛔ The core decision, exported so a test can assert it by name. Counts changes between
 * CONSECUTIVE GRADED samples — and only changes. A workflow that has failed ten times running is
 * perfectly stable; instability is about CHANGE, not about quality.
 *
 * ⚠️ VOCABULARY NOTE — forge grades with THREE values where forge-hat grades with two. forge-hat's
 * graded set is {ACCEPTED, REJECTED}, so a change there is always green↔red. forge's is
 * {pass, fail, error}, so `fail → error` is a change between two values that are both RED. This
 * counts it as a flip, because the source semantics are "the verdict changed" and a workflow that
 * oscillates between a product failure and a provider error is not a workflow whose red you should
 * trust. It does make forge's flip counts marginally more sensitive than forge-hat's on the same
 * history.
 */
export function countFlips(samples: WorkflowVerdict[]): number {
  let flips = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i] !== samples[i - 1]) flips += 1;
  }
  return flips;
}

/**
 * ⛔ "Unstable" requires EVIDENCE of instability, never absence of evidence. A workflow with one
 * graded sample is `known: false` and `unstable: false` — it must not be silently downgraded to
 * noise on no data, because that would suppress exactly the reds nobody has ever seen before.
 */
export function isUnstable(flips: number, gradedSamples: number): boolean {
  if (gradedSamples < UNSTABLE_MIN_SAMPLES) return false;
  return flips / (gradedSamples - 1) >= UNSTABLE_AT_FLIP_RATE;
}

/**
 * Build the instability record for ONE already-ordered series of workflow rows (oldest first).
 *
 * ⛔ WITHHELD VERDICTS ARE NOT SAMPLES. `withheld` / `skip` mean nothing was graded, so they are
 * dropped from the series before any flip is counted — they neither flip nor stabilise. This is the
 * same rule `classifyChange` applies, for the same reason: a default is not an observation. Counting
 * an infra failure as a "change" would manufacture instability out of a dead network.
 */
export function instabilityOf(key: string, series: EvalWorkflow[]): Instability {
  const samples = series.filter((w) => isVerdictBearing(w.verdict)).map((w) => w.verdict);
  const withheldRuns = series.length - samples.length;
  const flips = countFlips(samples);
  const known = samples.length >= 2;
  return {
    key,
    samples,
    flips,
    flipRate: known ? flips / (samples.length - 1) : 0,
    withheldRuns,
    known,
    unstable: isUnstable(flips, samples.length),
  };
}

/**
 * Instability for every workflow seen in the last `window` runs, keyed exactly as the diff keys its
 * rows (provider-qualified), so the two can be joined without re-deriving anything.
 *
 * Query budget is bounded at `1 + window`: one `listAllRuns`, then one `listWorkflows` per run in
 * the window. The per-run reads are sequential on purpose — fanning out `window` concurrent queries
 * would contend with every other request for the same pg pool.
 */
export async function queryInstability(
  store: PgCpResultsBackend,
  opts: { window?: number } = {},
): Promise<Map<string, Instability>> {
  const requested = opts.window ?? DEFAULT_INSTABILITY_WINDOW;
  // listAllRuns caps at 100 itself; clamp here too so the query budget is honest.
  const window = Math.max(1, Math.min(Math.floor(requested) || DEFAULT_INSTABILITY_WINDOW, 100));

  const runs = await store.listAllRuns({ limit: window });

  // ⛔ listAllRuns is started_at DESC. A flip series is meaningless in the wrong direction, so
  // re-order oldest-first explicitly rather than trusting the caller's read order. run_id breaks
  // ties so two runs with an identical started_at still produce a deterministic series.
  const ordered = [...runs].sort((a, b) => {
    const at = String(a.started_at ?? '');
    const bt = String(b.started_at ?? '');
    if (at !== bt) return at < bt ? -1 : 1;
    return a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0;
  });

  const series = new Map<string, EvalWorkflow[]>();
  for (const run of ordered) {
    const workflows = await store.listWorkflows(run.run_id);
    for (const w of workflows) {
      const key = diffRowKey(w);
      const list = series.get(key);
      if (list) list.push(w);
      else series.set(key, [w]);
    }
  }

  const out = new Map<string, Instability>();
  for (const [key, list] of series) out.set(key, instabilityOf(key, list));
  return out;
}

/**
 * One line of prose for a report. Deliberately states the sample count: "flipped 3 of 5" earns very
 * different trust from "flipped 3 of 9", and a bare percentage hides which one you are reading.
 */
export function describeInstability(i: Instability): string {
  if (!i.known) {
    const only = i.samples.length === 1 ? '1 graded run' : 'no graded runs';
    return `no instability history (${only}${i.withheldRuns ? `, ${i.withheldRuns} withheld` : ''})`;
  }
  const pct = Math.round(i.flipRate * 100);
  const withheld = i.withheldRuns ? `, ${i.withheldRuns} withheld` : '';
  return `${i.flips} flip(s) across ${i.samples.length} graded runs (${pct}%${withheld})`;
}
