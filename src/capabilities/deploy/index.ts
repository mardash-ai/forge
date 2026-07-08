import { z } from 'zod';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Capability } from '../../core/types';
import type { Deployment } from '../../resources/types';
import { appRefInput, baseResource } from '../_shared';
import { logPath, workspaceDir } from '../../shared/paths';
import { nowIso } from '../../shared/time';
import { rollout, IMPLEMENTATION } from '../../plugins/deploy-compose-rollout/index';

const inputSchema = z.object({
  ...appRefInput,
  // The public service rolled start-first; every other service reconciles in place.
  service: z.string().default('web'),
  // Docker context of the target daemon (SSH etc.). Omit to target the local daemon.
  context: z.string().optional(),
  // Production compose manifest, resolved from the workspace dir. Defaults to what
  // `forge productionize` writes — `app/compose.prod.yaml` (the app repo is ./app in
  // the single-app layout `provision` uses) — so a plain `forge deploy` finds it with
  // no flag, and the compose file's relative bind-mounts resolve from ./app (P7.2).
  compose_file: z.string().default('app/compose.prod.yaml'),
  // Env file Compose interpolates the compose vars from. Defaults to what
  // `forge productionize` documents — `app/.env.prod` (the copy of `.env.prod.example`
  // the operator fills in) — the SAME file the compose interpolation hint names. Without
  // this, Compose auto-reads only `app/.env`, so secrets in the documented file are
  // silently ignored and a `${VAR:?}` interpolation aborts the deploy (P10). Passed only
  // when it exists (Compose errors on an explicitly-named env-file that isn't there, and
  // an app with no secrets legitimately ships none).
  env_file: z.string().default('app/.env.prod'),
  // Reverse-proxy network the old replica is drained out of before removal.
  proxy_net: z.string().default('proxy'),
  // Pull images first (non-fatal — a locked keychain over SSH still deploys cached images).
  pull: z.boolean().default(true),
  drain_seconds: z.number().int().nonnegative().default(3),
  timeout_seconds: z.number().int().positive().default(120),
});
type Input = z.infer<typeof inputSchema>;

// Resolve an operator-supplied `--env-file` / `--compose-file` arg against the app's
// WORKSPACE ROOT (FORGE_WORKSPACE) — exactly the dir `docker compose` runs from during the
// roll. A RELATIVE arg (the `app/.env.prod` / `app/compose.prod.yaml` defaults, or `make
// deploy`'s relative flags) resolves UNDER the workspace; an ABSOLUTE arg passes through
// unchanged. It is NEVER resolved against the control-plane container's process CWD
// (`/forge`), which holds no app files — the base-dir trap behind P16. `path.resolve` (not
// `path.join`) is deliberate: `path.join(ws, '/abs')` would mis-join an absolute path UNDER
// the workspace, silently dropping a valid absolute env-file; `path.resolve` returns it as-is.
export function resolveWorkspacePath(workspace: string, arg: string): string {
  return path.resolve(workspace, arg);
}

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
    // Deploy targets a production compose stack at the project root; a registered
    // Application is OPTIONAL — a prod host may never have run `forge init`. Resolve
    // it softly (to label the Deployment + events), but never require it.
    const known = await ctx.store.findAppByName(input.app);
    const appId = known && known.type === 'Application' ? known.id : undefined;
    // The prod compose manifest + its relative bind-mounts live at the project root,
    // which the control plane has mounted at the identical host==container path.
    const cwd = workspaceDir();

    // Resolve the env-file Compose interpolates from (P10). Pass it only when it
    // exists: Compose aborts on an explicitly-named env-file that isn't present, and an
    // app with no secrets legitimately has none — in which case Compose's own `app/.env`
    // auto-read still applies.
    let envFile: string | undefined;
    try {
      await stat(resolveWorkspacePath(cwd, input.env_file));
      envFile = input.env_file;
    } catch {
      envFile = undefined;
    }

    const resource: Deployment = {
      ...baseResource('Deployment', appId),
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
      app_id: appId,
      data: { service: input.service, target: input.context ?? 'local', compose_file: input.compose_file },
    });

    const log: string[] = [];
    const start = Date.now();
    try {
      const out = await rollout(
        {
          cwd,
          composeFile: input.compose_file,
          envFile,
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
      app_id: appId,
      data:
        resource.status === 'succeeded'
          ? { strategy: resource.strategy, service: resource.service, duration_ms: resource.duration_ms }
          : { service: resource.service, error_summary: resource.error_summary },
    });

    return resource;
  },
};
