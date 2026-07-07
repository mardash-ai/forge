import type { FastifyInstance } from 'fastify';
import { store } from '../storage/store';

// C3 — the application event log surface. Registered on BOTH the control-plane API (dev) and the
// data-plane server (prod sidecar), because this is the first APP→FORGE direction: the running app
// emits its own domain events and queries them back. Emit is best-effort (the app fire-and-forgets;
// a failed emit must never break the mutation that triggered it — that contract lives in the app's
// client, but these routes never throw for "nothing there" either).
//
//   POST /app-events            { app?, type, subject?, owner?, data? }  -> { event }
//   GET  /app-events            ?app=&subject=&owner=&limit=            -> { events }   (newest-first)
//   GET  /app-events/latest     ?app=&owner=                           -> { latest }   (subject -> ISO)
//
// `app` is the Application NAME; it defaults to the server's own app (data-plane: FORGE_APP_NAME),
// so the app usually doesn't pass it. Resolves to an app_id via the seeded Application record.
//
// `owner` (C11) is the opaque per-user id (C10's session `userId`). The app passes it on BOTH emit
// and read so events are partitioned by (app, owner): a read scoped to an owner returns ONLY that
// owner's events — user A can never read user B. Omitting `owner` is app-scoped (all owners), so a
// C10-less app and pre-C11 events keep working unchanged.
export function registerAppEventRoutes(
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

  app.post('/app-events', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; type?: string; subject?: string; owner?: string; data?: Record<string, unknown> };
    if (!b.type || typeof b.type !== 'string') {
      return reply.status(422).send({ error: { code: 'invalid_input', message: 'an app event requires a string `type`.', retry: 'change-input' } });
    }
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const event = await store.appendAppEvent({ app_id, type: b.type, subject: b.subject, owner: b.owner, data: b.data });
    return reply.status(200).send({ event });
  });

  app.get('/app-events', async (req, reply) => {
    const q = req.query as { app?: string; subject?: string; owner?: string; limit?: string };
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const events = await store.listAppEvents({ app_id, subject: q.subject, owner: q.owner, limit: q.limit ? Number(q.limit) : undefined });
    return { events };
  });

  app.get('/app-events/latest', async (req, reply) => {
    const q = req.query as { app?: string; owner?: string };
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    return { latest: await store.latestAppEventTimes(app_id, q.owner) };
  });
}
