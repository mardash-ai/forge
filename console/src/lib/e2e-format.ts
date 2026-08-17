/**
 * Pure formatters for the E2E tab's tile sub-lines.
 *
 * These live outside App.tsx so they can be unit-tested directly — the sub-lines are prose
 * *claims* about the numbers beside them, and a claim is exactly the kind of thing that should
 * have a test. Found in production on 2026-08-13: a run that died before attempting a single
 * workflow rendered `ATTEMPTED 0` above a confident "100% of catalogue".
 */

/** The subset of a run these formatters read. Structural, so callers can pass their own run type. */
export interface E2ERunCounts {
  workflows_attempted?: number | null;
  workflows_passed?: number | null;
  withheld_count?: number | null;
  /**
   * `workflows_intended` is what the RUNNER reports — how many workflows this run set out to
   * execute, known before the first one starts. `catalogue_size` was the name the UI read and
   * nothing ever wrote (it existed only in a fixture), so every real run rendered
   * "catalogue size unknown" while the count sat in the payload under the other name.
   */
  meta?: { workflows_intended?: number; catalogue_size?: number } | null;
}

/**
 * Attempted tile sub-line — the mock's "100% of catalogue".
 *
 * Never claims a fraction it cannot compute. A run that attempted nothing is not "100% of
 * catalogue", and an unknown catalogue size is not a full one: both previously fell through the
 * same branch and rendered the mock's happy-path string under a zero. Absence reads as absence.
 */
export function fmtE2ePctOfCatalogue(run: E2ERunCounts | null | undefined): string {
  if (!run) return '—';
  const planned = run.meta?.workflows_intended ?? run.meta?.catalogue_size;
  const attempted = run.workflows_attempted ?? 0;
  if (attempted <= 0) return 'nothing attempted';
  if (!planned || planned <= 0) return 'planned count not reported';
  // Say what is LEFT, not only a percentage — the operator's question during a run is "how much
  // more", and a bare percentage makes them do the arithmetic (Mark, 2026-08-14).
  const remaining = Math.max(0, planned - attempted);
  return remaining > 0 ? `${attempted} of ${planned} · ${remaining} to go` : `${attempted} of ${planned}`;
}

/** Accepted tile sub-line — the mock's "57% of runnable" (runnable excludes withheld). */
export function fmtE2ePctOfRunnable(run: E2ERunCounts | null | undefined): string {
  if (!run) return '—';
  const runnable = (run.workflows_attempted ?? 0) - (run.withheld_count ?? 0);
  if (runnable <= 0) return 'none runnable';
  return `${Math.round(((run.workflows_passed ?? 0) / runnable) * 100)}% of runnable`;
}

/**
 * Run-modal "Full catalogue" radio label.
 *
 * Never renders a raw null: when the catalogue size is known it names the count; when it is not
 * yet known it says so in words — the same rule applied to the Attempted tile sub-line.
 *
 *   fmtE2eFullScopeLabel(75)   → "Full catalogue — 75 workflows"
 *   fmtE2eFullScopeLabel(null) → "Full catalogue — workflow count not yet known"
 */
export function fmtE2eFullScopeLabel(catalogueSize: number | null | undefined): string {
  if (typeof catalogueSize === 'number' && catalogueSize > 0) {
    return `Full catalogue — ${catalogueSize} workflows`;
  }
  return 'Full catalogue — workflow count not yet known';
}

/**
 * Run-modal spend-estimate duration label.
 *
 * Scales with the selection instead of borrowing the full-catalogue ~40 min figure for
 * every scope. Named workflows are estimated at ~1 min each; a suite run at ~20 min; the full
 * catalogue at ~40 min. Follows the same "name the number when you have it" rule as the other
 * formatters — the caller is responsible for not surfacing this when no cost estimate is known.
 *
 *   fmtE2eRunDuration('full',   1) → "~40 min"
 *   fmtE2eRunDuration('suite',  1) → "~20 min"
 *   fmtE2eRunDuration('named',  1) → "~1 min"
 *   fmtE2eRunDuration('named',  3) → "~3 min"
 */
/**
 * How long a run of this scope should take.
 *
 * ⛔ `full` used to return a hardcoded `~40 min`. Six measured runs on 2026-08-14 averaged ~58s of
 * WALL CLOCK per workflow, and the catalogue is 76 — about 73 minutes. The modal was therefore
 * understating a full run by nearly half, next to a spend figure that was understating it by 30x,
 * above the checkbox where the operator gives consent. Both now derive from what runs actually did.
 *
 * `secsPerWorkflow` and `catalogue` are optional: when either is unknown the estimate says so
 * rather than substituting a number nobody measured.
 */
export function fmtE2eRunDuration(
  scope: 'full' | 'suite' | 'named',
  namedCount: number,
  catalogue?: number | null,
  secsPerWorkflow?: number | null,
): string {
  const perWf = typeof secsPerWorkflow === 'number' && secsPerWorkflow > 0 ? secsPerWorkflow : null;
  const mins = (n: number) => `~${Math.max(1, Math.round((n * (perWf ?? 0)) / 60))} min`;
  if (scope === 'named') return perWf ? mins(namedCount) : `~${namedCount} min`;
  if (scope === 'suite') return perWf ? mins(20) : '~20 min';
  if (perWf && typeof catalogue === 'number' && catalogue > 0) return mins(catalogue);
  return 'duration not yet measured';
}

// ─────────────────────────────────────────────────────────────────────────────
// Run-over-run diff — `GET /api/e2e/diff`
// ─────────────────────────────────────────────────────────────────────────────
//
// ⛔ THE ONE INVARIANT EVERY FUNCTION BELOW UPHOLDS: **a WITHHELD verdict is never a regression.**
//
// `became-withheld` means the rig stopped observing — forge-hat's UNARMED / INFRA-FAIL, including
// `claims-unavailable`. Nothing was tested, so there is no verdict to have got worse. Counting it as
// a red cost three releases on 2026-08-16 (HAT-F-065): an operator chased a "regression" that was a
// dead credential, while the lane it hid stayed unobserved.
//
// The rule is structural here, not a convention the UI is asked to remember: `e2eGroupDiffChanges`
// puts withheld rows in their own bucket, `e2eDeltaCounts` counts the buckets rather than the raw
// kinds, and `e2eDeltaSegments` hands the withheld segment a tone that is not `crit`. A caller has
// to work at it to render one as a failure.
//
// ⚠️ `E2EDiffKind` mirrors `src/console/e2e-api.ts` → `DiffChangeKind`, which itself mirrors
// `forge-hat/src/results/diff.ts`. Three repos, one vocabulary; keep them in step.

export type E2EDiffKind =
  | 'newly-red'
  | 'newly-green'
  | 'still-red'
  | 'still-green'
  | 'became-withheld'
  | 'became-graded'
  | 'withheld-both'
  | 'added'
  | 'removed';

/** ⛔ Exactly one kind is a regression — the console's copy of the server's `isRegression`. */
export function e2eIsRegressionKind(kind: E2EDiffKind): boolean {
  return kind === 'newly-red';
}

/** One row of the diff. Verdicts are the raw store spellings, not display labels. */
export interface E2EDiffChange {
  key: string;
  workflow_id: string;
  provider: string | null;
  kind: E2EDiffKind;
  before: string | null;
  after: string | null;
}

/**
 * Per-workflow flip history, keyed exactly as a diff row is keyed.
 *
 * Every field is optional on purpose. `instability` is served by a newer forge than the one a given
 * console may be talking to, and an absent noise floor must degrade to "no history yet" — never to a
 * confident claim, and never to a crash.
 */
export interface E2EInstability {
  key?: string;
  /** Graded verdicts in the window, oldest first. Withheld runs are already dropped. */
  samples?: string[];
  flips?: number;
  flipRate?: number;
  withheldRuns?: number;
  /** ⛔ False whenever fewer than two GRADED samples exist: unknown is not stable. */
  known?: boolean;
  unstable?: boolean;
}

/** The subset of the `/api/e2e/diff` payload these formatters read. */
export interface E2EDiffPayload {
  run_id?: string;
  baseline_run_id?: string;
  changes?: E2EDiffChange[] | null;
  counts?: Partial<Record<E2EDiffKind, number>> | null;
  /** Added by a later forge. Absent is a supported state, not an error. */
  instability?: Record<string, E2EInstability> | null;
}

/**
 * The provider-qualified row key — a verbatim mirror of the server's `diffRowKey`.
 *
 * ⛔ Keying on bare `workflow_id` collapses a dual-provider run into one entry, so an anthropic
 * regression can hide behind an openai pass. The console joins its own workflow rows to diff rows
 * with this, and both sides derive the key from the same stored fields, so the join is exact.
 */
export function e2eDiffRowKey(wf: { workflow_id: string; provider?: string | null }): string {
  return wf.provider ? `${wf.workflow_id}:${wf.provider}` : wf.workflow_id;
}

/**
 * The four groups the run-detail panel renders, in the order it renders them.
 *
 * `trustedRed` and `flakyRed` partition `newly-red` by whether the flip history says this workflow
 * changes its mind anyway. ⛔ A row with NO history lands in `trustedRed`, deliberately: "unstable"
 * requires evidence of instability, and letting absent history demote a red would suppress exactly
 * the reds nobody has ever seen before.
 */
export interface E2EDiffGroups {
  /** newly-red, and nothing in the history says it flips. Lead with these. */
  trustedRed: E2EDiffChange[];
  /** newly-red, but `instability.unstable` — weak evidence, confirm before chasing. */
  flakyRed: E2EDiffChange[];
  /** newly-green — a red that came back. */
  recovered: E2EDiffChange[];
  /** ⛔ became-withheld. The rig stopped observing. NEVER a regression, never counted as one. */
  withheld: E2EDiffChange[];
}

export function e2eGroupDiffChanges(diff: E2EDiffPayload | null | undefined): E2EDiffGroups {
  const out: E2EDiffGroups = { trustedRed: [], flakyRed: [], recovered: [], withheld: [] };
  const instability = diff?.instability ?? null;
  for (const c of diff?.changes ?? []) {
    if (c.kind === 'newly-red') {
      // `=== true` and not a truthiness check: an absent field must not read as unstable.
      if (instability?.[c.key]?.unstable === true) out.flakyRed.push(c);
      else out.trustedRed.push(c);
    } else if (c.kind === 'newly-green') out.recovered.push(c);
    else if (c.kind === 'became-withheld') out.withheld.push(c);
  }
  const byId = (a: E2EDiffChange, b: E2EDiffChange) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  out.trustedRed.sort(byId);
  out.flakyRed.sort(byId);
  out.recovered.sort(byId);
  out.withheld.sort(byId);
  return out;
}

/**
 * The delta chips above a run.
 *
 * Counted from the GROUPS, never from the server's raw `counts` map — the same rule the verdict
 * tiles follow ("count the rows you are about to render"). A chip and the rows beneath it cannot
 * disagree, because they are the same array.
 */
export interface E2EDeltaCounts {
  /** newly-red with a steady (or absent) flip history. */
  trustedRed: number;
  /** newly-red on a workflow that flips. */
  flakyRed: number;
  /** trustedRed + flakyRed. ⛔ Never includes a withheld row. */
  newlyRed: number;
  recovered: number;
  /** ⛔ became-withheld. Reported, never added to any red total. */
  withheld: number;
  /** still-red + still-green + withheld-both — rows whose classification did not move. */
  unchanged: number;
  /** Was withheld, is graded now. Evidence arrived; the verdict itself may still be red. */
  becameGraded: number;
  added: number;
  removed: number;
}

export function e2eDeltaCounts(diff: E2EDiffPayload | null | undefined): E2EDeltaCounts {
  const g = e2eGroupDiffChanges(diff);
  let unchanged = 0;
  let becameGraded = 0;
  let added = 0;
  let removed = 0;
  for (const c of diff?.changes ?? []) {
    if (c.kind === 'still-red' || c.kind === 'still-green' || c.kind === 'withheld-both') unchanged += 1;
    else if (c.kind === 'became-graded') becameGraded += 1;
    else if (c.kind === 'added') added += 1;
    else if (c.kind === 'removed') removed += 1;
  }
  return {
    trustedRed: g.trustedRed.length,
    flakyRed: g.flakyRed.length,
    newlyRed: g.trustedRed.length + g.flakyRed.length,
    recovered: g.recovered.length,
    withheld: g.withheld.length,
    unchanged,
    becameGraded,
    added,
    removed,
  };
}

/** Semantic tone. ⛔ There is deliberately no `crit` path for the withheld segment. */
export type E2EDeltaTone = 'crit' | 'ok' | 'info';

export interface E2EDeltaSegment {
  kind: 'newly-red' | 'newly-green' | 'became-withheld';
  glyph: '▲' | '▼' | '⊘';
  count: number;
  tone: E2EDeltaTone;
  /** Spoken form, for a title/aria-label — a glyph alone is not an accessible label. */
  label: string;
}

/**
 * The `Δ vs prev` column, as data.
 *
 * Zero segments are omitted rather than rendered as `▲0`: a column full of zeroes reads as noise and
 * hides the rows that did move. The withheld segment is `info`, and there is no branch that makes it
 * anything else — that is the invariant, expressed as code rather than as a comment.
 */
export function e2eDeltaSegments(counts: E2EDeltaCounts | null | undefined): E2EDeltaSegment[] {
  if (!counts) return [];
  const segs: E2EDeltaSegment[] = [];
  if (counts.newlyRed > 0)
    segs.push({ kind: 'newly-red', glyph: '▲', count: counts.newlyRed, tone: 'crit', label: 'newly red' });
  if (counts.recovered > 0)
    segs.push({ kind: 'newly-green', glyph: '▼', count: counts.recovered, tone: 'ok', label: 'recovered' });
  if (counts.withheld > 0)
    segs.push({
      kind: 'became-withheld',
      glyph: '⊘',
      count: counts.withheld,
      tone: 'info',
      label: 'withheld',
    });
  return segs;
}

/** `▲2 ▼1 ⊘3`. `no change` when a comparison ran and moved nothing; `—` when none ran. */
export function fmtE2eDeltaCompact(counts: E2EDeltaCounts | null | undefined): string {
  if (!counts) return '—';
  const segs = e2eDeltaSegments(counts);
  return segs.length === 0 ? 'no change' : segs.map((s) => `${s.glyph}${s.count}`).join(' ');
}

/** The spoken form of the same column — and it says out loud that withheld is not a regression. */
export function fmtE2eDeltaTitle(counts: E2EDeltaCounts | null | undefined): string {
  if (!counts) return 'no comparison available';
  const segs = e2eDeltaSegments(counts);
  if (segs.length === 0) return 'nothing changed since the previous run';
  const body = segs.map((s) => `${s.count} ${s.label}`).join(' · ');
  return counts.withheld > 0 ? `${body} — withheld is not a regression` : body;
}

/** Stated in the UI, verbatim, wherever withheld rows are shown. */
export const E2E_WITHHELD_NOT_A_REGRESSION =
  'The rig stopped observing these — nothing was tested, so there is no verdict to have got worse. Not product regressions.';

/**
 * A verdict as the operator reads it, optionally with the trial fraction behind it.
 *
 * ⛔ A withheld verdict NEVER renders a fraction. `INFRA-FAIL 0/3` would assert three trials were
 * graded and all failed, when in fact none of them ran — the precise lie this whole surface exists
 * to stop. `null` is `—`: absent, not zero.
 */
export function fmtE2eDiffVerdict(
  verdict: string | null | undefined,
  trials?: { passed?: number | null; total?: number | null } | null,
): string {
  if (!verdict) return '—';
  if (verdict === 'withheld' || verdict === 'skip') return 'INFRA-FAIL';
  const label = verdict === 'pass' ? 'ACCEPTED' : verdict === 'fail' ? 'REJECTED' : verdict.toUpperCase();
  const total = trials?.total ?? 0;
  if (total > 0) return `${label} ${trials?.passed ?? 0}/${total}`;
  return label;
}

/**
 * The row's flip-history label.
 *
 * ⛔ "No history yet" is stated, never rendered as steady. Fewer than two graded samples is unknown,
 * and unknown must not quietly reassure someone about a red they have never seen before.
 */
export function fmtE2eFlipHistory(i: E2EInstability | null | undefined): string {
  const withheldRuns = i?.withheldRuns ?? 0;
  if (!i || i.known !== true) {
    if (withheldRuns > 0) return `no graded history · ${withheldRuns} withheld`;
    return 'no history yet';
  }
  const flips = i.flips ?? 0;
  const runs = i.samples?.length ?? 0;
  const base = `${flips} flip${flips === 1 ? '' : 's'} in ${runs} run${runs === 1 ? '' : 's'}`;
  return withheldRuns > 0 ? `${base} · ${withheldRuns} withheld` : base;
}

export type E2ESparkMark = 'ok' | 'red' | 'held';

/**
 * The verdict-history sparkline, oldest first.
 *
 * ⛔ Only what the data actually says. `Instability.samples` carries GRADED verdicts with the
 * withheld runs already dropped and no record of where they sat, so interleaved withheld runs cannot
 * be placed — and are not invented. The one withheld mark this function will emit is a trailing one,
 * for a run the caller knows is withheld right now (a `became-withheld` row), which is positionally
 * certain because it is the newest point in the series.
 */
export function e2eSparkSeries(
  i: E2EInstability | null | undefined,
  opts: { trailingWithheld?: boolean; max?: number } = {},
): E2ESparkMark[] {
  const max = opts.max ?? 12;
  const marks: E2ESparkMark[] = (i?.samples ?? []).map((v) => (v === 'pass' ? 'ok' : 'red'));
  if (opts.trailingWithheld) marks.push('held');
  return marks.length > max ? marks.slice(marks.length - max) : marks;
}

/** Structural stand-in for a run: enough to order two of them. */
export interface E2ERunOrder {
  run_id: string;
  started_at?: string | null;
}

/**
 * The run immediately BEFORE this one — the nearest strictly-older run by `started_at`.
 *
 * ⛔ This was `runs.find((r) => r.run_id !== activeRun?.run_id)` over a started_at-DESC list. For the
 * newest run that happens to be right; for every OTHER run it returns the run immediately *after* the
 * one being viewed, and the duration chart then labelled a later run "previous nightly". A comparison
 * that silently runs backwards is worse than no comparison.
 *
 * A verbatim mirror of the rule `GET /api/e2e/diff` applies server-side when no `baseline_run_id` is
 * given, so the chart and the diff panel can never name different baselines. Strictly older, so two
 * runs sharing a `started_at` are not each other's predecessor; `run_id` breaks any remaining tie
 * deterministically. Order-independent — it does not assume the caller's list is sorted.
 */
export function e2ePreviousRun<T extends E2ERunOrder>(
  runs: readonly T[],
  current: E2ERunOrder | null | undefined,
): T | null {
  const at = current?.started_at ? String(current.started_at) : null;
  if (!current || !at) return null;
  let best: T | null = null;
  for (const r of runs) {
    if (r.run_id === current.run_id) continue;
    const rt = r.started_at ? String(r.started_at) : null;
    if (!rt || rt >= at) continue;
    if (best === null) {
      best = r;
      continue;
    }
    const bt = String(best.started_at);
    if (rt > bt || (rt === bt && r.run_id > best.run_id)) best = r;
  }
  return best;
}
