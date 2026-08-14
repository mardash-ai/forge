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
import { readFileSync } from 'node:fs';
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
