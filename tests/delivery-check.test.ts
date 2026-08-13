import { describe, it, expect } from 'vitest';
import {
  runProducerCheck,
  runReleaseCheck,
  runConsumerCheck,
  runChecks,
  formatCheckResult,
  formatBatchResult,
  type DeliveryCheckDriver,
  type SilenceDeclaration,
  type CheckResult,
} from '../src/plugins/delivery-check/index';

// Delivery-check capability (C38) — proves the three check types go RED on a
// reconstructed behind-state, then GREEN once each lag is resolved. Also proves
// the batch runner reports a non-ok result when any check fails, and that an explicit
// in-repo silence declaration with a reason suppresses the failure without hiding it.

// ── Fake driver helpers ───────────────────────────────────────────────────────

function makeDriver(overrides: Partial<DeliveryCheckDriver> = {}): DeliveryCheckDriver {
  return {
    async getLatestReleaseTag() {
      return 'v1.28.9';
    },
    async getUnreleasedCommits(_tag, _paths) {
      return [];
    },
    async getTagImageDigest(_image, _tag) {
      return 'sha256:' + 'a'.repeat(64);
    },
    async getDeployedDigest(_image) {
      return 'sha256:' + 'a'.repeat(64);
    },
    async readSilences() {
      return [];
    },
    ...overrides,
  };
}

const DIGEST_RELEASE = 'sha256:' + 'a'.repeat(64);
const DIGEST_OLD = 'sha256:' + 'b'.repeat(64);
const IMAGE = 'ghcr.io/mardash-ai/forge-control-plane';

// ── Producer check ────────────────────────────────────────────────────────────

describe('producer check', () => {
  it('RED: main is ahead of the latest release tag (unreleased source commits)', async () => {
    const driver = makeDriver({
      async getUnreleasedCommits(_tag, _paths) {
        return [
          'abc1234 feat: add delivery-check capability (C38)',
          'def5678 fix: correct release check silencing logic',
        ];
      },
    });

    const result = await runProducerCheck(driver, {
      repoName: 'forge',
      sourcePaths: ['src/', 'tests/', 'package.json', 'Dockerfile'],
    });

    expect(result.status).toBe('fail');
    expect(result.artifact).toBe('forge:main');
    expect(result.message).toContain('2 commit(s) ahead of v1.28.9');
    expect(result.message).toContain('source changes on main are not included in any release');
    expect(result.remedy).toBeDefined();
    expect(result.remedy).toContain('new release');
    expect(result.detail).toContain('abc1234');
    expect(result.detail).toContain('def5678');
  });

  it('GREEN: all source changes are included in the latest release tag', async () => {
    const driver = makeDriver({
      async getUnreleasedCommits(_tag, _paths) {
        return []; // nothing ahead — green
      },
    });

    const result = await runProducerCheck(driver, {
      repoName: 'forge',
      sourcePaths: ['src/', 'tests/', 'package.json', 'Dockerfile'],
    });

    expect(result.status).toBe('pass');
    expect(result.artifact).toBe('forge:main');
    expect(result.message).toContain('current');
  });

  it('RED: no release tag exists (first release not yet published)', async () => {
    const driver = makeDriver({
      async getLatestReleaseTag() {
        return null;
      },
    });

    const result = await runProducerCheck(driver, { repoName: 'forge', sourcePaths: [] });

    expect(result.status).toBe('fail');
    expect(result.message).toContain('No release tag found');
    expect(result.remedy).toContain('first release');
  });

  it('silenced: lag accepted via explicit in-repo declaration with reason', async () => {
    const driver = makeDriver({
      async getUnreleasedCommits() {
        return ['abc1234 work-in-progress: C39 started'];
      },
      async readSilences(): Promise<SilenceDeclaration[]> {
        return [
          {
            check: 'producer',
            reason: 'C39 in progress — intentional hold until feature is complete',
          },
        ];
      },
    });

    const result = await runProducerCheck(driver, { repoName: 'forge', sourcePaths: [] });

    expect(result.status).toBe('silenced');
    expect(result.silence_reason).toContain('C39');
    // The message still NAMES the lag — it does not pretend everything is fine
    expect(result.message).toContain('ahead of');
  });

  it('NOT silenced when silence has expired', async () => {
    const driver = makeDriver({
      async getUnreleasedCommits() {
        return ['abc1234 something'];
      },
      async readSilences(): Promise<SilenceDeclaration[]> {
        return [
          {
            check: 'producer',
            reason: 'old hold',
            expires: '2020-01-01', // long past
          },
        ];
      },
    });

    const result = await runProducerCheck(driver, { repoName: 'forge', sourcePaths: [] });
    expect(result.status).toBe('fail');
  });

  it('NOT silenced when silence has no reason', async () => {
    const driver = makeDriver({
      async getUnreleasedCommits() {
        return ['abc1234 something'];
      },
      async readSilences(): Promise<SilenceDeclaration[]> {
        // reason is empty string — invalid; not silenced
        return [{ check: 'producer', reason: '' }];
      },
    });

    const result = await runProducerCheck(driver, { repoName: 'forge', sourcePaths: [] });
    expect(result.status).toBe('fail');
  });
});

// ── Release check ─────────────────────────────────────────────────────────────

describe('release check', () => {
  it('RED: deployed digest does not match the release digest (deployment is behind)', async () => {
    const driver = makeDriver({
      async getTagImageDigest(_image, _tag) {
        return DIGEST_RELEASE;
      },
      async getDeployedDigest(_image) {
        return DIGEST_OLD; // old digest — behind
      },
    });

    const result = await runReleaseCheck(driver, { image: IMAGE, label: 'forge-control-plane' });

    expect(result.status).toBe('fail');
    expect(result.artifact).toBe(IMAGE);
    expect(result.message).toContain('not running the v1.28.9 release digest');
    expect(result.message).toContain('behind');
    expect(result.remedy).toContain('Deploy');
    expect(result.remedy).toContain(DIGEST_RELEASE);
    expect(result.detail).toContain(`expected: ${DIGEST_RELEASE}`);
    expect(result.detail).toContain(`deployed: ${DIGEST_OLD}`);
  });

  it('GREEN: deployed digest matches the release digest', async () => {
    const driver = makeDriver({
      async getTagImageDigest(_image, _tag) {
        return DIGEST_RELEASE;
      },
      async getDeployedDigest(_image) {
        return DIGEST_RELEASE; // matches — green
      },
    });

    const result = await runReleaseCheck(driver, { image: IMAGE, label: 'forge-control-plane' });

    expect(result.status).toBe('pass');
    expect(result.message).toContain('running release v1.28.9');
  });

  it('RED: release image not published (tag exists but image not in GHCR)', async () => {
    const driver = makeDriver({
      async getTagImageDigest(_image, _tag) {
        return null; // not in registry
      },
    });

    const result = await runReleaseCheck(driver, { image: IMAGE, label: 'forge-control-plane' });

    expect(result.status).toBe('fail');
    expect(result.artifact).toBe(`${IMAGE}:v1.28.9`);
    expect(result.message).toContain('not published');
    expect(result.remedy).toContain('publish workflow');
  });

  it('RED: deployed digest not tracked (deployment.json missing)', async () => {
    const driver = makeDriver({
      async getDeployedDigest(_image) {
        return null;
      },
    });

    const result = await runReleaseCheck(driver, { image: IMAGE, label: 'forge-control-plane' });

    expect(result.status).toBe('fail');
    expect(result.message).toContain('not tracked');
    expect(result.remedy).toContain('deployment.json');
  });

  it('silenced: release lag accepted with explicit reason', async () => {
    const driver = makeDriver({
      async getTagImageDigest() {
        return DIGEST_RELEASE;
      },
      async getDeployedDigest() {
        return DIGEST_OLD;
      },
      async readSilences(): Promise<SilenceDeclaration[]> {
        return [{ check: 'release', reason: 'Mac mini OS upgrade in progress' }];
      },
    });

    const result = await runReleaseCheck(driver, { image: IMAGE, label: 'forge-control-plane' });

    expect(result.status).toBe('silenced');
    expect(result.silence_reason).toContain('Mac mini');
  });
});

// ── Consumer check ────────────────────────────────────────────────────────────

describe('consumer check', () => {
  it('RED: consumer pinned to an old version of the producer', async () => {
    const driver = makeDriver();

    const result = await runConsumerCheck(driver, {
      consumerName: 'forge-os',
      producerName: 'forge',
      pinnedVersion: 'v1.27.0',
      latestVersion: 'v1.28.9',
    });

    expect(result.status).toBe('fail');
    expect(result.artifact).toBe('forge-os:forge@v1.27.0');
    expect(result.message).toContain('forge-os is pinned to forge@v1.27.0');
    expect(result.message).toContain('latest release is v1.28.9');
    expect(result.remedy).toContain('Update the forge pin');
    expect(result.remedy).toContain('v1.27.0');
    expect(result.remedy).toContain('v1.28.9');
  });

  it('GREEN: consumer pinned to the latest version', async () => {
    const driver = makeDriver();

    const result = await runConsumerCheck(driver, {
      consumerName: 'forge-os',
      producerName: 'forge',
      pinnedVersion: 'v1.28.9',
      latestVersion: 'v1.28.9',
    });

    expect(result.status).toBe('pass');
    expect(result.message).toContain('current');
  });

  it('silenced: consumer lag accepted with explicit reason', async () => {
    const driver = makeDriver({
      async readSilences(): Promise<SilenceDeclaration[]> {
        return [{ check: 'consumer', reason: 'forge-os adopt in progress, PR #42 open' }];
      },
    });

    const result = await runConsumerCheck(driver, {
      consumerName: 'forge-os',
      producerName: 'forge',
      pinnedVersion: 'v1.27.0',
      latestVersion: 'v1.28.9',
    });

    expect(result.status).toBe('silenced');
    expect(result.silence_reason).toContain('PR #42');
  });
});

// ── Batch runner + formatting ─────────────────────────────────────────────────

describe('batch runner', () => {
  it('ok:false when any check fails; non-zero exit required', async () => {
    const driver = makeDriver({
      async getUnreleasedCommits() {
        return ['abc1234 unreleased change'];
      },
    });

    const batch = await runChecks([
      () => runProducerCheck(driver, { repoName: 'forge', sourcePaths: [] }),
    ]);

    expect(batch.ok).toBe(false);
    expect(batch.failed).toBe(1);
    expect(batch.passed).toBe(0);
  });

  it('ok:true when all checks pass', async () => {
    const driver = makeDriver();

    const batch = await runChecks([
      () => runProducerCheck(driver, { repoName: 'forge', sourcePaths: [] }),
      () =>
        runReleaseCheck(driver, { image: IMAGE, label: 'forge-control-plane' }),
    ]);

    expect(batch.ok).toBe(true);
    expect(batch.failed).toBe(0);
    expect(batch.passed).toBe(2);
  });

  it('ok:true when silenced checks cover all failures (explicit silences)', async () => {
    const driver = makeDriver({
      async getUnreleasedCommits() {
        return ['abc unreleased'];
      },
      async readSilences(): Promise<SilenceDeclaration[]> {
        return [{ check: 'producer', reason: 'intentional hold' }];
      },
    });

    const batch = await runChecks([
      () => runProducerCheck(driver, { repoName: 'forge', sourcePaths: [] }),
    ]);

    // Silenced = acceptable, not a failure.
    expect(batch.ok).toBe(true);
    expect(batch.failed).toBe(0);
    expect(batch.silenced).toBe(1);
  });

  it('mix: some pass some fail → ok:false', async () => {
    const passingDriver = makeDriver();
    const failingDriver = makeDriver({
      async getDeployedDigest() {
        return DIGEST_OLD;
      },
    });

    const batch = await runChecks([
      () => runProducerCheck(passingDriver, { repoName: 'forge', sourcePaths: [] }),
      () => runReleaseCheck(failingDriver, { image: IMAGE, label: 'forge-control-plane' }),
    ]);

    expect(batch.ok).toBe(false);
    expect(batch.passed).toBe(1);
    expect(batch.failed).toBe(1);
  });
});

// ── formatCheckResult ─────────────────────────────────────────────────────────

describe('formatCheckResult', () => {
  it('fail result includes ✗ icon + artifact + remedy arrow', () => {
    const r: CheckResult = {
      check: 'producer',
      status: 'fail',
      artifact: 'forge:main',
      message: 'main is 2 commit(s) ahead of v1.28.9',
      remedy: 'Publish a new release.',
    };
    const out = formatCheckResult(r);
    expect(out).toContain('✗');
    expect(out).toContain('forge:main');
    expect(out).toContain('→ Publish');
  });

  it('pass result includes ✓ icon', () => {
    const r: CheckResult = {
      check: 'producer',
      status: 'pass',
      artifact: 'forge:main',
      message: 'current',
    };
    const out = formatCheckResult(r);
    expect(out).toContain('✓');
    expect(out).not.toContain('→');
  });

  it('silenced result includes ~ icon + silence reason', () => {
    const r: CheckResult = {
      check: 'producer',
      status: 'silenced',
      artifact: 'forge:main',
      message: 'ahead (lag accepted)',
      silence_reason: 'C39 in progress',
    };
    const out = formatCheckResult(r);
    expect(out).toContain('~');
    expect(out).toContain('C39 in progress');
  });
});

describe('formatBatchResult', () => {
  it('reports failure count and fix instruction when ok:false', async () => {
    const driver = makeDriver({
      async getUnreleasedCommits() {
        return ['abc unreleased'];
      },
    });
    const batch = await runChecks([
      () => runProducerCheck(driver, { repoName: 'forge', sourcePaths: [] }),
    ]);
    const out = formatBatchResult(batch);
    expect(out).toContain('1 FAILED');
    expect(out).toContain('Fix the failing checks');
  });

  it('reports all-delivered when ok:true', async () => {
    const driver = makeDriver();
    const batch = await runChecks([
      () => runProducerCheck(driver, { repoName: 'forge', sourcePaths: [] }),
    ]);
    const out = formatBatchResult(batch);
    expect(out).toContain('all hops delivered');
  });
});

// ── Forge's own producer + release check — wired scenarios ───────────────────
//
// These scenarios reconstruct the exact behind-states that would occur in forge's
// own CI (forge:main ahead of newest release / deployment off the release digest)
// and prove the checks go RED, then GREEN once the lag is resolved.

describe("forge's own delivery checks — wired red/green demonstration", () => {
  const FORGE_IMAGE = 'ghcr.io/mardash-ai/forge-control-plane';

  it('PRODUCER RED: forge main is ahead of v1.28.9 (C38 commit not yet released)', async () => {
    // Reconstruct: main has the C38 commit but v1.28.9 was tagged before it.
    const driver = makeDriver({
      async getLatestReleaseTag() {
        return 'v1.28.9';
      },
      async getUnreleasedCommits(_tag, _paths) {
        return [
          'c38aaaa feat: add delivery-check capability (C38)',
          'c38bbbb test: prove delivery-check red/green',
        ];
      },
    });

    const result = await runProducerCheck(driver, {
      repoName: 'forge',
      sourcePaths: ['src/', 'tests/', 'package.json', 'Dockerfile'],
    });

    // Must be RED — naming the exact artifact and remedy
    expect(result.status).toBe('fail');
    expect(result.artifact).toBe('forge:main');
    expect(result.message).toContain('2 commit(s) ahead of v1.28.9');
    expect(result.remedy).toContain('new release');
    expect(result.detail).toContain('c38aaaa');
  });

  it('PRODUCER GREEN: forge main matches v1.29.0 release (C38 is released)', async () => {
    // After release: v1.29.0 tagged, no unreleased source commits.
    const driver = makeDriver({
      async getLatestReleaseTag() {
        return 'v1.29.0';
      },
      async getUnreleasedCommits() {
        return []; // all included in v1.29.0
      },
    });

    const result = await runProducerCheck(driver, {
      repoName: 'forge',
      sourcePaths: ['src/', 'tests/', 'package.json', 'Dockerfile'],
    });

    expect(result.status).toBe('pass');
    expect(result.message).toContain('v1.29.0');
  });

  it('RELEASE RED: forge control-plane is not running v1.29.0 release digest', async () => {
    // Reconstruct: v1.29.0 is tagged and image is published, but Mac mini still runs old digest.
    const RELEASED_DIGEST = 'sha256:' + '9'.repeat(64);
    const RUNNING_DIGEST = 'sha256:' + '0'.repeat(64); // old

    const driver = makeDriver({
      async getLatestReleaseTag() {
        return 'v1.29.0';
      },
      async getTagImageDigest(_image, _tag) {
        return RELEASED_DIGEST;
      },
      async getDeployedDigest(_image) {
        return RUNNING_DIGEST;
      },
    });

    const result = await runReleaseCheck(driver, {
      image: FORGE_IMAGE,
      label: 'forge-control-plane',
    });

    expect(result.status).toBe('fail');
    expect(result.artifact).toBe(FORGE_IMAGE);
    expect(result.message).toContain('not running the v1.29.0 release digest');
    expect(result.remedy).toContain(RELEASED_DIGEST);
    expect(result.detail).toContain(`expected: ${RELEASED_DIGEST}`);
    expect(result.detail).toContain(`deployed: ${RUNNING_DIGEST}`);
  });

  it('RELEASE GREEN: forge control-plane is running v1.29.0 release digest', async () => {
    // After deploy: deployment.json updated with v1.29.0 digest.
    const RELEASED_DIGEST = 'sha256:' + '9'.repeat(64);

    const driver = makeDriver({
      async getLatestReleaseTag() {
        return 'v1.29.0';
      },
      async getTagImageDigest(_image, _tag) {
        return RELEASED_DIGEST;
      },
      async getDeployedDigest(_image) {
        return RELEASED_DIGEST; // matches — green
      },
    });

    const result = await runReleaseCheck(driver, {
      image: FORGE_IMAGE,
      label: 'forge-control-plane',
    });

    expect(result.status).toBe('pass');
    expect(result.message).toContain('running release v1.29.0');
  });

  it('BATCH RED: both forge checks failing together (no release of C38 AND deploy behind)', async () => {
    const RELEASED_DIGEST = 'sha256:' + '9'.repeat(64);
    const RUNNING_DIGEST = 'sha256:' + '0'.repeat(64);

    const driver = makeDriver({
      async getLatestReleaseTag() {
        return 'v1.28.9';
      },
      async getUnreleasedCommits() {
        return ['c38aaaa feat: C38 delivery-check capability'];
      },
      async getTagImageDigest() {
        return RELEASED_DIGEST;
      },
      async getDeployedDigest() {
        return RUNNING_DIGEST;
      },
    });

    const batch = await runChecks([
      () =>
        runProducerCheck(driver, {
          repoName: 'forge',
          sourcePaths: ['src/', 'tests/', 'package.json', 'Dockerfile'],
        }),
      () => runReleaseCheck(driver, { image: FORGE_IMAGE, label: 'forge-control-plane' }),
    ]);

    expect(batch.ok).toBe(false);
    expect(batch.failed).toBe(2);

    const formatted = formatBatchResult(batch);
    // Both failures are visible in the output — no check scrolled past silently
    expect(formatted).toContain('forge:main');
    expect(formatted).toContain(FORGE_IMAGE);
    expect(formatted).toContain('2 FAILED');
  });

  it('BATCH GREEN: both forge checks passing after release + deploy', async () => {
    const RELEASED_DIGEST = 'sha256:' + '9'.repeat(64);

    const driver = makeDriver({
      async getLatestReleaseTag() {
        return 'v1.29.0';
      },
      async getUnreleasedCommits() {
        return [];
      },
      async getTagImageDigest() {
        return RELEASED_DIGEST;
      },
      async getDeployedDigest() {
        return RELEASED_DIGEST;
      },
    });

    const batch = await runChecks([
      () =>
        runProducerCheck(driver, {
          repoName: 'forge',
          sourcePaths: ['src/', 'tests/', 'package.json', 'Dockerfile'],
        }),
      () => runReleaseCheck(driver, { image: FORGE_IMAGE, label: 'forge-control-plane' }),
    ]);

    expect(batch.ok).toBe(true);
    expect(batch.failed).toBe(0);
    expect(batch.passed).toBe(2);

    const formatted = formatBatchResult(batch);
    expect(formatted).toContain('all hops delivered');
  });
});
