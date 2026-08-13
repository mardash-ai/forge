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
  meta?: { catalogue_size?: number } | null;
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
  const catalogue = run.meta?.catalogue_size;
  const attempted = run.workflows_attempted ?? 0;
  if (attempted <= 0) return 'nothing attempted';
  if (!catalogue || catalogue <= 0) return 'catalogue size unknown';
  return `${Math.round((attempted / catalogue) * 100)}% of catalogue`;
}

/** Accepted tile sub-line — the mock's "57% of runnable" (runnable excludes withheld). */
export function fmtE2ePctOfRunnable(run: E2ERunCounts | null | undefined): string {
  if (!run) return '—';
  const runnable = (run.workflows_attempted ?? 0) - (run.withheld_count ?? 0);
  if (runnable <= 0) return 'none runnable';
  return `${Math.round(((run.workflows_passed ?? 0) / runnable) * 100)}% of runnable`;
}
