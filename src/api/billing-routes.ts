import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { store } from '../storage/store';
import { ForgeError } from '../shared/errors';
import { APP_HEADER, SESSION_COOKIE, SERVICE_TOKEN_HEADER, verifySessionToken, parseCookies } from '../shared/session';
import { resolveAuthConfig, resolveServiceToken, serviceTokenMatches } from '../plugins/auth-identity/index';
import * as authStore from '../plugins/auth-identity/store';
import {
  getSubscription,
  getEntitlementsView,
  getEntitlementView,
  getCatalog,
  putCatalog,
  createCheckout,
  createPortal,
  handleStripeWebhook,
  reconcileApp,
  deleteCustomer,
} from '../billing/service';
import { resolveBillingConfig } from '../billing/config';

// C33 — the billing HTTP surface. The app proxies the browser-facing ops SAME-ORIGIN to this sidecar (like
// `/auth/*`, `/connect/*`), so the C10 session cookie rides along and the SUBSCRIBER is ALWAYS derived from
// the verified session — never trusted from the client. A background/server call (a reconcile check) may
// instead authenticate with the app's C10 SERVICE token and pass `subscriber` — the same trusted-internal
// model as the C2 scheduler / the C24 broker. The platform holds the Stripe key and does ALL Stripe I/O;
// the app never imports a Stripe SDK, never sees the key, and never parses a raw event.
//
//   GET  /billing/subscription     ?subscriber=       -> SubscriptionRecord (200; `none` when absent, never 404)
//   GET  /billing/entitlements     ?subscriber=       -> { plan_key, source, status, entitlements }
//   GET  /billing/entitlement      ?subscriber=&key=  -> { key, value, source, plan_key }
//   GET  /billing/catalog          ?app=              -> { plans }                     (public product info)
//   PUT  /billing/catalog          { app?, plans }    -> { plans }                     (idempotent; SERVICE token)
//   POST /billing/checkout         { subscriber, plan_key, success_url, cancel_url, scope_ref?, customer_email? } -> { url, session_id }
//   POST /billing/portal           { subscriber, return_url } -> { url }               (404 not_a_customer)
//   POST /billing/reconcile        { app? }           -> { reconciled, skipped }       (SERVICE token; self-heal)
//   DELETE /billing/customer       { app?, subscriber } -> { deleted, subscription_canceled, stripe_customer_deleted, record_dropped } (SERVICE token; idempotent teardown)
//   POST /hooks/billing/stripe     (raw; platform-owned, NOT app-called) -> verify + reconcile
//   POST /hooks/billing/apple      -> 501 not_configured  (RESERVED — adapter deferred)
//   POST /hooks/billing/google     -> 501 not_configured  (RESERVED — adapter deferred)
//
// Registered on BOTH planes (like /auth, /connect). The webhook runs in an ENCAPSULATED child scope whose
// raw-buffer body parser stays local, so it never disturbs the JSON parsing of sibling routes.

export function registerBillingRoutes(app: FastifyInstance, opts: { defaultApp?: () => string | undefined } = {}): void {
  const trimmed = (v: unknown): string | undefined => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s || undefined;
  };
  const resolveAppName = (req: FastifyRequest, explicit?: string): string | undefined => {
    const fromExplicit = trimmed(explicit);
    if (fromExplicit) return fromExplicit;
    const fromQuery = trimmed((req.query as { app?: string } | undefined)?.app);
    if (fromQuery) return fromQuery;
    const fromBody = trimmed((req.body as { app?: string } | undefined)?.app);
    if (fromBody) return fromBody;
    const hdr = req.headers[APP_HEADER];
    const fromHeader = trimmed(Array.isArray(hdr) ? hdr[0] : hdr);
    if (fromHeader) return fromHeader;
    return opts.defaultApp?.();
  };
  const resolveAppId = async (req: FastifyRequest, explicit?: string): Promise<{ id: string; name: string } | null> => {
    const n = resolveAppName(req, explicit);
    if (!n) return null;
    const a = await store.findAppByName(n);
    return a && a.type === 'Application' ? { id: a.id, name: n } : null;
  };

  async function sessionUser(req: FastifyRequest, appId: string): Promise<{ userId: string; email: string } | null> {
    const cfg = await resolveAuthConfig(appId);
    if (!cfg.sessionSecret) return null;
    const claims = verifySessionToken(parseCookies(req.headers.cookie)[SESSION_COOKIE], cfg.sessionSecret);
    if (!claims) return null;
    const s = await authStore.getSession(appId, claims.sessionId);
    if (!s || s.revoked || new Date(s.expires_at).getTime() <= Date.now()) return null;
    return { userId: claims.userId, email: claims.email };
  }

  const serviceTokenPresented = (req: FastifyRequest): string | undefined => {
    const hdr = req.headers[SERVICE_TOKEN_HEADER];
    const fromHeader = trimmed(Array.isArray(hdr) ? hdr[0] : hdr);
    if (fromHeader) return fromHeader;
    const auth = req.headers.authorization;
    const h = Array.isArray(auth) ? auth[0] : auth;
    const m = h ? /^Bearer\s+(.+)$/i.exec(h.trim()) : null;
    return m ? m[1]!.trim() : undefined;
  };

  const errorReply = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ForgeError) return reply.status(e.status).send(e.toJSON());
    return reply.status(500).send({ error: { code: 'internal_error', message: String((e as Error)?.message ?? e), retry: 'no' } });
  };

  const forbidden = { error: { code: 'forbidden', message: 'you may only access your own subscription.', retry: 'needs-human' } };
  const needAuth = { error: { code: 'unauthorized', message: 'a signed-in user (or a valid service token) is required.', retry: 'needs-human' } };

  async function hasValidServiceToken(req: FastifyRequest, appId: string): Promise<boolean> {
    const presented = serviceTokenPresented(req);
    if (!presented) return false;
    return serviceTokenMatches(presented, await resolveServiceToken(appId));
  }

  // Resolve the SUBSCRIBER for a browser-facing op. Session → the session user (a passed subscriber that
  // differs is a 403). Else a valid service token → the passed subscriber (trusted internal). Else null
  // (unauthorized). Returns { subscriber } or a sentinel describing why it failed.
  async function resolveSubscriber(
    req: FastifyRequest,
    appId: string,
    passed: string | undefined,
  ): Promise<{ subscriber: string } | { error: 'unauthorized' } | { error: 'forbidden' }> {
    const user = await sessionUser(req, appId);
    if (user) {
      if (passed && passed !== user.userId) return { error: 'forbidden' };
      return { subscriber: user.userId };
    }
    if (await hasValidServiceToken(req, appId)) {
      const sub = trimmed(passed);
      if (!sub) return { error: 'unauthorized' };
      return { subscriber: sub };
    }
    return { error: 'unauthorized' };
  }

  // === reads =======================================================================================
  app.get('/billing/subscription', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const resolved = await resolveSubscriber(req, app_.id, trimmed((req.query as { subscriber?: string }).subscriber));
    if ('error' in resolved) return reply.status(resolved.error === 'forbidden' ? 403 : 401).send(resolved.error === 'forbidden' ? forbidden : needAuth);
    return reply.status(200).send(await getSubscription(app_.id, resolved.subscriber));
  });

  app.get('/billing/entitlements', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const resolved = await resolveSubscriber(req, app_.id, trimmed((req.query as { subscriber?: string }).subscriber));
    if ('error' in resolved) return reply.status(resolved.error === 'forbidden' ? 403 : 401).send(resolved.error === 'forbidden' ? forbidden : needAuth);
    return reply.status(200).send(await getEntitlementsView(app_.id, resolved.subscriber));
  });

  app.get('/billing/entitlement', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const q = req.query as { subscriber?: string; key?: string };
    const key = trimmed(q.key);
    if (!key) return reply.status(422).send({ error: { code: 'invalid_input', message: 'a `key` is required.', retry: 'change-input' } });
    const resolved = await resolveSubscriber(req, app_.id, trimmed(q.subscriber));
    if ('error' in resolved) return reply.status(resolved.error === 'forbidden' ? 403 : 401).send(resolved.error === 'forbidden' ? forbidden : needAuth);
    return reply.status(200).send(await getEntitlementView(app_.id, resolved.subscriber, key));
  });

  // === catalog =====================================================================================
  // Public product info. `configured` is the TRUE data-plane billing state (whether STRIPE_SECRET_KEY
  // is provisioned on THIS sidecar) — the app reads it to decide whether plans are actually purchasable,
  // rather than inferring from its own env. When false, checkout/portal degrade to 503, so the app can
  // hide/disable purchase CTAs instead of surfacing plans whose checkout would fail.
  app.get('/billing/catalog', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const [catalog, cfg] = await Promise.all([getCatalog(app_.id), resolveBillingConfig(app_.id)]);
    return reply.status(200).send({ ...catalog, configured: cfg.configured });
  });

  // Catalog WRITE is an admin op (the app populates it server-side) — gated behind the C10 service token so
  // a browser on the same-origin proxy can never rewrite pricing.
  app.put('/billing/catalog', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await hasValidServiceToken(req, app_.id))) return reply.status(401).send(needAuth);
    const b = (req.body ?? {}) as { plans?: unknown };
    try {
      return reply.status(200).send(await putCatalog(app_.id, b.plans));
    } catch (e) {
      return errorReply(reply, e);
    }
  });

  // === Stripe ops ==================================================================================
  app.post('/billing/checkout', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const b = (req.body ?? {}) as {
      subscriber?: string; plan_key?: string; success_url?: string; cancel_url?: string; scope_ref?: string; customer_email?: string;
      mode?: unknown; trial_period_days?: unknown; payment_method_collection?: unknown;
    };
    const resolved = await resolveSubscriber(req, app_.id, trimmed(b.subscriber));
    if ('error' in resolved) return reply.status(resolved.error === 'forbidden' ? 403 : 401).send(resolved.error === 'forbidden' ? forbidden : needAuth);
    const planKey = trimmed(b.plan_key);
    const successUrl = trimmed(b.success_url);
    const cancelUrl = trimmed(b.cancel_url);
    if (!planKey || !successUrl || !cancelUrl) {
      return reply.status(422).send({ error: { code: 'invalid_input', message: '`plan_key`, `success_url` and `cancel_url` are required.', retry: 'change-input' } });
    }
    // Subscription is the only billing mode this platform supports. Accept the app's explicit `mode`
    // (it sends "subscription") but reject anything else clearly rather than silently ignoring it.
    if (b.mode !== undefined && String(b.mode) !== 'subscription') {
      return reply.status(422).send({ error: { code: 'invalid_input', message: '`mode` must be "subscription" (the only supported billing mode).', retry: 'change-input' } });
    }
    // Optional free trial: a positive integer day count (Stripe accepts 1–730). Absent ⇒ no trial.
    let trialPeriodDays: number | undefined;
    if (b.trial_period_days !== undefined && b.trial_period_days !== null && String(b.trial_period_days) !== '') {
      const n = Number(b.trial_period_days);
      if (!Number.isInteger(n) || n < 1 || n > 730) {
        return reply.status(422).send({ error: { code: 'invalid_input', message: '`trial_period_days` must be an integer between 1 and 730.', retry: 'change-input' } });
      }
      trialPeriodDays = n;
    }
    // Optional payment-method collection policy. Absent ⇒ Stripe default.
    let paymentMethodCollection: 'always' | 'if_required' | undefined;
    if (b.payment_method_collection !== undefined && b.payment_method_collection !== null && String(b.payment_method_collection) !== '') {
      const v = String(b.payment_method_collection);
      if (v !== 'always' && v !== 'if_required') {
        return reply.status(422).send({ error: { code: 'invalid_input', message: '`payment_method_collection` must be "always" or "if_required".', retry: 'change-input' } });
      }
      paymentMethodCollection = v;
    }
    try {
      const out = await createCheckout({
        appId: app_.id,
        subscriber: resolved.subscriber,
        planKey,
        successUrl,
        cancelUrl,
        ...(trimmed(b.scope_ref) ? { scopeRef: trimmed(b.scope_ref)! } : {}),
        ...(trimmed(b.customer_email) ? { customerEmail: trimmed(b.customer_email)! } : {}),
        ...(trialPeriodDays !== undefined ? { trialPeriodDays } : {}),
        ...(paymentMethodCollection !== undefined ? { paymentMethodCollection } : {}),
      });
      await recordC3(app_.id, 'billing.checkout_started', resolved.subscriber, { plan_key: planKey });
      return reply.status(200).send(out);
    } catch (e) {
      return errorReply(reply, e);
    }
  });

  app.post('/billing/portal', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const b = (req.body ?? {}) as { subscriber?: string; return_url?: string };
    const resolved = await resolveSubscriber(req, app_.id, trimmed(b.subscriber));
    if ('error' in resolved) return reply.status(resolved.error === 'forbidden' ? 403 : 401).send(resolved.error === 'forbidden' ? forbidden : needAuth);
    const returnUrl = trimmed(b.return_url);
    if (!returnUrl) return reply.status(422).send({ error: { code: 'invalid_input', message: '`return_url` is required.', retry: 'change-input' } });
    try {
      return reply.status(200).send(await createPortal(app_.id, resolved.subscriber, returnUrl));
    } catch (e) {
      return errorReply(reply, e);
    }
  });

  // Administrative billing-customer teardown (account closure / right-to-be-forgotten) — SERVICE-token
  // gated (NOT end-user reachable). Cancels any active/trialing subscription, deletes the Stripe customer,
  // and drops the platform subscription-of-record row for `subscriber`. Idempotent + safe when the
  // subscriber was never a customer or Stripe is unconfigured. The consumer calls this inside its own
  // account-purge cascade; the platform never touches the consumer's own domain rows.
  app.delete('/billing/customer', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await hasValidServiceToken(req, app_.id))) return reply.status(401).send(needAuth);
    const b = (req.body ?? {}) as { subscriber?: string };
    const subscriber = trimmed(b.subscriber) ?? trimmed((req.query as { subscriber?: string }).subscriber);
    if (!subscriber) {
      return reply.status(422).send({ error: { code: 'invalid_input', message: 'a `subscriber` is required.', retry: 'change-input' } });
    }
    try {
      const out = await deleteCustomer(app_.id, subscriber);
      await recordC3(app_.id, 'billing.customer_deleted', subscriber, {
        subscription_canceled: out.subscription_canceled,
        stripe_customer_deleted: out.stripe_customer_deleted,
        record_dropped: out.record_dropped,
      });
      return reply.status(200).send(out);
    } catch (e) {
      // A transient Stripe/store failure → 503 so the caller retries; the local row is untouched (the
      // Stripe teardown runs before the drop), so a retry re-attempts cleanly.
      return reply.status(503).send({ error: { code: 'billing_teardown_failed', message: String((e as Error)?.message ?? e), retry: 'retry' } });
    }
  });

  // Reconcile sweep (self-heal dropped webhooks) — SERVICE-token gated; an operator / a C2 job triggers it.
  app.post('/billing/reconcile', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await hasValidServiceToken(req, app_.id))) return reply.status(401).send(needAuth);
    try {
      return reply.status(200).send(await reconcileApp(app_.id));
    } catch (e) {
      return errorReply(reply, e);
    }
  });

  // === reserved provider webhooks (adapters DEFERRED) ==============================================
  const reserved = (provider: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    void req;
    return reply.status(501).send({
      error: { code: 'not_configured', message: `The ${provider} billing webhook is reserved but not implemented on this platform build.`, retry: 'no' },
    });
  };
  app.post('/hooks/billing/apple', reserved('Apple App Store'));
  app.post('/hooks/billing/google', reserved('Google Play'));

  // === Stripe webhook (RAW bytes, encapsulated) ====================================================
  // The consumer's same-origin /hooks/* edge proxies Stripe's request RAW to here. Signature is verified
  // from the RAW bytes in the sidecar — the app never sees STRIPE_WEBHOOK_SECRET or parses the event. The
  // buffer body parser is registered in THIS encapsulated child only, so sibling JSON routes are untouched.
  app.register(async (webhook) => {
    const keepRaw = (_req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void) => done(null, body);
    webhook.addContentTypeParser('application/json', { parseAs: 'buffer' }, keepRaw);
    webhook.addContentTypeParser('*', { parseAs: 'buffer' }, keepRaw);

    webhook.post('/hooks/billing/stripe', async (req, reply) => {
      const app_ = await resolveAppId(req);
      if (!app_) return reply.status(404).send(unknownApp);
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '', 'utf8');
      const sig = req.headers['stripe-signature'];
      const signature = Array.isArray(sig) ? sig[0] : sig;
      try {
        const result = await handleStripeWebhook(app_.id, raw, signature);
        if (result.outcome === 'signature_invalid') {
          return reply.status(400).send({ error: { code: 'signature_invalid', message: 'Stripe signature verification failed.', retry: 'no' } });
        }
        if (result.outcome === 'processed' && result.record) {
          await recordC3(app_.id, 'billing.subscription_updated', result.record.subscriber, {
            status: result.record.status, plan_key: result.record.plan_key, event_type: result.event_type ?? null,
          });
        }
        return reply.status(result.status).send({ received: true, outcome: result.outcome });
      } catch (e) {
        // A transient re-fetch / store failure → 5xx so Stripe retries (idempotent on redelivery).
        return reply.status(503).send({ error: { code: 'webhook_retry', message: String((e as Error)?.message ?? e), retry: 'retry' } });
      }
    });
  });

  // Best-effort C3 telemetry — never fail the billing op because the timeline write hiccuped.
  async function recordC3(appId: string, type: string, subscriber: string, data: Record<string, unknown>): Promise<void> {
    try {
      await store.appendAppEvent({ app_id: appId, type, subject: subscriber, owner: subscriber, data });
    } catch {
      /* ignore */
    }
  }
}

const unknownApp = { error: { code: 'not_found', message: 'unknown app (pass `app` or set FORGE_APP_NAME).', retry: 'change-input' } };
