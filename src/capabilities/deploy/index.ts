import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Capability } from '../../core/types';
import type { Deployment } from '../../resources/types';
import { appRefInput, resolveApp, baseResource } from '../_shared';
import { logPath, workspaceDir } from '../../shared/paths';
import { nowIso } from '../../shared/time';
import { rollout, IMPLEMENTATION } from '../../plugins/deploy-compose-rollout/index';

const inputSchema = z.object({
  ...appRefInput,
  // The public service rolled start-first; every other service reconciles in place.
  service: z.string().default('web'),
  // Docker context of the target daemon (SSH etc.). Omit to target the local daemon.
  context: z.string().optional(),
  // Production compose manifest, resolved at the project root (workspace dir).
  compose_file: z.string().default('compose.prod.yaml'),
  // Reverse-proxy network the old replica is drained out of before removal.
  proxy_net: z.string().default('proxy'),
  // Pull images first (non-fatal — a locked keychain over SSH still deploys cached images).
  pull: z.boolean().default(true),
  drain_seconds: z.number().int().nonnegative().default(3),
  timeout_seconds: z.number().int().positive().default(120),
});
type Input = z.infer<typeof inputSchema>;

// Deploy — a zero-downtime release of the app's PRODUCTION stack. The technology
// (docker compose start-first roll behind Traefik) is an Implementation; the
// contract is "deploy the app with no outage window and record a Deployment".
// Long-running: the request blocks until the roll resolves and returns the Resource.
export const deployCapability: Capability<Input, Deployment> = {
  name: 'Deploy',
  slug: 'deploy',
  description: 'Zero-downtime deploy of the app’s production stack (start-first roll) and record a Deployment.',
  inputSchema,
  resourceType: 'Deployment',
  events: ['DeploymentStarted', 'DeploymentCompleted', 'DeploymentRolledBack'],
  longRunning: true,
  requiresDocker: true,
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);
    // The prod compose manifest + its relative bind-mounts live at the project root,
    // which the control plane has mounted at the identical host==container path.
    const cwd = workspaceDir();

    const resource: Deployment = {
      ...baseResource('Deployment', app.id),
      type: 'Deployment',
      status: 'running',
      implementation: IMPLEMENTATION,
      service: input.service,
      context: input.context,
      compose_file: input.compose_file,
      reconciled_services: [],
      old_container_ids: [],
      new_container_ids: [],
      started_at: nowIso(),
      duration_ms: 0,
      log_path: '',
    };
    resource.log_path = logPath(resource.id);
    await ctx.store.saveResource(resource);
    await ctx.emit({
      type: 'DeploymentStarted',
      resource_type: 'Deployment',
      resource_id: resource.id,
      app_id: app.id,
      data: { service: input.service, target: input.context ?? 'local', compose_file: input.compose_file },
    });

    const log: string[] = [];
    const start = Date.now();
    try {
      const out = await rollout(
        {
          cwd,
          composeFile: input.compose_file,
          service: input.service,
          context: input.context,
          proxyNet: input.proxy_net,
          pull: input.pull,
          timeoutMs: input.timeout_seconds * 1000,
          drainMs: input.drain_seconds * 1000,
        },
        log,
      );
      resource.status = 'succeeded';
      resource.strategy = out.strategy;
      resource.reconciled_services = out.reconciled_services;
      resource.old_container_ids = out.old_container_ids;
      resource.new_container_ids = out.new_container_ids;
    } catch (err) {
      resource.status = 'failed';
      resource.error_summary = err instanceof Error ? err.message : String(err);
    }
    resource.finished_at = nowIso();
    resource.duration_ms = Date.now() - start;
    resource.updated_at = nowIso();

    // Persist the step log (partial log survives a failure — it's caller-owned above).
    try {
      await mkdir(path.dirname(resource.log_path), { recursive: true });
      await writeFile(resource.log_path, `$ forge deploy --app ${input.app}\n${log.join('\n')}\n`);
    } catch {
      /* logging is best-effort */
    }

    await ctx.store.saveResource(resource);
    await ctx.emit({
      // A failed roll auto-discards the new replica and keeps the old one serving — that
      // is a rollback, so the terminal fact on failure is DeploymentRolledBack.
      type: resource.status === 'succeeded' ? 'DeploymentCompleted' : 'DeploymentRolledBack',
      resource_type: 'Deployment',
      resource_id: resource.id,
      app_id: app.id,
      data:
        resource.status === 'succeeded'
          ? { strategy: resource.strategy, service: resource.service, duration_ms: resource.duration_ms }
          : { service: resource.service, error_summary: resource.error_summary },
    });

    return resource;
  },
};
