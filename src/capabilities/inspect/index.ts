import { z } from 'zod';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { Capability } from '../../core/types';
import type { Inspection } from '../../resources/types';
import { appRefInput, resolveApp, baseResource } from '../_shared';
import { listSecretNames } from '../../plugins/secrets-local/index';
import type { ScheduledJob, AgentTask } from '../../resources/types';
import { parseHealthResponse, httpStatusFor } from '../../shared/health';

const inputSchema = z.object({
  ...appRefInput,
  type: z
    .enum(['app', 'resources', 'events', 'app-events', 'notifications', 'routes', 'scripts', 'docker', 'secrets', 'jobs', 'agent-runs', 'health'])
    .default('app'),
});
type Input = z.infer<typeof inputSchema>;

// Live health probe timeout — an inspection must never hang on a wedged app.
const HEALTH_TIMEOUT_MS = 5_000;

// Where the control plane reaches a Builder app's HTTP server to probe health — the
// SAME env convention the scheduler uses to call an app back (host.docker.internal in
// dev; FORGE_APP_CALLBACK_HOST/PORT on a prod compose network). Port falls back to the
// provisioned web host port, then the manifest port, then 3000.
function resolveAppBase(manifest: Record<string, unknown>): string {
  const host = process.env.FORGE_APP_CALLBACK_HOST ?? 'host.docker.internal';
  const envPort = process.env.FORGE_APP_CALLBACK_PORT;
  const webPort = (manifest.infra as { ports?: { web?: unknown } } | undefined)?.ports?.web;
  const manifestPort = typeof webPort === 'number' ? webPort : typeof manifest.port === 'number' ? manifest.port : 3000;
  return `http://${host}:${envPort ?? manifestPort}`;
}

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
  description: 'Return a compact structured view of an Application (app, resources, events, app-events, notifications, routes, scripts, docker, secrets, jobs, agent-runs, health).',
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
      case 'app-events': {
        // The APP's own domain event log (C3) — distinct from platform `events` above.
        const events = await ctx.store.listAppEvents({ app_id: app.id, limit: 20 });
        data = events.map((e) => ({ id: e.id, type: e.type, subject: e.subject, at: e.at }));
        summary = events.length
          ? `${events.length} recent app event(s) for ${app.name}.`
          : `No app events for ${app.name} yet.`;
        break;
      }
      case 'notifications': {
        // The app's derived notifications (C4) — active + dismissed.
        const notes = await ctx.store.listNotifications(app.id, { includeDismissed: true });
        data = notes.map((n) => ({ key: n.key, title: n.title, subject: n.subject, dismissed: n.dismissed, at: n.updated_at }));
        const active = notes.filter((n) => !n.dismissed).length;
        summary = `${active} active notification(s) for ${app.name}${notes.length > active ? ` (+${notes.length - active} dismissed)` : ''}.`;
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
      case 'agent-runs': {
        // Durable agent-run records (C1) — every model invocation, success AND failure.
        const runs = (await ctx.store.listResources({ type: 'AgentTask', app_id: app.id })) as AgentTask[];
        data = runs.map((r) => ({
          id: r.id,
          label: r.label,
          status: r.status,
          model: r.model,
          artifact_id: r.artifact_id,
          error: r.error,
          at: r.created_at,
        }));
        const failed = runs.filter((r) => r.status === 'failed').length;
        summary = runs.length
          ? `${runs.length} agent run(s) for ${app.name}${failed ? ` (${failed} failed)` : ''}.`
          : `No agent runs for ${app.name} yet.`;
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
      case 'health': {
        // Read the readiness path the whole platform already points at (dev/prod
        // compose healthchecks, the C7 Traefik loadbalancer.healthcheck), fetch it
        // LIVE (no-cache), and render the parsed standard health schema.
        let manifest: Record<string, unknown> = {};
        try {
          manifest = JSON.parse(await readFile(path.join(app.repo_path, 'forge.app.json'), 'utf8'));
        } catch {
          /* no manifest — fall through to the default readiness path */
        }
        const production = (manifest.production ?? {}) as { readiness_path?: string };
        const readinessPath = production.readiness_path ?? '/api/health';
        const url = `${resolveAppBase(manifest)}${readinessPath}`;

        try {
          const res = await fetch(url, {
            headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
            signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
          });
          const text = await res.text();
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          const parsed = parseHealthResponse(json);
          if (parsed.ok) {
            const h = parsed.value;
            const expected = httpStatusFor(h.status);
            const conventionOk = res.status === expected;
            data = {
              url,
              reachable: true,
              http_status: res.status,
              conforms: true,
              status: h.status,
              service: h.service,
              time: h.time,
              checks: h.checks,
              ...(conventionOk
                ? {}
                : { convention_warning: `HTTP ${res.status} but status '${h.status}' implies HTTP ${expected} (200/503 convention)` }),
            };
            const failed = h.checks.filter((c) => c.status === 'unavailable').map((c) => c.name);
            summary =
              `${app.name} health: ${h.status} (HTTP ${res.status}) — ${h.checks.length} check(s)` +
              (failed.length ? `, down: ${failed.join(', ')}` : '') +
              (conventionOk ? '' : ' [convention mismatch]');
          } else {
            data = { url, reachable: true, http_status: res.status, conforms: false, error: parsed.error, body_preview: text.slice(0, 200) };
            summary = `${app.name} health endpoint reachable (HTTP ${res.status}) but does not conform to the standard schema — ${parsed.error}.`;
          }
        } catch (e) {
          data = { url, reachable: false, error: String((e as Error)?.message ?? e) };
          summary = `${app.name} health endpoint unreachable at ${url}. Is the app running? (forge dev --app ${app.name})`;
        }
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
