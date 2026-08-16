/**
 * THE CATALOGUE SYNC — the repo is the source of truth, read at two commits.
 *
 * ## Why this exists
 *
 * The run picker used to be populated by a manifest that forge-hat sent along with a run report.
 * That made the runner the publisher of a fact it merely consumes, and produced a dead end: a newly
 * added workflow was invisible in the picker, and running it was the only way to make it appear —
 * which required selecting it. It also meant every edit was stale until something ran.
 *
 * The repo is the source of truth. This module reads it.
 *
 * ## Two questions, deliberately not collapsed
 *
 *   in_main    does this workflow EXIST?              → repo at the configured ref (default main)
 *   in_runner  can it EXECUTE right now?              → repo at the commit the running
 *                                                       e2e-runner image was built from
 *
 * They differ whenever the runner is behind main, which is the normal state immediately after
 * someone adds a workflow. Showing only main reintroduces `no workflow file for: W-077`. Showing
 * only the runner hides new work. The picker shows both and explains the difference.
 *
 * The runner's commit comes from `HAT_COMMIT` on the Cloud Run job, written by the same release
 * step that sets the image digest — so the two cannot drift. Resolving it through the registry
 * (digest → tag → git tag → commit) would be four links and three failure modes.
 *
 * ## Failure rules, all deliberate
 *
 *   - ANY failure leaves the previous snapshot intact and records `error`. "We could not reach
 *     GitHub" and "there are no workflows" are different facts and must never share an appearance.
 *   - No HAT_COMMIT ⇒ `in_runner` is NULL (undetermined), NOT false. The picker treats NULL as
 *     selectable-with-a-caveat: if we cannot tell, blocking every run is worse than letting the
 *     runner refuse with its own error. Today's deployed job predates the stamp, so NULL is the
 *     real state until forge-hat >= v0.35.0 has rolled.
 *   - `catalogue.json` absent at a commit (older tags predate it) is UNKNOWN for that side, not
 *     empty. An empty read must never retire the whole catalogue.
 */

import type { PgCpResultsBackend } from '../storage/backends/cp-results/pg';
import type { CatalogueEntryInput } from '../storage/backends/cp-results/types';
import { gcpJson } from '../plugins/console-gcp/http';

const GITHUB = 'https://api.github.com';

/** Defaults that WORK. A setting changes these; it never supplies something missing. */
export const CATALOGUE_DEFAULTS = {
  repo: 'mardash-ai/forge-hat',
  ref: 'main',
  intervalSeconds: 300,
} as const;

/** Floor on opportunistic refresh, so a busy screen cannot hammer GitHub. */
export const MIN_REFRESH_SECONDS = 60;

type ManifestRow = {
  workflow_id: string;
  name?: string;
  requires?: 'any' | 'openai' | 'anthropic' | 'both';
  tags?: string[];
  suites?: string[];
  family?: string | null;
};

async function gh<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${GITHUB}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}`);
  return (await res.json()) as T;
}

/** Resolve a ref (branch, tag or sha) to a commit sha. */
async function resolveCommit(repo: string, ref: string, token: string): Promise<string> {
  const c = await gh<{ sha: string }>(`/repos/${repo}/commits/${encodeURIComponent(ref)}`, token);
  if (!c?.sha) throw new Error(`could not resolve ${repo}@${ref}`);
  return c.sha;
}

/**
 * Read `catalogue.json` at a commit.
 *
 * Returns null when the file is ABSENT (a commit predating the generated catalogue) — distinct
 * from an empty list, and distinct from a read that failed, which throws.
 */
async function readManifest(repo: string, commit: string, token: string): Promise<ManifestRow[] | null> {
  const res = await fetch(`${GITHUB}/repos/${repo}/contents/catalogue.json?ref=${commit}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} contents/catalogue.json@${commit.slice(0, 7)}`);
  const doc = JSON.parse(await res.text()) as { version?: number; workflows?: ManifestRow[] };
  if (!Array.isArray(doc?.workflows)) throw new Error('catalogue.json has no workflows array');
  return doc.workflows;
}

/** Read HAT_VERSION / HAT_COMMIT off the e2e-runner job. Absent ⇒ nulls, never a throw. */
export async function readRunnerIdentity(
  project: string,
  region: string,
  job: string,
): Promise<{ commit: string | null; version: string | null }> {
  try {
    const j = await gcpJson<{
      template?: { template?: { containers?: Array<{ env?: Array<{ name: string; value?: string }> }> } };
    }>({ url: `https://run.googleapis.com/v2/projects/${project}/locations/${region}/jobs/${job}` });
    const env = j?.template?.template?.containers?.[0]?.env ?? [];
    const pick = (n: string) => env.find((e) => e.name === n)?.value ?? null;
    return { commit: pick('HAT_COMMIT'), version: pick('HAT_VERSION') };
  } catch {
    // Unreadable job ⇒ undetermined, which is a real state the picker renders honestly.
    return { commit: null, version: null };
  }
}

export type SyncResult = {
  ok: boolean;
  mainCommit: string | null;
  runnerCommit: string | null;
  runnerVersion: string | null;
  workflowsMain: number | null;
  workflowsRunner: number | null;
  error: string | null;
};

/**
 * Run one sync. Never throws: a failure is recorded and reported, and the previous snapshot stands.
 */
export async function syncCatalogue(opts: {
  store: PgCpResultsBackend;
  token: string;
  repo?: string;
  ref?: string;
  project: string;
  region: string;
  job: string;
}): Promise<SyncResult> {
  const repo = opts.repo || CATALOGUE_DEFAULTS.repo;
  const ref = opts.ref || CATALOGUE_DEFAULTS.ref;

  const base: SyncResult = {
    ok: false,
    mainCommit: null,
    runnerCommit: null,
    runnerVersion: null,
    workflowsMain: null,
    workflowsRunner: null,
    error: null,
  };

  try {
    if (!opts.token) throw new Error('CONSOLE_GITHUB_TOKEN is not configured');

    const runner = await readRunnerIdentity(opts.project, opts.region, opts.job);
    const mainCommit = await resolveCommit(repo, ref, opts.token);
    const mainRows = await readManifest(repo, mainCommit, opts.token);
    if (mainRows === null) {
      throw new Error(
        `catalogue.json is absent at ${repo}@${mainCommit.slice(0, 7)} — the repo predates it ` +
          `(forge-hat >= v0.35.0 generates it)`,
      );
    }

    // The runner's view. Same commit ⇒ same list, no second request.
    let runnerRows: ManifestRow[] | null = null;
    if (runner.commit) {
      runnerRows =
        runner.commit === mainCommit ? mainRows : await readManifest(repo, runner.commit, opts.token);
    }

    const runnerIds = runnerRows ? new Set(runnerRows.map((w) => w.workflow_id)) : null;
    const mainIds = new Set(mainRows.map((w) => w.workflow_id));

    // The UNION. A workflow present only in the runner (removed on main) still ran and must remain
    // selectable; one present only on main is blocked-and-explained. Neither may vanish.
    const merged = new Map<string, ManifestRow>();
    for (const w of runnerRows ?? []) merged.set(w.workflow_id, w);
    for (const w of mainRows) merged.set(w.workflow_id, w); // main's metadata wins where both have it

    const rows: CatalogueEntryInput[] = [...merged.values()].map((w) => ({
      workflow_id: w.workflow_id,
      name: w.name ?? '',
      requires: w.requires ?? 'any',
      tags: w.tags ?? [],
      suites: w.suites ?? [],
      family: w.family ?? null,
      in_main: mainIds.has(w.workflow_id),
      // undefined ⇒ NULL ⇒ undetermined. Only a SUCCESSFUL runner read yields true/false.
      ...(runnerIds ? { in_runner: runnerIds.has(w.workflow_id) } : {}),
    }));

    await opts.store.replaceCatalogue(rows);
    const result: SyncResult = {
      ok: true,
      mainCommit,
      runnerCommit: runner.commit,
      runnerVersion: runner.version,
      workflowsMain: mainRows.length,
      workflowsRunner: runnerRows ? runnerRows.length : null,
      error: null,
    };
    await opts.store.setCatalogueSync({
      repo,
      main_ref: ref,
      main_commit: mainCommit,
      runner_commit: runner.commit,
      runner_version: runner.version,
      workflows_main: result.workflowsMain,
      workflows_runner: result.workflowsRunner,
      error: null,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // ⛔ The catalogue rows are NOT touched. A GitHub outage must not empty the picker; the
    // operator sees the previous list with a stale-and-why banner instead of a blank one.
    await opts.store.setCatalogueSync({ repo, main_ref: ref, error: message }).catch(() => undefined);
    console.error(`[catalogue-sync] ${message} — keeping the previous catalogue`);
    return { ...base, error: message };
  }
}
