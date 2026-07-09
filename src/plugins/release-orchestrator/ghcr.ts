// Plugin: release-orchestrator — the technology adapter (git + GHCR + docker).
//
// The side-effecting steps `forge release` needs that are NOT already covered by the C7/C8/C14
// code paths: resolve the app's HEAD commit + its GHCR owner from git, resolve/await an image's
// digest in the registry, and (build mode) build+push a multi-arch image. The docker/git calls
// are integration-only; the PARSERS below are pure and unit-tested (they decide what a command's
// output means, which is where a real bug would hide — e.g. mis-reading a digest).

import { run } from '../../shared/exec';
import { isSha256 } from './plan';

export const IMPLEMENTATION = 'release-orchestrator';

// ---------------------------------------------------------------------------
// Pure parsers (unit-tested — no git, no docker).
// ---------------------------------------------------------------------------

// Extract the GitHub owner (org/user) from a remote URL. Handles the SSH and HTTPS forms
// git prints, with or without a trailing `.git`. Returns undefined for anything unrecognized
// (the caller then requires an explicit --owner).
export function parseOwnerFromRemote(remoteUrl: string): string | undefined {
  const url = remoteUrl.trim();
  if (!url) return undefined;
  // git@github.com:owner/repo.git  |  ssh://git@github.com/owner/repo.git
  // https://github.com/owner/repo(.git)  |  github.com/owner/repo
  const m =
    url.match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?\/?$/) /* owner is the path segment before the repo */;
  if (!m) return undefined;
  const owner = m[1]?.trim();
  return owner && owner !== 'github.com' ? owner : undefined;
}

// Read the index/manifest digest out of `docker buildx imagetools inspect <ref> --format
// '{{json .Manifest.Digest}}'` (a quoted "sha256:…") or a bare `sha256:…` line. Returns the
// digest only if it is a well-formed sha256; otherwise undefined (image absent / bad output).
export function parseImageDigest(output: string): string | undefined {
  const text = (output ?? '').trim();
  if (!text) return undefined;
  // A JSON-quoted string, a bare token, or the digest embedded in a larger blob.
  const m = text.match(/sha256:[0-9a-f]{64}/i);
  const digest = m?.[0]?.toLowerCase();
  return digest && isSha256(digest) ? digest : undefined;
}

// Distinguish a registry "image not found yet" (a normal poll miss) from a transient/hard
// error (auth, network, rate limit). During the CI-publish wait we keep polling through
// "not found"; a transient error we ALSO retry (until timeout); only the timeout is fatal.
export function isNotFound(output: string): boolean {
  return /not found|manifest unknown|no such manifest|does not exist|404/i.test(output ?? '');
}

// ---------------------------------------------------------------------------
// git — resolve the commit + owner from the app repo (integration).
// ---------------------------------------------------------------------------

export async function gitHeadCommit(repo: string): Promise<string | undefined> {
  try {
    const r = await run('git', ['-C', repo, 'rev-parse', 'HEAD'], { timeoutMs: 15_000 });
    const sha = r.combined.trim().split('\n')[0]?.trim();
    return r.code === 0 && sha ? sha : undefined;
  } catch {
    return undefined;
  }
}

// True iff the working tree is clean; undefined if git could not be run (binary absent /
// not a repo) so the caller can degrade rather than falsely claim dirty.
export async function gitWorkingTreeClean(repo: string): Promise<boolean | undefined> {
  try {
    const r = await run('git', ['-C', repo, 'status', '--porcelain'], { timeoutMs: 15_000 });
    if (r.code !== 0) return undefined;
    return r.combined.trim().length === 0;
  } catch {
    return undefined;
  }
}

export async function gitRemoteOwner(repo: string): Promise<string | undefined> {
  try {
    const r = await run('git', ['-C', repo, 'remote', 'get-url', 'origin'], { timeoutMs: 15_000 });
    if (r.code !== 0) return undefined;
    return parseOwnerFromRemote(r.combined);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// registry — resolve / await an image digest (integration).
// ---------------------------------------------------------------------------

export interface DockerRunner {
  (args: string[], timeoutMs?: number): Promise<{ code: number; out: string }>;
}

// Default docker runner (targets the local daemon, or a remote one via --context prepended by
// the caller's arg list). Isolated so tests can inject a fake for the poll loop.
export function dockerRunner(context?: string): DockerRunner {
  return async (args, timeoutMs = 60_000) => {
    const full = context ? ['--context', context, ...args] : args;
    const r = await run('docker', full, { timeoutMs });
    return { code: r.code ?? -1, out: r.combined };
  };
}

// Resolve an image's index digest from the registry, or undefined if it is not present yet.
// Uses `docker buildx imagetools inspect` (understands multi-arch indexes; ships with the
// buildx plugin the control-plane image now carries).
export async function resolveDigest(docker: DockerRunner, ref: string): Promise<string | undefined> {
  // Best-effort: a non-zero exit OR a spawn failure (docker/buildx absent) → undefined, never a
  // throw. The assess-phase probe must degrade to "not published yet" rather than abort a release.
  try {
    const r = await docker(['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest.Digest}}'], 60_000);
    if (r.code !== 0) return undefined;
    return parseImageDigest(r.out);
  } catch {
    return undefined;
  }
}

// A resolved image: the tag that actually exists in the registry + its index digest.
export interface DigestHit {
  ref: string;
  digest: string;
}

// Probe a LIST of candidate refs (e.g. `sha-<short>` then `sha-<full>`) and return the first
// that resolves — the robustness that fixes P23, where the tag `forge release` derived (full
// SHA) never matched the tag the publish workflow produced (short SHA). Best-effort per ref.
export async function resolveAnyDigest(docker: DockerRunner, refs: string[]): Promise<DigestHit | undefined> {
  for (const ref of dedupe(refs)) {
    const digest = await resolveDigest(docker, ref);
    if (digest) return { ref, digest };
  }
  return undefined;
}

function dedupe(refs: string[]): string[] {
  return [...new Set(refs.map((r) => r.trim()).filter(Boolean))];
}

const delay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

export interface PollOptions {
  timeoutMs: number; // total budget before giving up
  intervalMs: number; // wait between attempts
  now?: () => number; // injectable clock (tests)
  sleep?: (ms: number) => Promise<void>; // injectable sleep (tests)
  onAttempt?: (attempt: number, elapsedMs: number) => void;
}

// Poll the registry until ANY of the candidate refs resolves to a digest, or the timeout is hit.
// Every interval, each candidate is inspected in order (`sha-<short>` then `sha-<full>`), so a
// release finds whichever tag the app's publish workflow actually lands — the drift that caused
// P23 (release polled the full-SHA tag; the workflow only ever pushed the short-SHA tag) can no
// longer wedge the wait. Transient errors and "not found yet" both just retry — the resilience
// that recovers the manual flow's "died twice on transient API errors mid-roll." Throws a
// precise error naming every candidate on timeout.
export async function waitForAnyDigest(docker: DockerRunner, refs: string[], opts: PollOptions): Promise<DigestHit> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? delay;
  const deadline = now() + opts.timeoutMs;
  const candidates = dedupe(refs);
  let attempt = 0;
  let lastReason = 'not published yet';
  for (;;) {
    attempt++;
    opts.onAttempt?.(attempt, now() - (deadline - opts.timeoutMs));
    for (const ref of candidates) {
      const r = await docker(['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest.Digest}}'], 60_000);
      if (r.code === 0) {
        const digest = parseImageDigest(r.out);
        if (digest) return { ref, digest };
        lastReason = 'inspect returned no digest';
      } else {
        lastReason = isNotFound(r.out) ? 'not published yet' : `transient registry error: ${r.out.trim().split('\n').slice(-1)[0] ?? 'unknown'}`;
      }
    }
    if (now() >= deadline) {
      throw new Error(
        `timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for ${candidates.join(' or ')} (${lastReason}). ` +
          `Did the app's publish workflow run and go green for this commit? Check GitHub Actions, then re-run \`forge release\` (it resumes).`,
      );
    }
    await sleep(opts.intervalMs);
  }
}

// Single-ref wrapper (back-compat): poll one ref until it resolves, returning just the digest.
export async function waitForDigest(docker: DockerRunner, ref: string, opts: PollOptions): Promise<string> {
  return (await waitForAnyDigest(docker, [ref], opts)).digest;
}

// Build a multi-arch (amd64+arm64) image from the app repo and push it, returning the pushed
// index digest. Used only by `--publish-mode build` (a host with buildx + a registry login).
export async function buildAndPush(
  docker: DockerRunner,
  opts: { repo: string; ref: string; dockerfile?: string },
): Promise<string> {
  const args = [
    'buildx', 'build',
    '--platform', 'linux/amd64,linux/arm64',
    ...(opts.dockerfile ? ['-f', opts.dockerfile] : []),
    '-t', opts.ref,
    '--push',
    opts.repo,
  ];
  const r = await docker(args, 30 * 60_000);
  if (r.code !== 0) {
    throw new Error(`multi-arch build+push of ${opts.ref} failed: ${r.out.trim().split('\n').slice(-3).join(' ')}`);
  }
  // Resolve the pushed digest from the registry (buildx does not always echo it parseably).
  const digest = await resolveDigest(docker, opts.ref);
  if (!digest) throw new Error(`built+pushed ${opts.ref} but could not resolve its digest from the registry`);
  return digest;
}
