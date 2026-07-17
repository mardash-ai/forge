import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import { store } from '../storage/store';
import { executeCapability } from '../core/runtime';
import { describeCapabilities } from '../core/registry';
import { capabilities } from '../capabilities/index';
import { startScheduler } from '../plugins/scheduler-node/index';
import { startHealthSampler } from '../plugins/scheduler-node/health-sampler';
import { ForgeError } from '../shared/errors';
import { SYSTEM_ACTOR, type Actor } from '../shared/domain';
import { RESOURCE_TYPES, type ResourceType, type Application } from '../resources/types';
import { newResourceId } from '../shared/ids';
import { nowIso } from '../shared/time';
import { registerAppEventRoutes } from '../api/app-events-routes';
import { registerNotificationRoutes } from '../api/notifications-routes';
import { registerSearchRoutes } from '../api/search-routes';
import { registerBlobRoutes } from '../api/blobs-routes';
import { registerAuthRoutes } from '../api/auth-routes';
import { registerOwnerRoutes } from '../api/owner-routes';
import { registerThemeRoutes } from '../api/theme-routes';
import { registerStatusRoutes } from '../api/status-routes';
import { registerIncidentRoutes } from '../api/incident-routes';
import { registerAuthzRoutes } from '../api/authz-routes';
import { registerOAuthRoutes } from '../api/oauth-routes';
import { registerMcpRoutes } from '../api/mcp-routes';
import { initOtelLangfuse } from '../plugins/otel-langfuse/index';
import { registerConnectRoutes } from '../api/connect-routes';
import { registerMembershipRoutes } from '../api/membership-routes';
import { registerBillingRoutes } from '../api/billing-routes';
import { logPath } from '../shared/paths';
import { getBackends } from '../storage/backends';

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

// Search / indexing (C19) — the running app indexes its own resources and queries them full-text over
// the internal network (owner-scoped, BM25-ranked, best-effort writes). Defaults the app to this
// sidecar's FORGE_APP_NAME, so the app needn't pass it.
registerSearchRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

// File / blob storage (C20) — the running app uploads a user's file over the internal network and
// streams the bytes back owner-scoped. Bytes ride the durable forge_state volume (FORGE_STATE_DIR), so
// uploads survive a redeploy like auth/secrets. Defaults the app to this sidecar's FORGE_APP_NAME.
registerBlobRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

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

// Status incidents (C15 Phase 3) — the operator write surface (create/update/resolve/list) an
// operator reaches over the internal network to declare an incident against production; the public
// `/status` render above reads the same store. Defaults the app to this sidecar's FORGE_APP_NAME.
registerIncidentRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

// Authorization / policy engine (C29) — deterministic `POST /authorize` (+ C3 audit), policy CRUD, and
// the progressive-autonomy approvals surface. The running app calls these over the internal network.
registerAuthzRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

// OAuth 2.1 authorization server (C23) — the app proxies `/oauth/*` + `/.well-known/oauth-authorization-server`
// here (same-origin). Dynamic client registration + the authorize/consent flow (PKCE) + the token endpoint
// mint the scoped access/refresh tokens the MCP host verifies. Defaults the app to this sidecar's FORGE_APP_NAME.
registerOAuthRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

// Remote MCP server hosting (C23) — the app proxies `/mcp` + `/.well-known/oauth-protected-resource` here.
// `POST /mcp` (OAuth-gated JSON-RPC) serves the app's tools + dispatches each call back into the app over the
// compose network (like the scheduler), with scope enforcement + C3 attribution. The `/mcp/*` management
// routes register tools, version the instruction block, and schedule proactive prompts via C2. Defaults the
// app to this sidecar's FORGE_APP_NAME.
registerMcpRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

// Third-party connectors / outbound OAuth (C24) — the running app proxies `/connect/*` here (same-origin).
// Users connect their Google/Microsoft accounts; forge stores the tokens ENCRYPTED at rest (C5 master key),
// auto-refreshes them, and brokers a FRESH access token so the app calls the provider AS the user without
// ever handling raw tokens. Owner comes from the C10 session; the broker also accepts the C10 service token
// for background sends (e.g. the outbound-email capability). Defaults the app to this sidecar's FORGE_APP_NAME.
registerConnectRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

// Household / multi-member identity + roles + shared-private scoping (C31) — the membership lifecycle
// surface (groups + members + invitations + the app role registry). The running app drives membership over
// the internal network; the C29 `/authorize` above resolves the caller's role from this graph server-side.
// Defaults the app to this sidecar's FORGE_APP_NAME.
registerMembershipRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

// Billing / subscriptions / entitlements (C33) — the app proxies the browser-facing `/billing/*` ops
// SAME-ORIGIN here (subscription/entitlement reads, checkout, portal) and proxies Stripe's webhook RAW to
// `/hooks/billing/stripe`. The platform holds the Stripe key + verifies the webhook signature from raw
// bytes; the app never imports a Stripe SDK, sees the key, or parses an event. Payment-source-agnostic
// (stripe live; apple/google reserved). Defaults the app to this sidecar's FORGE_APP_NAME.
registerBillingRoutes(app, { defaultApp: () => process.env.FORGE_APP_NAME });

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
  // C36 — wire the OTel→Langfuse exporter once at boot. Returns false (tracing silently disabled) when
  // LANGFUSE_PUBLIC_KEY/SECRET_KEY are absent, so an un-instrumented deploy behaves exactly as before.
  const otelOn = initOtelLangfuse({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'forge-data-plane' });
  // P26 — initialize the pluggable store backends EAGERLY so a bad datastore config fails the boot,
  // not the first request. When a Postgres backend is selected (FORGE_IDENTITY_BACKEND=postgres) this
  // opens the pool + ensures the schema, and throws (→ process exit below) if FORGE_DB_URL is missing
  // or the database is unreachable. Filesystem (the default) is a cheap no-op.
  const backends = await getBackends();
  const appName = process.env.FORGE_APP_NAME ?? 'app';
  await ensureApp(appName);
  const loaded = await loadJobsFile(appName);
  await app.listen({ port, host: '0.0.0.0' });
  startScheduler(store, {
    tickMs: process.env.FORGE_SCHEDULER_TICK_MS ? Number(process.env.FORGE_SCHEDULER_TICK_MS) : undefined,
  });
  // C15 Phase 2 — the health sampler (opt-in via FORGE_STATUS_SAMPLE) records the
  // per-app uptime history the status page renders. No-op when disabled.
  startHealthSampler(store, { planeLabel: 'Forge data plane' });
  // eslint-disable-next-line no-console
  console.log(`forge data-plane listening on http://0.0.0.0:${port} (app=${appName}, jobs=${loaded}, store ${backends.describe()}, otel=${otelOn ? 'on' : 'off'})`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('forge data-plane failed to start:', err);
  process.exit(1);
});
