import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { TestRun } from '../../resources/types';
import { appRefInput, resolveApp, baseResource } from '../_shared';
import { logPath } from '../../shared/paths';
import { nowIso } from '../../shared/time';
import { test as runTest, IMPLEMENTATION } from '../../plugins/test-npm/index';

const inputSchema = z.object({ ...appRefInput });
type Input = z.infer<typeof inputSchema>;

// Test — repeatable test execution agents can run with no local assumptions.
export const testCapability: Capability<Input, TestRun> = {
  name: 'Test',
  slug: 'test',
  description: 'Run the test suite inside Docker (Vitest) and record a TestRun Resource.',
  inputSchema,
  resourceType: 'TestRun',
  events: ['TestRunStarted', 'TestRunSucceeded', 'TestRunFailed'],
  longRunning: true,
  requiresDocker: true,
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);

    const resource: TestRun = {
      ...baseResource('TestRun', app.id),
      type: 'TestRun',
      status: 'running',
      implementation: IMPLEMENTATION,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration_ms: 0,
      log_path: '',
    };
    resource.log_path = logPath(resource.id);
    await ctx.store.saveResource(resource);
    await ctx.emit({
      type: 'TestRunStarted',
      resource_type: 'TestRun',
      resource_id: resource.id,
      app_id: app.id,
      data: { implementation: IMPLEMENTATION },
    });

    const out = await runTest(app.repo_path, resource.log_path);
    resource.status = out.ok ? 'succeeded' : 'failed';
    resource.passed = out.passed;
    resource.failed = out.failed;
    resource.skipped = out.skipped;
    resource.duration_ms = out.run.durationMs;
    resource.failure_summary = out.failure_summary;
    resource.updated_at = nowIso();
    await ctx.store.saveResource(resource);

    await ctx.emit({
      type: out.ok ? 'TestRunSucceeded' : 'TestRunFailed',
      resource_type: 'TestRun',
      resource_id: resource.id,
      app_id: app.id,
      data: { passed: out.passed, failed: out.failed, skipped: out.skipped },
    });

    return resource;
  },
};
