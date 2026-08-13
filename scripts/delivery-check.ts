#!/usr/bin/env tsx
// Forge delivery-check CI runner (C38).
// Runs the requested delivery checks and exits 1 if any check fails (unsilenced).
//
// Usage:
//   npx tsx scripts/delivery-check.ts <check>...
//
// Checks:
//   producer   — main carries source changes not in any release tag → fail
//   release    — deployed image is not running the latest release digest → fail
//   consumer   — consumer pinned version lags producer's latest release → fail
//
// Example (forge's own CI wiring):
//   npx tsx scripts/delivery-check.ts producer release
//
// Environment variables:
//   FORGE_PRODUCER_REPO_NAME   — label for the repo (default: "forge")
//   FORGE_PRODUCER_SOURCE_PATHS— comma-separated paths (default: src/,tests/,package.json,Dockerfile)
//   FORGE_CP_IMAGE             — control-plane image name (default: from git remote)
//   FORGE_CP_IMAGE_LABEL       — label for messages (default: basename of image)
//   FORGE_DEPLOYED_DIGEST      — sha256:... of the currently deployed image (overrides deployment.json)
//   FORGE_CONSUMER_NAME        — for consumer check: the consumer name
//   FORGE_CONSUMER_PRODUCER    — for consumer check: the producer name
//   FORGE_CONSUMER_PINNED      — for consumer check: the pinned version
//   FORGE_CONSUMER_LATEST      — for consumer check: the latest version
//
// A lag is silenced ONLY by a `.delivery-silence.json` in the repo with a reason field.
// There is no default silencing.

import path from 'node:path';
import {
  runProducerCheck,
  runReleaseCheck,
  runConsumerCheck,
  runChecks,
  formatBatchResult,
  type CheckResult,
} from '../src/plugins/delivery-check/index';
import { createRealDriver } from '../src/plugins/delivery-check/real-driver';

function usage(): never {
  console.error('Usage: npx tsx scripts/delivery-check.ts <check>...');
  console.error('Checks: producer, release, consumer');
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const checks = args.filter((a) => ['producer', 'release', 'consumer'].includes(a));
  if (checks.length === 0) usage();

  const repoRoot = process.cwd();
  const driver = createRealDriver(repoRoot);

  const repoName = process.env['FORGE_PRODUCER_REPO_NAME'] ?? 'forge';
  const rawPaths = process.env['FORGE_PRODUCER_SOURCE_PATHS'];
  const sourcePaths = rawPaths
    ? rawPaths.split(',').map((p) => p.trim()).filter(Boolean)
    : ['src/', 'tests/', 'package.json', 'Dockerfile'];

  // Resolve the control-plane image name from env or git remote.
  let cpImage = process.env['FORGE_CP_IMAGE'];
  if (!cpImage) {
    // Best-effort: derive from git remote origin (github.com/owner/repo → ghcr.io/owner/...)
    const { run } = await import('../src/shared/exec');
    const remoteResult = await run('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      timeoutMs: 10_000,
    });
    const remoteUrl = remoteResult.code === 0 ? remoteResult.combined.trim() : '';
    const m = remoteUrl.match(/github\.com[:/]([^/]+)\//);
    const owner = m?.[1] ?? 'mardash-ai';
    cpImage = `ghcr.io/${owner}/forge-control-plane`;
  }
  const cpImageLabel = process.env['FORGE_CP_IMAGE_LABEL'] ?? path.basename(cpImage);

  const checkFns: Array<() => Promise<CheckResult>> = [];

  if (checks.includes('producer')) {
    checkFns.push(() =>
      runProducerCheck(driver, { repoName, sourcePaths }),
    );
  }

  if (checks.includes('release')) {
    checkFns.push(() =>
      runReleaseCheck(driver, { image: cpImage!, label: cpImageLabel }),
    );
  }

  if (checks.includes('consumer')) {
    const consumerName = process.env['FORGE_CONSUMER_NAME'];
    const producerName = process.env['FORGE_CONSUMER_PRODUCER'];
    const pinnedVersion = process.env['FORGE_CONSUMER_PINNED'];
    const latestVersion = process.env['FORGE_CONSUMER_LATEST'];
    if (!consumerName || !producerName || !pinnedVersion || !latestVersion) {
      console.error(
        'consumer check requires FORGE_CONSUMER_NAME, FORGE_CONSUMER_PRODUCER, ' +
          'FORGE_CONSUMER_PINNED, and FORGE_CONSUMER_LATEST environment variables.',
      );
      process.exit(2);
    }
    checkFns.push(() =>
      runConsumerCheck(driver, { consumerName, producerName, pinnedVersion, latestVersion }),
    );
  }

  const batch = await runChecks(checkFns);
  const output = formatBatchResult(batch);
  console.log(output);

  if (!batch.ok) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('delivery-check: unexpected error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
