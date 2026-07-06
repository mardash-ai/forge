import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Capability } from '../../core/types';
import type { Application } from '../../resources/types';
import { platformInput, baseResource } from '../_shared';
import { appDir as appDirFor, appLayout } from '../../shared/paths';
import { scaffold, IMPLEMENTATION } from '../../plugins/scaffold-nextjs-npm/index';
import { invalidInput } from '../../shared/errors';

const DEFAULT_PORT = 3000;

const inputSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be kebab-case'),
  template: z.string().default('nextjs-web'),
  package_manager: z.enum(['npm']).default('npm'),
  language: z.enum(['typescript']).default('typescript'),
  app_dir: z.boolean().default(true),
  docker: z.boolean().default(true),
  ...platformInput,
});

type Input = z.infer<typeof inputSchema>;

// InitializeApp — creates a standardized, Docker-ready Application from a Goal to
// build. Value beyond raw Claude: a consistent app SHAPE every downstream
// Capability understands (reproducible boilerplate, manifest, Dockerfile).
export const initializeApp: Capability<Input, Application> = {
  name: 'InitializeApp',
  slug: 'initialize-app',
  description: 'Create a Dockerized web/nextjs Application with standardized structure and Forge manifest.',
  inputSchema,
  resourceType: 'Application',
  events: ['ApplicationInitialized'],
  longRunning: false,
  requiresDocker: false,
  async execute(input, ctx) {
    // Single-app workspaces hold exactly one app (at ./app). Reject a second
    // init even under a different name — it would collide on the same directory.
    if (appLayout() === 'single') {
      const apps = await ctx.store.listResources({ type: 'Application' });
      if (apps.length > 0) {
        const owner = (apps[0] as { name?: string }).name ?? 'the existing app';
        throw invalidInput(
          `This workspace already contains an app ("${owner}"). Every repo holds exactly one app in single-app mode.`,
          { app: input.name },
        );
      }
    }

    const existing = await ctx.store.findAppByName(input.name);
    if (existing) {
      throw invalidInput(`An Application named "${input.name}" already exists.`, { app: input.name });
    }

    const dir = appDirFor(input.name);
    const { files, port } = scaffold({ name: input.name, port: DEFAULT_PORT });

    // Write every scaffolded file.
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(dir, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    const resource: Application = {
      ...baseResource('Application'),
      type: 'Application',
      name: input.name,
      repo_path: dir,
      platform: input.platform,
      framework: input.framework,
      template: input.template,
      language: input.language,
      package_manager: input.package_manager,
    };
    resource.app_id = resource.id;
    await ctx.store.saveResource(resource);

    // Forge app manifest — self-describing, read by Inspect.
    const manifest = {
      forge_version: '0.1.0',
      app_id: resource.id,
      name: input.name,
      platform: input.platform,
      framework: input.framework,
      template: input.template,
      language: input.language,
      package_manager: input.package_manager,
      port,
      implementation: IMPLEMENTATION,
      created_at: resource.created_at,
    };
    await writeFile(path.join(dir, 'forge.app.json'), JSON.stringify(manifest, null, 2) + '\n');

    await ctx.emit({
      type: 'ApplicationInitialized',
      resource_type: 'Application',
      resource_id: resource.id,
      app_id: resource.id,
      data: { name: input.name, platform: input.platform, framework: input.framework, implementation: IMPLEMENTATION },
    });

    return resource;
  },
};
