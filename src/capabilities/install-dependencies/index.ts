import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { DependencyInstall } from '../../resources/types';
import { appRefInput, resolveApp, baseResource } from '../_shared';
import { logPath } from '../../shared/paths';
import { nowIso } from '../../shared/time';
import { install, IMPLEMENTATION } from '../../plugins/package-npm/index';

const inputSchema = z.object({ ...appRefInput });
type Input = z.infer<typeof inputSchema>;

// InstallDependencies — install deps inside Docker and record the result as a
// Resource. Builders never run a local package manager.
export const installDependencies: Capability<Input, DependencyInstall> = {
  name: 'InstallDependencies',
  slug: 'install-dependencies',
  description: 'Install application dependencies inside Docker (npm) and record a DependencyInstall Resource.',
  inputSchema,
  resourceType: 'DependencyInstall',
  events: ['DependenciesInstalled'],
  longRunning: true,
  requiresDocker: true,
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);
    const resource: DependencyInstall = {
      ...baseResource('DependencyInstall', app.id),
      type: 'DependencyInstall',
      status: 'running',
      implementation: IMPLEMENTATION,
      duration_ms: 0,
      log_path: '',
      summary: '',
    };
    resource.log_path = logPath(resource.id);

    const result = await install(app.repo_path, resource.log_path);
    resource.status = result.ok ? 'succeeded' : 'failed';
    resource.duration_ms = result.run.durationMs;
    resource.summary = result.summary;
    resource.updated_at = nowIso();
    await ctx.store.saveResource(resource);

    await ctx.emit({
      type: 'DependenciesInstalled',
      resource_type: 'DependencyInstall',
      resource_id: resource.id,
      app_id: app.id,
      data: { status: resource.status, implementation: IMPLEMENTATION },
    });

    return resource;
  },
};
