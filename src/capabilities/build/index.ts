import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { Build } from '../../resources/types';
import { appRefInput, resolveApp, baseResource } from '../_shared';
import { logPath } from '../../shared/paths';
import { nowIso } from '../../shared/time';
import { build as runBuild, IMPLEMENTATION } from '../../plugins/build-npm/index';

const inputSchema = z.object({ ...appRefInput });
type Input = z.infer<typeof inputSchema>;

// Build — a repeatable, isolated build that produces structured, inspectable
// output. Value beyond raw Claude: reproducible, evented, summarized.
export const buildCapability: Capability<Input, Build> = {
  name: 'Build',
  slug: 'build',
  description: 'Run a reproducible production build inside Docker and record a Build Resource.',
  inputSchema,
  resourceType: 'Build',
  events: ['BuildStarted', 'BuildSucceeded', 'BuildFailed'],
  longRunning: true,
  requiresDocker: true,
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);

    const resource: Build = {
      ...baseResource('Build', app.id),
      type: 'Build',
      status: 'running',
      implementation: IMPLEMENTATION,
      started_at: nowIso(),
      duration_ms: 0,
      log_path: '',
      artifact_refs: [],
    };
    resource.log_path = logPath(resource.id);
    await ctx.store.saveResource(resource);
    await ctx.emit({
      type: 'BuildStarted',
      resource_type: 'Build',
      resource_id: resource.id,
      app_id: app.id,
      data: { implementation: IMPLEMENTATION },
    });

    const out = await runBuild(app.repo_path, resource.log_path);
    resource.status = out.ok ? 'succeeded' : 'failed';
    resource.finished_at = nowIso();
    resource.duration_ms = out.run.durationMs;
    resource.artifact_refs = out.artifact_refs;
    resource.error_summary = out.error_summary;
    resource.updated_at = nowIso();
    await ctx.store.saveResource(resource);

    await ctx.emit({
      type: out.ok ? 'BuildSucceeded' : 'BuildFailed',
      resource_type: 'Build',
      resource_id: resource.id,
      app_id: app.id,
      data: out.ok
        ? { duration_ms: resource.duration_ms, artifacts: resource.artifact_refs }
        : { duration_ms: resource.duration_ms, error_summary: resource.error_summary },
    });

    return resource;
  },
};
