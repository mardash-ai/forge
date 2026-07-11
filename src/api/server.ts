import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { store } from '../storage/store';
import { startScheduler } from '../plugins/scheduler-node/index';
import { startHealthSampler } from '../plugins/scheduler-node/health-sampler';
import { executeCapability } from '../core/runtime';
import { describeCapabilities } from '../core/registry';
import { ForgeError } from '../shared/errors';
import type { Actor } from '../shared/domain';
import { RESOURCE_TYPES, type ResourceType } from '../resources/types';
import { registerAppEventRoutes } from './app-events-routes';
import { registerNotificationRoutes } from './notifications-routes';
import { registerSearchRoutes } from './search-routes';
import { registerBlobRoutes } from './blobs-routes';
import { registerAuthRoutes } from './auth-routes';
import { registerOwnerRoutes } from './owner-routes';
import { registerThemeRoutes } from './theme-routes';
import { registerStatusRoutes } from './status-routes';
import { registerIncidentRoutes } from './incident-routes';
import { registerAuthzRoutes } from './authz-routes';
import { logPath } from '../shared/paths';
import { getBackends } from '../storage/backends';

// The Forge HTTP API. Capability APIs perform behavior; Resource/Event APIs
// expose state and facts. Humans and agents use these SAME contracts.
const app = Fastify({ logger: false });

function actorFromHeaders(headers: Record<string, unknown>): Actor {
  const type = (headers['x-forge-actor-type'] as string) || 'builder';
  const id = (headers['x-forge-actor-id'] as string) || 'local';
  const valid = ['builder', 'agent', 'system'];
  return { type: (valid.includes(type) ? type : 'builder') as Actor['type'], id };
}

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ForgeError) {
    return reply.status(err.status).send(err.toJSON());
  }
  // Zod / validation and unexpected errors.
  return reply.status(500).send({
    error: { code: 'internal_error', message: err.message, retry: 'no' },
  });
});

app.get('/health', async () => ({ status: 'ok', service: 'forge', state_dir: store.stateDir() }));

// Discovery — agents must be able to discover Forge.
app.get('/capabilities', async () => ({ capabilities: describeCapabilities() }));

// Capability APIs.
app.post('/capabilities/:slug', async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const actor = actorFromHeaders(req.headers as Record<string, unknown>);
  const result = await executeCapability(slug, req.body, actor);
  return reply.status(200).send(result);
});

// Resource APIs.
app.get('/resources', async (req) => {
  const q = req.query as { type?: string; app_id?: string; owner?: string };
  const type = q.type && (RESOURCE_TYPES as readonly string[]).includes(q.type) ? (q.type as ResourceType) : undefined;
  // `owner` (C11) scopes per-user resources (e.g. C1 agent-runs) to one user; omitted = app-scoped.
  const resources = await store.listResources({ type, app_id: q.app_id, owner: q.owner });
  return { resources };
});

app.get('/resources/:type/:id', async (req, reply) => {
  const { type, id } = req.params as { type: string; id: string };
  if (!(RESOURCE_TYPES as readonly string[]).includes(type)) {
    return reply.status(404).send({ error: { code: 'not_found', message: `Unknown resource type "${type}".`, retry: 'change-input' } });
  }
  const r = await store.getResource(type as ResourceType, id);
  if (!r) return reply.status(404).send({ error: { code: 'not_found', message: `No ${type} with id "${id}".`, retry: 'change-input' } });
  return { resource: r };
});

// Convenience: look up any resource by id alone.
app.get('/resources/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const r = await store.findResourceById(id);
  if (!r) return reply.status(404).send({ error: { code: 'not_found', message: `No resource "${id}".`, retry: 'change-input' } });
  return { resource: r };
});

// Application event log (C3) — the app emits/queries its own domain events here (dev: the app
// reaches the control plane; prod: the data-plane sidecar serves the same routes).
registerAppEventRoutes(app);

// Notifications (C4) — the app upserts/dismisses/clears its derived notifications here.
registerNotificationRoutes(app);

// Search / indexing (C19) — the app indexes its own resources and queries them full-text here
// (owner-scoped, BM25-ranked). Served here for dev; the data-plane sidecar serves the same routes
// in production, like app-events/notifications.
registerSearchRoutes(app);

// File / blob storage (C20) — the app uploads a user's file (multipart), gets an opaque `blob_id`, and
// streams the bytes back owner-scoped. Served here for dev; the data-plane sidecar serves the same
// routes in production, like app-events/notifications/search.
registerBlobRoutes(app);

// Identity / auth (C10) — hosted login/signup/verify/reset/OAuth/sign-out pages + session accessor.
// Served here for dev; the data-plane sidecar serves the same routes in production.
registerAuthRoutes(app);

// Owner-scoping migration (C11) — one-time `claim-legacy` cutover that assigns owner-less shared-store
// records (C3/C4/C1) to a seeded owner. Owner-scoping itself is just an added dimension on the C3/C4/C1
// routes above; this is only the migration primitive.
registerOwnerRoutes(app);

// App theming (C16) — `GET /theme.css`: the app's `--forge-*` token set + sandboxed custom CSS.
// The auth (C10) + status (C15) pages render from these SAME tokens, so theming once themes all
// platform-served UI. Public; per-app resolved (dev is multi-app, so no default).
registerThemeRoutes(app);

// Status page (C15) — `GET /status` (+ `/status.json`): a PUBLIC, themed dashboard aggregating the
// app's live C6 health into an overall banner + per-component rows. Served here for dev; the
// data-plane sidecar serves the same routes in production (like /auth).
registerStatusRoutes(app, { planeLabel: 'Forge control plane' });

// Status incidents (C15 Phase 3) — the OPERATOR write surface (create/update/resolve/list)
// behind `forge status incident …`. The public rendering rides `/status` above; served here
// for dev, and on the data-plane sidecar in prod.
registerIncidentRoutes(app);

// Authorization / policy engine (C29) — the deterministic `POST /authorize` (evaluate + C3 audit),
// policy CRUD, and the progressive-autonomy approvals surface. Served on both planes.
registerAuthzRoutes(app);

// Event APIs.
app.get('/events', async (req) => {
  const q = req.query as { app_id?: string; resource_id?: string; limit?: string };
  const events = await store.listEvents({
    app_id: q.app_id,
    resource_id: q.resource_id,
    limit: q.limit ? Number(q.limit) : 50,
  });
  return { events };
});

// Full logs — never returned by default; explicit endpoint only.
app.get('/logs/:resourceId', async (req, reply) => {
  const { resourceId } = req.params as { resourceId: string };
  try {
    const content = await readFile(logPath(resourceId), 'utf8');
    return reply.type('text/plain').send(content);
  } catch {
    return reply.status(404).send({ error: { code: 'not_found', message: `No log for "${resourceId}".`, retry: 'change-input' } });
  }
});

const port = Number(process.env.PORT ?? 3717);

async function main() {
  await store.init();
  // P26 — eager backend init: fail the boot on a bad datastore config (opens the Postgres pool +
  // ensures the schema when selected; a cheap no-op for the filesystem default).
  const backends = await getBackends();
  await app.listen({ port, host: '0.0.0.0' });
  // Resume durable scheduled work (C2) — jobs due while the plane was down fire now.
  startScheduler(store, {
    tickMs: process.env.FORGE_SCHEDULER_TICK_MS ? Number(process.env.FORGE_SCHEDULER_TICK_MS) : undefined,
  });
  // C15 Phase 2 — the health sampler (opt-in via FORGE_STATUS_SAMPLE) records the
  // per-app uptime history the status page renders. No-op when disabled.
  startHealthSampler(store, { planeLabel: 'Forge control plane' });
  // eslint-disable-next-line no-console
  console.log(`forge api listening on http://0.0.0.0:${port} (store ${backends.describe()})`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('forge api failed to start:', err);
  process.exit(1);
});
