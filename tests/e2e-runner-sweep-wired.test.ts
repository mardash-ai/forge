/**
 * ⛔ The post-run mail sweep must be WIRED, not merely available.
 *
 * This whole line of work began with a capability that existed and was never invoked: the console's
 * drilldown endpoint returned scenes correctly and nothing called it. The mail sweep repeated the
 * shape twice in one afternoon — first `cmdTeardown` reachable only from the CLI so no run ever ran
 * it, then module variables that default to `""` and would have left the sweep permanently skipped
 * because the call site never passed them.
 *
 * A cleanup that silently never runs is indistinguishable from one that works, right up until the
 * mailbox has 34 messages in it again. These assertions pin the wiring at every layer that can
 * quietly drop it.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODULE = readFileSync(join(process.cwd(), 'terraform/modules/e2e-runner/main.tf'), 'utf8');
const CALLSITE = readFileSync(join(process.cwd(), 'infra/main.tf'), 'utf8');

describe('the runner job can sweep mail after a run', () => {
  it('declares both delegation variables', () => {
    expect(MODULE).toMatch(/variable "google_teardown_service_account"/);
    expect(MODULE).toMatch(/variable "google_teardown_subject"/);
  });

  it('wires them onto the job as the env names forge-hat reads', () => {
    // A value exported under one name and read under another is this estate's most expensive defect
    // shape — these are the names `sweepMailResidue` actually looks up.
    expect(MODULE).toMatch(/name\s+=\s+"HAT_GOOGLE_TEARDOWN_SERVICE_ACCOUNT"/);
    expect(MODULE).toMatch(/name\s+=\s+"HAT_GOOGLE_SUBJECT"/);
  });

  it('⛔ the CALL SITE passes real values — defaults would disable the sweep forever', () => {
    expect(CALLSITE).toMatch(/google_teardown_service_account\s+=\s+"hat-teardown@/);
    expect(CALLSITE).toMatch(/google_teardown_subject\s+=\s+"dorinda-test@mardash\.ai"/);
  });

  it('⛔ never delegates to the read-only VERIFIER account', () => {
    // hat-verifier@ must stay incapable of changing what it reports on.
    expect(CALLSITE).not.toMatch(/google_teardown_service_account\s+=\s+"hat-verifier@/);
  });

  it('grants tokenCreator so the runner can mint the delegated token', () => {
    // Without this the sweep fails at signJwt with a 403 that reads like a broken credential.
    expect(MODULE).toMatch(/roles\/iam\.serviceAccountTokenCreator/);
    expect(MODULE).toMatch(/google_service_account_iam_member" "runner_impersonates_teardown/);
  });

  it('scopes the binding to that ONE account, not the whole project', () => {
    const block = MODULE.slice(MODULE.indexOf('runner_impersonates_teardown'));
    expect(block).toMatch(
      /service_account_id\s+=\s+"projects\/\$\{var\.project_id\}\/serviceAccounts\/\$\{var\.google_teardown_service_account\}"/,
    );
  });
});

describe('the job can outlive a full catalogue run', () => {
  const MODULE_SRC = readFileSync(join(process.cwd(), 'terraform/modules/e2e-runner/main.tf'), 'utf8');

  it('⛔ the timeout exceeds the measured full-catalogue wall clock, with margin', () => {
    // 2026-08-14: the cap was 3600s while 76 workflows x ~58s of measured wall clock projects to
    // ~4400s. A full run was guaranteed to be killed two-thirds through — and because the kill
    // lands before the terminal progress push, the run row sits in `running` forever. The operator
    // pays for 60 workflows and gets a run that never resolves.
    //
    // A timeout tuned tight enough to fire on a HEALTHY run is not a safety net; it is a scheduled
    // failure. This asserts the backstop stays a backstop.
    const m = MODULE_SRC.match(/variable "job_timeout"[\s\S]*?default\s+=\s+"(\d+)s"/);
    expect(m, 'job_timeout default not found — test needs updating').toBeTruthy();
    const timeoutS = Number(m![1]);

    const WORKFLOWS = 83; // suites/full.yaml (76 + six Outlook/SMS workflows + Microsoft openid/email scope fix, 2026-08-21)
    const MEASURED_WALL_S_PER_WORKFLOW = 58; // mean of six runs, 2026-08-14
    const projected = WORKFLOWS * MEASURED_WALL_S_PER_WORKFLOW;

    expect(timeoutS).toBeGreaterThan(projected);
    // And not merely by a hair — the estimate is a mean, so half of all runs are slower than it.
    expect(timeoutS).toBeGreaterThanOrEqual(Math.round(projected * 1.5));
  });

  it('the catalogue size the estimate is built on has not moved', () => {
    // ⛔ GUARDED, because this reads a SIBLING repo. The first version read
    // `../forge-hat/suites/full.yaml` unconditionally — fine on a dev box where both repos sit side
    // by side, ENOENT in CI where only `forge` is checked out. It failed the build and blocked the
    // publish (2026-08-14). The gate did its job; the test was wrong.
    //
    // Skipping is safe here because forge-hat asserts the count in ITS OWN CI, where the file always
    // exists (`tests/ingest-report.test.ts` pins 76). And the assertion that actually protects this
    // repo — timeout > catalogue x measured rate, just above — runs unconditionally off a constant.
    // So nothing is silently uncovered by the skip.
    const suitePath = join(process.cwd(), '../forge-hat/suites/full.yaml');
    if (!existsSync(suitePath)) return;
    const entries = readFileSync(suitePath, 'utf8')
      .split('\n')
      .filter((l) => /^\s*-\s/.test(l)).length;
    expect(entries).toBeLessThanOrEqual(83);
  });
});
