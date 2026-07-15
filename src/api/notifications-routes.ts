import type { FastifyInstance } from 'fastify';
import { store } from '../storage/store';
import { notify, normalizeChannels, CHANNELS, type Channel } from '../notifications/delivery';
import { getVapidPublicKey } from '../notifications/vapid';

// C4 + C21 — the notification surface. Registered on BOTH the control-plane API (dev) and the data-plane
// server (prod sidecar), like the C3 app-event routes (app→Forge). The app derives WHICH conditions matter
// (domain) and upserts a notification by stable key; Forge persists + tracks dismissal + clear, and — when
// the caller asks — DELIVERS the notification out over browser push (Web Push / VAPID) and/or email (C21).
//
//   POST /notifications                    { app?, key, title, body?, data?, subject?, owner?,
//                                            channels?, idempotency_key? }  -> { notification?, delivery? }
//   POST /notifications/dismiss            { app?, key, owner? }            -> { dismissed }
//   POST /notifications/clear              { app?, key, owner? }            -> { cleared }
//   GET  /notifications                    ?app=&include_dismissed=&owner=  -> { notifications }  (newest-first)
//
//   C21 delivery surface (push subscriptions + the VAPID public key):
//   GET  /notifications/vapid-public-key   ?app=                           -> { public_key, applicationServerKey }
//   POST /notifications/push/subscribe     { app?, owner, subscription }   -> { subscribed, endpoint }
//   POST /notifications/push/unsubscribe   { app?, owner?, endpoint }      -> { unsubscribed }
//
// `app` defaults to the server's own app (data-plane: FORGE_APP_NAME), so the app needn't pass it.
//
// `owner` (C11) is the opaque per-user id (C10's session `userId`), which the APP derives from the verified
// session and passes here — it is NEVER trusted from the browser directly (same trust model as the C4
// store / C19 search / C20 blobs). Scoping is by (app, owner): a subscription belongs to one user, and
// dismiss/clear/list act on the caller's own. Omitting `owner` is app-scoped (all owners) for the C4 store;
// push/email delivery require an owner (there is otherwise no per-user target).
export function registerNotificationRoutes(
  app: FastifyInstance,
  opts: { defaultApp?: () => string | undefined } = {},
): void {
  const resolveApp = async (name?: string): Promise<{ id: string; name: string } | null> => {
    const n = name ?? opts.defaultApp?.();
    if (!n) return null;
    const a = await store.findAppByName(n);
    return a && a.type === 'Application' ? { id: a.id, name: n } : null;
  };
  const resolveAppId = async (name?: string): Promise<string | null> => (await resolveApp(name))?.id ?? null;
  const unknownApp = { error: { code: 'not_found', message: 'unknown app (pass `app` or set FORGE_APP_NAME).', retry: 'change-input' } };
  const badKey = { error: { code: 'invalid_input', message: 'a notification requires a string `key`.', retry: 'change-input' } };

  app.post('/notifications', async (req, reply) => {
    const b = (req.body ?? {}) as {
      app?: string; key?: string; title?: string; body?: string; data?: Record<string, unknown>;
      subject?: string; owner?: string; channels?: unknown; idempotency_key?: string;
    };
    if (!b.key || typeof b.key !== 'string') return reply.status(422).send(badKey);
    if (!b.title || typeof b.title !== 'string') {
      return reply.status(422).send({ error: { code: 'invalid_input', message: 'a notification requires a string `title`.', retry: 'change-input' } });
    }
    // Validate `channels` (a subset of in_app|push|email) BEFORE resolving the app, so a bad request is a
    // clean 422. Absent/empty → default ['in_app'] (backward compatible).
    if (b.channels !== undefined) {
      if (!Array.isArray(b.channels) || b.channels.some((c) => typeof c !== 'string' || !(CHANNELS as readonly string[]).includes(c))) {
        return reply.status(422).send({
          error: { code: 'invalid_input', message: `channels must be a subset of ${CHANNELS.join('|')}.`, retry: 'change-input' },
        });
      }
    }
    const resolved = await resolveApp(b.app);
    if (!resolved) return reply.status(404).send(unknownApp);
    const channels = normalizeChannels(b.channels as string[] | undefined) as Channel[];
    const result = await notify(resolved.id, resolved.name, {
      key: b.key, title: b.title, body: b.body, data: b.data, subject: b.subject, owner: b.owner,
      channels, ...(b.idempotency_key ? { idempotencyKey: b.idempotency_key } : {}),
    });
    // Backward compatible: a pure-in_app notify() returns exactly `{ notification }`; delivery is added
    // only when an external channel was requested.
    const payload: Record<string, unknown> = {};
    if (result.notification) payload.notification = result.notification;
    if (result.delivery) payload.delivery = result.delivery;
    return reply.status(200).send(payload);
  });

  app.post('/notifications/dismiss', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; key?: string; owner?: string };
    if (!b.key || typeof b.key !== 'string') return reply.status(422).send(badKey);
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    return { dismissed: await store.dismissNotification(app_id, b.key, b.owner) };
  });

  app.post('/notifications/clear', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; key?: string; owner?: string };
    if (!b.key || typeof b.key !== 'string') return reply.status(422).send(badKey);
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    return { cleared: await store.clearNotification(app_id, b.key, b.owner) };
  });

  app.get('/notifications', async (req, reply) => {
    const q = req.query as { app?: string; include_dismissed?: string; owner?: string };
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const includeDismissed = q.include_dismissed === 'true' || q.include_dismissed === '1';
    return { notifications: await store.listNotifications(app_id, { includeDismissed, owner: q.owner }) };
  });

  // --- C21 delivery surface -------------------------------------------------------------------------

  // The app's VAPID public key — the `applicationServerKey` a browser passes to `pushManager.subscribe`.
  // Auto-generates + persists the keypair on first read (zero operator config). PUBLIC (the key is meant
  // to be shared); no owner needed. dorinda-web's service worker fetches this (proxied same-origin).
  app.get('/notifications/vapid-public-key', async (req, reply) => {
    const app_id = await resolveAppId((req.query as { app?: string }).app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const publicKey = await getVapidPublicKey(app_id);
    // `applicationServerKey` is an alias for the same value, named as the Web Push API expects it.
    return { public_key: publicKey, applicationServerKey: publicKey };
  });

  // Register a browser PushSubscription for the caller (owner from the verified session, passed by the
  // app). Idempotent — deduped by endpoint (a device re-subscribing UPDATES in place). A person may hold
  // many devices.
  app.post('/notifications/push/subscribe', async (req, reply) => {
    const b = (req.body ?? {}) as {
      app?: string; owner?: string;
      subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    };
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    if (!b.owner || typeof b.owner !== 'string') {
      return reply.status(422).send({ error: { code: 'invalid_input', message: 'push subscribe requires an `owner` (the session userId).', retry: 'change-input' } });
    }
    const sub = b.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') {
      return reply.status(422).send({
        error: { code: 'invalid_input', message: 'push subscribe requires `subscription` = { endpoint, keys: { p256dh, auth } }.', retry: 'change-input' },
      });
    }
    const rec = await store.registerPushSubscription(app_id, {
      owner: b.owner, endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    return reply.status(200).send({ subscribed: true, endpoint: rec.endpoint });
  });

  // Unregister a browser PushSubscription by endpoint. When `owner` is supplied it must own the endpoint
  // (a user can only remove their own device). Idempotent (false when the endpoint was not registered).
  app.post('/notifications/push/unsubscribe', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; owner?: string; endpoint?: string };
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    if (!b.endpoint || typeof b.endpoint !== 'string') {
      return reply.status(422).send({ error: { code: 'invalid_input', message: 'push unsubscribe requires an `endpoint`.', retry: 'change-input' } });
    }
    return { unsubscribed: await store.unregisterPushSubscription(app_id, b.endpoint, b.owner) };
  });
}
