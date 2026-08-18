/**
 * INSTABILITY — the noise floor under a diff.
 *
 * A diff answers "what changed since the baseline". It cannot answer "does this row change all the
 * time anyway", and against a stochastic system a coin-flip red and a real regression are the same
 * row. This module counts how often a verdict CHANGED between consecutive GRADED runs.
 *
 * ⛔ THE LOAD-BEARING TESTS ARE THE TWO SUPPRESSION GUARDS, and both protect a red from being
 * silently explained away:
 *
 *   1. Withheld/skip rows are dropped BEFORE flips are counted. `withheld` means the RIG failed and
 *      nothing was graded — pass, withheld, pass is ZERO flips, not two. Counting a dead network as
 *      a "change" manufactures instability out of nothing and buries a real regression under it.
 *   2. Fewer than two graded samples is `known: false` AND `unstable: false`. "Unstable" must mean
 *      EVIDENCE of instability, never absence of evidence — otherwise a first-ever red, the one
 *      nobody has seen before, gets downgraded to noise on no data at all.
 *
 * The third guard is the inverse: a steadily-failing workflow is STABLE. Instability is about
 * CHANGE, not about quality, and this module never touches a verdict either way.
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_INSTABILITY_WINDOW,
  UNSTABLE_AT_FLIP_RATE,
  UNSTABLE_MIN_SAMPLES,
  countFlips,
  describeInstability,
  instabilityOf,
  isUnstable,
  queryInstability,
} from '../src/console/e2e-api';
import type { EvalRun, EvalWorkflow, WorkflowVerdict } from '../src/storage/backends/cp-results/types';

// ── fixtures ────────────────────────────────────────────────────────────────

function wf(id: string, verdict: WorkflowVerdict, provider: string | null = null): EvalWorkflow {
  return {
    id: `row:${id}:${provider ?? '-'}`,
    run_id: 'r',
    workflow_id: id,
    tenant_id: 't',
    verdict,
    integrity_class: null,
    prompt: null,
    duration_ms: null,
    started_at: null,
    completed_at: null,
    input_tokens: 0,
    output_tokens: 0,
    provider,
    lanes: provider ? [provider] : [],
    trials_total: verdict === 'withheld' ? 0 : 3,
    trials_passed: verdict === 'pass' ? 3 : 0,
    failing_bar: null,
    meta: {},
    created_at: '2026-08-16T02:00:00.000Z',
    updated_at: '2026-08-16T02:00:00.000Z',
  };
}

/** A series of rows for one key, from a list of verdicts (oldest first). */
function series(verdicts: WorkflowVerdict[], id = 'W-001'): EvalWorkflow[] {
  return verdicts.map((v) => wf(id, v));
}

function run(n: number): EvalRun {
  const day = String(n).padStart(2, '0');
  return {
    run_id: `run-${day}`,
    tenant_id: 't',
    canonical_url: null,
    provider: null,
    trigger_source: null,
    workflows_attempted: 0,
    workflows_passed: 0,
    workflows_failed: 0,
    pass_rate: null,
    withheld_count: 0,
    rejected_count: 0,
    spend_cents: 0,
    p50_duration_ms: null,
    p99_duration_ms: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    status: 'completed',
    started_at: `2026-08-${day}T02:00:00.000Z`,
    completed_at: null,
    meta: {},
    created_at: `2026-08-${day}T02:00:00.000Z`,
    updated_at: `2026-08-${day}T02:00:00.000Z`,
  };
}

/**
 * A store over `byRun`, keyed run_id → workflow rows. `listAllRuns` answers started_at DESC exactly
 * as pg does — the ordering the query must not trust.
 */
function fakeStore(byRun: Record<string, EvalWorkflow[]>) {
  const calls = { listAllRuns: [] as number[], listWorkflows: [] as string[] };
  const runs = Object.keys(byRun)
    .sort()
    .map((id) => ({ ...run(Number(id.split('-')[1])), run_id: id }));
  const store = {
    listAllRuns: async (opts: { limit?: number } = {}) => {
      calls.listAllRuns.push(opts.limit ?? -1);
      const desc = [...runs].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
      return desc.slice(0, opts.limit ?? desc.length);
    },
    listWorkflows: async (runId: string) => {
      calls.listWorkflows.push(runId);
      return byRun[runId] ?? [];
    },
  };
  return { store: store as never, calls };
}

// ── countFlips ──────────────────────────────────────────────────────────────

describe('countFlips', () => {
  it('counts changes between consecutive samples, and nothing else', () => {
    expect(countFlips([])).toBe(0);
    expect(countFlips(['pass'])).toBe(0);
    expect(countFlips(['pass', 'pass'])).toBe(0);
    expect(countFlips(['pass', 'fail'])).toBe(1);
    expect(countFlips(['pass', 'fail', 'pass'])).toBe(2);
    expect(countFlips(['pass', 'pass', 'fail', 'fail', 'pass'])).toBe(2);
  });

  it('a run of identical verdicts never flips, however long and however red', () => {
    expect(countFlips(Array(10).fill('fail') as WorkflowVerdict[])).toBe(0);
  });

  it("forge grades with three values, so fail → error is a change (forge-hat's set has two)", () => {
    // A workflow oscillating between a product failure and a provider error is not one whose red
    // deserves confidence, so the change counts. Documented because it makes forge's flip counts
    // marginally more sensitive than forge-hat's on the same history.
    expect(countFlips(['fail', 'error'])).toBe(1);
  });
});

// ── isUnstable ──────────────────────────────────────────────────────────────

describe('isUnstable', () => {
  it('⛔ is false below two graded samples, at any flip count — evidence, never absence of it', () => {
    expect(isUnstable(0, 0)).toBe(false);
    expect(isUnstable(0, 1)).toBe(false);
    expect(isUnstable(5, 1)).toBe(false);
  });

  it('trips at the declared RATE with the sample floor, and not before', () => {
    // The exact boundary, both sides. 10 graded samples ⇒ 9 pairs; 40% of 9 is 3.6, so 3 flips is
    // trusted and 4 is noise.
    expect(isUnstable(3, 10)).toBe(false);
    expect(isUnstable(4, 10)).toBe(true);
    // Below the sample floor nothing is unstable, at any flip count.
    expect(isUnstable(2, 3)).toBe(false);
    expect(isUnstable(2, 4)).toBe(true); // 2/3 ≈ 67%
  });

  it('⛔ the constants are PINNED, and mirrored in forge-hat — change them together', () => {
    /*
     * Retuned 2026-08-18 against the acceptance machine's real store: the old absolute rule
     * (flips >= 2 in the window) branded 27 of 88 known workflows (31%) unstable — silencing a
     * third of the catalogue's regressions. Rate ≥ 0.4 with ≥ 4 graded samples brands 8/88 (9%),
     * exactly the genuine flappers (W-991 at 100%, W-104 at 71%, W-046 at 56%).
     *
     * ⛔ forge-hat/src/results/instability.ts carries the SAME rule for the CLI classifier. If this
     * assertion just failed on a deliberate retune, retune forge-hat's copy in the same change —
     * its own pinning test names this file right back.
     */
    expect(UNSTABLE_AT_FLIP_RATE).toBe(0.4);
    expect(UNSTABLE_MIN_SAMPLES).toBe(4);
    expect(DEFAULT_INSTABILITY_WINDOW).toBe(10);
  });
});

// ── instabilityOf ───────────────────────────────────────────────────────────

describe('instabilityOf', () => {
  it('⛔ drops WITHHELD rows from the series: pass, withheld, pass is ZERO flips', () => {
    // The rig failed in the middle. Nothing was graded, so nothing changed. Counting the withheld
    // row as two flips would brand a rock-steady workflow unstable on a dead network alone.
    const i = instabilityOf('W-001', series(['pass', 'withheld', 'pass']));

    expect(i.flips).toBe(0);
    expect(i.samples).toEqual(['pass', 'pass']);
    expect(i.withheldRuns).toBe(1);
    expect(i.known).toBe(true);
    expect(i.unstable).toBe(false);
    expect(i.flipRate).toBe(0);
  });

  it('⛔ drops SKIP the same way — forge withholds under two names', () => {
    const i = instabilityOf('W-001', series(['fail', 'skip', 'fail', 'skip', 'fail']));

    expect(i.samples).toEqual(['fail', 'fail', 'fail']);
    expect(i.flips).toBe(0);
    expect(i.withheldRuns).toBe(2);
    expect(i.unstable).toBe(false);
  });

  it('⛔ fewer than two GRADED samples ⇒ known:false AND unstable:false — a first-ever red stands', () => {
    // Nine withheld runs and one red. There is no history to judge this red by, and "no history"
    // must never be served as "known noise" — that suppresses exactly the reds nobody has seen.
    const first = instabilityOf('W-001', series(['fail']));
    expect(first.known).toBe(false);
    expect(first.unstable).toBe(false);
    expect(first.flipRate).toBe(0);

    const blind = instabilityOf('W-001', series(['withheld', 'withheld', 'withheld', 'withheld', 'fail']));
    expect(blind.samples).toEqual(['fail']);
    expect(blind.withheldRuns).toBe(4);
    expect(blind.known).toBe(false);
    expect(blind.unstable).toBe(false);

    const nothing = instabilityOf('W-001', series(['withheld', 'skip']));
    expect(nothing.samples).toEqual([]);
    expect(nothing.known).toBe(false);
    expect(nothing.unstable).toBe(false);
    expect(nothing.flipRate).toBe(0);
  });

  it('⛔ a steadily-failing workflow is STABLE — instability is about change, not quality', () => {
    const i = instabilityOf('W-002', series(Array(8).fill('fail') as WorkflowVerdict[]));

    expect(i.flips).toBe(0);
    expect(i.flipRate).toBe(0);
    expect(i.known).toBe(true);
    expect(i.unstable).toBe(false);
    // ⛔ And the verdict itself is untouched: every sample is still red.
    expect(i.samples.every((v) => v === 'fail')).toBe(true);
  });

  it('the coin flip is unstable', () => {
    const i = instabilityOf('W-016', series(['pass', 'fail', 'pass', 'fail', 'pass']));

    expect(i.flips).toBe(4);
    expect(i.flipRate).toBe(1);
    expect(i.known).toBe(true);
    expect(i.unstable).toBe(true);
  });

  it('one flip in a long green history is known but not unstable', () => {
    const i = instabilityOf('W-004', series(['pass', 'pass', 'pass', 'pass', 'fail']));

    expect(i.flips).toBe(1);
    expect(i.known).toBe(true);
    expect(i.unstable).toBe(false);
    expect(i.flipRate).toBeCloseTo(0.25);
  });

  it('describeInstability states the sample count, so 3-of-5 cannot read as 3-of-9', () => {
    expect(describeInstability(instabilityOf('W-001', series(['fail'])))).toContain('1 graded run');
    expect(describeInstability(instabilityOf('W-016', series(['pass', 'fail', 'pass'])))).toContain(
      '3 graded runs',
    );
  });
});

// ── queryInstability, against a fake store ──────────────────────────────────

describe('queryInstability', () => {
  it('⛔ providers are tracked separately: openai steady while anthropic flips', async () => {
    // Keying on bare workflow_id would average the two lanes into one row and hide the coin flip
    // behind the steady lane — the same collapse the diff's provider-qualified key exists to stop.
    const { store } = fakeStore({
      'run-01': [wf('W-003', 'pass', 'openai'), wf('W-003', 'pass', 'anthropic')],
      'run-02': [wf('W-003', 'pass', 'openai'), wf('W-003', 'fail', 'anthropic')],
      'run-03': [wf('W-003', 'pass', 'openai'), wf('W-003', 'pass', 'anthropic')],
      'run-04': [wf('W-003', 'pass', 'openai'), wf('W-003', 'fail', 'anthropic')],
    });

    const m = await queryInstability(store);

    const openai = m.get('W-003:openai')!;
    const anthropic = m.get('W-003:anthropic')!;
    expect(openai.flips).toBe(0);
    expect(openai.unstable).toBe(false);
    expect(anthropic.flips).toBe(3);
    expect(anthropic.unstable).toBe(true);
    expect([...m.keys()].sort()).toEqual(['W-003:anthropic', 'W-003:openai']);
  });

  it('orders the series oldest-first even though listAllRuns answers newest-first', async () => {
    // pass, pass, fail chronologically. Read in store order it is fail, pass, pass — the same flip
    // count, which is exactly why a wrong-direction bug hides: only `samples` shows it.
    const { store } = fakeStore({
      'run-01': [wf('W-001', 'pass')],
      'run-02': [wf('W-001', 'pass')],
      'run-03': [wf('W-001', 'fail')],
    });

    const i = (await queryInstability(store)).get('W-001')!;

    expect(i.samples).toEqual(['pass', 'pass', 'fail']);
    expect(i.flips).toBe(1);
  });

  it('keeps the query budget bounded at 1 + window, and honours ?window=', async () => {
    const byRun: Record<string, EvalWorkflow[]> = {};
    for (let n = 1; n <= 12; n += 1) {
      byRun[`run-${String(n).padStart(2, '0')}`] = [wf('W-001', n % 2 ? 'pass' : 'fail')];
    }

    const wide = fakeStore(byRun);
    await queryInstability(wide.store);
    expect(wide.calls.listAllRuns).toEqual([DEFAULT_INSTABILITY_WINDOW]);
    expect(wide.calls.listWorkflows).toHaveLength(DEFAULT_INSTABILITY_WINDOW);

    const narrow = fakeStore(byRun);
    const m = await queryInstability(narrow.store, { window: 3 });
    expect(narrow.calls.listAllRuns).toEqual([3]);
    expect(narrow.calls.listWorkflows).toHaveLength(3);
    // The window is the RECENT 3 runs — run-10, run-11, run-12 — oldest-first.
    expect(narrow.calls.listWorkflows).toEqual(['run-10', 'run-11', 'run-12']);
    expect(m.get('W-001')!.samples).toEqual(['fail', 'pass', 'fail']);
  });

  it('a window with no runs yields an empty map, not a crash', async () => {
    const { store } = fakeStore({});
    expect((await queryInstability(store)).size).toBe(0);
  });

  it('a row that appears only in the newest run is known:false — no history is not stability', async () => {
    const { store } = fakeStore({
      'run-01': [wf('W-001', 'pass')],
      'run-02': [wf('W-001', 'pass'), wf('W-099', 'fail')],
    });

    const fresh = (await queryInstability(store)).get('W-099')!;
    expect(fresh.samples).toEqual(['fail']);
    expect(fresh.known).toBe(false);
    expect(fresh.unstable).toBe(false);
  });
});
