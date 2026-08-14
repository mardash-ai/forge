/**
 * ⛔ THE LINK AN OPERATOR CLICKS WHEN A RUN FAILS MUST GO SOMEWHERE.
 *
 * 2026-08-14. The "Cloud Run ↗" link on a failed run led to a Console page reading **"URL not
 * found"**. It had been built by pattern-matching the job page's own path —
 *
 *     /run/jobs/details/{region}/{job}/executions/{id}      ← not a real Console route
 *
 * — which looks right, sits next to a route that IS real, and was never clicked in anger until a run
 * failed. That is the whole failure mode: a link is only exercised on the bad day.
 *
 * The replacement is NOT a better guess. It is the `Log URI` that
 * `gcloud run jobs executions describe` prints for the same execution — Google's own answer to
 * "where do I look at this execution", reproduced field for field and diffed against the real
 * command output before being trusted.
 *
 * It is also the better destination. This link renders only on a FAILED or STOPPED run, and what
 * you want then is what the container actually said — not a status page restating the failure you
 * are already looking at.
 */

import { describe, it, expect } from 'vitest';
import { buildExecutionConsoleUrl, buildJobExecutionsUrl } from '../src/plugins/console-gcp/jobs';

const NAME = 'projects/dorinda-prod/locations/us-east1/jobs/e2e-runner/executions/e2e-runner-qnvmt';

describe('buildExecutionConsoleUrl', () => {
  it('⛔ does not emit the dead /executions/{id} route', () => {
    const url = buildExecutionConsoleUrl(NAME, 'dorinda-prod')!;
    expect(url).not.toMatch(/\/run\/jobs\/details\/[^/]+\/[^/]+\/executions\/[^?]+/);
  });

  it('matches the Log URI gcloud prints for the same execution', () => {
    // Captured verbatim from:
    //   gcloud run jobs executions describe e2e-runner-qnvmt --region us-east1 --project dorinda-prod
    const url = new URL(buildExecutionConsoleUrl(NAME, 'dorinda-prod')!);
    expect(url.origin + url.pathname).toBe('https://console.cloud.google.com/logs/viewer');
    expect(url.searchParams.get('project')).toBe('dorinda-prod');

    const filter = (url.searchParams.get('advancedFilter') ?? '').split('\n').sort();
    expect(filter).toEqual(
      [
        'resource.type="cloud_run_job"',
        'resource.labels.job_name="e2e-runner"',
        'resource.labels.location="us-east1"',
        'labels."run.googleapis.com/execution_name"="e2e-runner-qnvmt"',
      ].sort(),
    );
  });

  it('⛔ scopes to ONE execution, not the job’s whole history', () => {
    // Without the execution_name line the view is every run the job has ever done — which on a
    // failure is worse than no link, because it looks specific and is not.
    const url = buildExecutionConsoleUrl(NAME, 'dorinda-prod')!;
    expect(decodeURIComponent(url)).toContain('execution_name"="e2e-runner-qnvmt"');
  });

  it('returns null for a malformed execution name rather than a broken link', () => {
    expect(buildExecutionConsoleUrl('nonsense', 'p')).toBeNull();
    expect(buildExecutionConsoleUrl('projects/p/locations/r/jobs/j', 'p')).toBeNull();
  });

  it('the job-level fallback uses the route verified against the live Console', () => {
    expect(buildJobExecutionsUrl('us-east1', 'e2e-runner', 'dorinda-prod')).toBe(
      'https://console.cloud.google.com/run/jobs/details/us-east1/e2e-runner/executions?project=dorinda-prod',
    );
  });
});
