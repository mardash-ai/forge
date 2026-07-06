import { z } from 'zod';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { Capability } from '../../core/types';
import type { Inspection } from '../../resources/types';
import { appRefInput, resolveApp, baseResource } from '../_shared';
import { listSecretNames } from '../../plugins/secrets-local/index';
import type { ScheduledJob } from '../../resources/types';

const inputSchema = z.object({
  ...appRefInput,
  type: z.enum(['app', 'resources', 'events', 'routes', 'scripts', 'docker', 'secrets', 'jobs']).default('app'),
});
type Input = z.infer<typeof inputSchema>;

async function walk(dir: string, base = dir): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

// Convert an App Router file path into a route, e.g.
//   app/api/health/route.ts -> GET/POST /api/health
//   app/projects/page.tsx    -> /projects
function fileToRoute(rel: string): { route: string; kind: 'page' | 'api' } | null {
  const norm = rel.replace(/\\/g, '/');
  const m = norm.match(/^app\/(.*\/)?(route|page)\.(tsx?|jsx?)$/);
  if (!m) return null;
  const segs = (m[1] ?? '').split('/').filter(Boolean).filter((s) => !/^\(.*\)$/.test(s));
  const route = '/' + segs.join('/');
  return { route: route === '/' ? '/' : route.replace(/\/$/, ''), kind: m[2] === 'route' ? 'api' : 'page' };
}

// Inspect — compact structured inspection that summarizes project state without
// dumping the repository. One of the highest-value token-reduction Capabilities.
export const inspect: Capability<Input, Inspection> = {
  name: 'Inspect',
  slug: 'inspect',
  description: 'Return a compact structured view of an Application (app, resources, events, routes, scripts, docker).',
  inputSchema,
  resourceType: 'Inspection',
  events: ['InspectionCreated'],
  longRunning: false,
  requiresDocker: false,
  plane: 'both', // observability surface used in both dev and production
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);
    let summary = '';
    let data: unknown = {};

    switch (input.type) {
      case 'app': {
        let manifest: Record<string, unknown> = {};
        try {
          manifest = JSON.parse(await readFile(path.join(app.repo_path, 'forge.app.json'), 'utf8'));
        } catch {
          /* ignore */
        }
        const resources = await ctx.store.listResources({ app_id: app.id });
        const counts: Record<string, number> = {};
        for (const r of resources) counts[r.type] = (counts[r.type] ?? 0) + 1;
        data = {
          name: app.name,
          platform: app.platform,
          framework: app.framework,
          language: app.language,
          package_manager: app.package_manager,
          repo_path: app.repo_path,
          port: manifest.port ?? 3000,
          infra: manifest.infra ?? null,
          resource_counts: counts,
        };
        summary = `${app.name} — ${app.platform}/${app.framework}, ${resources.length} resource(s).`;
        break;
      }
      case 'resources': {
        const resources = await ctx.store.listResources({ app_id: app.id });
        data = resources.map((r) => ({
          id: r.id,
          type: r.type,
          status: (r as { status?: string }).status,
          created_at: r.created_at,
        }));
        summary = `${resources.length} resource(s) for ${app.name}.`;
        break;
      }
      case 'events': {
        const events = await ctx.store.listEvents({ app_id: app.id, limit: 20 });
        data = events.map((e) => ({ id: e.id, type: e.type, resource_id: e.resource_id, at: e.timestamp }));
        summary = `${events.length} recent event(s) for ${app.name}.`;
        break;
      }
      case 'routes': {
        const files = await walk(app.repo_path);
        const routes = files
          .map(fileToRoute)
          .filter((r): r is { route: string; kind: 'page' | 'api' } => r !== null)
          .sort((a, b) => a.route.localeCompare(b.route));
        data = routes;
        summary = `${routes.length} route(s): ${routes.filter((r) => r.kind === 'api').length} api, ${routes.filter((r) => r.kind === 'page').length} page.`;
        break;
      }
      case 'scripts': {
        let scripts: Record<string, string> = {};
        try {
          const pkg = JSON.parse(await readFile(path.join(app.repo_path, 'package.json'), 'utf8'));
          scripts = pkg.scripts ?? {};
        } catch {
          /* ignore */
        }
        data = scripts;
        summary = `${Object.keys(scripts).length} npm script(s).`;
        break;
      }
      case 'secrets': {
        // Names only — the values never leave the secrets backend.
        const names = await listSecretNames(app.id);
        data = names.map((name) => ({ name, set: true }));
        summary = names.length
          ? `${names.length} secret(s) set for ${app.name}: ${names.join(', ')}.`
          : `No secrets set for ${app.name}. Set one: forge secrets set --app ${app.name} --name <NAME> --value <v>`;
        break;
      }
      case 'jobs': {
        const jobs = (await ctx.store.listResources({ type: 'ScheduledJob', app_id: app.id })) as ScheduledJob[];
        data = jobs.map((j) => ({
          name: j.name,
          schedule: j.schedule,
          target: `${j.target.method} ${j.target.path}`,
          enabled: j.enabled,
          next_run_at: j.next_run_at,
          last_status: j.last_status,
          runs: j.run_count,
        }));
        summary = jobs.length
          ? `${jobs.length} scheduled job(s) for ${app.name}.`
          : `No scheduled jobs for ${app.name}. Add one: forge schedule --app ${app.name} --name <n> --cron "0 0 * * *" --target /api/cron/<n>`;
        break;
      }
      case 'docker': {
        let compose = '';
        try {
          compose = await readFile(path.join(app.repo_path, 'compose.yaml'), 'utf8');
        } catch {
          /* not provisioned */
        }
        // Only read keys under the `services:` block (stop at the next
        // top-level key such as `volumes:`), so volume names aren't mistaken
        // for services.
        const servicesBlock = compose.split(/^services:$/m)[1]?.split(/^\S/m)[0] ?? '';
        const services = [...servicesBlock.matchAll(/^ {2}([a-z0-9_-]+):$/gim)].map((m) => m[1]);
        const provisioned = compose.length > 0;
        data = { provisioned, services, compose_file: provisioned ? path.join(app.repo_path, 'compose.yaml') : null };
        summary = provisioned
          ? `Provisioned. Services: ${services.join(', ')}.`
          : 'Not provisioned yet. Run: forge provision --app ' + app.name;
        break;
      }
    }

    const resource: Inspection = {
      ...baseResource('Inspection', app.id),
      type: 'Inspection',
      inspection_type: input.type,
      summary,
      data,
    };
    await ctx.store.saveResource(resource);
    await ctx.emit({
      type: 'InspectionCreated',
      resource_type: 'Inspection',
      resource_id: resource.id,
      app_id: app.id,
      data: { inspection_type: input.type },
    });

    return resource;
  },
};
