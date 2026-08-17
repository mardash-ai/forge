import { describe, it, expect } from 'vitest';
import {
  E2E_WITHHELD_NOT_A_REGRESSION,
  e2eDeltaCounts,
  e2eDeltaSegments,
  e2eDiffRowKey,
  e2eGroupDiffChanges,
  e2eIsRegressionKind,
  e2ePreviousRun,
  e2eSparkSeries,
  fmtE2eDeltaCompact,
  fmtE2eDeltaTitle,
  fmtE2eDiffVerdict,
  fmtE2eFlipHistory,
} from '../console/src/lib/e2e-format';
import type { E2EDiffChange, E2EDiffKind, E2EDiffPayload } from '../console/src/lib/e2e-format';

/**
 * The console's run-over-run diff surfaces, tested where the claims live.
 *
 * ⛔ THE INVARIANT UNDER TEST: **a WITHHELD verdict is never a regression.** `became-withheld` means
 * the rig stopped observing — forge-hat's UNARMED / INFRA-FAIL, including `claims-unavailable`.
 * Nothing was tested, so there is no verdict that could have got worse. Rendering one as a red is
 * the defect that cost three releases on 2026-08-16 (HAT-F-065): an operator chased a "regression"
 * that was a dead credential, while the lane it hid stayed unobserved.
 *
 * These are the same class of claim the tile sub-lines are tested for — prose and counts asserted
 * ABOUT data, which is exactly the kind of thing that drifts silently away from the data.
 */

const change = (over: Partial<E2EDiffChange> & { kind: E2EDiffKind; key: string }): E2EDiffChange => ({
  workflow_id: over.key.split(':')[0]!,
  provider: over.key.includes(':') ? (over.key.split(':')[1] ?? null) : null,
  before: null,
  after: null,
  ...over,
});

/** A run where every category is represented at once — the shape a real nightly produces. */
const MIXED: E2EDiffPayload = {
  run_id: '2026-08-16T02-00-remote',
  baseline_run_id: '2026-08-15T02-00-remote',
  changes: [
    change({ key: 'W-004', kind: 'newly-red', before: 'pass', after: 'fail' }),
    change({ key: 'W-016', kind: 'newly-red', before: 'pass', after: 'fail' }),
    change({ key: 'W-035', kind: 'newly-green', before: 'fail', after: 'pass' }),
    change({ key: 'W-003:anthropic', kind: 'became-withheld', before: 'pass', after: 'withheld' }),
    change({ key: 'W-044:anthropic', kind: 'withheld-both', before: 'withheld', after: 'withheld' }),
    change({ key: 'W-020', kind: 'still-green', before: 'pass', after: 'pass' }),
    change({ key: 'W-021', kind: 'still-red', before: 'fail', after: 'fail' }),
    change({ key: 'W-050', kind: 'added', before: null, after: 'pass' }),
    change({ key: 'W-060', kind: 'removed', before: 'pass', after: null }),
    change({ key: 'W-070', kind: 'became-graded', before: 'withheld', after: 'fail' }),
  ],
  instability: {
    // Steady: nine graded runs, never flipped until now.
    'W-004': {
      key: 'W-004',
      samples: ['pass', 'pass', 'pass', 'fail'],
      flips: 1,
      known: true,
      unstable: false,
    },
    // A coin flip. Its red is weak evidence.
    'W-016': {
      key: 'W-016',
      samples: ['pass', 'fail', 'pass', 'fail'],
      flips: 3,
      known: true,
      unstable: true,
    },
    'W-003:anthropic': {
      key: 'W-003:anthropic',
      samples: ['pass', 'pass', 'pass'],
      flips: 0,
      known: true,
      unstable: false,
      withheldRuns: 1,
    },
  },
};

describe('⛔ a withheld verdict is never a regression', () => {
  it('classes only newly-red as a regression', () => {
    const kinds: E2EDiffKind[] = [
      'newly-red',
      'newly-green',
      'still-red',
      'still-green',
      'became-withheld',
      'became-graded',
      'withheld-both',
      'added',
      'removed',
    ];
    expect(kinds.filter(e2eIsRegressionKind)).toEqual(['newly-red']);
  });

  it('keeps became-withheld out of every red group and every red count', () => {
    const groups = e2eGroupDiffChanges(MIXED);
    const counts = e2eDeltaCounts(MIXED);

    // The row is present — withheld is reported, never swallowed…
    expect(groups.withheld.map((c) => c.key)).toEqual(['W-003:anthropic']);
    expect(counts.withheld).toBe(1);

    // …and it is in NO red bucket, and in NO red total.
    const reds = [...groups.trustedRed, ...groups.flakyRed].map((c) => c.key);
    expect(reds).not.toContain('W-003:anthropic');
    expect(counts.newlyRed).toBe(2);
    expect(counts.trustedRed + counts.flakyRed).toBe(counts.newlyRed);
  });

  it('never gives the withheld segment a critical tone', () => {
    const segs = e2eDeltaSegments(e2eDeltaCounts(MIXED));
    const withheld = segs.find((s) => s.kind === 'became-withheld');
    expect(withheld).toBeDefined();
    expect(withheld!.tone).toBe('info');
    expect(segs.filter((s) => s.tone === 'crit').map((s) => s.kind)).toEqual(['newly-red']);
  });

  it('says out loud, in the column tooltip, that withheld is not a regression', () => {
    expect(fmtE2eDeltaTitle(e2eDeltaCounts(MIXED))).toContain('withheld is not a regression');
    expect(E2E_WITHHELD_NOT_A_REGRESSION).toMatch(/not product regressions/i);
  });

  it('does not count a withheld-both row as newly red either', () => {
    const counts = e2eDeltaCounts(MIXED);
    // withheld-both is a row that was blind before and is blind now: nothing changed.
    expect(counts.unchanged).toBe(3); // still-green + still-red + withheld-both
    expect(counts.newlyRed).toBe(2);
  });
});

describe('instability splits the reds without ever inventing history', () => {
  it('routes a flipper to the weak-evidence group and a steady workflow to the trusted one', () => {
    const g = e2eGroupDiffChanges(MIXED);
    expect(g.trustedRed.map((c) => c.key)).toEqual(['W-004']);
    expect(g.flakyRed.map((c) => c.key)).toEqual(['W-016']);
  });

  it('renders fine when the server sends no instability map at all', () => {
    // A console can be talking to a forge that predates the field. Absent must degrade, not crash,
    // and must not demote a red.
    const noHistory: E2EDiffPayload = { ...MIXED, instability: undefined };
    const g = e2eGroupDiffChanges(noHistory);
    expect(g.flakyRed).toEqual([]);
    expect(g.trustedRed.map((c) => c.key)).toEqual(['W-004', 'W-016']);
    expect(e2eDeltaCounts(noHistory).newlyRed).toBe(2);
  });

  it('⛔ treats unknown history as unknown, never as "flaky" — an unseen red is not suppressed', () => {
    const unknown: E2EDiffPayload = {
      ...MIXED,
      instability: { 'W-016': { key: 'W-016', samples: ['fail'], flips: 0, known: false, unstable: false } },
    };
    expect(e2eGroupDiffChanges(unknown).flakyRed).toEqual([]);
    expect(e2eGroupDiffChanges(unknown).trustedRed.map((c) => c.key)).toEqual(['W-004', 'W-016']);
  });

  it('does not read a merely-truthy instability record as unstable', () => {
    // `unstable` absent means "the server did not say". Only an explicit true demotes a red.
    const vague: E2EDiffPayload = {
      ...MIXED,
      instability: { 'W-016': { key: 'W-016', flips: 9 } },
    };
    expect(e2eGroupDiffChanges(vague).flakyRed).toEqual([]);
  });

  it('survives a null diff entirely', () => {
    expect(e2eDeltaCounts(null)).toMatchObject({ newlyRed: 0, recovered: 0, withheld: 0, unchanged: 0 });
    expect(e2eGroupDiffChanges(undefined)).toEqual({
      trustedRed: [],
      flakyRed: [],
      recovered: [],
      withheld: [],
    });
  });
});

describe('the Δ vs prev column', () => {
  it('formats the three movements compactly', () => {
    expect(fmtE2eDeltaCompact(e2eDeltaCounts(MIXED))).toBe('▲2 ▼1 ⊘1');
  });

  it('omits a movement that did not happen rather than printing ▲0', () => {
    const onlyWithheld = e2eDeltaCounts({
      changes: [change({ key: 'W-003', kind: 'became-withheld', before: 'pass', after: 'withheld' })],
    });
    expect(fmtE2eDeltaCompact(onlyWithheld)).toBe('⊘1');
  });

  it('distinguishes "compared and nothing moved" from "no comparison"', () => {
    const nothingMoved = e2eDeltaCounts({
      changes: [change({ key: 'W-020', kind: 'still-green', before: 'pass', after: 'pass' })],
    });
    expect(fmtE2eDeltaCompact(nothingMoved)).toBe('no change');
    expect(fmtE2eDeltaCompact(null)).toBe('—');
    expect(fmtE2eDeltaTitle(null)).toBe('no comparison available');
  });

  it('spells the glyphs out for a screen reader', () => {
    expect(fmtE2eDeltaTitle(e2eDeltaCounts(MIXED))).toBe(
      '2 newly red · 1 recovered · 1 withheld — withheld is not a regression',
    );
  });
});

describe('verdict labels never assert trials that did not run', () => {
  it('renders a graded verdict with its trial fraction', () => {
    expect(fmtE2eDiffVerdict('pass', { passed: 3, total: 3 })).toBe('ACCEPTED 3/3');
    expect(fmtE2eDiffVerdict('fail', { passed: 0, total: 3 })).toBe('REJECTED 0/3');
  });

  it('⛔ never puts a fraction behind INFRA-FAIL — nothing was graded', () => {
    expect(fmtE2eDiffVerdict('withheld', { passed: 0, total: 3 })).toBe('INFRA-FAIL');
    expect(fmtE2eDiffVerdict('skip', { passed: 0, total: 3 })).toBe('INFRA-FAIL');
  });

  it('reads an absent verdict as absent, not as zero', () => {
    expect(fmtE2eDiffVerdict(null)).toBe('—');
    expect(fmtE2eDiffVerdict(undefined)).toBe('—');
  });

  it('omits the fraction when no trial counts are known', () => {
    expect(fmtE2eDiffVerdict('pass')).toBe('ACCEPTED');
    expect(fmtE2eDiffVerdict('pass', { passed: 0, total: 0 })).toBe('ACCEPTED');
  });
});

describe('the flip-history label', () => {
  it('⛔ states "no history yet" rather than implying steadiness', () => {
    expect(fmtE2eFlipHistory(undefined)).toBe('no history yet');
    expect(fmtE2eFlipHistory({ known: false, samples: ['fail'] })).toBe('no history yet');
    expect(fmtE2eFlipHistory({ known: false, withheldRuns: 4 })).toBe('no graded history · 4 withheld');
  });

  it('names the sample count, so 3-of-5 is not read as 3-of-9', () => {
    expect(fmtE2eFlipHistory({ known: true, flips: 0, samples: ['pass', 'pass', 'pass'] })).toBe(
      '0 flips in 3 runs',
    );
    expect(fmtE2eFlipHistory({ known: true, flips: 1, samples: ['pass', 'fail'] })).toBe('1 flip in 2 runs');
  });

  it('carries the withheld-run context beside the flips', () => {
    expect(
      fmtE2eFlipHistory({ known: true, flips: 2, samples: ['pass', 'fail', 'pass'], withheldRuns: 1 }),
    ).toBe('2 flips in 3 runs · 1 withheld');
  });
});

describe('the verdict sparkline shows only what the data records', () => {
  it('maps graded samples oldest-first', () => {
    expect(e2eSparkSeries({ samples: ['pass', 'fail', 'pass'] })).toEqual(['ok', 'red', 'ok']);
  });

  it('⛔ does not invent positions for interleaved withheld runs', () => {
    // `samples` drops withheld runs and records nothing about where they sat, so a bar cannot be
    // placed for them. Only the caller-known trailing one is emitted.
    const marks = e2eSparkSeries({ samples: ['pass', 'pass'], withheldRuns: 3 });
    expect(marks).toEqual(['ok', 'ok']);
    expect(marks).not.toContain('held');
  });

  it('appends one flat mark for a run the caller knows is withheld right now', () => {
    expect(e2eSparkSeries({ samples: ['pass', 'pass'] }, { trailingWithheld: true })).toEqual([
      'ok',
      'ok',
      'held',
    ]);
  });

  it('keeps the most recent marks when the series is longer than the sparkline', () => {
    const samples = ['pass', 'pass', 'pass', 'fail'];
    expect(e2eSparkSeries({ samples }, { max: 2 })).toEqual(
      ['pass', 'fail'].map((v) => (v === 'pass' ? 'ok' : 'red')),
    );
  });

  it('renders nothing rather than a stub when there is no history', () => {
    expect(e2eSparkSeries(null)).toEqual([]);
    expect(e2eSparkSeries({})).toEqual([]);
  });
});

describe('the diff row key', () => {
  it('⛔ qualifies by provider, so an anthropic red cannot hide behind an openai pass', () => {
    expect(e2eDiffRowKey({ workflow_id: 'W-003', provider: 'anthropic' })).toBe('W-003:anthropic');
    expect(e2eDiffRowKey({ workflow_id: 'W-003', provider: 'openai' })).toBe('W-003:openai');
  });

  it('falls back to the bare id when a row records no provider', () => {
    expect(e2eDiffRowKey({ workflow_id: 'W-003', provider: null })).toBe('W-003');
    expect(e2eDiffRowKey({ workflow_id: 'W-003' })).toBe('W-003');
  });
});

describe('"the previous run" is the nearest strictly-OLDER run', () => {
  // The list as `/api/e2e/runs` returns it: started_at DESC.
  const RUNS = [
    { run_id: 'c', started_at: '2026-08-16T02:00:00Z' },
    { run_id: 'b', started_at: '2026-08-15T02:00:00Z' },
    { run_id: 'a', started_at: '2026-08-14T02:00:00Z' },
  ];

  it('⛔ does not resolve to a LATER run for a run that is not the newest', () => {
    // The bug: `runs.find((r) => r.run_id !== active.run_id)` returned `c` — which happened AFTER
    // `b` — and the duration chart then labelled it "previous nightly".
    const naive = RUNS.find((r) => r.run_id !== 'b');
    expect(naive!.run_id).toBe('c');

    const fixed = e2ePreviousRun(RUNS, RUNS[1]);
    expect(fixed!.run_id).toBe('a');
    expect(fixed!.started_at < RUNS[1]!.started_at).toBe(true);
  });

  it('picks the immediate predecessor of the newest run', () => {
    expect(e2ePreviousRun(RUNS, RUNS[0])!.run_id).toBe('b');
  });

  it('does not depend on the caller having sorted the list', () => {
    const shuffled = [RUNS[1]!, RUNS[2]!, RUNS[0]!];
    expect(e2ePreviousRun(shuffled, RUNS[0])!.run_id).toBe('b');
    expect(e2ePreviousRun(shuffled, RUNS[1])!.run_id).toBe('a');
  });

  it('returns null for the oldest run — one run is not a comparison', () => {
    expect(e2ePreviousRun(RUNS, RUNS[2])).toBeNull();
    expect(e2ePreviousRun([RUNS[0]!], RUNS[0])).toBeNull();
    expect(e2ePreviousRun(RUNS, null)).toBeNull();
  });

  it('excludes a run that started at the same instant, and breaks remaining ties on run_id', () => {
    const tied = [
      { run_id: 'z', started_at: '2026-08-16T02:00:00Z' },
      { run_id: 'y', started_at: '2026-08-15T02:00:00Z' },
      { run_id: 'x', started_at: '2026-08-15T02:00:00Z' },
    ];
    // `y` and `x` are simultaneous: neither precedes the other.
    expect(e2ePreviousRun(tied, tied[1])).toBeNull();
    // …and for `z`, the tie between two equally-recent predecessors resolves deterministically.
    expect(e2ePreviousRun(tied, tied[0])!.run_id).toBe('y');
  });

  it('ignores rows with no started_at rather than guessing their order', () => {
    const partial = [
      { run_id: 'c', started_at: '2026-08-16T02:00:00Z' },
      { run_id: 'b', started_at: null },
      { run_id: 'a', started_at: '2026-08-14T02:00:00Z' },
    ];
    expect(e2ePreviousRun(partial, partial[0])!.run_id).toBe('a');
    expect(e2ePreviousRun(partial, partial[1])).toBeNull();
  });
});
