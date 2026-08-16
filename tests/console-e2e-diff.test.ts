/**
 * `queryDiffRuns` — the run-over-run classifier.
 *
 * ⛔ THE LOAD-BEARING TESTS ARE THE WITHHELD ONES, and they are regression tests for a defect that
 * was live and agent-facing.
 *
 * `queryDiffRuns` bucketed with `verdict !== 'pass'`, so a `withheld` row — forge-hat's UNARMED /
 * INFRA-FAIL, meaning the RIG failed and nothing was tested — counted as a **regression**, and
 * `diff_e2e_runs` served that to a triage agent as a product failure. `WorkflowVerdict`'s own
 * declaration carries the rule it broke. This is HAT-F-065's shape: on 2026-08-16 the same class of
 * error cost three releases and four paid live runs before anyone disbelieved it.
 *
 * Every test below marked ⛔ fails against the previous implementation.
 */

import { describe, it, expect } from 'vitest';

import {
  classifyChange,
  diffRowKey,
  isRegression,
  isVerdictBearing,
  isWithheldVerdict,
  queryDiffRuns,
} from '../src/console/e2e-api';
import type { WorkflowVerdict } from '../src/storage/backends/cp-results/types';
import type { EvalWorkflow } from '../src/storage/backends/cp-results/types';

// ── the pure decisions ──────────────────────────────────────────────────────

describe('the verdict algebra', () => {
  it('splits the five verdicts into graded and withheld with no overlap and no gap', () => {
    const all: WorkflowVerdict[] = ['pass', 'fail', 'error', 'skip', 'withheld'];
    for (const v of all) {
      expect(isVerdictBearing(v)).toBe(!isWithheldVerdict(v));
    }
    expect(isVerdictBearing('pass')).toBe(true);
    // ⛔ `error` means the sender used a word the receiver does not know — a broken contract,
    // not a graded product failure. Counting it as red reports a runner/store mismatch as a
    // regression, which is the withheld bug one verdict over.
    expect(isVerdictBearing('error')).toBe(false);
    expect(isWithheldVerdict('error')).toBe(true);
    expect(isWithheldVerdict('withheld')).toBe(true);
    expect(isWithheldVerdict('skip')).toBe(true);
  });

  it('classifies the four graded transitions', () => {
    expect(classifyChange('pass', 'fail')).toBe('newly-red');
    expect(classifyChange('fail', 'pass')).toBe('newly-green');
    expect(classifyChange('pass', 'pass')).toBe('still-green');
    expect(classifyChange('fail', 'fail')).toBe('still-red');
    expect(classifyChange('pass', 'error')).toBe('became-withheld');
  });

  it('⛔ a verdict that became WITHHELD is never a regression', () => {
    for (const held of ['withheld', 'skip', 'error'] as WorkflowVerdict[]) {
      const kind = classifyChange('pass', held);
      expect(kind).toBe('became-withheld');
      expect(isRegression(kind)).toBe(false);
    }
  });

  it('⛔ isRegression admits exactly one kind', () => {
    const kinds = [
      'newly-red', 'newly-green', 'still-red', 'still-green',
      'became-withheld', 'became-graded', 'withheld-both', 'added', 'removed',
    ] as const;
    expect(kinds.filter((k) => isRegression(k))).toEqual(['newly-red']);
  });

  it('a withheld row that becomes graded is became-graded, even when the verdict is red', () => {
    // Evidence ARRIVED. The red may be real, but it is not a flip — there was nothing to flip from.
    expect(classifyChange('withheld', 'fail')).toBe('became-graded');
    expect(isRegression(classifyChange('withheld', 'fail'))).toBe(false);
  });

  it('⛔ keys are provider-qualified so one lane cannot hide behind the other', () => {
    expect(diffRowKey({ workflow_id: 'W-003', provider: 'anthropic' })).toBe('W-003:anthropic');
    expect(diffRowKey({ workflow_id: 'W-003', provider: null })).toBe('W-003');
  });
});

// ── the query, against a fake store ─────────────────────────────────────────

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

function fakeStore(baseline: EvalWorkflow[], run: EvalWorkflow[]) {
  return {
    getRun: async (id: string) => ({ run_id: id }) as never,
    listWorkflows: async (runId: string) => (runId === 'base' ? baseline : run),
  } as never;
}

describe('queryDiffRuns', () => {
  it('⛔ a run that goes entirely WITHHELD reports ZERO regressions', async () => {
    // The alarm is real and loud, but it is not a catalogue of product regressions. Against the
    // previous implementation this returned three regressions — a blind rig blamed on the product.
    const baseline = ['W-001', 'W-002', 'W-003'].map((id) => wf(id, 'pass'));
    const run = ['W-001', 'W-002', 'W-003'].map((id) => wf(id, 'withheld'));

    const d = await queryDiffRuns(fakeStore(baseline, run), 'r', 'base');

    expect(d).not.toBeNull();
    expect(d!.regressions).toHaveLength(0);
    expect(d!.withheld_now).toHaveLength(3);
    expect(d!.counts['became-withheld']).toBe(3);
  });

  it('⛔ an anthropic regression is not hidden by an openai pass', async () => {
    const baseline = [wf('W-003', 'pass', 'openai'), wf('W-003', 'pass', 'anthropic')];
    const run = [wf('W-003', 'pass', 'openai'), wf('W-003', 'fail', 'anthropic')];

    const d = await queryDiffRuns(fakeStore(baseline, run), 'r', 'base');

    expect(d!.regressions).toHaveLength(1);
    expect(d!.regressions[0]!.provider).toBe('anthropic');
    expect(d!.counts['still-green']).toBe(1);
  });

  it('separates every category and counts each row exactly once', async () => {
    const baseline = [wf('W-001', 'pass'), wf('W-002', 'pass'), wf('W-003', 'fail'), wf('W-004', 'withheld')];
    const run = [
      wf('W-001', 'fail'),      // newly-red
      wf('W-002', 'withheld'),  // became-withheld — NOT a regression
      wf('W-003', 'pass'),      // newly-green
      wf('W-004', 'pass'),      // became-graded
      wf('W-005', 'fail'),      // added, graded failing
      wf('W-006', 'withheld'),  // added, but nothing was tested
    ];

    const d = await queryDiffRuns(fakeStore(baseline, run), 'r', 'base');

    expect(d!.changes).toHaveLength(6);
    expect(d!.regressions.map((w) => w.workflow_id)).toEqual(['W-001']);
    expect(d!.withheld_now.map((w) => w.workflow_id)).toEqual(['W-002']);
    expect(d!.improvements.map((w) => w.workflow_id)).toEqual(['W-003']);
    expect(d!.became_graded.map((w) => w.workflow_id)).toEqual(['W-004']);
    expect(d!.new_failures.map((w) => w.workflow_id)).toEqual(['W-005']);
    // ⛔ A brand-new row that is withheld is neither a pass nor a failure — nothing was tested.
    expect(d!.new_passes).toHaveLength(0);
    expect(d!.counts.added).toBe(2);
  });

  it('a row present only in the baseline is removed, not a regression', async () => {
    const d = await queryDiffRuns(fakeStore([wf('W-009', 'pass')], []), 'r', 'base');
    expect(d!.counts.removed).toBe(1);
    expect(d!.regressions).toHaveLength(0);
  });

  it('returns null when either run is unknown', async () => {
    const store = { getRun: async () => null, listWorkflows: async () => [] } as never;
    expect(await queryDiffRuns(store, 'r', 'base')).toBeNull();
  });
});
