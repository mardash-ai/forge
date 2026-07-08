import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { store } from '../storage/store';
import { executeCapability } from '../core/runtime';
import { describeCapabilities } from '../core/registry';
import { capabilities } from '../capabilities/index';
import { startScheduler } from '../plugins/scheduler-node/index';
import { ForgeError } from '../shared/errors';
import { SYSTEM_ACTOR, type Actor } from '../shared/domain';
import { RESOURCE_TYPES, type ResourceType, type Application } from '../resources/types';
import { newResourceId } from '../shared/ids';
import { nowIso } from '../shared/time';
import { registerAppEventRoutes } from '../api/app-events-routes';
import { registerNotificationRoutes } from '../api/notifications-routes';
import { registerAuthRoutes } from '../api/auth-routes';
import { registerOwnerRoutes } from '../api/owner-routes';
import { registerThemeRoutes } from '../api/theme-routes';
import { registerStatusRoutes } from '../api/status-routes';
import { logPath } from '../shared/paths';

// The Forge DATA PLANE server — the production/runtime counterpart to the control
// plane. It ships in a SLIM image (no Docker CLI, no build/test/lint, no dev deps)
// and exposes only the data-plane capabilities (plane = data|both): the scheduler
// (C2), the secrets store (C5), and read/observe surfaces. It carries NO dev-time
// capabilities (init/provision/install/dev/build/test/lint/explain/plan).
const app = Fastify({ logger: false });

// Slugs this plane is allowed to run — control-plane capabilities are refused.
const DATA_PLANE_SLUGS = new Set(
  capabilities.filter((c) => (c.plane ?? 'control') !== 'control').map((c) => c.slug),
);

function actorFromHeaders(headers: Record<string, unknown>): Actor {
  const type = (headers['x-forge-actor-type'] as string) || 'system';
  const id = (headers['x-forge-actor-id'] as string) || 'data-plane';
  const valid = ['builder', 'agent', 'system'];
  return { type: (valid.includes(type) ? type : 'system') as Actor['type'], id };
}

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ForgeError) return reply.status(err.status).send(err.toJSON());
  return reply.status(500).send({ error: { code: 'internal_error', message: err.message, retry: 'no' } });
});

app.get('/health', async () => ({ status: 'ok', service: 'forge-data-plane', state_dir: store.stateDir() }));

// Discovery — only the data-plane capabilities.
app.get('/capabilities', async () => ({
  capabilities: describeCapabilities().filter((c) => DATA_PLANE_SLUGS.has(c.slug)),
}));

app.post('/capabilities/:slug', async (req, reply) => {
  const { slug } = req.params as { slug: string };
  if (!DATA_PLANE_SLUGS.has(slug)) {
    return reply.status(404).send({
      error: { code: 'not_found', message: `Capability "${slug}" is not served by the data plane (control-plane only).`, retry: 'change-input' },
    });
  }
  const actor = actorFromHeaders(req.headers as Record<string, unknown>);
  const result = await executeCapability(slug, req.body, actor);
  return reply.status(200).send(result);
});

// Read surfaces (state + facts) — safe in production.
app.get('/resources', async (req) => {
  const q = req.query as { type?: string; app_id?: string; owner?: string };
  const type = q.type && (RESOURCE_TYPES as readonly string[]).includes(q.type) ? (q.type as ResourceType) : undefined;
  // `owner` (C11) scopes per-user resources (e.g. C1 agent-runs) to one user; omitted = app-scoped.
  return { resources: await store.listResources({ type, app_id: q.app_id, owner: q.owner }) };
});
app.get('/resources/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const r = await store.findResourceById(id);
  if (!r) return reply.status(404).send({ error: { code: 'not_found', message: `No resource "${id}".`, retry: 'change-input' } });
  return { resource: r };
});
app.get('/events', async (req) => {
  const q = req.query as { app_id?: string; resource_id?: string; limit?: string };
  return { events: await store.listEvents({ app_id: q.app_id, resource_id: q.resource_id, limit: q.limit ? Number(q.limit) : 50 }) };
});
app.get('/logs/:resourceId', async (req, reply) => {
  const { resourceId } = req.params as { resourceId: string };
  try {
    return reply.type('text/plain').send(await readFile(logPath(resourceId), 'utf8'));
  } catch {
    return reply.status(404).send({ error: { code: 'not_found', message: `No log for "${resourceId}".`, retry: 'change-input' } });
  }
});

// Application event log (C3) — the running app emits/queries its own domain events here over the
// internal network. Defaults the app to this sidecar's FORGE_APP_NAME, so the app needn't pass it.
registerAppEventRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

// Notifications (C4) — the app upserts/dismisses/clears its derived notifications here. A scheduled
// job (C2) can upsert while the user is away so the inbox is current before they open the app.
registerNotificationRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

// Identity / auth (C10) — the HOSTED login/signup/verify/reset/OAuth/sign-out pages + the session
// accessor. The app proxies `/auth/*` here (same-origin) and gates the rest of itself by verifying
// the signed session cookie locally. Defaults the app to this sidecar's FORGE_APP_NAME.
registerAuthRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

// Owner-scoping migration (C11) — one-time `claim-legacy` cutover assigning owner-less C3/C4/C1
// records to a seeded owner. Runs on the data plane so a production cutover needs no control plane.
registerOwnerRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

// App theming (C16) — `GET /theme.css`: the app's `--forge-*` tokens + sandboxed custom CSS. The
// theme is resolved from FORGE_THEME_FILE (the sidecar mount productionize wires). Defaults the app
// to this sidecar's FORGE_APP_NAME.
registerThemeRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

// Status page (C15) — `GET /status` (+ `/status.json`): the PUBLIC themed health dashboard. In prod
// this sidecar reaches the app's C6 health over the compose network (FORGE_APP_CALLBACK_HOST/PORT +
// FORGE_READINESS_PATH, which productionize sets). Defaults the app to this sidecar's FORGE_APP_NAME.
registerStatusRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME, planeLabel: 'Forge data plane' });

// In production there is no `./forge provision`, so seed a minimal Application
// record for the app this sidecar serves — enough for schedule-job/inspect to
// resolve it by name. The scheduler reaches the app via env, not this record.
async function ensureApp(name: string): Promise<Application> {
  const existing = (await store.findAppByName(name)) as Application | null;
  if (existing) return existing;
  const id = process.env.FORGE_APP_ID ?? newResourceId('Application');
  const now = nowIso();
  const resource: Application = {
    id, type: 'Application', app_id: id, created_at: now, updated_at: now,
    name, repo_path: process.env.FORGE_APP_REPO_PATH ?? '/app',
    platform: 'web', framework: 'nextjs', template: 'nextjs-web', language: 'typescript', package_manager: 'npm',
  };
  await store.saveResource(resource);
  return resource;
}

// Optionally register scheduled jobs declared in a mounted JSON file, e.g.
//   [{ "name": "reminders", "every": "15m", "target_path": "/api/cron/reminders" }]
async function loadJobsFile(appName: string): Promise<number> {
  const file = process.env.FORGE_JOBS_FILE;
  if (!file) return 0;
  let jobs: unknown;
  try {
    jobs = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return 0;
  }
  if (!Array.isArray(jobs)) return 0;
  let n = 0;
  for (const j of jobs) {
    try {
      await executeCapability('schedule-job', { app: appName, ...(j as Record<string, unknown>) }, SYSTEM_ACTOR);
      n++;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('data-plane: failed to register job', (j as { name?: string })?.name, String((e as Error)?.message ?? e));
    }
  }
  return n;
}

const port = Number(process.env.PORT ?? 3718);

async function main() {
  await store.init();
  const appName = process.env.FORGE_APP_NAME ?? 'app';
  await ensureApp(appName);
  const loaded = await loadJobsFile(appName);
  await app.listen({ port, host: '0.0.0.0' });
  startScheduler(store, {
    tickMs: process.env.FORGE_SCHEDULER_TICK_MS ? Number(process.env.FORGE_SCHEDULER_TICK_MS) : undefined,
  });
  // eslint-disable-next-line no-console
  console.log(`forge data-plane listening on http://0.0.0.0:${port} (app=${appName}, jobs=${loaded})`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('forge data-plane failed to start:', err);
  process.exit(1);
});
