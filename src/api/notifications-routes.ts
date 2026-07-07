import type { FastifyInstance } from 'fastify';
import { store } from '../storage/store';

// C4 — the notification surface. Registered on BOTH the control-plane API (dev) and the data-plane
// server (prod sidecar), like the C3 app-event routes (app→Forge). The app derives WHICH conditions
// matter (domain) and upserts a notification by stable key; Forge persists + tracks dismissal + clear.
//
//   POST /notifications           { app?, key, title, body?, data?, subject? }  -> { notification }
//   POST /notifications/dismiss   { app?, key }                                 -> { dismissed }
//   POST /notifications/clear     { app?, key }                                 -> { cleared }
//   GET  /notifications           ?app=&include_dismissed=                      -> { notifications }  (newest-first)
//
// `app` defaults to the server's own app (data-plane: FORGE_APP_NAME), so the app needn't pass it.
export function registerNotificationRoutes(
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
  const badKey = { error: { code: 'invalid_input', message: 'a notification requires a string `key`.', retry: 'change-input' } };

  app.post('/notifications', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; key?: string; title?: string; body?: string; data?: Record<string, unknown>; subject?: string };
    if (!b.key || typeof b.key !== 'string') return reply.status(422).send(badKey);
    if (!b.title || typeof b.title !== 'string') {
      return reply.status(422).send({ error: { code: 'invalid_input', message: 'a notification requires a string `title`.', retry: 'change-input' } });
    }
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const notification = await store.upsertNotification(app_id, { key: b.key, title: b.title, body: b.body, data: b.data, subject: b.subject });
    return reply.status(200).send({ notification });
  });

  app.post('/notifications/dismiss', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; key?: string };
    if (!b.key || typeof b.key !== 'string') return reply.status(422).send(badKey);
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    return { dismissed: await store.dismissNotification(app_id, b.key) };
  });

  app.post('/notifications/clear', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; key?: string };
    if (!b.key || typeof b.key !== 'string') return reply.status(422).send(badKey);
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    return { cleared: await store.clearNotification(app_id, b.key) };
  });

  app.get('/notifications', async (req, reply) => {
    const q = req.query as { app?: string; include_dismissed?: string };
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const includeDismissed = q.include_dismissed === 'true' || q.include_dismissed === '1';
    return { notifications: await store.listNotifications(app_id, { includeDismissed }) };
  });
}
