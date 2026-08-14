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
export function fmtE2eRunDuration(scope: 'full' | 'suite' | 'named', namedCount: number): string {
  if (scope === 'named') return `~${namedCount} min`;
  if (scope === 'suite') return '~20 min';
  return '~40 min';
}
