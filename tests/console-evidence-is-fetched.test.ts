/**
 * ⛔ THE CONSOLE MUST NEVER SHOW EVIDENCE IT DID NOT FETCH.
 *
 * 2026-08-14. Mark opened an ACCEPTED workflow and the drawer said "No scene data for this trial",
 * then opened its cassette and saw the prompt "Use Dorinda." with no reply. Both were reported as
 * missing data. Neither was.
 *
 *   1. Both drilldown call sites built their result as
 *        `{ workflow: wf, scenes: [], mcp_calls: [], claims: [] }`
 *      — a hardcoded empty literal for every REAL workflow, with the populated shape reachable only
 *      by the dev fixture. `GET /api/e2e/workflows/:id` existed and returned all three collections
 *      correctly. The console never called it. No amount of correctly-ingested evidence could ever
 *      have appeared, on any run, ever.
 *
 *   2. The cassette panel was a MOCKUP. It rendered a hardcoded prompt ("Use Dorinda."), a hardcoded
 *      assistant reply ("Connected to <id>. Here's your current snapshot…"), and `calls.slice(0, 2)`
 *      of an array that was always empty. An operator reading it saw an invented conversation
 *      presented in the same type, colour and layout as a real one.
 *
 * (2) is the more dangerous of the two by a wide margin. Missing evidence announces itself; a
 * fabricated transcript is indistinguishable from a real one and is exactly what an acceptance
 * harness exists to rule out.
 *
 * Why this test is a SOURCE test rather than a rendering test: the defect is not what the component
 * does with its data, it is that the data never arrives. A DOM test with a stubbed result would have
 * passed against the broken console — which is precisely how the bug survived. This asserts the
 * wiring itself.
 *
 * WHAT WAS ACTUALLY WRONG WITH MY VERIFICATION, recorded so the lesson outlives the fix: I confirmed
 * `scenes: 2` by querying the API. The API was telling the truth about a row nothing rendered.
 * Operator-facing evidence is verified in the BROWSER or it is not verified.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = readFileSync(join(process.cwd(), 'console/src/App.tsx'), 'utf8');

/**
 * Strip comments before matching.
 *
 * The first draft of this test failed against the FIXED console, because the fix documents the
 * removed literals in comments ("this used to render 'Use Dorinda.'") and the guard matched the
 * explanation instead of the code. A guard that cannot tell a warning about a defect from the defect
 * itself punishes documenting it — so it reads code only.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The dev fixture block is allowed to contain literal sample content — it is marked SAMPLE DATA. */
function withoutFixtures(src: string): string {
  // Drop every `const E2E_FIXTURE_… = { … };` top-level declaration, then all commentary.
  return codeOnly(src.replace(/^const E2E_FIXTURE_[A-Z_]+[\s\S]*?^};$/gm, ''));
}

describe('the drilldown fetches its evidence', () => {
  it('calls the workflow drilldown endpoint', () => {
    expect(APP).toMatch(/\/api\/e2e\/workflows\/\$\{encodeURIComponent\(/);
  });

  it('⛔ never synthesises an empty evidence set for a real workflow', () => {
    // The exact shape that made every real drawer permanently empty. Matching on the literal
    // combination — not on `scenes: []` alone — so a legitimate empty initial state elsewhere in the
    // console does not trip this.
    const synthesised =
      /\{\s*workflow:\s*\w+\s*,\s*scenes:\s*\[\]\s*,\s*mcp_calls:\s*\[\]\s*,\s*claims:\s*\[\]\s*\}/;
    expect(synthesised.test(withoutFixtures(APP))).toBe(false);
  });

  it('distinguishes "still loading" from "loaded and empty" from "the fetch failed"', () => {
    // Three different facts must not share one appearance. The drawer takes an `error` prop for
    // exactly this reason: left null on failure it renders "Loading…" forever, which reads as a slow
    // network and hides a broken endpoint.
    expect(APP).toMatch(/error\?:\s*string \| null/);
    expect(APP).toMatch(/Could not load this workflow's evidence/);
    expect(APP).toMatch(/Loading evidence…/);
  });

  it('does not attach one workflow’s evidence to another’s verdict', () => {
    // useApi retains its last payload when the path goes null, so expanding a second workflow would
    // otherwise flash A's scenes under B's verdict. Real evidence under the wrong claim is worse
    // than none.
    expect(APP).toMatch(/wfDrilldownApi\.data\.workflow\.id === expandedWfId/);
  });
});

describe('the cassette panel renders only what happened', () => {
  const body = withoutFixtures(APP);

  it('⛔ contains no fabricated assistant reply', () => {
    // The literal that shipped for months, presented as Dorinda's answer.
    expect(body).not.toMatch(/Here&apos;s your current snapshot/);
    expect(body).not.toMatch(/Connected to \{wf\?\./);
  });

  it('⛔ contains no hardcoded conversational prompt', () => {
    // A prompt literal outside the fixtures means the panel is inventing the user's half.
    expect(body).not.toMatch(/>\s*Use Dorinda\.\s*</);
  });

  it('renders the reply — the half that was missing entirely', () => {
    expect(APP).toMatch(/t\.reply/);
    expect(APP).toMatch(/the assistant produced no visible reply/);
  });

  it('never truncates the transcript to the first two calls', () => {
    // `calls.slice(0, 2)` / `calls.slice(2)` split the mockup into "the scripted part" and "the
    // rest". A transcript that silently drops turns is not a record.
    expect(body).not.toMatch(/\.slice\(0,\s*2\)/);
  });

  it('⛔ separates the attempts instead of running them together', () => {
    // Mark, 2026-08-14: "a user repeatedly says 'Use Dorinda' — is it having the user say it far too
    // often?" No: W-001 runs 3 attempts, each a FRESH chat saying the canonical two words exactly
    // once. But the panel rendered all three as one continuous scroll, so correct behaviour read as
    // a broken prompt. Evidence that misrepresents its own STRUCTURE is a defect even when every
    // value in it is true.
    expect(APP).toMatch(/a fresh conversation/);
    expect(APP).toMatch(/t\.attempt \?\? 1/);
  });

  it('says so plainly when no transcript was recorded, rather than reconstructing one', () => {
    expect(APP).toMatch(/No transcript was recorded for this workflow/);
  });

  it('keeps "unreadable trace" distinct from "called no tools"', () => {
    // An unreadable trace is not an empty one — conflating them is how a blind run reads as clean.
    expect(APP).toMatch(/tool_trace_unreadable/);
    expect(APP).toMatch(/NOT the same as the/);
  });
});

describe('operator-facing vocabulary', () => {
  const code = codeOnly(APP);
  it('⛔ does not claim to show "trial 1" of N', () => {
    // The chip read `trial 1 of {trials_total}` with the 1 HARDCODED, above a drawer that pools
    // evidence from every attempt. It described a per-attempt breakdown that has never existed.
    expect(code).not.toMatch(/trial 1 of \{/);
    expect(code).not.toMatch(/<Chip>trial 1<\/Chip>/);
  });

  it('counts attempts in plain language', () => {
    expect(APP).toMatch(/attempt\{/);
  });
});

describe('the run modal prices the CATALOGUE, not the last run', () => {
  const code = codeOnly(APP);

  it('⛔ never derives the catalogue size from a previous run’s scope', () => {
    // 2026-08-14: `const catalogue = runs[0]?.workflows_attempted` sat directly beneath a comment
    // explaining why that is wrong. It read correctly while every run happened to be full, then two
    // 2-workflow verification runs made the modal offer "Full catalogue — 2 workflows · $0.16" for a
    // 76-workflow, ~$5, 75-minute run — above a checkbox reading "I confirm: spend approximately
    // $0.16". The RUN was correct (`suite: "full"` never uses the count), so nothing downstream
    // could have caught it. Only consent was wrong, which is the one thing this dialog is for.
    expect(code).not.toMatch(/catalogue\s*(:[^=]*)?=\s*(typeof\s+)?lastAttempted/);
    expect(code).not.toMatch(/catalogue[^=\n]*=\s*runs\[0\]\?\.workflows_attempted/);
  });

  it('reads the size the catalogue reports about itself', () => {
    // ⛔ This first read `expect(code).toMatch(/catalogue_size/)` and passed against the BROKEN
    // modal — because a dev fixture contains `catalogue_size: 75`. A guard satisfied by sample data
    // certifies coverage it never looked at, which is the same failure as the completeness check
    // that skipped every column with a digit in it. Assert the actual binding, fixtures excluded.
    //
    // 2026-08-16: the source moved, and got BETTER. The size now comes from the CATALOGUE itself —
    // the rows served by /api/e2e/catalogue and published by forge-hat on every run — rather than a
    // `catalogue_size` number riding on a run's meta. The property is unchanged, so the guard
    // follows it: the count comes from the catalogue, never from run history.
    const body = withoutFixtures(APP);
    expect(body).toMatch(/useApi<E2ECatalogueEntry\[\]>\('\/api\/e2e\/catalogue'\)/);
    // What "Full catalogue" actually promises: counted from those rows and narrowed to what the
    // selected provider can run, so the figure above the confirm checkbox is what will happen.
    expect(body).toMatch(/const fullRunnable = cat\.filter\(\(e\) => canRun\(e\)\)\.length/);
  });

  it('scales spend per workflow rather than reusing a run’s total', () => {
    // A 2-workflow run's $0.16 is not what 76 workflows cost — the same inference error in a
    // different coat.
    expect(code).toMatch(/centsPerWorkflow/);
    expect(code).toMatch(/centsPerWorkflow \* effectiveCount/);
    // ⛔ And the multiplicand is what will RUN, not what was clicked: a workflow the provider
    // selection excludes is planned ZERO times, so pricing it would promise a run the executor
    // never agreed to — the same arithmetic that made a `both` run promise twice its capacity.
    expect(code).toMatch(/const effectiveCount/);
    expect(code).toMatch(/runnableIds/);
  });

  it('⛔ shows unknown as unknown, never as a figure', () => {
    // A count nobody can vouch for must not reach a confirmation checkbox.
    expect(APP).toMatch(/not known yet/);
  });
});
