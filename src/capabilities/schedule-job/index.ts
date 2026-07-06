import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { ScheduledJob } from '../../resources/types';
import { resolveApp, baseResource } from '../_shared';
import { nowIso } from '../../shared/time';
import { invalidInput, notFound } from '../../shared/errors';
import { toCanonical, parseSchedule, nextRun } from '../../plugins/scheduler-node/schedule';
import { IMPLEMENTATION } from '../../plugins/scheduler-node/index';

const inputSchema = z.object({
  app: z.string().min(1).describe('Application name'),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'job name must be kebab-case').describe('Job name, unique per app'),
  target_path: z.string().startsWith('/', 'target must be an app path like /api/cron/habits').optional(),
  method: z.enum(['GET', 'POST']).default('POST'),
  // Exactly one of these (unless --remove):
  every: z.string().optional(), // recurring interval, e.g. 30m / 1h / 24h
  cron: z.string().optional(), // recurring 5-field cron (UTC), e.g. "0 0 * * *"
  at: z.string().optional(), // one-shot ISO timestamp
  disabled: z.boolean().default(false),
  remove: z.boolean().default(false),
});
type Input = z.infer<typeof inputSchema>;

// ScheduleJob — register (or remove) durable recurring/one-shot work that Forge
// fires on cadence by calling back into the app. Behavior lives in the
// scheduler-node Implementation; this Capability is the stable contract.
export const scheduleJob: Capability<Input, ScheduledJob> = {
  name: 'ScheduleJob',
  slug: 'schedule-job',
  description: 'Register or remove a durable scheduled job (recurring cron/interval or one-shot) that calls back into the app.',
  inputSchema,
  resourceType: 'ScheduledJob',
  events: ['JobScheduled', 'JobUnscheduled'],
  longRunning: false,
  requiresDocker: false,
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);
    const existing = (await ctx.store.listResources({ type: 'ScheduledJob', app_id: app.id })).find(
      (j) => (j as ScheduledJob).name === input.name,
    ) as ScheduledJob | undefined;

    if (input.remove) {
      if (!existing) throw notFound(`No scheduled job "${input.name}" for app "${input.app}".`, { name: input.name });
      await ctx.store.deleteResource('ScheduledJob', existing.id);
      await ctx.emit({
        type: 'JobUnscheduled',
        resource_type: 'ScheduledJob',
        resource_id: existing.id,
        app_id: app.id,
        data: { name: input.name },
      });
      return { ...existing, enabled: false, updated_at: nowIso() };
    }

    if (!input.target_path) {
      throw invalidInput('A target path is required, e.g. --target /api/cron/habits.', { name: input.name });
    }

    // Validate the schedule and seed the first fire time.
    const canonical = toCanonical(input);
    const next = nextRun(parseSchedule(canonical), new Date());
    if (!next) throw invalidInput('Schedule is already in the past — nothing would ever run.', { schedule: canonical });

    const resource: ScheduledJob = {
      ...(existing ?? baseResource('ScheduledJob', app.id)),
      type: 'ScheduledJob',
      name: input.name,
      schedule: canonical,
      target: { method: input.method, path: input.target_path },
      enabled: !input.disabled,
      next_run_at: next.toISOString(),
      last_run_at: existing?.last_run_at,
      last_status: existing?.last_status ?? 'never',
      run_count: existing?.run_count ?? 0,
      fail_count: 0,
      updated_at: nowIso(),
    };
    await ctx.store.saveResource(resource);

    await ctx.emit({
      type: 'JobScheduled',
      resource_type: 'ScheduledJob',
      resource_id: resource.id,
      app_id: app.id,
      data: { name: input.name, schedule: canonical, target: resource.target, implementation: IMPLEMENTATION },
    });

    return resource;
  },
};
