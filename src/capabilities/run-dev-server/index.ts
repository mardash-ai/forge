import { z } from 'zod';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Capability } from '../../core/types';
import type { DevServer } from '../../resources/types';
import { appRefInput, resolveApp, baseResource } from '../_shared';
import { logPath } from '../../shared/paths';
import { nowIso } from '../../shared/time';
import { composeUp, composeDown, composePs } from '../../plugins/runtime-docker-compose/index';
import { readSecrets } from '../../plugins/secrets-local/index';

const inputSchema = z.object({
  ...appRefInput,
  action: z.enum(['start', 'stop', 'status']).default('start'),
});
type Input = z.infer<typeof inputSchema>;

function healthOf(state?: string, health?: string): DevServer['health'] {
  if (health === 'healthy') return 'healthy';
  if (health === 'starting') return 'starting';
  if (health === 'unhealthy') return 'unhealthy';
  if (state === 'running') return 'starting';
  return 'unknown';
}

// RunDevServer — start/stop/inspect the app in a known-good containerized runtime
// without relying on local state.
export const runDevServer: Capability<Input, DevServer> = {
  name: 'RunDevServer',
  slug: 'run-dev-server',
  description: 'Start, stop, or inspect the app dev server in Docker; records a DevServer Resource.',
  inputSchema,
  resourceType: 'DevServer',
  events: ['DevServerStarted', 'DevServerStopped'],
  longRunning: true,
  requiresDocker: true,
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);

    let port = 3000;
    try {
      const manifest = JSON.parse(await readFile(path.join(app.repo_path, 'forge.app.json'), 'utf8'));
      if (typeof manifest.port === 'number') port = manifest.port;
    } catch {
      /* default */
    }

    const resource: DevServer = {
      ...baseResource('DevServer', app.id),
      type: 'DevServer',
      status: 'stopped',
      url: `http://localhost:${port}`,
      port,
      container_id: '',
      health: 'unknown',
      log_path: '',
    };
    resource.log_path = logPath(resource.id);

    if (input.action === 'stop') {
      await composeDown(app.repo_path);
      resource.status = 'stopped';
      resource.updated_at = nowIso();
      await ctx.store.saveResource(resource);
      await ctx.emit({
        type: 'DevServerStopped',
        resource_type: 'DevServer',
        resource_id: resource.id,
        app_id: app.id,
        data: {},
      });
      return resource;
    }

    if (input.action === 'start') {
      // Inject the app's declared secrets (decrypted only here, in memory) into
      // the compose process so the running container receives them. A failure to
      // read them is non-fatal — the app then just sees them absent and degrades.
      const secretEnv = await readSecrets(app.id).catch(() => ({}));
      await composeUp(app.repo_path, 'web', { logFile: resource.log_path, env: secretEnv });
    }

    // status (and post-start): read container state.
    const services = await composePs(app.repo_path);
    const web = services.find((s) => s.name === 'web');
    resource.container_id = web?.id ?? '';
    resource.status = web?.state === 'running' ? 'running' : input.action === 'start' ? 'failed' : 'stopped';
    resource.health = healthOf(web?.state, web?.health);
    resource.updated_at = nowIso();
    await ctx.store.saveResource(resource);

    if (input.action === 'start') {
      await ctx.emit({
        type: 'DevServerStarted',
        resource_type: 'DevServer',
        resource_id: resource.id,
        app_id: app.id,
        data: { url: resource.url, status: resource.status },
      });
    }

    return resource;
  },
};
