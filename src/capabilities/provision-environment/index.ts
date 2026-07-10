import { z } from 'zod';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Capability } from '../../core/types';
import type { Environment } from '../../resources/types';
import { appRefInput, resolveApp, baseResource } from '../_shared';
import { generateCompose, IMPLEMENTATION } from '../../plugins/runtime-docker-compose/index';
import { convergeInfra, parseComposeInfra, type PrevInfra } from './converge';

const inputSchema = z.object({
  ...appRefInput,
  with_postgres: z.boolean().default(false),
  with_redis: z.boolean().default(false),
  // Explicit removals — additive-by-default means nothing is dropped otherwise.
  without_postgres: z.boolean().default(false),
  without_redis: z.boolean().default(false),
  // Host-port overrides (container ports are fixed). Coerced: the CLI sends strings.
  postgres_port: z.coerce.number().int().positive().optional(),
  redis_port: z.coerce.number().int().positive().optional(),
  web_port: z.coerce.number().int().positive().optional(),
  // Allow dropping a service that owns a data volume (e.g. Postgres).
  force: z.boolean().default(false),
  // Secret names the app needs available in its runtime (e.g. ANTHROPIC_API_KEY).
  // Additive: merged with what's already declared. Forge injects the values from
  // its encrypted store at run time; they never appear in the generated compose.
  secrets: z.array(z.string()).default([]),
  // P26 — where Forge's OWN platform state (C10 identity, …) lives: 'filesystem' (default) or
  // 'postgres' (a separate forge_platform database the sidecar dials via FORGE_DB_URL). Remembered in
  // the manifest so `productionize` wires the sidecar + compose. Carried forward convergently.
  platform_store: z.enum(['filesystem', 'postgres']).optional(),
});

type Input = z.infer<typeof inputSchema>;

// ProvisionEnvironment — generate a consistent, runnable Docker environment for
// an Application. It CONVERGES the desired environment from what's declared in
// forge.app.json (plus this call's flags), so a re-provision reproduces the env
// rather than replacing it from flags — a flag-less re-provision never silently
// drops a service or resets a host-port remap (see P1).
export const provisionEnvironment: Capability<Input, Environment> = {
  name: 'ProvisionEnvironment',
  slug: 'provision-environment',
  description: 'Converge a Docker Compose environment (web + optional postgres/redis) for an Application; idempotent and non-destructive.',
  inputSchema,
  resourceType: 'Environment',
  events: ['EnvironmentProvisioned'],
  longRunning: false,
  requiresDocker: false,
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);
    const manifestPath = path.join(app.repo_path, 'forge.app.json');
    const composeFile = path.join(app.repo_path, 'compose.yaml');

    // Load the manifest — the source of truth we converge from.
    let manifest: Record<string, unknown> = {};
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      // no manifest yet — treat as a fresh app
    }
    const appPort = typeof manifest.port === 'number' ? manifest.port : 3000;

    // Recover what's already provisioned: prefer the persisted `infra`, else infer
    // it from the existing compose.yaml (apps provisioned before this fix), so even
    // the first flag-less re-provision after upgrading preserves services + ports.
    let prev = (manifest.infra ?? null) as PrevInfra | null;
    if (!prev) {
      let existingCompose = '';
      try {
        existingCompose = await readFile(composeFile, 'utf8');
      } catch {
        /* not provisioned yet */
      }
      prev = parseComposeInfra(existingCompose, appPort);
    }

    // Legacy: a top-level `secrets` array (pre-`infra`) is folded in, then dropped.
    const legacySecrets = Array.isArray(manifest.secrets)
      ? (manifest.secrets as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];

    // Converge. Throws (422) if a data-volume service would be dropped without --force.
    const desired = convergeInfra(prev, input, appPort, legacySecrets) as ReturnType<typeof convergeInfra> & { platform_store?: string };
    // P26 — carry the platform-store choice forward convergently (this call's flag wins, else the
    // remembered value), so a flag-less re-provision never resets it.
    const platformStore = input.platform_store ?? (prev as { platform_store?: string } | null)?.platform_store;
    if (platformStore) desired.platform_store = platformStore;

    const compose = generateCompose({
      appName: app.name,
      port: appPort,
      withPostgres: desired.postgres,
      withRedis: desired.redis,
      devCommand: 'npm run dev',
      secrets: desired.secrets,
      ports: desired.ports,
    });
    await writeFile(composeFile, compose);

    // Persist the converged desired infra so a future re-provision needs no flags.
    manifest.infra = desired;
    if ('secrets' in manifest) delete (manifest as { secrets?: unknown }).secrets;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    // .env.example — reflects the converged services.
    const envLines = ['# Environment for ' + app.name, `PORT=${appPort}`, 'NODE_ENV=development'];
    if (desired.postgres) {
      envLines.push('DATABASE_URL=postgres://forge:forge@postgres:5432/' + app.name.replace(/[^a-z0-9_]/gi, '_'));
    }
    if (desired.redis) envLines.push('REDIS_URL=redis://redis:6379');
    await writeFile(path.join(app.repo_path, '.env.example'), envLines.join('\n') + '\n');

    const services = ['web', ...(desired.postgres ? ['postgres'] : []), ...(desired.redis ? ['redis'] : [])];
    const ports: Record<string, number> = { web: desired.ports.web };
    if (desired.ports.postgres !== undefined) ports.postgres = desired.ports.postgres;
    if (desired.ports.redis !== undefined) ports.redis = desired.ports.redis;

    const resource: Environment = {
      ...baseResource('Environment', app.id),
      type: 'Environment',
      env_type: 'docker-compose',
      status: 'provisioned',
      services,
      ports,
      compose_file: composeFile,
    };
    await ctx.store.saveResource(resource);

    await ctx.emit({
      type: 'EnvironmentProvisioned',
      resource_type: 'Environment',
      resource_id: resource.id,
      app_id: app.id,
      data: { services, secrets: desired.secrets, implementation: IMPLEMENTATION },
    });

    return resource;
  },
};
