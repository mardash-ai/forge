/**
 * ⛔ THE REPO IS THE SOURCE OF TRUTH — AND A FAILED SYNC MUST NOT EMPTY THE PICKER.
 *
 * The run picker was briefly populated by a manifest forge-hat sent with a run report. That made
 * the runner the publisher of a fact it merely consumes, and produced a dead end: a workflow added
 * to the repo was invisible in the picker, and running it was the only way to make it appear —
 * which required selecting it.
 *
 * This sync reads the repo at TWO commits and keeps the answers apart:
 *
 *   in_main    it exists                 → repo at the configured ref
 *   in_runner  it can execute right now  → repo at the commit the running image was built from
 *
 * Three behaviours below are load-bearing and none of them is obvious:
 *
 *   1. THE UNION. A workflow on main but not in the runner must be present-and-blocked, not
 *      absent; one in the runner but not on main still ran and must stay selectable.
 *   2. TRI-STATE `in_runner`. NULL means undetermined. Collapsing it to false would block every
 *      workflow the moment a job spec became unreadable — worse than the bug being fixed.
 *   3. A FAILED SYNC PRESERVES THE PREVIOUS SNAPSHOT. "GitHub is unreachable" and "there are no
 *      workflows" are different facts; only one of them should ever empty a picker, and it is
 *      neither of them.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Pool } from 'pg';
import { PgCpResultsBackend, ensureCpResultsSchema } from '../src/storage/backends/cp-results/pg';
import { syncCatalogue } from '../src/console/catalogue-sync';
import { resetCredentialCache } from '../src/plugins/console-gcp/http';

const HAS_PG = process.env.FORGE_CP_RESULTS_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

const MAIN_SHA = 'a'.repeat(40);
const RUNNER_SHA = 'b'.repeat(40);

const wf = (id: string, requires = 'any') => ({
  workflow_id: id,
  name: `workflow ${id}`,
  requires,
  tags: ['p0'],
  suites: ['full'],
  family: 'W-0xx',
});

/** main has W-001..W-003; the runner image is older and lacks W-003. */
const MAIN_MANIFEST = { version: 1, workflows: [wf('W-001', 'openai'), wf('W-002'), wf('W-003')] };
const RUNNER_MANIFEST = { version: 1, workflows: [wf('W-001', 'openai'), wf('W-002')] };

type FetchStub = { runnerCommit: string | null; failGitHub?: boolean; missingAtMain?: boolean };

function installFetch(cfg: FetchStub): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    /*
     * ⛔ The GCP TOKEN layer — answered FIRST, because `gcpJson` calls `accessToken()` before it
     * ever fetches the API URL. This mock originally answered only the API URLs, so on a
     * credential-less runner (CI) accessToken exhausted every real path — metadata server, ADC
     * file, gcloud — and THREW before the mocked API fetch was consulted. readRunnerIdentity
     * caught it and returned null, and the assertion failed.
     *
     * The test passed on the acceptance machine (real ADC on disk) and failed on every CI run —
     * red on EVERY forge commit for days, which is a check people learn to skip. A test's
     * environment must be closed: if the code under test talks to N services, the mock answers
     * all N, not the N-1 that happened to exist on the author's machine.
     */
    if (url.includes('metadata.google.internal') || url.includes('metadata/computeMetadata')) {
      return json({ access_token: 'test-token', expires_in: 3600 });
    }
    if (url.includes('oauth2.googleapis.com')) {
      return json({ access_token: 'test-token', expires_in: 3600 });
    }

    // The Cloud Run job — where the runner's identity comes from.
    if (url.includes('run.googleapis.com')) {
      const env = cfg.runnerCommit
        ? [
            { name: 'HAT_COMMIT', value: cfg.runnerCommit },
            { name: 'HAT_VERSION', value: '0.35.0' },
          ]
        : [{ name: 'DORINDA_TEST_TENANT', value: 'user_x' }];
      return json({ template: { template: { containers: [{ env }] } } });
    }
    if (cfg.failGitHub) return new Response('boom', { status: 503 });
    if (url.includes('/commits/')) return json({ sha: MAIN_SHA });
    if (url.includes('catalogue.json')) {
      if (cfg.missingAtMain) return new Response('not found', { status: 404 });
      const body = url.includes(RUNNER_SHA) ? RUNNER_MANIFEST : MAIN_MANIFEST;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
}

describe.skipIf(!HAS_PG)('the catalogue sync', () => {
  let pool: Pool;
  let store: PgCpResultsBackend;
  const realFetch = globalThis.fetch;

  const run = (cfg: FetchStub) => {
    // Token state is module-level and cached. Reset it so (a) a REAL token cached by an earlier
    // test on a credentialed machine cannot mask a broken mock, and (b) a negative-cache entry
    // from a credential-less machine cannot outlive the mock that would have answered.
    resetCredentialCache();
    installFetch(cfg);
    return syncCatalogue({
      store,
      token: 'test-token',
      repo: 'mardash-ai/forge-hat',
      ref: 'main',
      project: 'p',
      region: 'r',
      job: 'e2e-runner',
    });
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
    await pool.query('DROP TABLE IF EXISTS forge_cp_eval_catalogue');
    await pool.query('DROP TABLE IF EXISTS forge_cp_catalogue_sync');
    await ensureCpResultsSchema(pool);
    store = new PgCpResultsBackend(pool);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM forge_cp_eval_catalogue');
    await pool.query('DELETE FROM forge_cp_catalogue_sync');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await pool?.end().catch(() => undefined);
  });

  it('⛔ stores the UNION, with main-only workflows present but marked not-in-runner', async () => {
    const r = await run({ runnerCommit: RUNNER_SHA });
    expect(r.ok).toBe(true);
    expect(r.mainCommit).toBe(MAIN_SHA);
    expect(r.runnerCommit).toBe(RUNNER_SHA);
    expect(r.runnerVersion).toBe('0.35.0');

    const rows = await store.listCatalogue();
    expect(rows.map((x) => x.workflow_id)).toEqual(['W-001', 'W-002', 'W-003']);

    const byId = Object.fromEntries(rows.map((x) => [x.workflow_id, x]));
    // W-003 exists but the runner image predates it: present, blocked-and-explainable — NOT absent.
    expect(byId['W-003']!.in_main).toBe(true);
    expect(byId['W-003']!.in_runner).toBe(false);
    expect(byId['W-002']!.in_runner).toBe(true);
    // The computed requirement survives the round trip — it is what the picker greys out on.
    expect(byId['W-001']!.requires).toBe('openai');
  });

  it('⛔ NO HAT_COMMIT means UNDETERMINED (null), never "not in the runner"', async () => {
    // Today's deployed job predates the stamp. Reporting false here would block every workflow.
    const r = await run({ runnerCommit: null });
    expect(r.ok).toBe(true);
    expect(r.runnerCommit).toBeNull();

    const rows = await store.listCatalogue();
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => x.in_runner === null)).toBe(true);
    expect(rows.every((x) => x.in_main === true)).toBe(true);
  });

  it('⛔ a FAILED sync leaves the previous catalogue intact and records why', async () => {
    await run({ runnerCommit: RUNNER_SHA });
    expect(await store.listCatalogue()).toHaveLength(3);

    const r = await run({ runnerCommit: RUNNER_SHA, failGitHub: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/GitHub 503/);

    // The rows are untouched — an outage must not empty the picker.
    const rows = await store.listCatalogue();
    expect(rows).toHaveLength(3);

    // …and the failure is VISIBLE, not swallowed.
    const sync = await store.getCatalogueSync();
    expect(sync?.error).toMatch(/GitHub 503/);
  });

  it('an absent catalogue.json at main is an error, not an empty catalogue', async () => {
    await run({ runnerCommit: RUNNER_SHA });
    const r = await run({ runnerCommit: RUNNER_SHA, missingAtMain: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/absent/);
    // Emptying on a 404 would retire every workflow the moment someone pointed at an older ref.
    expect(await store.listCatalogue()).toHaveLength(3);
  });

  it('records both commits and counts so the UI can show drift', async () => {
    await run({ runnerCommit: RUNNER_SHA });
    const sync = await store.getCatalogueSync();
    expect(sync?.main_commit).toBe(MAIN_SHA);
    expect(sync?.runner_commit).toBe(RUNNER_SHA);
    expect(sync?.workflows_main).toBe(3);
    expect(sync?.workflows_runner).toBe(2);
    expect(sync?.error).toBeNull();
    expect(sync?.synced_at).toBeTruthy();
  });

  it('a workflow retired from main is removed from the picker', async () => {
    await run({ runnerCommit: RUNNER_SHA });
    // Runner-only now: main drops back to the older list.
    MAIN_MANIFEST.workflows = RUNNER_MANIFEST.workflows;
    const r = await run({ runnerCommit: RUNNER_SHA });
    expect(r.ok).toBe(true);
    expect((await store.listCatalogue()).map((x) => x.workflow_id)).toEqual(['W-001', 'W-002']);
    MAIN_MANIFEST.workflows = [wf('W-001', 'openai'), wf('W-002'), wf('W-003')];
  });
});
