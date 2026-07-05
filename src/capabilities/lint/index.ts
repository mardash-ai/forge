import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { CheckRun } from '../../resources/types';
import { appRefInput, resolveApp, baseResource } from '../_shared';
import { logPath } from '../../shared/paths';
import { nowIso } from '../../shared/time';
import { lint as runLint, IMPLEMENTATION } from '../../plugins/lint-eslint/index';

const inputSchema = z.object({ ...appRefInput });
type Input = z.infer<typeof inputSchema>;

// Lint — a cheap, fast validation step with compact output, before expensive
// build/test loops.
export const lintCapability: Capability<Input, CheckRun> = {
  name: 'Lint',
  slug: 'lint',
  description: 'Run ESLint inside Docker and record a CheckRun Resource.',
  inputSchema,
  resourceType: 'CheckRun',
  events: ['CheckRunStarted', 'CheckRunSucceeded', 'CheckRunFailed'],
  longRunning: true,
  requiresDocker: true,
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);

    const resource: CheckRun = {
      ...baseResource('CheckRun', app.id),
      type: 'CheckRun',
      check_type: 'lint',
      status: 'running',
      implementation: IMPLEMENTATION,
      duration_ms: 0,
      problems: 0,
      log_path: '',
      summary: '',
    };
    resource.log_path = logPath(resource.id);
    await ctx.store.saveResource(resource);
    await ctx.emit({
      type: 'CheckRunStarted',
      resource_type: 'CheckRun',
      resource_id: resource.id,
      app_id: app.id,
      data: { check_type: 'lint', implementation: IMPLEMENTATION },
    });

    const out = await runLint(app.repo_path, resource.log_path);
    resource.status = out.ok ? 'succeeded' : 'failed';
    resource.problems = out.problems;
    resource.duration_ms = out.run.durationMs;
    resource.summary = out.summary;
    resource.updated_at = nowIso();
    await ctx.store.saveResource(resource);

    await ctx.emit({
      type: out.ok ? 'CheckRunSucceeded' : 'CheckRunFailed',
      resource_type: 'CheckRun',
      resource_id: resource.id,
      app_id: app.id,
      data: { problems: out.problems },
    });

    return resource;
  },
};
