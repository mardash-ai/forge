import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Capability } from '../../core/types';
import type { Release, ReleasePhaseRecord, Deployment, ProductionArtifacts, Verification } from '../../resources/types';
import { appRefInput, resolveAppLenient, baseResource } from '../_shared';
import { productionize } from '../productionize/index';
import { deployCapability } from '../deploy/index';
import { verify } from '../verify/index';
import { workspaceDir } from '../../shared/paths';
import { nowIso } from '../../shared/time';
import { run } from '../../shared/exec';
import {
  IMPLEMENTATION,
  runRelease,
  ReleaseError,
  targetImageRef,
  gitHeadCommit,
  gitWorkingTreeClean,
  gitRemoteOwner,
  dockerRunner,
  resolveDigest,
  waitForDigest,
  buildAndPush,
  type ReleaseExecutor,
  type Observed,
  type ReleaseOutcome,
} from '../../plugins/release-orchestrator/index';

const inputSchema = z.object({
  ...appRefInput,
  // Public host for the post-deploy verify gate. Recovered from the app's persisted
  // production config (`forge productionize --host`) when omitted.
  host: z.string().optional(),
  // How the commit's web image reaches GHCR:
  //   'ci'    — the app's publish workflow builds it on push; release WAITS for it (default).
  //   'build' — release builds+pushes a multi-arch image itself (needs buildx + a registry login).
  publish_mode: z.enum(['ci', 'build']).default('ci'),
  // Assess + report the plan without mutating anything (no publish/repin/deploy/verify).
  dry_run: z.boolean().default(false),
  // GHCR poll budget + interval for CI mode (seconds).
  timeout_seconds: z.number().int().positive().default(600),
  poll_interval_seconds: z.number().int().positive().default(10),
  // The commit to release (defaults to the app repo's HEAD).
  commit: z.string().optional(),
  // Overrides for building the image ref when a full --image-ref isn't given. The default
  // ref is `ghcr.io/<owner>/<app>-app:sha-<commit>` (the C18 convention).
  image_ref: z.string().optional(),
  owner: z.string().optional(),
  registry: z.string().optional(),
  image_suffix: z.string().optional(),
  // Deploy passthrough (C7).
  context: z.string().optional(),
  service: z.string().optional(),
  compose_file: z.string().optional(),
  env_file: z.string().optional(),
  // Release an uncommitted working tree (normally refused for reproducibility).
  allow_dirty: z.boolean().default(false),
  // Verify passthrough (C14).
  page_path: z.string().optional(),
  health_path: z.string().optional(),
  api_paths: z.array(z.string()).optional(),
  cron_path: z.string().optional(),
  expect_google: z.boolean().optional(),
  expect_email: z.boolean().optional(),
  expect_password_signup: z.boolean().optional(),
  check_refresh: z.boolean().optional(),
  verify_timeout_ms: z.number().int().positive().optional(),
});
type Input = z.infer<typeof inputSchema>;

const DEFAULT_COMPOSE = 'app/compose.prod.yaml';

// Read the app's persisted production config (forge.app.json `production`) — the current
// web-image pin + host, so a re-run can SKIP a repin that already matches and verify can
// recover the host without a flag.
async function readProduction(repo: string): Promise<{ web_image?: string; host?: string }> {
  try {
    const manifest = JSON.parse(await readFile(path.join(repo, 'forge.app.json'), 'utf8')) as {
      production?: { web_image?: string; host?: string };
    };
    return { web_image: manifest.production?.web_image, host: manifest.production?.host };
  } catch {
    return {};
  }
}

// Release (C18) — the capstone command. One atomic, idempotent, fail-safe operation that takes
// a committed app to DEPLOYED + VERIFIED: it publishes/awaits the commit's web image in GHCR,
// resolves its digest, repins compose via Productionize (C8), rolls the stack via Deploy (C7,
// with the P14 drift gate), and gates on Verify (C14). Long-running: the request blocks until
// the pipeline resolves and returns the Release Resource. The orchestration (fail-safe abort +
// idempotent resume) lives in the release-orchestrator Implementation; this Capability wires the
// REAL executor (git/docker + the reused C7/C8/C14 capabilities) to that runner.
export const releaseCapability: Capability<Input, Release> = {
  name: 'Release',
  slug: 'release',
  description:
    'Run the full production deploy pipeline end-to-end, idempotently and fail-safe: publish/await the commit’s image, repin (C8), deploy (C7 + P14 drift gate), verify (C14). Resumable after a partial failure; leaves prod on the last-good version on any error.',
  inputSchema,
  resourceType: 'Release',
  events: ['ReleaseStarted', 'ReleaseCompleted', 'ReleaseFailed'],
  longRunning: true,
  requiresDocker: true,
  plane: 'control',
  async execute(input, ctx) {
    // Resolve the target the SAME lenient way `forge deploy` does — a store-registered
    // Application is optional on a prod host, inferred from the single-app layout +
    // `app/forge.app.json` when the store lacks it (P19). Assess must never require a box-side
    // `forge init app`; the repin/verify phases it composes resolve the same way (below).
    const app = await resolveAppLenient(ctx.store, input.app);
    const repo = app.repo_path;
    const docker = dockerRunner(input.context);
    const composeFile = input.compose_file ?? DEFAULT_COMPOSE;

    const resource: Release = {
      ...baseResource('Release', app.id),
      type: 'Release',
      status: 'failed', // pessimistic until the pipeline reports success
      app: app.name,
      commit: input.commit ?? '',
      image_ref: input.image_ref ?? '',
      host: input.host,
      publish_mode: input.publish_mode,
      dry_run: input.dry_run,
      implementation: IMPLEMENTATION,
      phases: [],
      duration_ms: 0,
    };
    const started = Date.now();

    await ctx.emit({
      type: 'ReleaseStarted',
      resource_type: 'Release',
      resource_id: resource.id,
      app_id: app.id,
      data: { app: app.name, publish_mode: input.publish_mode, dry_run: input.dry_run },
    });

    // The REAL executor: shells out via the git/GHCR/docker adapters and REUSES the C7 Deploy /
    // C8 Productionize / C14 Verify capabilities in-process (executeCapability runs the same
    // validate→policy→execute path the CLI hits — no reimplementation of any of them).
    const exec: ReleaseExecutor = {
      async assess(): Promise<Observed> {
        // Commit: explicit --commit, else the repo's HEAD.
        const commit = (input.commit ?? (await gitHeadCommit(repo)))?.trim();
        if (!commit) {
          throw new Error('could not resolve the commit to release — pass --commit <sha>, or run inside a git repo (is git available?)');
        }
        // Working-tree cleanliness only gates when we did NOT get an explicit commit (an
        // explicit --commit means the caller pinned exactly what to ship).
        const workingTreeClean = input.commit ? undefined : await gitWorkingTreeClean(repo);

        // Image ref: explicit --image-ref, else ghcr.io/<owner>/<app>-app:sha-<commit>.
        let imageRef = input.image_ref?.trim();
        if (!imageRef) {
          const owner = (input.owner ?? (await gitRemoteOwner(repo)))?.trim();
          if (!owner) {
            throw new Error('could not resolve the GHCR owner — pass --owner <org>, or --image-ref <full ref>, or set the repo’s origin remote');
          }
          imageRef = targetImageRef({ registry: input.registry, owner, app: app.name, commit, suffix: input.image_suffix });
        }

        const prod = await readProduction(repo);
        const publishedDigest = await resolveDigest(docker, imageRef); // best-effort probe
        return {
          commit,
          workingTreeClean,
          imageRef,
          publishedDigest,
          currentPin: prod.web_image,
          host: input.host ?? prod.host,
        };
      },

      async publish(imageRef, observed): Promise<string> {
        if (input.publish_mode === 'build') {
          return buildAndPush(docker, { repo, ref: imageRef, dockerfile: path.join(repo, 'Dockerfile') });
        }
        return waitForDigest(docker, imageRef, {
          timeoutMs: input.timeout_seconds * 1000,
          intervalMs: input.poll_interval_seconds * 1000,
        });
      },

      async isDeployCurrent(targetPin): Promise<boolean> {
        // Best-effort: is the running web container already on the target pin's exact image?
        // Compared by LOCAL image id — the same identity the P14 drift gate uses. Any error →
        // false (deploy runs; it is idempotent, so this only ever costs a safe reconcile).
        try {
          const cwd = workspaceDir();
          const pin = await run('docker', ['image', 'inspect', targetPin, '--format', '{{.Id}}'], { cwd, timeoutMs: 30_000 });
          const pinnedId = pin.code === 0 ? pin.combined.trim().split('\n')[0]?.trim() : '';
          if (!pinnedId) return false;
          const ctxArgs = input.context ? ['--context', input.context] : [];
          const ps = await run('docker', [...ctxArgs, 'compose', '-f', composeFile, 'ps', '-q', 'web'], { cwd, timeoutMs: 30_000 });
          const cid = ps.code === 0 ? ps.combined.trim().split('\n')[0]?.trim() : '';
          if (!cid) return false;
          const insp = await run('docker', [...ctxArgs, 'inspect', cid, '--format', '{{.Image}}'], { cwd, timeoutMs: 30_000 });
          const runId = insp.code === 0 ? insp.combined.trim().split('\n')[0]?.trim() : '';
          return Boolean(runId && runId === pinnedId);
        } catch {
          return false;
        }
      },

      async repin(targetPin): Promise<string> {
        // C8 — reuse the Productionize execute directly (its own inputSchema applies defaults +
        // validation). Keep the data-plane pin: omitting the flag makes converge recover the
        // persisted one. Shares release's ctx (store/emit/actor) — no re-dispatch, no cycle.
        const pa = (await productionize.execute(
          productionize.inputSchema.parse({ app: app.name, web_image: targetPin }),
          ctx,
        )) as ProductionArtifacts;
        return `productionize → compose pinned web_image=${pa.web_image}`;
      },

      async deploy() {
        // C7 — start-first roll + P14 drift gate.
        const d = (await deployCapability.execute(
          deployCapability.inputSchema.parse({
            app: app.name,
            ...(input.context ? { context: input.context } : {}),
            ...(input.service ? { service: input.service } : {}),
            ...(input.compose_file ? { compose_file: input.compose_file } : {}),
            ...(input.env_file ? { env_file: input.env_file } : {}),
          }),
          ctx,
        )) as Deployment;
        return { id: d.id, status: d.status === 'succeeded' ? 'succeeded' : 'failed', error: d.error_summary };
      },

      async verify(host) {
        // C14 — post-deploy contract smoke.
        const v = (await verify.execute(
          verify.inputSchema.parse({
            app: app.name,
            host,
            ...(input.page_path ? { page_path: input.page_path } : {}),
            ...(input.health_path ? { health_path: input.health_path } : {}),
            ...(input.api_paths ? { api_paths: input.api_paths } : {}),
            ...(input.cron_path ? { cron_path: input.cron_path } : {}),
            ...(input.expect_google !== undefined ? { expect_google: input.expect_google } : {}),
            ...(input.expect_email !== undefined ? { expect_email: input.expect_email } : {}),
            ...(input.expect_password_signup !== undefined ? { expect_password_signup: input.expect_password_signup } : {}),
            ...(input.check_refresh !== undefined ? { check_refresh: input.check_refresh } : {}),
            ...(input.verify_timeout_ms ? { timeout_ms: input.verify_timeout_ms } : {}),
          }),
          ctx,
        )) as Verification;
        return { id: v.id, passed: v.passed, summary: v.summary };
      },
    };

    // Drive the pipeline. runRelease throws ReleaseError at the first failing phase (prod left
    // on the last-good version); anything else is an unexpected fault — recorded the same way.
    try {
      const outcome: ReleaseOutcome = await runRelease(
        exec,
        { publishMode: input.publish_mode, dryRun: input.dry_run, allowDirty: input.allow_dirty, host: input.host },
      );
      resource.status = 'succeeded';
      resource.commit = outcome.commit;
      resource.image_ref = outcome.image_ref;
      resource.web_image_pin = outcome.web_image_pin;
      resource.host = outcome.host;
      resource.phases = outcome.phases as ReleasePhaseRecord[];
      resource.deployment_id = outcome.deployment_id;
      resource.verification_id = outcome.verification_id;
    } catch (err) {
      if (err instanceof ReleaseError) {
        resource.status = 'failed';
        resource.failed_phase = err.phase;
        resource.error_summary = err.message;
        resource.phases = err.phases as ReleasePhaseRecord[];
        // Preserve what assess learned (image ref / commit) if it got that far.
        const assessed = err.phases.find((p) => p.phase === 'assess' && p.status === 'ran');
        if (assessed) {
          const m = assessed.detail.match(/image (\S+)/);
          if (m && m[1] && !resource.image_ref) resource.image_ref = m[1];
        }
      } else {
        resource.status = 'failed';
        resource.error_summary = err instanceof Error ? err.message : String(err);
        resource.phases = [{ phase: 'assess', status: 'failed', detail: resource.error_summary, duration_ms: 0 }];
      }
    }

    resource.duration_ms = Date.now() - started;
    resource.updated_at = nowIso();
    await ctx.store.saveResource(resource);

    await ctx.emit({
      type: resource.status === 'succeeded' ? 'ReleaseCompleted' : 'ReleaseFailed',
      resource_type: 'Release',
      resource_id: resource.id,
      app_id: app.id,
      data:
        resource.status === 'succeeded'
          ? { commit: resource.commit, web_image_pin: resource.web_image_pin, deployment_id: resource.deployment_id, dry_run: resource.dry_run }
          : { failed_phase: resource.failed_phase, error_summary: resource.error_summary },
    });

    return resource;
  },
};
