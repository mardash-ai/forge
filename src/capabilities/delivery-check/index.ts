// Delivery-Check Capability (C38) — guards all four hops in the delivery pipeline:
//   commit→tag  (producer check)
//   tag→image   (release check, hop 1: was the image published?)
//   image→run   (release check, hop 2: is the deployed service on the release digest?)
//   release→pin (consumer check: is the consumer's pin current?)
//
// Every failing check exits non-zero, names the exact artifact that is behind, and
// states the concrete remedy. A lag is silenced ONLY by an explicit `.delivery-silence.json`
// in the repo carrying a reason; there is no default silencing. The overall `ok` field on
// the DeliveryCheckRun resource is the CI gate.

import { z } from 'zod';
import path from 'node:path';
import type { Capability } from '../../core/types';
import type { DeliveryCheckRun, DeliveryCheckResult } from '../../resources/types';
import { baseResource } from '../_shared';
import { nowIso } from '../../shared/time';
import {
  runProducerCheck,
  runReleaseCheck,
  runConsumerCheck,
  runChecks,
  type CheckResult,
  type ConsumerCheckOpts,
} from '../../plugins/delivery-check/index';
import { createRealDriver } from '../../plugins/delivery-check/real-driver';

const consumerSchema = z.object({
  consumer_name: z.string().min(1),
  producer_name: z.string().min(1),
  pinned_version: z.string().min(1),
  latest_version: z.string().min(1),
});

const inputSchema = z.object({
  // Which checks to run. Defaults to all three.
  checks: z.array(z.enum(['producer', 'release', 'consumer'])).default(['producer', 'release', 'consumer']),
  // -- Producer check options --
  // Human label for the git repo in messages (e.g. "forge").
  repo_name: z.string().default('forge'),
  // Paths that count as source changes; empty = all paths.
  source_paths: z.array(z.string()).default(['src/', 'tests/', 'package.json', 'Dockerfile']),
  // -- Release check options --
  // Fully-qualified image name without tag (e.g. "ghcr.io/mardash-ai/forge-control-plane").
  image: z.string().optional(),
  // Human label for the image in messages.
  image_label: z.string().optional(),
  // -- Consumer check options --
  // List of consumer→producer version pins to check.
  consumers: z.array(consumerSchema).default([]),
  // -- Common --
  // Absolute path to the repo root. Defaults to process.cwd().
  repo_root: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

// Map the plugin's CheckResult to the resource's DeliveryCheckResult (same shape, typed separately).
function toResourceResult(r: CheckResult): DeliveryCheckResult {
  return {
    check: r.check,
    status: r.status,
    artifact: r.artifact,
    message: r.message,
    ...(r.remedy !== undefined ? { remedy: r.remedy } : {}),
    ...(r.silence_reason !== undefined ? { silence_reason: r.silence_reason } : {}),
    ...(r.pending_reason !== undefined ? { pending_reason: r.pending_reason } : {}),
    ...(r.detail !== undefined ? { detail: r.detail } : {}),
  };
}

export const deliveryCheck: Capability<Input, DeliveryCheckRun> = {
  name: 'DeliveryCheck',
  slug: 'delivery-check',
  description:
    'Guard every hop of the delivery pipeline (commit→tag→image→deploy→consumer-pin). ' +
    'Each failing check exits non-zero and names the specific artifact behind with a concrete remedy. ' +
    'Silence requires an explicit in-repo declaration with a reason.',
  inputSchema,
  resourceType: 'DeliveryCheckRun',
  events: ['DeliveryCheckCompleted', 'DeliveryCheckFailed'],
  longRunning: false,
  requiresDocker: false,
  plane: 'control',

  async execute(input, ctx) {
    const started = Date.now();
    const repoRoot = input.repo_root ?? process.cwd();
    const driver = createRealDriver(repoRoot);

    const checksToRun: Array<() => Promise<CheckResult>> = [];

    if (input.checks.includes('producer')) {
      checksToRun.push(() =>
        runProducerCheck(driver, {
          repoName: input.repo_name,
          sourcePaths: input.source_paths,
        }),
      );
    }

    if (input.checks.includes('release')) {
      const image =
        input.image ?? `ghcr.io/${process.env['GITHUB_REPOSITORY_OWNER'] ?? 'unknown'}/forge-control-plane`;
      const label = input.image_label ?? path.basename(image);
      checksToRun.push(() => runReleaseCheck(driver, { image, label }));
    }

    for (const c of input.consumers) {
      if (input.checks.includes('consumer')) {
        const opts: ConsumerCheckOpts = {
          consumerName: c.consumer_name,
          producerName: c.producer_name,
          pinnedVersion: c.pinned_version,
          latestVersion: c.latest_version,
        };
        checksToRun.push(() => runConsumerCheck(driver, opts));
      }
    }

    const batch = await runChecks(checksToRun);

    const resource: DeliveryCheckRun = {
      ...baseResource('DeliveryCheckRun'),
      type: 'DeliveryCheckRun',
      checks_requested: input.checks,
      ok: batch.ok,
      passed: batch.passed,
      failed: batch.failed,
      silenced: batch.silenced,
      pending: batch.pending,
      results: batch.results.map(toResourceResult),
      duration_ms: Date.now() - started,
      updated_at: nowIso(),
    };

    await ctx.store.saveResource(resource);

    await ctx.emit({
      type: batch.ok ? 'DeliveryCheckCompleted' : 'DeliveryCheckFailed',
      resource_type: 'DeliveryCheckRun',
      resource_id: resource.id,
      data: {
        ok: batch.ok,
        passed: batch.passed,
        failed: batch.failed,
        silenced: batch.silenced,
        checks: input.checks,
      },
    });

    return resource;
  },
};
