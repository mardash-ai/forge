import { z } from 'zod';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Capability } from '../../core/types';
import type { Environment } from '../../resources/types';
import { appRefInput, resolveApp, baseResource } from '../_shared';
import { generateCompose, IMPLEMENTATION } from '../../plugins/runtime-docker-compose/index';

const inputSchema = z.object({
  ...appRefInput,
  with_postgres: z.boolean().default(false),
  with_redis: z.boolean().default(false),
  // Secret names the app needs available in its runtime (e.g. ANTHROPIC_API_KEY).
  // Merged with any declared in forge.app.json. Forge injects the values from its
  // encrypted store at run time; they never appear in the generated compose file.
  secrets: z.array(z.string()).default([]),
});

type Input = z.infer<typeof inputSchema>;

// ProvisionEnvironment — generate a consistent, runnable Docker environment for
// an Application. Value beyond raw Claude: deterministic ports, health checks,
// and services wired the same way every time.
export const provisionEnvironment: Capability<Input, Environment> = {
  name: 'ProvisionEnvironment',
  slug: 'provision-environment',
  description: 'Generate a Docker Compose environment (web + optional postgres/redis) for an Application.',
  inputSchema,
  resourceType: 'Environment',
  events: ['EnvironmentProvisioned'],
  longRunning: false,
  requiresDocker: false,
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);

    // Read the app port + declared secrets from its manifest (deterministic).
    let port = 3000;
    const declaredSecrets = new Set<string>(input.secrets);
    try {
      const manifest = JSON.parse(await readFile(path.join(app.repo_path, 'forge.app.json'), 'utf8'));
      if (typeof manifest.port === 'number') port = manifest.port;
      if (Array.isArray(manifest.secrets)) {
        for (const s of manifest.secrets) if (typeof s === 'string') declaredSecrets.add(s);
      }
    } catch {
      // fall back to defaults
    }

    const compose = generateCompose({
      appName: app.name,
      port,
      withPostgres: input.with_postgres,
      withRedis: input.with_redis,
      devCommand: 'npm run dev',
      secrets: [...declaredSecrets],
    });
    const composeFile = path.join(app.repo_path, 'compose.yaml');
    await writeFile(composeFile, compose);

    // .env.example
    const envLines = ['# Environment for ' + app.name, `PORT=${port}`, 'NODE_ENV=development'];
    if (input.with_postgres) {
      envLines.push('DATABASE_URL=postgres://forge:forge@postgres:5432/' + app.name.replace(/[^a-z0-9_]/gi, '_'));
    }
    if (input.with_redis) envLines.push('REDIS_URL=redis://redis:6379');
    await writeFile(path.join(app.repo_path, '.env.example'), envLines.join('\n') + '\n');

    const services = ['web', ...(input.with_postgres ? ['postgres'] : []), ...(input.with_redis ? ['redis'] : [])];
    const ports: Record<string, number> = { web: port };
    if (input.with_postgres) ports.postgres = 5432;
    if (input.with_redis) ports.redis = 6379;

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
      data: { services, implementation: IMPLEMENTATION },
    });

    return resource;
  },
};
