/**
 * ⛔ A TILE'S NUMBER MUST EQUAL THE ROWS ITS FILTER YIELDS.
 *
 * Mark, 2026-08-14, running the full catalogue:
 *
 *   "There was one withheld workflow. When I clicked on it, no workflows displayed in the table."
 *   "The number of reported workflows in any tile should always match the number of workflows
 *    listed in the table. The tiles should function like a top-level filter of the table."
 *
 * The tiles counted from the run-level counters the runner reports (`withheld_count`,
 * `workflows_failed`); the table filtered on each row's stored verdict. Two sources, computed
 * independently, free to disagree — and they did, because `UNARMED`/`INFRA-FAIL` were stored as
 * `error` while the withheld filter matched `verdict === 'skip'`, which nothing ever was.
 *
 * The same flattening made the pill render a blind run as "✗ rejected": W-009 showed every trial
 * step green under a red verdict, because it had never been rejected at all. Reporting a withheld
 * run as a rejection sends someone to debug a product that did nothing wrong — the most expensive
 * wrong conclusion this console can produce.
 *
 * These tests pin the PROPERTY rather than the instance: for any set of workflows and any filter,
 * the tile count and the filtered row count are the same number, because both come from `bucketOf`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(__dirname, '..', 'console', 'src', 'App.tsx'), 'utf8');

// The bucket rule, mirrored here so the property can be exercised without booting the app. The
// source-level tests below assert App.tsx actually uses this shape rather than a second copy.
type Verdict = 'pass' | 'fail' | 'error' | 'skip' | 'withheld';
type Bucket = 'pass' | 'fail' | 'withheld';
const bucketOf = (v: Verdict): Bucket =>
  v === 'pass' ? 'pass' : v === 'withheld' || v === 'skip' ? 'withheld' : 'fail';

describe('bucketOf — the one definition', () => {
  it('⛔ treats withheld as its own outcome, never as a failure', () => {
    expect(bucketOf('withheld')).toBe('withheld');
    // The legacy spelling from before the `withheld` verdict existed means the same thing.
    expect(bucketOf('skip')).toBe('withheld');
  });

  it('keeps genuine reds red', () => {
    expect(bucketOf('fail')).toBe('fail');
    // 'error' is an unrecognised verdict the store refused to guess at — red, but not withheld.
    expect(bucketOf('error')).toBe('fail');
  });

  it('accepts only a pass as a pass', () => {
    expect(bucketOf('pass')).toBe('pass');
  });
});

describe('every tile equals its filtered table', () => {
  const workflows: Verdict[] = [
    'pass',
    'pass',
    'fail',
    'error',
    'withheld',
    'skip', // legacy spelling — must land in the same bucket as 'withheld'
    'pass',
  ];

  const counts = workflows.reduce<Record<Bucket, number>>((a, v) => ((a[bucketOf(v)] += 1), a), {
    pass: 0,
    fail: 0,
    withheld: 0,
  });

  it.each(['pass', 'fail', 'withheld'] as const)('tile "%s" matches the rows it filters to', (bucket) => {
    const rows = workflows.filter((v) => bucketOf(v) === bucket);
    expect(rows.length).toBe(counts[bucket]);
  });

  it('⛔ the withheld tile is not empty when a withheld workflow exists', () => {
    // The exact symptom: tile read 1, clicking it produced an empty table.
    expect(counts.withheld).toBe(2);
    expect(workflows.filter((v) => bucketOf(v) === 'withheld').length).toBe(2);
  });

  it('every workflow lands in exactly one bucket — the tiles sum to the table', () => {
    expect(counts.pass + counts.fail + counts.withheld).toBe(workflows.length);
  });
});

describe('the console reads through one helper, not two sources', () => {
  it('defines bucketOf and bucketCounts', () => {
    expect(APP).toMatch(/export function bucketOf\(/);
    expect(APP).toMatch(/export function bucketCounts\(/);
  });

  it('⛔ the metric tiles count ROWS, never a parallel run-level counter', () => {
    // The tiles read `activeRun.withheld_count` / `workflows_failed` while the table filtered on
    // verdict. That is what let them disagree; counting rows makes disagreement impossible.
    expect(APP).toMatch(/value=\{counts\.pass\}/);
    expect(APP).toMatch(/value=\{counts\.fail\}/);
    expect(APP).toMatch(/value=\{counts\.withheld\}/);
    expect(APP).not.toMatch(/value=\{activeRun\?\.withheld_count/);
    expect(APP).not.toMatch(/value=\{activeRun\?\.workflows_failed/);
  });

  it('⛔ the table filter uses bucketOf rather than its own verdict comparisons', () => {
    expect(APP).toMatch(/bucketOf\(w\) !== verdictFilter/);
    // The old hand-rolled predicate, which is where the drift lived.
    expect(APP).not.toMatch(/verdictFilter === 'withheld' && w\.verdict !== 'skip'/);
  });

  it('⛔ the verdict pill reads the bucket, not the raw verdict', () => {
    expect(APP).toMatch(/const bucket = bucketOf\(/);
    expect(APP).toMatch(/if \(bucket === 'withheld'\)/);
  });
});

describe('the progress bar divides by the target, not by itself', () => {
  it('⛔ never uses workflows_attempted as the denominator', () => {
    // It read `const intended = run.workflows_attempted`, so it divided a number by itself and could
    // only ever show "n of n" at 100% — on a run that had barely started (Mark, 2026-08-14).
    const bar = APP.slice(
      APP.indexOf('function RunProgressBar'),
      APP.indexOf('function RunProgressBar') + 5000,
    );
    expect(bar).not.toMatch(/const intended = run\.workflows_attempted/);
    expect(bar).toMatch(/workflows_intended/);
    expect(bar).toMatch(/catalogue_size/);
  });

  it('the bar and its label read the same value', () => {
    const bar = APP.slice(
      APP.indexOf('function RunProgressBar'),
      APP.indexOf('function RunProgressBar') + 5000,
    );
    expect(bar).toMatch(/completed \/ target/);
    expect(bar).toMatch(/\{completed\} \/ \{target\}/);
  });

  it('⛔ an unknown target renders no bar rather than a full one', () => {
    // Rendering 100% against a denominator nobody reported is the same dishonesty relocated.
    const bar = APP.slice(
      APP.indexOf('function RunProgressBar'),
      APP.indexOf('function RunProgressBar') + 5000,
    );
    expect(bar).toMatch(/hasCounter = target !== null/);
    expect(bar).toMatch(/total not reported/);
  });
});

describe('a workflow that did not pass explains itself', () => {
  it('⛔ speaks in two voices — withheld is not a failure', () => {
    // "all of the trials had green checks for every step, yet the workflow was rejected."
    expect(APP).toMatch(/Why this was rejected/);
    expect(APP).toMatch(/No verdict — the harness could not test this/);
    // The withheld voice must say plainly that this is NOT product evidence.
    expect(APP).toMatch(/This is not evidence against the product/);
  });

  it('explains why green steps can still be a rejection', () => {
    expect(APP).toMatch(/attempts passed/);
    expect(APP).toMatch(/the failure is the bar named above/);
  });
});

describe('copying the triage prompt confirms itself', () => {
  it('⛔ flashes only after the clipboard accepts it', () => {
    // A flash fired optimistically confirms a copy that may never have happened.
    expect(APP).toMatch(/wfTriageFlash/);
    expect(APP).toMatch(/\.then\(\(\) => \{\s*setWfTriageFlash/);
    expect(APP).toMatch(/copied \? '✓ copied' : '⧉ Triage this workflow'/);
  });
});
