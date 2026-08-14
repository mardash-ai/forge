/**
 * The E2E triage prompt — the clipboard hand-off from the console to a diagnosing agent.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * The first version of this prompt emitted a run id, four counters and a list of failing workflow
 * slugs, then told the receiving agent to go and fetch everything itself with the e2e MCP tools.
 * That is a *pointer*, not a brief. It has three concrete costs:
 *
 *   1. The agent that receives the paste very often has NO access to the forge control plane. The
 *      operator pastes into whatever assistant is in front of them. A prompt whose entire content
 *      is "call get_workflow_result" is unusable there, and the agent's only options are to guess
 *      or to ask — both of which cost the operator the round trip the button was meant to save.
 *   2. Even with the tools, the agent burns turns re-fetching data the console ALREADY HAS ON
 *      SCREEN. The operator is looking at the failing bar; the prompt should carry it.
 *   3. Most expensive: a bare list of "failures" invites the reader to treat every non-pass as a
 *      product bug. It is not. See the block below — that distinction is the single most valuable
 *      thing this prompt carries.
 *
 * ⛔ THE REJECTED / WITHHELD DISTINCTION — the reason this module is written this carefully
 * ------------------------------------------------------------------------------------------
 * forge-hat reports three outcomes, not two:
 *
 *   ACCEPTED  → the product met the bar.
 *   REJECTED  → the product was tested and genuinely FAILED a bar. A verdict exists. Triage it.
 *   WITHHELD  → the RIG failed (UNARMED, INFRA-FAIL). Nothing was tested, so NO VERDICT EXISTS.
 *               This is not a product failure, it is a missing measurement.
 *
 * Collapsing withheld into "failed" is a defect this estate has already paid for twice: the store
 * mapped UNARMED/INFRA-FAIL onto the `error` verdict, and the console renders anything that is not
 * a skip as "✗ rejected" — so a blind run was shown to the operator as a broken product, and every
 * run's apparent failure count was inflated. See `src/storage/backends/cp-results/types.ts`
 * (WorkflowVerdict) and the migration comment in `pg.ts`.
 *
 * A prompt that hands a withheld workflow to an agent under the heading "failures to triage" will
 * reliably produce a filed bug against product code that was never exercised. That wastes an
 * engineer, and worse, it pollutes the findings registry with a phantom the next run cannot
 * reproduce. So this module puts rejected and withheld in DIFFERENT SECTIONS, states the rule in
 * the prompt body in the imperative, and refuses to let the withheld section be read as a defect
 * list.
 *
 * There is a third bucket, and pretending otherwise would repeat the original sin: `verdict:
 * 'error'`. Post-2026-08-14 `error` means "the runner sent a word the store did not recognise" —
 * genuinely unknown. Rows written BEFORE that migration also used `error` for UNARMED/INFRA-FAIL.
 * So `error` is neither safely a product bug nor safely a rig failure. It gets its own section with
 * an instruction to resolve which one it is BEFORE acting. Guessing is what we are trying to stop.
 *
 * Finally, `integrity_class === 'corrupted'` overrides the verdict. The canonical triage protocol
 * (`src/console/e2e-api.ts`, TRIAGE_INSTRUCTIONS) is explicit: corrupted means eval-infrastructure
 * failure, NOT a product bug — do not file, do not re-run, do not alert. A `fail` row carrying a
 * corrupted integrity class is therefore routed to the no-verdict section, with the reason named.
 *
 * SIZE — this goes to a CLIPBOARD, and it must never lie about what it cut
 * -----------------------------------------------------------------------
 * Full drilldown evidence runs ~35 KB per workflow (turns + mcp_calls carry whole request/response
 * payloads). Twenty failures of that would be ~700 KB — past what most chat surfaces accept and far
 * past what is useful. So everything here is bounded, and EVERY bound announces itself in the
 * output: `… [+N chars truncated]`, `… [N of M tool calls omitted …]`. A shortened value that looks
 * complete is worse than a long one — the agent reasons from a fragment believing it has the whole,
 * which is exactly how "the assistant never called send_email" gets concluded from a truncated
 * trace. Silent truncation is banned in this file. Every limit and its rationale is in
 * DEFAULT_TRIAGE_LIMITS below.
 *
 * HONEST DEGRADATION
 * ------------------
 * The console fetches drilldown evidence PER WORKFLOW, only for the row the operator expanded. When
 * the operator hits "Triage this run" there will usually be evidence for zero or one of the
 * failures. This module therefore treats evidence as optional everywhere: present → inline it;
 * absent → say "evidence not loaded" and hand over the exact tool call that fetches it. It never
 * renders an empty section as though the evidence had been checked and found empty. "No tool calls
 * were made" and "we did not look" are opposite facts (the same rule the store applies to
 * `tool_trace_unreadable`), and this file keeps them apart.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Structural mirrors of the store shapes.
//
// Declared locally rather than imported so this module compiles inside the console's tsconfig
// (which includes only `console/src`) without dragging server-side types across the boundary. They
// are STRUCTURAL and deliberately wider/looser than the canonical definitions — every field the
// caller might not have is optional — so both `console/src/App.tsx`'s E2E* interfaces and
// `src/storage/backends/cp-results/types.ts`'s Eval* interfaces are assignable without a cast.
//
// Canonical sources, in sync with which these must be kept:
//   src/storage/backends/cp-results/types.ts   (EvalRun, EvalWorkflow, EvalScene, EvalTurn, …)
//   src/console/e2e-api.ts                     (RunDetail, WorkflowResult)
//   console/src/App.tsx                        (E2ERun, E2EWorkflow, E2EScene, E2EMcpCall, …)
//
// `verdict` is typed as the WIDE union including 'withheld'. The store emits it (the CHECK
// constraint was widened on 2026-08-14) but App.tsx's local interface has not caught up and still
// declares the four-member union — which is assignable to this one, so both compile.
// ─────────────────────────────────────────────────────────────────────────────

/** Verdict vocabulary as stored. 'withheld' is a real verdict; 'skip' is its legacy spelling. */
export type TriageVerdict = 'pass' | 'fail' | 'error' | 'skip' | 'withheld';

/** Run-level row. Only the fields the brief prints are named; all are tolerated as absent. */
export interface TriageRun {
  run_id: string;
  tenant_id?: string | null;
  canonical_url?: string | null;
  provider?: string | null;
  trigger_source?: string | null;
  workflows_attempted?: number | null;
  workflows_passed?: number | null;
  workflows_failed?: number | null;
  pass_rate?: number | null;
  withheld_count?: number | null;
  rejected_count?: number | null;
  spend_cents?: number | null;
  p50_duration_ms?: number | null;
  p99_duration_ms?: number | null;
  total_input_tokens?: number | null;
  total_output_tokens?: number | null;
  status?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Per-workflow row — the summary the run detail endpoint returns for every workflow. */
export interface TriageWorkflow {
  /** Database row id. This is what `get_workflow_result` / the drilldown endpoint takes. */
  id: string;
  workflow_id: string;
  verdict: TriageVerdict;
  integrity_class?: string | null;
  prompt?: string | null;
  duration_ms?: number | null;
  provider?: string | null;
  lanes?: readonly string[] | null;
  trials_total?: number | null;
  trials_passed?: number | null;
  failing_bar?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface TriageAssertion {
  name: string;
  expected: unknown;
  operator: string;
}

export interface TriageObservedValue {
  name: string;
  value: unknown;
}

export interface TriageScene {
  scene_index?: number | null;
  scene_name?: string | null;
  assertions?: readonly TriageAssertion[] | null;
  observed_values?: readonly TriageObservedValue[] | null;
  passed?: boolean | null;
}

export interface TriageToolCall {
  tool: string;
  ok?: boolean;
  summary?: string;
}

export interface TriageTurn {
  turn_index?: number | null;
  /** Which trial/conversation this turn belongs to, 1-based. */
  attempt?: number | null;
  scene?: string | null;
  prompt?: string | null;
  reply?: string | null;
  tool_calls?: readonly TriageToolCall[] | null;
  /** ⛔ Trace could not be READ. Never render as "called nothing" — opposite facts. */
  tool_trace_unreadable?: boolean | null;
}

export interface TriageMcpCall {
  call_index?: number | null;
  tool_name: string;
  request?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
  duration_ms?: number | null;
  error?: string | null;
}

export interface TriageClaim {
  claim_index?: number | null;
  claim_type?: string | null;
  claim_text?: string | null;
  verdict?: string | null;
  evidence?: Record<string, unknown> | null;
}

/** One workflow's fetched drilldown — the `WorkflowResult` / `E2EWorkflowResult` shape. */
export interface TriageWorkflowEvidence {
  workflow: { id: string; workflow_id?: string };
  scenes?: readonly TriageScene[] | null;
  /** Optional: a store predating the turns table returns a result with no `turns` key at all. */
  turns?: readonly TriageTurn[] | null;
  mcp_calls?: readonly TriageMcpCall[] | null;
  claims?: readonly TriageClaim[] | null;
}

/**
 * Whatever evidence the caller happens to have. The console realistically holds zero or one
 * (`wfResult`), so an array is the natural shape; a Map is accepted for a caller that caches.
 */
export type TriageEvidenceInput =
  readonly TriageWorkflowEvidence[] | ReadonlyMap<string, TriageWorkflowEvidence>;

// ─────────────────────────────────────────────────────────────────────────────
// Limits
// ─────────────────────────────────────────────────────────────────────────────

export interface TriageLimits {
  /** Failures given a full evidence block. Beyond this they are listed as one-liners. */
  maxDetailedFailures: number;
  /** Withheld workflows listed by name before collapsing to a count-by-reason tail. */
  maxWithheldListed: number;
  /** Rejected workflows named in the undetailed tail of §3 before rolling up to a count. */
  maxRejectedListed: number;
  /** Unresolved-verdict ('error') workflows listed by name. */
  maxUnresolvedListed: number;
  maxScenesPerWorkflow: number;
  maxAssertionsPerScene: number;
  maxTurnsPerWorkflow: number;
  maxMcpCallsPerWorkflow: number;
  maxClaimsPerWorkflow: number;
  /**
   * Total characters of inlined evidence one workflow may spend. The per-item caps alone do NOT
   * bound a block — 6 scenes × 8 assertions × 2 lines × ~330 chars is ~32 KB from scenes alone,
   * which is how the first draft of this module blew a 60 KB budget on a single workflow and cut
   * away the instructions at the end. This is the backstop that makes the worst case arithmetic.
   */
  maxEvidenceCharsPerWorkflow: number;
  /** Per-string caps. Every one of these emits a visible marker when it bites. */
  promptChars: number;
  replyChars: number;
  failingBarChars: number;
  /** The failing bar in a one-line summary row, where the full bar is not worth its length. */
  summaryBarChars: number;
  valueChars: number;
  jsonChars: number;
  claimChars: number;
  errorChars: number;
  /** Last-resort ceiling on the whole prompt. Also announces itself. */
  hardCapChars: number;
}

/**
 * The defaults, and WHY each number is what it is.
 *
 * The governing constraint: this string goes to a clipboard and then into a chat box. Target a
 * worst case around 50 KB (~13k tokens) — large enough that an agent can diagnose without a single
 * tool call, small enough to paste anywhere and to leave room for the agent's own reasoning. Raw
 * evidence for ONE workflow is ~35 KB, so these caps are doing real work.
 *
 * These numbers are a budget, not a guarantee. The guarantee comes from the ASSEMBLY ORDER: the
 * fixed sections (§1, §2, §4–§7) are built first and their cost subtracted, and §3 — the only
 * section that scales with the run — gets what is left. Two earlier drafts got this wrong in the
 * same way, and the symptom is nasty: a pathological run produced a full-size brief with the
 * withheld warning and "never lower a bar" cut off the end. See the comment on the §3 builder.
 *
 *   maxDetailedFailures: 8   — 8 × ~5.5 KB ≈ 44 KB of failure detail. Eight is also about the point
 *                              past which an agent stops triaging and starts summarising. Failures
 *                              9+ are still NAMED with their failing bar and row id (never dropped
 *                              silently) — just without inline evidence.
 *   maxEvidenceCharsPerWorkflow: 5000
 *                            — the only bound that bounds a BLOCK; the per-item caps bound items,
 *                              and 6 scenes × 8 assertions of them is still 30 KB. Split by
 *                              EVIDENCE_BUDGET_SHARE so a workflow with 200 tool calls cannot
 *                              starve its own transcript.
 *   maxRejectedListed: 30 / summaryBarChars: 160
 *                            — the undetailed tail of §3 is bounded too. 70 one-liners at the full
 *                              400-char bar is another 28 KB, which is how the tail alone can push
 *                              a brief past the ceiling.
 *   maxTurnsPerWorkflow: 8   — enough to see the setup and the turn that tripped the bar. Kept from
 *                              BOTH ENDS (first 2, last 6): the failing assertion is usually late,
 *                              the framing is in the opening turn. If the char budget bites on top
 *                              of that, turns are dropped from the FRONT — see renderTurns.
 *   maxMcpCallsPerWorkflow: 14 — a normal workflow makes 3–10 calls; 14 covers most in full. Calls
 *                              carrying an `error` are emitted FIRST so no later bound can quietly
 *                              undo their priority.
 *   maxScenesPerWorkflow: 6  — failing scenes are emitted first, so the cap bites on passing ones.
 *   replyChars: 900          — the assistant's visible reply is what the claims were extracted
 *                              from; 900 covers a full Dorinda reply. promptChars 400 covers a
 *                              scripted turn prompt. Both must stay under the turns share of the
 *                              evidence budget (0.3 × 5000 = 1500) so one turn always fits.
 *   jsonChars: 300           — MCP request/response payloads are the worst offenders (a calendar
 *                              list response can be tens of KB). 300 shows the shape and the first
 *                              fields, which is what identifies a wrong-argument bug.
 *   hardCapChars: 60000      — belt and braces. If some pathological run slips past every other
 *                              cap, the prompt is cut once, at the end, with a loud marker.
 */
export const DEFAULT_TRIAGE_LIMITS: TriageLimits = {
  maxDetailedFailures: 8,
  maxWithheldListed: 25,
  maxRejectedListed: 30,
  maxUnresolvedListed: 15,
  maxScenesPerWorkflow: 6,
  maxAssertionsPerScene: 8,
  maxTurnsPerWorkflow: 8,
  maxMcpCallsPerWorkflow: 14,
  maxClaimsPerWorkflow: 8,
  maxEvidenceCharsPerWorkflow: 5000,
  promptChars: 400,
  replyChars: 900,
  failingBarChars: 400,
  summaryBarChars: 160,
  valueChars: 250,
  jsonChars: 300,
  claimChars: 250,
  errorChars: 300,
  hardCapChars: 60_000,
};

export interface TriagePromptOptions {
  /** Drilldown evidence already fetched. Missing entries degrade to an explicit "not loaded". */
  evidence?: TriageEvidenceInput;
  /** Override any subset of the size bounds. */
  limits?: Partial<TriageLimits>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Truncation helpers — the only place a string is ever shortened, so the "never silently" rule
// has exactly one enforcement point.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shorten `s` to `max` characters, ALWAYS leaving a visible marker naming what went.
 *
 * The marker is the point. A reader who sees `… [+8214 chars truncated]` knows to fetch the rest
 * before concluding; a reader given a clean-looking fragment concludes from the fragment.
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.length - max;
  return `${s.slice(0, max)}… [+${cut} chars truncated]`;
}

/** Collapse newlines so a multi-line value cannot break the brief's indentation-based structure. */
function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ⏎ ').trim();
}

/** A single-line, length-bounded rendering of an arbitrary stored value. */
function fmtValue(v: unknown, max: number): string {
  if (v === undefined) return '(absent)';
  if (v === null) return 'null';
  if (typeof v === 'string') return truncate(oneLine(JSON.stringify(v)), max);
  try {
    return truncate(oneLine(JSON.stringify(v)), max);
  } catch {
    // Circular or otherwise unserialisable — say so rather than dropping the field.
    return '(unserialisable value)';
  }
}

function fmtText(s: string | null | undefined, max: number, absent = '(not recorded)'): string {
  if (s === null || s === undefined || s === '') return absent;
  return truncate(oneLine(s), max);
}

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'not recorded';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : String(n);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bucketing — the load-bearing logic of this module
// ─────────────────────────────────────────────────────────────────────────────

export type TriageBucket = 'accepted' | 'rejected' | 'withheld' | 'unresolved';

/**
 * Which of the three outcomes (plus the honest fourth, "unknown") a workflow belongs to.
 *
 * ⛔ Read the module header before changing this function. Getting it wrong is how a rig failure
 * becomes a filed product bug.
 *
 *   pass                              → accepted
 *   withheld | skip                   → withheld  (rig failed / never armed — NO verdict exists)
 *   fail + integrity_class corrupted  → withheld  (the protocol says corrupted is infra, not
 *                                                  product, whatever the verdict column says)
 *   fail                              → rejected  (a real verdict against the product)
 *   error                             → unresolved (ambiguous by construction — see header)
 */
export function bucketOf(wf: TriageWorkflow): TriageBucket {
  if (wf.verdict === 'pass') return 'accepted';
  if (wf.verdict === 'withheld' || wf.verdict === 'skip') return 'withheld';
  if (wf.integrity_class === 'corrupted') return 'withheld';
  if (wf.verdict === 'fail') return 'rejected';
  return 'unresolved';
}

/** The rig's own words for why nothing was measured, when it recorded them. */
function withheldReason(wf: TriageWorkflow): string {
  const meta = (wf.meta ?? {}) as { withheld_reason?: unknown };
  if (typeof meta.withheld_reason === 'string' && meta.withheld_reason) return meta.withheld_reason;
  if (wf.integrity_class === 'corrupted') return 'integrity_class=corrupted (eval infrastructure failure)';
  return 'reason not recorded';
}

/**
 * A human name for the workflow.
 *
 * There is no `name` column — the slug and the prompt are all that exist. Rather than invent a
 * field, derive a title from the slug (`h5-teen-share-up` → "teen share up") and keep the slug
 * beside it, so the agent can quote the exact identifier back at the tools.
 */
export function humanName(workflowId: string): string {
  const stripped = workflowId.replace(/^[a-z]+\d*-/, '');
  const words = stripped.replace(/[-_]+/g, ' ').trim();
  if (!words) return workflowId;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function normaliseEvidence(input: TriageEvidenceInput | undefined): Map<string, TriageWorkflowEvidence> {
  const map = new Map<string, TriageWorkflowEvidence>();
  if (!input) return map;
  const entries: TriageWorkflowEvidence[] =
    input instanceof Map ? [...input.values()] : [...(input as readonly TriageWorkflowEvidence[])];
  for (const ev of entries) {
    if (!ev?.workflow) continue;
    // Index under BOTH keys: the console holds row ids, an agent-fed cache may hold slugs.
    if (ev.workflow.id) map.set(ev.workflow.id, ev);
    if (ev.workflow.workflow_id) map.set(ev.workflow.workflow_id, ev);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trials line — "which trial failed and whether others passed".
 *
 * There is no column recording WHICH trial index failed, and inventing one would be worse than
 * useless. What IS derivable is the far more actionable fact: whether the failure reproduced on
 * every trial (deterministic — a real, chaseable defect) or on some (flaky — the bug may be timing,
 * or the bar may be over-tight). Turn `attempt` numbers, when evidence is loaded, name which
 * conversations were captured.
 */
function trialsLine(wf: TriageWorkflow, turns: readonly TriageTurn[] | null): string {
  const total = wf.trials_total ?? 0;
  const passed = wf.trials_passed ?? 0;
  if (total <= 0) {
    return 'trials: none ran (0 trials recorded — nothing was measured)';
  }
  const failed = Math.max(0, total - passed);
  let verdictShape: string;
  if (passed === 0) {
    verdictShape = `deterministic — all ${total} trial(s) failed, no trial passed`;
  } else if (failed === 0) {
    verdictShape = 'no failing trial recorded — the row-level verdict disagrees with the trial counts';
  } else {
    verdictShape = `FLAKY — ${failed} of ${total} trials failed, ${passed} passed (same build, same bar)`;
  }
  let attempts = '';
  if (turns && turns.length) {
    const seen = [...new Set(turns.map((t) => t.attempt ?? 1))].sort((a, b) => a - b);
    attempts = ` · transcript captured for attempt(s) ${seen.join(', ')}`;
  }
  return `trials: ${passed}/${total} passed · ${verdictShape}${attempts}`;
}

/**
 * Scenes, as BLOCKS.
 *
 * Each assertion is one block (name / expected / observed). Blocks matter because the budget cuts
 * between them and never inside one: an `expected: "reader"` line with the budget marker where its
 * `observed:` line should be reads as "the rig recorded no observed value" — a fabricated finding,
 * produced by a size limit.
 */
function renderScenes(scenes: readonly TriageScene[], lim: TriageLimits): string[][] {
  const blocks: string[][] = [];
  // Failing scenes first — the cap must never bite a failing scene while a passing one survives.
  const ordered = [...scenes].sort((a, b) => {
    const rank = (s: TriageScene) => (s.passed === false ? 0 : s.passed === null ? 1 : 2);
    return rank(a) - rank(b) || (a.scene_index ?? 0) - (b.scene_index ?? 0);
  });
  const shown = ordered.slice(0, lim.maxScenesPerWorkflow);
  for (const sc of shown) {
    const status = sc.passed === true ? 'passed' : sc.passed === false ? 'FAILED' : 'no result recorded';
    blocks.push([`    scene ${fmtNum(sc.scene_index)} "${sc.scene_name ?? 'unnamed'}" — ${status}`]);
    const observed = new Map<string, unknown>();
    for (const ov of sc.observed_values ?? []) observed.set(ov.name, ov.value);
    const asserts = sc.assertions ?? [];
    for (const a of asserts.slice(0, lim.maxAssertionsPerScene)) {
      const has = observed.has(a.name);
      blocks.push([
        `      · ${a.name}`,
        `          expected (${a.operator}): ${fmtValue(a.expected, lim.valueChars)}`,
        // "not observed" and "observed as null" are different facts; keep them apart.
        `          observed:            ${
          has ? fmtValue(observed.get(a.name), lim.valueChars) : '(no observed value recorded)'
        }`,
      ]);
      observed.delete(a.name);
    }
    if (asserts.length > lim.maxAssertionsPerScene) {
      blocks.push([`      … [${asserts.length - lim.maxAssertionsPerScene} more assertions omitted]`]);
    }
    // Observed values with no matching assertion still matter — they are what the rig saw.
    for (const [name, value] of observed) {
      blocks.push([`      · ${name} — observed ${fmtValue(value, lim.valueChars)} (no assertion on it)`]);
    }
  }
  if (ordered.length > shown.length) {
    blocks.push([
      `    … [${ordered.length - shown.length} more scenes omitted — failing scenes shown first]`,
    ]);
  }
  return blocks;
}

/** The lines for a single turn, kept together so a budget cut never orphans half a turn. */
function turnBlock(t: TriageTurn, lim: TriageLimits): string[] {
  const out: string[] = [];
  const scene = t.scene ? ` · scene "${t.scene}"` : '';
  out.push(`    turn ${fmtNum(t.turn_index)} (attempt ${t.attempt ?? 1})${scene}`);
  out.push(`      user:      ${fmtText(t.prompt, lim.promptChars)}`);
  out.push(`      assistant: ${fmtText(t.reply, lim.replyChars, '(no visible reply recorded)')}`);
  // ⛔ Three distinct states, three distinct renderings. "unreadable" is NOT "called nothing":
  // a blind run that reads as a clean one is the failure mode this flag exists to prevent.
  if (t.tool_trace_unreadable) {
    out.push('      tools:     ⛔ TOOL TRACE UNREADABLE — this is NOT "the assistant called nothing".');
    out.push('                 Nobody could see what it called. Treat tool expectations as WITHHELD.');
  } else if (!t.tool_calls || t.tool_calls.length === 0) {
    out.push('      tools:     none called (trace readable and empty)');
  } else {
    const calls = t.tool_calls
      .map((c) => {
        const ok = c.ok === undefined ? '?' : c.ok ? 'ok' : 'FAILED';
        const sum = c.summary ? ` — ${truncate(oneLine(c.summary), lim.valueChars)}` : '';
        return `${c.tool}[${ok}]${sum}`;
      })
      .join('; ');
    out.push(`      tools:     ${truncate(calls, lim.jsonChars * 2)}`);
  }
  return out;
}

/**
 * The transcript — count-capped from both ends, then budget-capped from the FRONT.
 *
 * Two different cuts, for two different reasons:
 *
 *   Count cap: keep the first 2 turns (they establish what was asked) and the last N (they contain
 *   the turn that tripped the bar). The middle is dropped with a marker naming how many went, so a
 *   3-turn excerpt is never read as a 3-turn conversation.
 *
 *   Character budget: when even the selected turns are too large, drop from the FRONT, never the
 *   back. The failing assertion is almost always late in a conversation; cutting the tail to stay
 *   in budget would reliably delete the single most diagnostic turn in the record. Whole turns are
 *   dropped, never partial ones — half a turn under a "turn 4" header is a misleading artefact.
 */
function renderTurns(turns: readonly TriageTurn[], lim: TriageLimits, budget: number): string[] {
  const ordered = [...turns].sort(
    (a, b) => (a.attempt ?? 1) - (b.attempt ?? 1) || (a.turn_index ?? 0) - (b.turn_index ?? 0),
  );

  let selected = ordered;
  let middleOmitted = 0;
  let headCount = 0;
  if (ordered.length > lim.maxTurnsPerWorkflow) {
    headCount = Math.min(2, lim.maxTurnsPerWorkflow - 1);
    const tail = lim.maxTurnsPerWorkflow - headCount;
    middleOmitted = ordered.length - headCount - tail;
    selected = [...ordered.slice(0, headCount), ...ordered.slice(ordered.length - tail)];
  }

  const blocks = selected.map((t) => turnBlock(t, lim));
  const cost = (b: string[]) => b.reduce((n, l) => n + l.length + 1, 0);

  // Fill backwards from the last turn until the budget is spent.
  let used = 0;
  let firstKept = blocks.length;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const c = cost(blocks[i] as string[]);
    if (used + c > budget && firstKept < blocks.length) break;
    if (used + c > budget && firstKept === blocks.length) {
      // Not even the last turn fits. Keep it anyway — a transcript section with no turn in it is
      // worse than one slightly over budget, and every line inside is already individually capped.
      firstKept = i;
      used += c;
      break;
    }
    used += c;
    firstKept = i;
  }

  const out: string[] = [];
  const budgetDropped = firstKept;
  if (budgetDropped > 0) {
    out.push(
      `    … [${budgetDropped} earlier turn(s) cut for size — the LAST turns are kept because the` +
        ` failing bar trips late]`,
    );
  }
  for (let i = firstKept; i < blocks.length; i++) {
    // The middle-omitted marker sits at its real position in the conversation, not at the top.
    if (middleOmitted > 0 && i === headCount) {
      out.push(
        `    … [${middleOmitted} middle turn(s) omitted — first ${headCount} and last ${
          blocks.length - headCount
        } kept]`,
      );
    }
    out.push(...(blocks[i] as string[]));
  }
  return out;
}

/**
 * MCP calls actually made.
 *
 * ⛔ ERRORED CALLS ARE EMITTED FIRST, as their own group, not merged back into index order.
 *
 * That looks like a cosmetic choice and is not. Both the count cap and the per-workflow character
 * budget cut from the END of this list; a call at index 39 that carried `upstream 503 from gmail`
 * would be exempted from the count cap, re-sorted to the bottom, and then quietly deleted by the
 * budget — which is precisely the line that would have classified the failure in one read. An
 * exemption that a later bound silently undoes is not an exemption. Emitting errors first makes
 * the guarantee survive every downstream cut. Call indices are printed on every line, so the
 * original ordering is still recoverable by eye.
 *
 * ⛔ Errors are FIRST, not EXEMPT. An earlier draft exempted them from the character budget
 * outright; a workflow with ten errored calls then blew the per-workflow ceiling tenfold and the
 * whole-brief hard cap deleted the triage instructions at the end of the file. A guarantee that
 * removes a bound has just moved the failure somewhere less visible.
 */
function renderMcpCalls(calls: readonly TriageMcpCall[], lim: TriageLimits): string[][] {
  const ordered = [...calls].sort((a, b) => (a.call_index ?? 0) - (b.call_index ?? 0));
  const errored = ordered.filter((c) => c.error);
  const clean = ordered.filter((c) => !c.error);
  const room = Math.max(0, lim.maxMcpCallsPerWorkflow - errored.length);
  const shownClean = clean.slice(0, room);

  const render = (c: TriageMcpCall): string[] => {
    const dur = c.duration_ms === null || c.duration_ms === undefined ? '' : ` · ${fmtMs(c.duration_ms)}`;
    return [
      `    #${fmtNum(c.call_index)} ${c.tool_name}${dur}${c.error ? '  ⛔ ERRORED' : ''}`,
      `        request:  ${fmtValue(c.request, lim.jsonChars)}`,
      c.error
        ? `        error:    ${fmtText(c.error, lim.errorChars)}`
        : `        response: ${fmtValue(c.response, lim.jsonChars)}`,
    ];
  };

  const blocks: string[][] = [];
  // The group header is prepended to the FIRST errored call, not pushed as a block of its own — a
  // header that survives the budget while the call under it is cut announces evidence that is not
  // there. Header and first error stand or fall together.
  const header =
    errored.length > 0 && clean.length > 0
      ? `    — ${errored.length} ERRORED call(s), shown first (out of index order, by design) —`
      : null;
  errored.forEach((c, i) => {
    const b = render(c);
    blocks.push(i === 0 && header ? [header, ...b] : b);
  });
  if (errored.length > 0 && shownClean.length > 0) {
    blocks.push(['    — successful calls, in index order —']);
  }
  for (const c of shownClean) blocks.push(render(c));
  const omitted = clean.length - shownClean.length;
  if (omitted > 0) {
    blocks.push([`    … [${omitted} of ${ordered.length} tool calls omitted — every errored call is kept]`]);
  }
  return blocks;
}

function renderClaims(claims: readonly TriageClaim[], lim: TriageLimits): string[][] {
  const blocks: string[][] = [];
  // Refuted/unverifiable first: a verified claim is not what triage is looking for.
  const ordered = [...claims].sort((a, b) => {
    const rank = (c: TriageClaim) => (c.verdict === 'refuted' ? 0 : c.verdict === 'verified' ? 2 : 1);
    return rank(a) - rank(b) || (a.claim_index ?? 0) - (b.claim_index ?? 0);
  });
  const shown = ordered.slice(0, lim.maxClaimsPerWorkflow);
  for (const c of shown) {
    const type = c.claim_type ? `${c.claim_type}: ` : '';
    const block = [
      `    [${(c.verdict ?? 'no verdict').toUpperCase()}] ${type}${fmtText(c.claim_text, lim.claimChars)}`,
    ];
    if (c.evidence && Object.keys(c.evidence).length > 0) {
      block.push(`        evidence: ${fmtValue(c.evidence, lim.jsonChars)}`);
    }
    blocks.push(block);
  }
  if (ordered.length > shown.length) {
    blocks.push([
      `    … [${ordered.length - shown.length} more claims omitted — refuted/unverifiable shown first]`,
    ]);
  }
  return blocks;
}

/**
 * How the per-workflow evidence budget is divided between the four kinds of evidence.
 *
 * A fixed split rather than first-come-first-served: without it, a workflow that made 200 MCP calls
 * would consume the whole budget before the transcript was reached, and the brief would silently
 * become "here are some tool calls" for exactly the workflows that are hardest to diagnose. Scenes
 * get the largest share because expected-vs-observed is what decides a classification.
 */
const EVIDENCE_BUDGET_SHARE = { scenes: 0.4, turns: 0.3, mcp: 0.2, claims: 0.1 } as const;

/** Characters a block of lines costs, newlines included. */
function blockCost(b: readonly string[]): number {
  return b.reduce((n, l) => n + l.length + 1, 0);
}

/**
 * Emit as many whole BLOCKS as the budget allows, then STOP AND SAY SO.
 *
 * Two rules, both learned the hard way:
 *
 *   Whole blocks. A cut inside an assertion (`expected:` kept, `observed:` gone) or inside an
 *   errored call (`⛔ ERRORED` kept, the error text gone) manufactures a false finding out of a
 *   size limit — the reader sees a field that genuinely looks unrecorded. Blocks are the unit that
 *   is meaningful on its own; nothing smaller may survive alone.
 *
 *   Always say so. A section that just ends is indistinguishable from a section that had nothing
 *   more to say. The marker names how many items went and how to get them.
 */
function capBlocks(blocks: string[][], budget: number, kind: string, rowId: string): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] as string[];
    const cost = blockCost(b);
    // Keep the first block even if it alone exceeds the budget: a section with a marker and no
    // content at all tells the reader strictly less than one over-long item does. Every line in it
    // is already individually capped, so the overrun is bounded.
    if (used + cost > budget && i > 0) {
      out.push(
        `    … [${blocks.length - i} more ${kind}(s) cut — per-workflow evidence budget reached;` +
          ` fetch the full record with get_workflow_result("${rowId}")]`,
      );
      return out;
    }
    out.push(...b);
    used += cost;
  }
  return out;
}

/** One failure's full block: header facts, then whatever evidence exists — or an honest absence. */
function renderFailureBlock(
  wf: TriageWorkflow,
  index: number,
  ev: TriageWorkflowEvidence | undefined,
  lim: TriageLimits,
): string[] {
  const out: string[] = [];
  const turns = ev?.turns ?? null;
  out.push(`### R${index} · ${wf.workflow_id} — ${humanName(wf.workflow_id)}`);
  out.push(`  verdict:   ${wf.verdict} (REJECTED — the product was tested and missed a bar)`);
  out.push(`  integrity: ${wf.integrity_class ?? 'not recorded'}`);
  out.push(`  ${trialsLine(wf, turns)}`);
  out.push(
    `  duration:  ${fmtMs(wf.duration_ms)} · provider ${wf.provider ?? '—'} · lanes ${
      wf.lanes && wf.lanes.length ? wf.lanes.join(', ') : '—'
    }`,
  );
  out.push(`  row id:    ${wf.id}`);
  out.push(`  FAILING BAR: ${fmtText(wf.failing_bar, lim.failingBarChars, '(no failing bar recorded)')}`);
  out.push(`  opening prompt: ${fmtText(wf.prompt, lim.promptChars)}`);

  if (!ev) {
    // ⛔ Honest degradation. The console fetches drilldown per-workflow, so most failures in a
    // run-wide triage have no evidence loaded. Say that, and hand over the exact call — never
    // print empty EXPECTED/OBSERVED sections, which read as "checked, nothing there".
    out.push('  evidence:  NOT LOADED in the console when this brief was copied.');
    out.push(
      `             Scenes, transcript, tool calls and claims exist in the store but were not fetched.`,
    );
    out.push(`             Fetch with: get_workflow_result("${wf.id}")`);
    out.push(
      '             ⛔ Absence here means "we did not look", NOT "there was nothing". Do not conclude',
    );
    out.push('             that no tools were called or no claims were made from this block.');
    return out;
  }

  const budget = lim.maxEvidenceCharsPerWorkflow;
  const scenes = ev.scenes ?? [];
  out.push('  EXPECTED vs OBSERVED:');
  if (scenes.length === 0) {
    out.push('    (drilldown loaded and contains no scene rows — the rig recorded no assertions)');
  } else {
    out.push(
      ...capBlocks(renderScenes(scenes, lim), budget * EVIDENCE_BUDGET_SHARE.scenes, 'assertion', wf.id),
    );
  }

  out.push('  TRANSCRIPT (what the assistant visibly replied):');
  if (turns === null) {
    out.push('    (this store returned no `turns` collection — it predates the turns table)');
  } else if (turns.length === 0) {
    out.push('    (drilldown loaded and contains no turns — no conversation was captured)');
  } else {
    // Turns do their own budgeting — they must be cut from the FRONT, not the back. See renderTurns.
    out.push(...renderTurns(turns, lim, budget * EVIDENCE_BUDGET_SHARE.turns));
  }

  const mcp = ev.mcp_calls ?? null;
  out.push('  MCP TOOL CALLS ACTUALLY MADE:');
  if (mcp === null) {
    out.push('    (no mcp_calls collection in the loaded drilldown)');
  } else if (mcp.length === 0) {
    out.push('    (drilldown loaded and contains no MCP calls — the product called nothing)');
  } else {
    // Errored calls are ordered FIRST so the budget cut cannot reach them. See renderMcpCalls.
    out.push(...capBlocks(renderMcpCalls(mcp, lim), budget * EVIDENCE_BUDGET_SHARE.mcp, 'tool call', wf.id));
  }

  const claims = ev.claims ?? null;
  out.push('  EXTRACTED CLAIMS:');
  if (claims === null) {
    out.push('    (no claims collection in the loaded drilldown)');
  } else if (claims.length === 0) {
    out.push('    (drilldown loaded and contains no extracted claims)');
  } else {
    out.push(...capBlocks(renderClaims(claims, lim), budget * EVIDENCE_BUDGET_SHARE.claims, 'claim', wf.id));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the triage brief for a run.
 *
 * `workflows` may be the whole run's workflow list (the "Triage this run" button) or a single
 * workflow (the drilldown's "⧉ Triage this workflow"). Both are handled: everything is derived
 * from the list, and the counters come from the run row.
 */
export function buildE2eTriagePrompt(
  run: TriageRun,
  workflows: readonly TriageWorkflow[],
  options: TriagePromptOptions = {},
): string {
  const lim = { ...DEFAULT_TRIAGE_LIMITS, ...(options.limits ?? {}) };
  const evidence = normaliseEvidence(options.evidence);

  const rejected = workflows.filter((w) => bucketOf(w) === 'rejected');
  const withheld = workflows.filter((w) => bucketOf(w) === 'withheld');
  const unresolved = workflows.filter((w) => bucketOf(w) === 'unresolved');
  const accepted = workflows.filter((w) => bucketOf(w) === 'accepted');

  const L: string[] = [];

  // ── 1 · Run context ──────────────────────────────────────────────────────
  const meta = (run.meta ?? {}) as { api_version?: unknown; workflows_intended?: unknown };
  const apiVersion = typeof meta.api_version === 'string' ? meta.api_version : null;
  L.push(`# E2E TRIAGE BRIEF — run ${run.run_id}`);
  L.push('');
  L.push('You are diagnosing a forge-hat end-to-end acceptance run against the live product.');
  L.push('All evidence available in the console at copy time is INLINE below. Read it before');
  L.push('fetching anything.');
  L.push('');
  L.push('## 1 · Run context');
  L.push(`  run_id:        ${run.run_id}`);
  L.push(`  tenant:        ${run.tenant_id ?? 'not recorded'}`);
  L.push(
    `  provider:      ${run.provider ?? 'not recorded'}${apiVersion ? ` · product api ${apiVersion}` : ''}`,
  );
  L.push(`  trigger:       ${run.trigger_source ?? 'not recorded'}`);
  L.push(`  status:        ${run.status ?? 'not recorded'}`);
  L.push(`  started:       ${run.started_at ?? 'not recorded'}`);
  L.push(
    `  completed:     ${run.completed_at ?? (run.status === 'running' ? 'still running' : 'not recorded')}`,
  );
  L.push(`  canonical URL: ${run.canonical_url ?? 'not recorded — quote the run_id in any report'}`);
  L.push('');
  L.push('  Top line (as the store counted it):');
  L.push(
    `    ${fmtNum(run.workflows_attempted)} attempted · ${fmtNum(run.workflows_passed)} accepted · ` +
      `${fmtNum(run.rejected_count ?? run.workflows_failed)} rejected · ${fmtNum(run.withheld_count)} withheld`,
  );
  L.push(
    `    pass rate ${run.pass_rate === null || run.pass_rate === undefined ? 'not computed' : `${Math.round(run.pass_rate * 100)}%`}` +
      ` · p50 ${fmtMs(run.p50_duration_ms)} · p99 ${fmtMs(run.p99_duration_ms)}` +
      ` · spend ${run.spend_cents === null || run.spend_cents === undefined ? '—' : `$${(run.spend_cents / 100).toFixed(2)}`}`,
  );
  L.push(`    tokens in ${fmtNum(run.total_input_tokens)} · out ${fmtNum(run.total_output_tokens)}`);
  L.push('');
  L.push(
    `  This brief covers ${workflows.length} workflow row(s) handed to it: ${accepted.length} accepted · ` +
      `${rejected.length} rejected · ${withheld.length} withheld · ${unresolved.length} unresolved.`,
  );
  L.push('');

  // ── 2 · The distinction ──────────────────────────────────────────────────
  // This section is not framing; it is the most important content in the file. An agent that reads
  // only this and section 3 still triages correctly. An agent that skips it files phantom bugs.
  L.push('## 2 · ⛔ READ FIRST — rejected is NOT the same as withheld');
  L.push('');
  L.push('  This harness reports THREE outcomes, not two:');
  L.push('');
  L.push('    ACCEPTED — the product met the bar.');
  L.push('    REJECTED — the product was tested and genuinely FAILED a bar. A verdict exists.');
  L.push('               These are the only candidates for a product bug.');
  L.push('    WITHHELD — the RIG failed (UNARMED / INFRA-FAIL / corrupted integrity). Nothing was');
  L.push('               tested. NO VERDICT EXISTS. This is a MISSING MEASUREMENT, not a defect.');
  L.push('');
  L.push('  ⛔ DO NOT file a product bug, open a product issue, or claim a product regression for');
  L.push('  anything in the WITHHELD section (§4). The product code in question was never executed.');
  L.push('  A withheld workflow tells you the harness or the environment needs fixing so the');
  L.push('  measurement can be taken — that is the entire finding. Fix the rig, re-run, then judge.');
  L.push('');
  L.push('  Equally: do not "explain away" a REJECTED workflow as infrastructure without evidence.');
  L.push('  Both directions of this mistake are expensive.');
  L.push('');

  // §3 is built LAST and spliced in here — see the comment above the builder below. Its size is
  // whatever is left after the fixed sections have taken theirs.
  const s3Anchor = L.length;

  // ── 4 · Withheld ─────────────────────────────────────────────────────────
  L.push(`## 4 · WITHHELD — the RIG failed, no verdict exists (${withheld.length})`);
  L.push('');
  L.push('  ⛔ NOT PRODUCT BUGS. Nothing below was measured. Do not file product findings from this');
  L.push('  section. The action here is to repair the harness/environment and re-run.');
  L.push('');
  if (withheld.length === 0) {
    L.push('  None — every workflow in this brief produced a real verdict.');
    L.push('');
  } else {
    const listed = withheld.slice(0, lim.maxWithheldListed);
    for (const wf of listed) {
      L.push(
        `  ⊘ ${wf.workflow_id} — ${withheldReason(wf)} (verdict "${wf.verdict}", integrity ${wf.integrity_class ?? 'not recorded'})`,
      );
    }
    if (withheld.length > listed.length) {
      // Roll the tail up by reason rather than dropping names into a void — the reason histogram is
      // what an operator acts on, and it stays truthful when the list is capped.
      const tally = new Map<string, number>();
      for (const wf of withheld.slice(listed.length)) {
        const r = withheldReason(wf);
        tally.set(r, (tally.get(r) ?? 0) + 1);
      }
      L.push(`  … [${withheld.length - listed.length} more withheld, rolled up by reason:]`);
      for (const [reason, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
        L.push(`      ${count} × ${reason}`);
      }
    }
    L.push('');
    const bd = (run.meta ?? {})['withheld_breakdown'];
    if (bd && typeof bd === 'object') {
      L.push('  Run-level withheld breakdown as the runner reported it:');
      for (const [reason, count] of Object.entries(bd as Record<string, unknown>)) {
        L.push(`    ${String(count)} × ${reason}`);
      }
      L.push('');
    }
  }

  // ── 5 · Unresolved ───────────────────────────────────────────────────────
  // Section 5 only exists when there is something ambiguous to resolve, so the later headings are
  // numbered from a counter rather than hardcoded — a brief that runs 1,2,3,4,6 reads like a
  // section went missing, and "what happened to §5?" is a question no triage agent should spend a
  // thought on.
  let nextSection = 5;
  if (unresolved.length > 0) {
    L.push(
      `## ${nextSection++} · UNRESOLVED VERDICT (${unresolved.length}) — decide which of the two, then act`,
    );
    L.push('');
    L.push('  These carry verdict "error": the store could not classify what the runner sent. Rows');
    L.push('  written before 2026-08-14 also used "error" for UNARMED / INFRA-FAIL, so an "error"');
    L.push('  row may be either a real rejection or a withheld one. ⛔ Resolve which BEFORE filing');
    L.push('  anything — read integrity_class and the tool trace. If it cannot be resolved, say so;');
    L.push('  an unresolved row is not a licence to guess.');
    L.push('');
    for (const wf of unresolved.slice(0, lim.maxUnresolvedListed)) {
      L.push(
        `  ? ${wf.workflow_id} — integrity ${wf.integrity_class ?? 'not recorded'} · trials ${fmtNum(wf.trials_passed)}/${fmtNum(wf.trials_total)}`,
      );
      L.push(`      bar: ${fmtText(wf.failing_bar, lim.failingBarChars, '(none recorded)')}`);
      L.push(`      get_workflow_result("${wf.id}")`);
    }
    if (unresolved.length > lim.maxUnresolvedListed) {
      L.push(`  … [${unresolved.length - lim.maxUnresolvedListed} more unresolved rows omitted]`);
    }
    L.push('');
  }

  // ── 6 · The task ─────────────────────────────────────────────────────────
  L.push(`## ${nextSection++} · What to do`);
  L.push('');
  L.push('  For EACH workflow in §3 (and each §5 row you resolve to a rejection), classify the');
  L.push('  failure into exactly one of these four, and say which evidence line decided it:');
  L.push('');
  L.push('    product              — the product did the wrong thing. The bar is right, the harness');
  L.push('                           asked correctly, the environment was healthy, and the observed');
  L.push('                           behaviour is genuinely wrong. This is the only class that');
  L.push('                           becomes a product finding.');
  L.push('    harness              — the rig is wrong: a driver/runner defect, a broken expectation,');
  L.push('                           a selector or timing bug. The product may be fine. Owner: forge-hat.');
  L.push('    workflow-translation — the scenario was translated into the wrong test: the assertion');
  L.push('                           does not express the intent, the prompt asks for something other');
  L.push('                           than what the bar checks, or the bar is over-tight. Owner: the');
  L.push('                           workflow definition, not the product.');
  L.push('    environment          — auth expiry, a dead channel, a deploy window, quota, a network');
  L.push('                           fault. Nothing to fix in either codebase; re-run once healthy.');
  L.push('');
  L.push('  For each one, report: classification · the root cause in one sentence · the evidence');
  L.push('  line that proves it · which repo owns the fix · whether it reproduces across trials.');
  L.push('');
  L.push('  ⛔ Never lower a bar to make a run green.');
  L.push('');
  L.push('  Also flag, explicitly:');
  L.push('    · any workflow whose trials disagree (flaky) — a bar that passes sometimes is a');
  L.push('      different finding from one that always fails, and must not be reported as the same.');
  L.push('    · any turn marked TOOL TRACE UNREADABLE — its tool expectations are WITHHELD, not met');
  L.push('      and not missed. Do not infer "called nothing" from an unreadable trace.');
  L.push('    · a single run is never conclusive on its own. Confirm a regression against a clean');
  L.push('      baseline before calling anything a regression.');
  L.push('');

  // ── 7 · Fetching more ────────────────────────────────────────────────────
  L.push(`## ${nextSection} · If you have the forge e2e MCP tools, this is how to get the rest`);
  L.push('');
  // padEnd, not hand-counted spaces: the run id is variable-length, so a hand-aligned column is
  // aligned for exactly one run id and ragged for every other.
  const toolLines: Array<[string, string]> = [
    [`get_e2e_run("${run.run_id}")`, 'the full run detail and every workflow row'],
    ['get_workflow_result("<row id>")', 'scenes, transcript, MCP calls, claims'],
    ['diff_e2e_runs("<run>", "<baseline>")', 'isolate regressions from standing failures'],
    ['list_e2e_runs({ limit: 10 })', 'find the last clean baseline'],
  ];
  const toolWidth = Math.max(...toolLines.map(([call]) => call.length));
  for (const [call, what] of toolLines) L.push(`    ${call.padEnd(toolWidth)}  — ${what}`);
  L.push('');
  L.push('  Row ids are printed with each workflow above. If you do NOT have these tools, everything');
  L.push('  inlined above is still sufficient to classify most failures — say what you could not');
  L.push('  determine rather than guessing at it.');

  // ── 3 · Rejected — built LAST, spliced FIRST ─────────────────────────────
  //
  // ⛔ Order matters, and it is the opposite of the reading order.
  //
  // Everything above and below §3 is FIXED-SIZE and non-negotiable: the withheld quarantine (§4),
  // the four classifications, "never lower a bar", the fetch instructions. §3 is the only section
  // that scales with the run — one bad night can reject seventy workflows. Building §3 first and
  // trimming the result at a global ceiling cuts from the END of the string, which deletes the
  // instructions and leaves a brief that is all evidence and no protocol. Measured, before this
  // was fixed: a 75-rejection run produced a 60 KB brief containing neither the withheld warning
  // nor "never lower a bar".
  //
  // So the fixed sections are built first and their cost is known; §3 gets what is left, and
  // degrades from full evidence → named one-liners → a count, announcing each step.
  const S3: string[] = [];
  const fixedCost = L.reduce((n, l) => n + l.length + 1, 0);
  // Reserve a little headroom for the splice itself and for the closing marker.
  let s3Budget = Math.max(0, lim.hardCapChars - fixedCost - 500);
  // ── 3 · Rejected ─────────────────────────────────────────────────────────
  S3.push(`## 3 · REJECTED — product failed a bar (${rejected.length})`);
  S3.push('');
  if (rejected.length === 0) {
    S3.push('  None. No workflow in this brief produced a product-level rejection.');
    S3.push('');
  } else {
    // Emit full evidence blocks while both the count cap AND the remaining budget allow. A
    // workflow that does not fit is not dropped — it falls through to the named list below.
    const detailed: TriageWorkflow[] = [];
    for (const wf of rejected.slice(0, lim.maxDetailedFailures)) {
      const block = renderFailureBlock(
        wf,
        detailed.length + 1,
        evidence.get(wf.id) ?? evidence.get(wf.workflow_id),
        lim,
      );
      const cost = blockCost(block) + 1;
      if (detailed.length > 0 && cost > s3Budget) break;
      s3Budget -= cost;
      detailed.push(wf);
      S3.push(...block);
      S3.push('');
    }
    if (rejected.length > detailed.length) {
      // Never dropped silently: the remainder is still named, with its bar, and with the call that
      // fetches its evidence.
      S3.push(
        `  … [${rejected.length - detailed.length} further rejected workflow(s) not detailed — evidence` +
          ` capped to keep this brief pasteable. Named below.]`,
      );
      // The one-liner list draws on the SAME budget as the evidence blocks. Left unbudgeted it
      // silently reintroduced the overflow the split was meant to remove: 22 names × ~300 chars is
      // another 6 KB, and the ceiling then ate the instructions again.
      let namedCount = 0;
      for (const wf of rejected.slice(detailed.length, lim.maxRejectedListed)) {
        const pair = [
          `    × ${wf.workflow_id} — bar: ${fmtText(wf.failing_bar, lim.summaryBarChars, '(none recorded)')}`,
          `        trials ${fmtNum(wf.trials_passed)}/${fmtNum(wf.trials_total)} · get_workflow_result("${wf.id}")`,
        ];
        const cost = blockCost(pair);
        if (cost > s3Budget) break;
        s3Budget -= cost;
        namedCount++;
        S3.push(...pair);
      }
      const unnamed = rejected.length - detailed.length - namedCount;
      if (unnamed > 0) {
        // Even the one-liner list is bounded — a run can reject 70 workflows, and 70 × 240 chars of
        // tail would eat the instructions at the bottom of the brief. Points at the complete source
        // rather than pretending the list is exhaustive.
        S3.push(
          `    … [${unnamed} further rejected workflow(s) not named individually —` +
            ` get_e2e_run("${run.run_id}") returns every row]`,
        );
      }
      S3.push('');
    }
  }

  L.splice(s3Anchor, 0, ...S3);

  let text = L.join('\n');
  if (text.length > lim.hardCapChars) {
    // Last-resort ceiling. Announced, like every other cut in this file.
    const cut = text.length - lim.hardCapChars;
    text = `${text.slice(0, lim.hardCapChars)}\n\n… [BRIEF TRUNCATED — +${cut} chars cut at the ${lim.hardCapChars}-char clipboard ceiling. Sections may be missing entirely; fetch the rest with get_e2e_run("${run.run_id}").]`;
  }
  return text;
}
