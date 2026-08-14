import { describe, it, expect } from 'vitest';
import { fmtE2eFullScopeLabel, fmtE2eRunDuration } from '../console/src/lib/e2e-format';

/**
 * Run-modal formatters — scope label and spend-estimate duration.
 *
 * Two bugs found on 2026-08-13:
 *
 *   1. The "Full catalogue" radio label used `\`Full catalogue — ${catalogue} workflows\``
 *      directly in JSX. When `catalogue` was null (no historical run in the store), the browser
 *      rendered the literal string "Full catalogue — null workflows" — a raw JS null exposed to
 *      the operator.
 *
 *   2. The cost-summary line hard-coded "~40 min" regardless of scope. A single named workflow
 *      does not take 40 minutes; it takes roughly 1 minute. Borrowing the full-catalogue figure
 *      for every selection inflates the estimate by ~40× for a single named workflow.
 *
 * Both bugs are verified below. Each test names what the pre-fix code would have produced and
 * asserts the corrected behavior — every assertion here would FAIL against the code that existed
 * before fmtE2eFullScopeLabel and fmtE2eRunDuration were introduced (which is verified by the
 * fact that those functions did not exist, so any import of them would itself fail).
 *
 * The fix follows the same rule already applied to the Attempted tile: name the number when you
 * have it, say plainly when you don't.
 */

describe('fmtE2eFullScopeLabel — scope label never renders a raw null', () => {
  it('names the catalogue count when it is known', () => {
    // Pre-fix: `Full catalogue — ${75} workflows` → "Full catalogue — 75 workflows"  ✓ already correct
    // Post-fix: identical — the number path must not regress.
    expect(fmtE2eFullScopeLabel(75)).toBe('Full catalogue — 75 workflows');
  });

  it('does not render a raw null when the catalogue size is unknown', () => {
    // Pre-fix: `Full catalogue — ${null} workflows` → "Full catalogue — null workflows"  ← BUG
    // Post-fix: must say in words that the count is not yet known.
    const out = fmtE2eFullScopeLabel(null);
    expect(out).not.toMatch(/null/);
    expect(out).toContain('not yet known');
    expect(out).toContain('Full catalogue');
  });

  it('treats undefined the same as null — no raw undefined in the label', () => {
    const out = fmtE2eFullScopeLabel(undefined);
    expect(out).not.toMatch(/undefined/);
    expect(out).toContain('not yet known');
  });

  it('treats a zero catalogue size as unknown rather than naming it', () => {
    // Zero cannot be a real catalogue size; treating it as known would show "0 workflows".
    const out = fmtE2eFullScopeLabel(0);
    expect(out).not.toMatch(/\b0\b/);
    expect(out).toContain('not yet known');
  });

  it('single-workflow catalogue names the count correctly', () => {
    expect(fmtE2eFullScopeLabel(1)).toBe('Full catalogue — 1 workflows');
  });
});

describe('fmtE2eRunDuration — spend estimate scales with the selection', () => {
  it('returns ~40 min for a full-catalogue run', () => {
    // The full catalogue has historically taken ~40 min — this must not regress.
    expect(fmtE2eRunDuration('full', 1)).toBe('~40 min');
  });

  it('returns ~20 min for a suite run, not the catalogue ~40 min', () => {
    // Pre-fix: hardcoded "~40 min" for every scope, including suite  ← BUG
    // Post-fix: suite covers ~20 workflows at ~1 min each → ~20 min.
    const out = fmtE2eRunDuration('suite', 1);
    expect(out).not.toBe('~40 min');
    expect(out).toBe('~20 min');
  });

  it('returns ~1 min for a single named workflow, not the catalogue ~40 min', () => {
    // Pre-fix: hardcoded "~40 min" even for a single named workflow  ← BUG (40× inflation)
    // Post-fix: one workflow ≈ 1 min.
    const out = fmtE2eRunDuration('named', 1);
    expect(out).not.toBe('~40 min');
    expect(out).toBe('~1 min');
  });

  it('scales the named duration with the workflow count', () => {
    // Three named workflows → ~3 min, not ~40 min.
    const out = fmtE2eRunDuration('named', 3);
    expect(out).not.toBe('~40 min');
    expect(out).toBe('~3 min');
  });

  it('named count of zero still produces a valid label', () => {
    // Edge: the modal defaults namedCount to 1 when the text box is empty, but the formatter
    // should not crash on zero — it should simply say "~0 min".
    expect(fmtE2eRunDuration('named', 0)).toBe('~0 min');
  });
});
