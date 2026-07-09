import type { FastifyInstance, FastifyRequest } from 'fastify';
import { store } from '../storage/store';
import { incidentStore } from '../storage/incident-store';
import { resolveAppLenient } from '../capabilities/_shared';
import type { Actor } from '../shared/domain';
import {
  type Incident,
  INCIDENT_STATUSES,
  INCIDENT_IMPACTS,
  isIncidentStatus,
  isIncidentImpact,
  normalizeComponents,
  orderActive,
  orderResolved,
  incidentJson,
} from '../incidents/types';

// C15 Phase 3 — the OPERATOR surface for status incidents (the control-plane side of
// the capability; the public rendering lives on the data plane in `/status`). An
// operator declares / updates / resolves / lists incidents here; the status page reads
// the same store and renders them publicly.
//
//   POST /status/incidents          { app?, title, status, impact, components?, body? } -> { incident }
//   POST /status/incidents/update   { app?, id, status, body? }                          -> { incident }
//   POST /status/incidents/resolve  { app?, id, body? }                                  -> { incident }
//   GET  /status/incidents          ?app=                                                -> { incidents } (active then recent-resolved)
//
// `app` defaults to the server's own app (data-plane: FORGE_APP_NAME) so a single-app
// operator needn't pass it, and is resolved LENIENTLY — a store-registered Application when
// there is one, else the single-app `app/forge.app.json` — so an operator can declare incidents
// on a box provisioned via deploy/productionize whose Application store was never populated by
// `forge init app` (P25; the same store-optional resolution `forge release`/`deploy` use, P19).
// These are WRITE/operator routes — unlike `/status` + `/status.json` (the public read surface),
// they are not meant to be publicly proxied.
//
// Each mutation emits the matching platform fact (IncidentOpened / IncidentUpdated /
// IncidentResolved) into the ForgeEvent log, like the other status facts.

function actorFromHeaders(headers: Record<string, unknown>): Actor {
  const type = (headers['x-forge-actor-type'] as string) || 'builder';
  const id = (headers['x-forge-actor-id'] as string) || 'operator';
  const valid = ['builder', 'agent', 'system'];
  return { type: (valid.includes(type) ? type : 'builder') as Actor['type'], id };
}

export function registerIncidentRoutes(
  app: FastifyInstance,
  opts: { defaultApp?: () => string | undefined } = {},
): void {
  // Resolve the app to a STABLE incident-store key, the SAME lenient way `forge release` /
  // `deploy` / `productionize` resolve their target (P19 → P25). A store-registered Application
  // WINS — its id links the `/status` render + the emitted facts. But on a box PROVISIONED via
  // deploy/productionize, whose control-plane Application store was NEVER populated by
  // `forge init app`, the app is inferred from the single-app layout + the committed
  // `app/forge.app.json` (exactly like `forge release`). Before this, `status incident` used the
  // STRICT lookup and 404'd `not_found` on that store-less box even with FORGE_APP_NAME set.
  //
  // The key is `id ?? name`: on the DATA PLANE (where the public `/status` renders these) the boot
  // `ensureApp` registers the app, so `id` is present and BOTH the incident write and the `/status`
  // read key by that same id — the incident store is the one, data-plane-resident `forge_state`
  // store `/status` reads. A store-less box keys by the app NAME (its only stable ref). Returns
  // null only when NEITHER a store record NOR a readable `app/forge.app.json` resolves the app —
  // the honest unknown-app case that still 404s.
  const resolveAppKey = async (name?: string): Promise<string | null> => {
    const n = name ?? opts.defaultApp?.();
    if (!n) return null;
    try {
      const target = await resolveAppLenient(store, n);
      return target.id ?? target.name;
    } catch {
      return null;
    }
  };
  const unknownApp = { error: { code: 'not_found', message: 'unknown app (pass `app` or set FORGE_APP_NAME).', retry: 'change-input' } };
  const notFound = { error: { code: 'not_found', message: 'no such incident for this app.', retry: 'change-input' } };
  const invalid = (message: string) => ({ error: { code: 'invalid_input', message, retry: 'change-input' } });

  const emit = async (
    req: FastifyRequest,
    type: 'IncidentOpened' | 'IncidentUpdated' | 'IncidentResolved',
    app_id: string,
    inc: Incident,
    data: Record<string, unknown>,
  ): Promise<void> => {
    await store.appendEvent({
      type,
      resource_type: 'Incident',
      resource_id: inc.id,
      app_id,
      actor: actorFromHeaders(req.headers as Record<string, unknown>),
      data,
    });
  };

  // Create an incident.
  app.post('/status/incidents', async (req, reply) => {
    const b = (req.body ?? {}) as {
      app?: string; title?: string; status?: string; impact?: string;
      components?: unknown; affected_components?: unknown; body?: string;
    };
    if (!b.title || typeof b.title !== 'string' || !b.title.trim()) {
      return reply.status(422).send(invalid('an incident requires a non-empty string `title`.'));
    }
    if (!isIncidentStatus(b.status)) {
      return reply.status(422).send(invalid(`\`status\` must be one of: ${INCIDENT_STATUSES.join(', ')}.`));
    }
    if (!isIncidentImpact(b.impact)) {
      return reply.status(422).send(invalid(`\`impact\` must be one of: ${INCIDENT_IMPACTS.join(', ')}.`));
    }
    const app_id = await resolveAppKey(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const inc = await incidentStore.create(app_id, {
      title: b.title.trim(),
      status: b.status,
      impact: b.impact,
      affected_components: normalizeComponents(b.components ?? b.affected_components),
      ...(typeof b.body === 'string' ? { body: b.body } : {}),
    });
    await emit(req, 'IncidentOpened', app_id, inc, {
      title: inc.title, status: inc.status, impact: inc.impact, affected_components: inc.affected_components,
    });
    return reply.status(200).send({ incident: incidentJson(inc) });
  });

  // Append an update to an incident.
  app.post('/status/incidents/update', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; id?: string; status?: string; body?: string };
    if (!b.id || typeof b.id !== 'string') return reply.status(422).send(invalid('an update requires the incident `id`.'));
    if (!isIncidentStatus(b.status)) {
      return reply.status(422).send(invalid(`\`status\` must be one of: ${INCIDENT_STATUSES.join(', ')}.`));
    }
    const app_id = await resolveAppKey(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const inc = await incidentStore.update(app_id, b.id, {
      status: b.status,
      ...(typeof b.body === 'string' ? { body: b.body } : {}),
    });
    if (!inc) return reply.status(404).send(notFound);
    const type = inc.status === 'resolved' ? 'IncidentResolved' : 'IncidentUpdated';
    await emit(req, type, app_id, inc, {
      status: inc.status, ...(inc.resolved_at ? { resolved_at: inc.resolved_at } : {}),
    });
    return reply.status(200).send({ incident: incidentJson(inc) });
  });

  // Resolve an incident (forces status:resolved + appends a final update).
  app.post('/status/incidents/resolve', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; id?: string; body?: string };
    if (!b.id || typeof b.id !== 'string') return reply.status(422).send(invalid('resolve requires the incident `id`.'));
    const app_id = await resolveAppKey(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const inc = await incidentStore.resolve(app_id, b.id, {
      ...(typeof b.body === 'string' ? { body: b.body } : {}),
    });
    if (!inc) return reply.status(404).send(notFound);
    await emit(req, 'IncidentResolved', app_id, inc, { status: inc.status, resolved_at: inc.resolved_at });
    return reply.status(200).send({ incident: incidentJson(inc) });
  });

  // List incidents (active newest-first, then recent-resolved).
  app.get('/status/incidents', async (req, reply) => {
    const q = req.query as { app?: string };
    const app_id = await resolveAppKey(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const all = await incidentStore.list(app_id);
    const incidents = [...orderActive(all), ...orderResolved(all)].map(incidentJson);
    return reply.status(200).send({ incidents });
  });
}
