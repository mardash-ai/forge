// Plugin: delivery-check — checks that every hop in the delivery pipeline is current.
//
// Three check types guard four hops (commit→tag, tag→image, image→deploy, release→consumer):
//   producer  — main branch carries source changes not yet included in any release tag.
//   release   — the deployed service is not running the latest release's image digest.
//   consumer  — a consumer's pinned version or running digest lags the producer's latest release.
//
// The driver interface separates the pure check logic (tested here) from the technology
// adapters (git/docker/gh) that the CI script and Capability wire up. Every check that
// finds a problem returns status:'fail' with a specific artifact name and a concrete remedy;
// a problem is only silenced by an explicit in-repo declaration carrying a reason.

export type CheckType = 'producer' | 'release' | 'consumer';

// The outcome of a single delivery check.
export interface CheckResult {
  check: CheckType;
  status: 'pass' | 'fail' | 'silenced';
  // The specific artifact that is behind (named so the build log is unambiguous).
  artifact: string;
  // Human-readable description of what is wrong (empty when passing).
  message: string;
  // Concrete next step to resolve the problem (present when status is 'fail').
  remedy?: string;
  // Present only when status is 'silenced': the declared reason for the accepted lag.
  silence_reason?: string;
  // Extra detail lines (commits, digests, …).
  detail?: string;
}

// An explicit silence declaration stored in `.delivery-silence.json`.
// A deliberate lag MUST be silenced with a reason; there is no silencing by default.
export interface SilenceDeclaration {
  check: CheckType;
  // Free-text reason. Required — the check will not accept an empty or missing reason.
  reason: string;
  // ISO date (YYYY-MM-DD). If set and now > expires, the silence is treated as absent.
  expires?: string;
}

export interface DeliverySilenceFile {
  silences: SilenceDeclaration[];
}

// ────────────────────────────────────────────────────────────────────────────
// Driver interface — the seam unit tests replace with fakes.
// ────────────────────────────────────────────────────────────────────────────

export interface DeliveryCheckDriver {
  // PRODUCER: return the list of commit shas/messages on HEAD not reachable from latestTag,
  // filtered to those that touch any of the supplied paths (empty paths = all paths).
  getUnreleasedCommits(latestTag: string, paths: string[]): Promise<string[]>;

  // PRODUCER: return the highest vX.Y.Z tag reachable from HEAD (null when none exist).
  getLatestReleaseTag(): Promise<string | null>;

  // RELEASE: return the published SHA-256 digest for `image:tag` from the registry
  // (null when the image or tag does not exist / is not accessible).
  getTagImageDigest(image: string, tag: string): Promise<string | null>;

  // RELEASE: return the digest of the currently DEPLOYED image (null when unknown).
  // Drivers may read this from a deployment-state file, an env var, or a live query.
  getDeployedDigest(image: string): Promise<string | null>;

  // Silence file: read the in-repo `.delivery-silence.json` (returns empty when absent).
  readSilences(): Promise<SilenceDeclaration[]>;
}

// ────────────────────────────────────────────────────────────────────────────
// Silence helper
// ────────────────────────────────────────────────────────────────────────────

function activeSilence(
  silences: SilenceDeclaration[],
  check: CheckType,
  now: Date = new Date(),
): SilenceDeclaration | undefined {
  return silences.find((s) => {
    if (s.check !== check) return false;
    if (!s.reason?.trim()) return false; // reason is mandatory
    if (s.expires) {
      const exp = new Date(s.expires);
      if (!isNaN(exp.getTime()) && now >= exp) return false; // expired
    }
    return true;
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Check 1: Producer — main carries unreleased source changes
// ────────────────────────────────────────────────────────────────────────────

export interface ProducerCheckOpts {
  // The git repository artifact name shown in messages (e.g. "forge").
  repoName: string;
  // Source paths that count as "source changes" (e.g. ["src/", "tests/", "package.json"]).
  // An empty array checks ALL paths.
  sourcePaths: string[];
}

export async function runProducerCheck(
  driver: DeliveryCheckDriver,
  opts: ProducerCheckOpts,
): Promise<CheckResult> {
  const { repoName, sourcePaths } = opts;
  const check: CheckType = 'producer';
  const artifact = `${repoName}:main`;

  const latestTag = await driver.getLatestReleaseTag();
  if (!latestTag) {
    return {
      check,
      status: 'fail',
      artifact,
      message: `No release tag found for ${repoName}. No release has ever been published.`,
      remedy: `Create the first release: tag HEAD with a vX.Y.Z version tag and publish the image.`,
    };
  }

  const commits = await driver.getUnreleasedCommits(latestTag, sourcePaths);

  if (commits.length === 0) {
    return {
      check,
      status: 'pass',
      artifact,
      message: `${repoName}:main is current — all source changes are included in ${latestTag}.`,
    };
  }

  const silences = await driver.readSilences();
  const silence = activeSilence(silences, check);
  if (silence) {
    return {
      check,
      status: 'silenced',
      artifact,
      message: `${repoName}:main is ${commits.length} commit(s) ahead of ${latestTag} (lag accepted).`,
      silence_reason: silence.reason,
      detail: commits.join('\n'),
    };
  }

  return {
    check,
    status: 'fail',
    artifact,
    message:
      `${repoName}:main is ${commits.length} commit(s) ahead of ${latestTag} — ` +
      `source changes on main are not included in any release.`,
    remedy: `Publish a new release (bump version + tag + push image) to deliver these commits.`,
    detail: commits.join('\n'),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Check 2: Release — deployed service is not on the release digest
// ────────────────────────────────────────────────────────────────────────────

export interface ReleaseCheckOpts {
  // Fully-qualified image name without tag (e.g. "ghcr.io/mardash-ai/forge-control-plane").
  image: string;
  // Human label for messages (e.g. "forge-control-plane").
  label: string;
}

export async function runReleaseCheck(
  driver: DeliveryCheckDriver,
  opts: ReleaseCheckOpts,
): Promise<CheckResult> {
  const { image, label } = opts;
  const check: CheckType = 'release';
  const artifact = image;

  const latestTag = await driver.getLatestReleaseTag();
  if (!latestTag) {
    return {
      check,
      status: 'fail',
      artifact,
      message: `No release tag found. ${label} has never been released.`,
      remedy: `Tag and publish the first release.`,
    };
  }

  const expectedDigest = await driver.getTagImageDigest(image, latestTag);
  if (!expectedDigest) {
    return {
      check,
      status: 'fail',
      artifact: `${image}:${latestTag}`,
      message: `Release image ${image}:${latestTag} is not published in the registry.`,
      remedy: `Ensure the publish workflow completed for ${latestTag}; re-run if it failed.`,
    };
  }

  const deployedDigest = await driver.getDeployedDigest(image);
  if (!deployedDigest) {
    return {
      check,
      status: 'fail',
      artifact,
      message: `Deployed digest for ${label} is not tracked. Cannot verify the deployment is current.`,
      remedy: `Record the deployed digest in deployment.json after each release deploy.`,
    };
  }

  if (deployedDigest === expectedDigest) {
    return {
      check,
      status: 'pass',
      artifact,
      message: `${label} is running release ${latestTag} (digest matches).`,
    };
  }

  const silences = await driver.readSilences();
  const silence = activeSilence(silences, check);
  if (silence) {
    return {
      check,
      status: 'silenced',
      artifact,
      message: `${label} is not running release ${latestTag} digest (lag accepted).`,
      silence_reason: silence.reason,
      detail: `expected: ${expectedDigest}\ndeployed: ${deployedDigest}`,
    };
  }

  return {
    check,
    status: 'fail',
    artifact,
    message:
      `${label} is not running the ${latestTag} release digest. ` +
      `The deployed image is behind.`,
    remedy: `Deploy ${image}:${latestTag} (digest: ${expectedDigest}) to production.`,
    detail: `expected: ${expectedDigest}\ndeployed: ${deployedDigest}`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Check 3: Consumer — pinned version lags the producer's latest release
// ────────────────────────────────────────────────────────────────────────────

export interface ConsumerCheckOpts {
  // The consumer artifact name shown in messages (e.g. "forge-os").
  consumerName: string;
  // The producer artifact name (e.g. "forge").
  producerName: string;
  // The version or digest the consumer currently pins.
  pinnedVersion: string;
  // The producer's latest release version.
  latestVersion: string;
}

export async function runConsumerCheck(
  driver: DeliveryCheckDriver,
  opts: ConsumerCheckOpts,
): Promise<CheckResult> {
  const { consumerName, producerName, pinnedVersion, latestVersion } = opts;
  const check: CheckType = 'consumer';
  const artifact = `${consumerName}:${producerName}@${pinnedVersion}`;

  if (pinnedVersion === latestVersion) {
    return {
      check,
      status: 'pass',
      artifact,
      message: `${consumerName} is current — pinned to ${producerName}@${latestVersion}.`,
    };
  }

  const silences = await driver.readSilences();
  const silence = activeSilence(silences, check);
  if (silence) {
    return {
      check,
      status: 'silenced',
      artifact,
      message:
        `${consumerName} is pinned to ${producerName}@${pinnedVersion} ` +
        `(latest: ${latestVersion}, lag accepted).`,
      silence_reason: silence.reason,
    };
  }

  return {
    check,
    status: 'fail',
    artifact,
    message:
      `${consumerName} is pinned to ${producerName}@${pinnedVersion} ` +
      `but the latest release is ${latestVersion}.`,
    remedy:
      `Update the ${producerName} pin in ${consumerName} from ${pinnedVersion} to ${latestVersion}.`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Batch runner — run multiple checks and collect results
// ────────────────────────────────────────────────────────────────────────────

export interface BatchCheckResult {
  results: CheckResult[];
  passed: number;
  failed: number;
  silenced: number;
  // True iff all checks passed or were explicitly silenced (no unaddressed failures).
  ok: boolean;
}

export async function runChecks(checks: Array<() => Promise<CheckResult>>): Promise<BatchCheckResult> {
  const results = await Promise.all(checks.map((fn) => fn()));
  const failed = results.filter((r) => r.status === 'fail').length;
  const silenced = results.filter((r) => r.status === 'silenced').length;
  const passed = results.filter((r) => r.status === 'pass').length;
  return { results, passed, failed, silenced, ok: failed === 0 };
}

// ────────────────────────────────────────────────────────────────────────────
// Formatted output — human-readable CI log lines
// ────────────────────────────────────────────────────────────────────────────

export function formatCheckResult(r: CheckResult): string {
  const icon = r.status === 'pass' ? '✓' : r.status === 'silenced' ? '~' : '✗';
  const lines: string[] = [`${icon} [${r.check}] ${r.artifact}: ${r.message}`];
  if (r.detail) {
    for (const line of r.detail.split('\n')) {
      if (line.trim()) lines.push(`    ${line}`);
    }
  }
  if (r.remedy) lines.push(`  → ${r.remedy}`);
  if (r.silence_reason) lines.push(`  ~ silenced: ${r.silence_reason}`);
  return lines.join('\n');
}

export function formatBatchResult(batch: BatchCheckResult): string {
  const lines = batch.results.map(formatCheckResult);
  lines.push('');
  if (batch.ok) {
    lines.push(
      `delivery-check: ${batch.passed} passed, ${batch.silenced} silenced — all hops delivered.`,
    );
  } else {
    lines.push(
      `delivery-check: ${batch.failed} FAILED, ${batch.passed} passed, ${batch.silenced} silenced`,
    );
    lines.push(`Fix the failing checks above before proceeding.`);
  }
  return lines.join('\n');
}
