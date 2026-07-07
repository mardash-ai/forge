import type { FastifyInstance } from 'fastify';
import { store } from '../storage/store';

// C11 — the owner-scoping MIGRATION surface. Owner-scoping is otherwise pure runtime behavior
// (emit/write take an `owner`; feed/query/inspect filter by it). This route is the one-time cutover
// primitive: when a previously single-user app adopts C10 identity, its shared-store records emitted
// BEFORE C11 have no owner. `claim-legacy` assigns every owner-LESS record across the platform's
// shared stores — C3 app events, C4 notifications, C1 agent-runs (+ their Artifacts) — to a single
// `owner` (the seeded owner user id). It is the platform-side counterpart to a consumer backfilling
// its OWN tables; the platform can't reach into its stores from the app, so it exposes this.
//
//   POST /owner/claim-legacy   { app?, owner }   -> { owner, claimed: { app_events, notifications, agent_runs } }
//
// Idempotent — already-owned records are untouched, so re-running claims only what's still legacy.
// `app` defaults to the server's own app (data-plane: FORGE_APP_NAME), so the app needn't pass it.
export function registerOwnerRoutes(
  app: FastifyInstance,
  opts: { defaultApp?: () => string | undefined } = {},
): void {
  const resolveAppId = async (name?: string): Promise<string | null> => {
    const n = name ?? opts.defaultApp?.();
    if (!n) return null;
    const a = await store.findAppByName(n);
    return a && a.type === 'Application' ? a.id : null;
  };
  const unknownApp = { error: { code: 'not_found', message: 'unknown app (pass `app` or set FORGE_APP_NAME).', retry: 'change-input' } };

  app.post('/owner/claim-legacy', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; owner?: string };
    if (!b.owner || typeof b.owner !== 'string') {
      return reply.status(422).send({ error: { code: 'invalid_input', message: 'claim-legacy requires a string `owner`.', retry: 'change-input' } });
    }
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);

    // Claim across every owner-scoped shared store. C1 spans two resource types (the run + its
    // artifact), so both are claimed to keep a run and its result attributed to the same owner.
    const app_events = await store.assignAppEventOwner(app_id, b.owner);
    const notifications = await store.assignNotificationOwner(app_id, b.owner);
    const agent_runs = await store.assignResourceOwner('AgentTask', app_id, b.owner);
    await store.assignResourceOwner('Artifact', app_id, b.owner);

    return reply.status(200).send({ owner: b.owner, claimed: { app_events, notifications, agent_runs } });
  });
}
