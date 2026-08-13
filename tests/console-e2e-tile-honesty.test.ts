import { describe, it, expect } from 'vitest';
import { fmtE2ePctOfCatalogue, fmtE2ePctOfRunnable } from '../console/src/lib/e2e-format';

/**
 * A tile sub-line must never assert a fraction it cannot compute.
 *
 * Found in production on 2026-08-13: a run that died before attempting a single workflow rendered
 * `ATTEMPTED 0` above the confident sub-line "100% of catalogue". Zero is not 100% of anything, and
 * an unknown catalogue size is not a full one — but both fell through the same `if (!catalogue)`
 * branch that hard-coded the mock's happy-path string.
 *
 * This is the fabricated-data class the E2E tab exists to avoid: the numbers were real and the
 * sentence next to them was invented. Absence must read as absence.
 */

// Minimal structural stand-ins — these helpers only read three fields.
const run = (fields: Record<string, unknown>) => fields as never;

describe('E2E tile sub-lines never invent a fraction', () => {
  it('does not claim "100% of catalogue" when nothing was attempted', () => {
    const out = fmtE2ePctOfCatalogue(run({ workflows_attempted: 0, meta: {} }));
    expect(out).not.toMatch(/100%/);
    expect(out).toBe('nothing attempted');
  });

  it('does not claim a percentage when the catalogue size is unknown', () => {
    const out = fmtE2ePctOfCatalogue(run({ workflows_attempted: 12, meta: {} }));
    expect(out).not.toMatch(/%/);
    expect(out).toBe('catalogue size unknown');
  });

  it('still reports a real fraction when both numbers are known', () => {
    const out = fmtE2ePctOfCatalogue(run({ workflows_attempted: 38, meta: { catalogue_size: 76 } }));
    expect(out).toBe('50% of catalogue');
  });

  it('treats a zero catalogue_size as unknown rather than as a full catalogue', () => {
    const out = fmtE2ePctOfCatalogue(run({ workflows_attempted: 5, meta: { catalogue_size: 0 } }));
    expect(out).toBe('catalogue size unknown');
  });

  it('reports an absent run as unknown, not as a complete one', () => {
    expect(fmtE2ePctOfCatalogue(null)).toBe('—');
    expect(fmtE2ePctOfRunnable(null)).toBe('—');
  });

  it('does not compute a pass rate when nothing was runnable', () => {
    const out = fmtE2ePctOfRunnable(run({ workflows_attempted: 3, withheld_count: 3, workflows_passed: 0 }));
    expect(out).toBe('none runnable');
  });
});
