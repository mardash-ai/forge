/**
 * ⛔ THE RUN DIALOG MUST NOT BE ABLE TO EXPRESS A RUN THAT CANNOT HAPPEN.
 *
 * 2026-08-16, run `run-2026-08-16-00-16-54`. `Named workflows` was a free-text field that validated
 * nothing. An operator pasted `W-001:blocked` — a store row id, and the ONLY id this console ever
 * displays — and the runner exited 2: the whole run dead in 16 seconds, nothing executed, the
 * evidence buried in a Cloud Run job log.
 *
 * Two separate defects are guarded here, and one of them was found only while fixing the other:
 *
 *   1. ids are typed rather than chosen, and nothing strips the plan label;
 *   2. the per-row "Re-run" button rendered "✓ queued" and POSTed NOTHING — `rerunFlash` was read
 *      in exactly one place, to draw that label. It reported an action it never performed, which is
 *      the same family as the fabricated transcript that once sat in this same screen.
 *
 * These are source-shape assertions on purpose: the picker's real behaviour is verified in a
 * BROWSER (see the Playwright check in the same change), because a UI claim verified any other way
 * is not verified. What these pin is the ABSENCE of the two specific constructs that caused harm —
 * the legitimate use of a source guard, per [[a-guard-that-asserts-source-text]].
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(__dirname, '..', 'console', 'src', 'App.tsx'), 'utf8');
const SERVER = readFileSync(join(__dirname, '..', 'src', 'console', 'server.ts'), 'utf8');

/** Comments describe the bug; only code can reintroduce it. */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

const APP_CODE = codeOnly(APP);
const SERVER_CODE = codeOnly(SERVER);

describe('the run dialog offers choices instead of a text box', () => {
  it('⛔ fetches the catalogue rather than inventing one', () => {
    expect(APP_CODE).toMatch(/useApi<E2ECataloguePayload>\('\/api\/e2e\/catalogue'\)/);
  });

  it('⛔ blocks for the RIGHT reason — runner-missing is not a provider mismatch', () => {
    // The two have different remedies: roll the image vs tick a checkbox. Reporting one as the
    // other sends an operator to change the thing that cannot help.
    expect(APP_CODE).toMatch(/const blockedBecause = /);
    expect(APP_CODE).toMatch(/if \(e\.in_runner === false\) return 'not-in-runner';/);
    // Order matters: not-in-runner is checked first, because it cannot be fixed by any provider.
    expect(APP_CODE.indexOf("return 'not-in-runner'")).toBeLessThan(APP_CODE.indexOf("return 'provider'"));
  });

  it('⛔ an UNDETERMINED runner state does not block anything', () => {
    // in_runner === null means we could not tell. Refusing every run on that basis would be a
    // worse failure than the one this replaced — one unreadable job spec bricking the console.
    expect(APP_CODE).not.toMatch(/in_runner !== true/);
    expect(APP_CODE).toMatch(/e\.in_runner === false/);
  });

  it('shows where the catalogue came from, and says so when the sync FAILED', () => {
    // Three states that must never share an appearance: never-synced, synced, sync-failed.
    expect(APP_CODE).toMatch(/data-testid="catalogue-provenance"/);
    expect(APP_CODE).toMatch(/Catalogue is stale/);
  });

  it("⛔ decides selectability from `requires`, the harness's own answer", () => {
    // Not re-derived from `ai:` on this side — that would put one rule in two repositories.
    expect(APP_CODE).toMatch(/e\.requires === 'both'/);
    expect(APP_CODE).toMatch(/const canRun = /);
  });

  it("⛔ a workflow that can't run on the selection is DISABLED, not merely labelled", () => {
    // The whole point of provider-first. A label an operator can ignore is not a guard.
    expect(APP_CODE).toMatch(/disabled=\{!ok\}/);
  });

  it('strips the plan label wherever a stored row id becomes a run target', () => {
    // Three places build run targets from stored rows; every one normalises.
    const stripped = APP_CODE.match(/workflow_id\.split\(':'\)\[0\]!/g) ?? [];
    expect(stripped.length).toBeGreaterThanOrEqual(3);
  });

  it('still has a fallback for the case where no catalogue has been published', () => {
    // An empty picker and an empty catalogue must not look alike.
    expect(APP_CODE).toMatch(/data-testid="named-fallback"/);
    expect(APP_CODE).toMatch(/hasCatalogue/);
  });

  it('⛔ prices and promises only what will REALLY run', () => {
    // Counting a workflow the provider selection excludes would promise a run the executor never
    // agreed to — the same arithmetic that once made a `both` run promise twice what it could do.
    expect(APP_CODE).toMatch(/const runnableIds = /);
    expect(APP_CODE).toMatch(/reqBody\.workflows = runnableIds/);
  });
});

describe('⛔ the per-row Re-run button no longer lies', () => {
  it('the queued-flag machinery is gone', () => {
    // `rerunFlash` existed solely to render "✓ queued" for an action that never happened.
    expect(APP_CODE).not.toMatch(/rerunFlash/);
    expect(APP_CODE).not.toMatch(/setRerunWfId/);
  });

  it('never renders a success label without a request', () => {
    expect(APP_CODE).not.toMatch(/✓ queued/);
  });

  it('opens the dialog pre-filled instead', () => {
    expect(APP_CODE).toMatch(/data-testid=\{`rerun-\$\{wf\.workflow_id\}`\}/);
    expect(APP_CODE).toMatch(/setRunModalPrefill\(\{\s*workflows: \[wf\.workflow_id\.split\(':'\)\[0\]!\]/);
  });
});

describe('⛔ the API refuses a bad id instead of spending a job on it', () => {
  it('normalises a labelled row id at the boundary', () => {
    expect(SERVER_CODE).toMatch(/w\.includes\(':'\) \? w\.slice\(0, w\.indexOf\(':'\)\) : w/);
  });

  it('sends the NORMALISED ids to the job, never the raw body', () => {
    // The line that actually put `W-001:blocked` into E2E_WORKFLOWS.
    expect(SERVER_CODE).not.toMatch(/E2E_WORKFLOWS'\] = body\.workflows\.join/);
    expect(SERVER_CODE).toMatch(/E2E_WORKFLOWS'\] = normalisedWorkflows\.join\(','\)/);
  });

  it('⛔ answers 400 naming the unknown ids — a form error, not a dead run', () => {
    expect(SERVER_CODE).toMatch(/code: 'unknown_workflows'/);
    expect(SERVER_CODE).toMatch(/not in the catalogue/);
  });

  it('does not block runs when the catalogue is unavailable', () => {
    // Failing closed here would make an empty store unable to start any run at all.
    expect(SERVER_CODE).toMatch(/known = cat\.length \? new Set/);
  });

  it('exposes the catalogue for the picker to read', () => {
    expect(SERVER_CODE).toMatch(/app\.get\('\/api\/e2e\/catalogue'/);
  });
});

describe('⛔ "Re-run" means THIS run again, not everything', () => {
  it('the detail-view Re-run seeds the workflows the run actually executed', () => {
    // It opened the dialog with NO prefill, so scope fell through to Full catalogue. On a
    // 2-workflow run that turned a re-run into all 76 — ~$3.41 and ~19 minutes, one click from a
    // button labelled with the opposite intent. Mark caught it in the first minutes of using the
    // new dialog (2026-08-16).
    expect(APP_CODE).toMatch(/data-testid="rerun-this-run"/);
    expect(APP_CODE).toMatch(
      /const ran = \[\s*\.\.\.new Set\(allWorkflows\.map\(\(w\) => w\.workflow_id\.split\(':'\)\[0\]!\)/,
    );
    // …on the lane it ran on, not the dialog's default.
    expect(APP_CODE).toMatch(/workflows: ran, provider: activeRun\?\.provider \?\? null/);
  });

  it('a run with no recorded workflows falls back to no prefill, not an empty selection', () => {
    // An empty prefill would open the dialog on a selection that cannot start, with no way to see
    // why. No prefill at all is the honest state.
    expect(APP_CODE).toMatch(/ran\.length \? \{ workflows: ran/);
  });

  it('⛔ BOTH mount sites take prefill and BOTH clear it', () => {
    // Two mounts of one dialog with only one updated is how the drilldown drawer shipped rendering
    // a hardcoded empty payload from both call sites. Count them rather than trusting one.
    const mounts = APP_CODE.match(/<E2ERunModal/g) ?? [];
    const prefilled = APP_CODE.match(/prefill=\{runModalPrefill\}/g) ?? [];
    expect(prefilled.length).toBe(mounts.length);
    // Cleared on close AND on run, at every site: a stale prefill silently scopes the NEXT run.
    const cleared = APP_CODE.match(/setRunModalPrefill\(null\)/g) ?? [];
    expect(cleared.length).toBeGreaterThanOrEqual(mounts.length * 2);
  });
});
