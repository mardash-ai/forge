import { z } from 'zod';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Capability } from '../../core/types';
import type { ProductionArtifacts } from '../../resources/types';
import { appRefInput, resolveApp, baseResource } from '../_shared';
import { parseComposeInfra, type PrevInfra } from '../provision-environment/converge';
import {
  IMPLEMENTATION,
  JOBS_FILE,
  generateProdDockerfile,
  generateProdDockerignore,
  generateProdCompose,
  generateEnvProdExample,
  applyStandaloneOutput,
  defaultNextConfig,
} from '../../plugins/productionize-nextjs-compose/index';
import { convergeProduction, type PrevProduction } from './converge';

const inputSchema = z.object({
  ...appRefInput,
  // Public host for the Traefik router (required first run; remembered after).
  host: z.string().optional(),
  // App readiness path Traefik + the container healthcheck probe.
  readiness_path: z.string().optional(),
  // Digest-pinned image refs (R1). web is app-specific; data-plane defaults from
  // FORGE_DATA_PLANE_IMAGE when unset.
  web_image: z.string().optional(),
  data_plane_image: z.string().optional(),
  // Traefik TLS cert resolver name (deployment-specific; default "letsencrypt").
  cert_resolver: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

// Next config filenames we recognize, in preference order.
const NEXT_CONFIG_FILES = ['next.config.mjs', 'next.config.js', 'next.config.ts'];

// Productionize — generate the app's CANONICAL production artifacts (the Next
// standalone Dockerfile + .dockerignore, `output:'standalone'` in the Next config,
// compose.prod.yaml, and .env.prod.example). Control-plane orchestration: it EMITS
// files (like `provision` generates the dev compose.yaml); nothing new runs in prod.
// The compose it writes is exactly what `forge deploy` (C7) rolls. Idempotent +
// convergent: a re-run reproduces the same bytes and never clobbers a hand value it
// doesn't own; images are digest-pinned (R1).
export const productionize: Capability<Input, ProductionArtifacts> = {
  name: 'Productionize',
  slug: 'productionize',
  description:
    'Generate the app’s canonical production artifacts (standalone Dockerfile, compose.prod.yaml with Traefik/data-plane/DB, .env.prod.example); idempotent and digest-pinned.',
  inputSchema,
  resourceType: 'ProductionArtifacts',
  events: ['ProductionArtifactsGenerated'],
  longRunning: false,
  requiresDocker: false,
  plane: 'control',
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);
    const repo = app.repo_path;
    const manifestPath = path.join(repo, 'forge.app.json');

    // Load the manifest — the source of truth we converge from (infra + prior production).
    let manifest: Record<string, unknown> = {};
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      /* no manifest yet — treated as a fresh app */
    }
    const appPort = typeof manifest.port === 'number' ? manifest.port : 3000;

    // Recover the declared infra: prefer the persisted `infra` (P1), else infer it
    // from the existing dev compose.yaml (apps provisioned before that block existed).
    let infra = (manifest.infra ?? null) as PrevInfra | null;
    if (!infra) {
      let devCompose = '';
      try {
        devCompose = await readFile(path.join(repo, 'compose.yaml'), 'utf8');
      } catch {
        /* not provisioned yet — prod stack is web + data-plane only */
      }
      infra = parseComposeInfra(devCompose, appPort);
    }

    // Converge the desired production config (throws 422 on missing/invalid inputs).
    const prevProd = (manifest.production ?? {}) as PrevProduction;
    const cfg = convergeProduction(prevProd, {
      host: input.host,
      readiness_path: input.readiness_path,
      web_image: input.web_image,
      data_plane_image: input.data_plane_image,
      cert_resolver: input.cert_resolver,
      data_plane_image_env: process.env.FORGE_DATA_PLANE_IMAGE,
    });

    const withPostgres = Boolean(infra.postgres);
    const withRedis = Boolean(infra.redis);
    const secrets = Array.isArray(infra.secrets) ? infra.secrets : [];
    // The app declares scheduled jobs (C2) by committing a `forge.jobs.json` at the
    // repo root — the same file the data-plane reads to auto-register on boot. When
    // present, the generated compose mounts it into the sidecar (P7.3).
    const withJobs = Boolean(await firstExisting(repo, [JOBS_FILE]));

    // 1. Standalone Dockerfile + .dockerignore (deterministic — re-run = identical bytes).
    await writeFile(path.join(repo, 'Dockerfile'), generateProdDockerfile({ appName: app.name, port: appPort }));
    await writeFile(path.join(repo, '.dockerignore'), generateProdDockerignore());

    // 2. Ensure `output: 'standalone'` in the Next config (idempotent; never clobbers
    //    a hand-set output). Create a config when the app has none.
    let nextConfigAction: string;
    const found = await firstExisting(repo, NEXT_CONFIG_FILES);
    if (found) {
      const patch = applyStandaloneOutput(await readFile(path.join(repo, found), 'utf8'));
      if (patch.changed) await writeFile(path.join(repo, found), patch.content);
      nextConfigAction = `${found}:${patch.action}`;
      if (patch.warning) nextConfigAction += ` (${patch.warning})`;
    } else {
      await writeFile(path.join(repo, 'next.config.mjs'), defaultNextConfig());
      nextConfigAction = 'next.config.mjs:created';
    }

    // 3. compose.prod.yaml — derived from infra + host + the digest-pinned images.
    await writeFile(
      path.join(repo, 'compose.prod.yaml'),
      generateProdCompose({
        appName: app.name,
        port: appPort,
        host: cfg.host,
        readinessPath: cfg.readiness_path,
        webImage: cfg.web_image,
        dataPlaneImage: cfg.data_plane_image,
        withPostgres,
        withRedis,
        secrets,
        certResolver: cfg.cert_resolver,
        withJobs,
      }),
    );

    // 4. .env.prod.example — documents .env.prod (never a real value).
    await writeFile(
      path.join(repo, '.env.prod.example'),
      generateEnvProdExample({ appName: app.name, host: cfg.host, withPostgres, withRedis, secrets, withJobs }),
    );

    // Persist the converged production config so a flag-less re-run reproduces it.
    manifest.production = cfg;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    const services = ['web', 'data-plane', ...(withPostgres ? ['postgres'] : []), ...(withRedis ? ['redis'] : [])];
    const files = ['Dockerfile', '.dockerignore', 'compose.prod.yaml', '.env.prod.example', found ?? 'next.config.mjs'];

    const resource: ProductionArtifacts = {
      ...baseResource('ProductionArtifacts', app.id),
      type: 'ProductionArtifacts',
      status: 'generated',
      host: cfg.host,
      readiness_path: cfg.readiness_path,
      web_image: cfg.web_image,
      data_plane_image: cfg.data_plane_image,
      services,
      files,
      compose_file: path.join(repo, 'compose.prod.yaml'),
    };
    await ctx.store.saveResource(resource);

    await ctx.emit({
      type: 'ProductionArtifactsGenerated',
      resource_type: 'ProductionArtifacts',
      resource_id: resource.id,
      app_id: app.id,
      data: {
        host: cfg.host,
        services,
        readiness_path: cfg.readiness_path,
        next_config: nextConfigAction,
        implementation: IMPLEMENTATION,
      },
    });

    return resource;
  },
};

// Return the first of `names` that exists under `dir`, else undefined.
async function firstExisting(dir: string, names: string[]): Promise<string | undefined> {
  const { stat } = await import('node:fs/promises');
  for (const name of names) {
    try {
      await stat(path.join(dir, name));
      return name;
    } catch {
      /* try the next */
    }
  }
  return undefined;
}
