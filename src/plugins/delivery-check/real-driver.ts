// Real DeliveryCheckDriver implementation — calls git, docker-inspect/manifest, and reads
// the in-repo tracking files. Used by the CI script and the Capability execute path.
// Unit tests inject a fake driver; this file is integration-only.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../shared/exec';
import type { DeliveryCheckDriver, SilenceDeclaration, DeliverySilenceFile } from './index';

// ── git helpers ───────────────────────────────────────────────────────────────

async function git(args: string[], cwd: string): Promise<string> {
  const r = await run('git', args, { cwd, timeoutMs: 30_000 });
  return r.code === 0 ? r.combined.trim() : '';
}

// ── docker/manifest helpers ───────────────────────────────────────────────────

// Resolve the sha256 digest of a remote image:tag by inspecting the manifest.
// Uses `docker manifest inspect` which doesn't need a pull.
async function resolveRemoteDigest(imageRef: string): Promise<string | null> {
  const r = await run('docker', ['manifest', 'inspect', '--verbose', imageRef], {
    timeoutMs: 60_000,
  });
  if (r.code !== 0) return null;
  // The verbose output may be an array (multi-arch) or object. We want the config digest.
  try {
    const parsed = JSON.parse(r.combined) as unknown;
    // Single-arch: { Descriptor: { digest: "sha256:..." } }
    // Multi-arch: [{ Descriptor: { digest: "sha256:..." } }, ...]
    // Return the index/manifest digest (the OCI image index digest, stable across arches).
    if (Array.isArray(parsed)) {
      const first = parsed[0] as { Descriptor?: { digest?: string } } | undefined;
      return first?.Descriptor?.digest ?? null;
    }
    const single = parsed as { Descriptor?: { digest?: string } };
    return single?.Descriptor?.digest ?? null;
  } catch {
    // Fall back to a regex scan for sha256 digests
    const m = r.combined.match(/"digest"\s*:\s*"(sha256:[a-f0-9]{64})"/);
    return m?.[1] ?? null;
  }
}

// ── GitHub REST API helper ────────────────────────────────────────────────────

// Call the GitHub REST API using the GITHUB_TOKEN environment variable (available in CI).
// Returns the parsed JSON body, or null when the request fails or credentials are absent.
async function githubApiGet<T>(apiPath: string): Promise<T | null> {
  const token = process.env['GITHUB_TOKEN'];
  const repo = process.env['GITHUB_REPOSITORY']; // "owner/repo" set by the Actions runner
  if (!token || !repo) return null;
  try {
    const url = `https://api.github.com/repos/${repo}${apiPath}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ── deployment-state file ─────────────────────────────────────────────────────

// deployment.json tracks the digest of the last successfully deployed image.
// Updated by the release/deploy process; read here to compare against the registry.
interface DeploymentState {
  // Keyed by image name (without tag).
  [image: string]: {
    tag: string;
    digest: string;
    deployed_at: string;
  };
}

async function readDeploymentState(repoRoot: string): Promise<DeploymentState> {
  try {
    const raw = await readFile(path.join(repoRoot, 'deployment.json'), 'utf8');
    return JSON.parse(raw) as DeploymentState;
  } catch {
    return {};
  }
}

// ── RealDriver ────────────────────────────────────────────────────────────────

export function createRealDriver(repoRoot: string): DeliveryCheckDriver {
  return {
    async getLatestReleaseTag(): Promise<string | null> {
      // Fetch all tags first so we don't miss recently-pushed ones in shallow clones.
      await git(['fetch', '--tags', '--quiet'], repoRoot).catch(() => null);
      const tag = await git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], repoRoot);
      return tag || null;
    },

    async getUnreleasedCommits(latestTag: string, paths: string[]): Promise<string[]> {
      // git log <tag>..HEAD [-- <paths>] --oneline
      const pathArgs = paths.length > 0 ? ['--', ...paths] : [];
      const result = await git(['log', '--oneline', `${latestTag}..HEAD`, ...pathArgs], repoRoot);
      if (!result) return [];
      return result.split('\n').filter((l) => l.trim().length > 0);
    },

    async getTagImageDigest(image: string, tag: string): Promise<string | null> {
      return resolveRemoteDigest(`${image}:${tag}`);
    },

    async getDeployedDigest(image: string): Promise<string | null> {
      // Check env var first (CI can inject this without a state file).
      const envDigest = process.env['FORGE_DEPLOYED_DIGEST'];
      if (envDigest?.startsWith('sha256:')) return envDigest;
      // Fall back to the deployment.json state file.
      const state = await readDeploymentState(repoRoot);
      return state[image]?.digest ?? null;
    },

    async readSilences(): Promise<SilenceDeclaration[]> {
      try {
        const raw = await readFile(path.join(repoRoot, '.delivery-silence.json'), 'utf8');
        const parsed = JSON.parse(raw) as DeliverySilenceFile;
        return Array.isArray(parsed.silences) ? parsed.silences : [];
      } catch {
        return [];
      }
    },

    async getPublishRunState(): Promise<'in_flight' | 'completed' | null> {
      // Query the GitHub Actions API for the most recent runs of the publish workflow.
      // In-flight states: queued, requested, waiting, in_progress.
      // Returns null when GITHUB_TOKEN / GITHUB_REPOSITORY are not set (local / non-CI runs).
      interface WorkflowRunsResponse {
        workflow_runs: Array<{ status: string }>;
      }
      const data = await githubApiGet<WorkflowRunsResponse>(
        '/actions/workflows/publish-image.yml/runs?per_page=3',
      );
      if (!data || !Array.isArray(data.workflow_runs) || data.workflow_runs.length === 0) return null;
      // Check if any of the most recent runs are still in-flight.
      const inFlightStatuses = new Set(['queued', 'requested', 'waiting', 'in_progress']);
      const hasInFlight = data.workflow_runs.some((r) => inFlightStatuses.has(r.status));
      return hasInFlight ? 'in_flight' : 'completed';
    },

    async getTagAgeSeconds(tag: string): Promise<number | null> {
      // For annotated tags, prefer the tagger timestamp (when the tag object was created).
      // For lightweight tags, fall back to the tagged commit's author timestamp.
      const taggerTs = await git(
        ['for-each-ref', '--format=%(taggerdate:unix)', `refs/tags/${tag}`],
        repoRoot,
      );
      const taggerEpoch = parseInt(taggerTs, 10);
      if (!isNaN(taggerEpoch) && taggerEpoch > 0) {
        return Math.floor(Date.now() / 1000) - taggerEpoch;
      }
      // Lightweight tag — use the commit timestamp.
      const commitTs = await git(['log', '-1', '--format=%ct', tag], repoRoot);
      const commitEpoch = parseInt(commitTs, 10);
      if (!isNaN(commitEpoch) && commitEpoch > 0) {
        return Math.floor(Date.now() / 1000) - commitEpoch;
      }
      return null;
    },
  };
}
