import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { store } from '../storage/store';
import { executeCapability } from '../core/runtime';
import { SYSTEM_ACTOR } from '../shared/domain';
import { ForgeError } from '../shared/errors';
import type { EmailDelivery } from '../resources/types';
import { APP_HEADER, SESSION_COOKIE, SERVICE_TOKEN_HEADER, verifySessionToken, parseCookies } from '../shared/session';
import { resolveAuthConfig, resolveServiceToken, serviceTokenMatches } from '../plugins/auth-identity/index';
import * as authStore from '../plugins/auth-identity/store';
import { providerIds } from '../connectors/providers';
import { availableProviders } from '../connectors/config';
import {
  startConnect,
  completeConnect,
  listConnections,
  disconnect,
  getFreshAccessToken,
} from '../connectors/service';

// C24 — the third-party connector HTTP surface. The app proxies `/connect/*` SAME-ORIGIN to this sidecar
// (like `/auth/*`, `/oauth/*`, `/mcp`), so the browser carries the C10 session cookie and the owner is
// ALWAYS derived from the session — never trusted from the client. The one exception is the BROKER
// (`POST /connect/:provider/token`): a background/server call (e.g. the outbound-email capability sending
// while the user is away) authenticates with the app's C10 SERVICE token and passes `owner` — the same
// trusted-internal model as the C2 scheduler / `/mcp/consents`. A browser cannot forge the service token.
//
//   GET    /connect/providers                 -> { providers:[{id,label,configured}] }   (discovery)
//   GET    /connect/:provider/start           -> 302 to the provider consent (owner from session)
//   GET    /connect/:provider/callback        -> exchange code, store sealed tokens, 302 to return_to
//   GET    /connect                           -> { connections:[…] } for the session user (never a token)
//   DELETE /connect/:provider                 -> { disconnected } for the session user (revoke + delete)
//   POST   /connect/:provider/token           -> { access_token, … } FRESH (auto-refresh); session OR service
//   POST   /connect/:provider/send            -> { message } send AS the user (C25 SendMessage); session OR service
//
// Registered on BOTH planes (like /auth). Records connect/disconnect/token-issue to the C3 app-event log.

export function registerConnectRoutes(app: FastifyInstance, opts: { defaultApp?: () => string | undefined } = {}): void {
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

  function publicBase(req: FastifyRequest): string {
    const explicit = process.env.FORGE_OAUTH_PUBLIC_URL;
    if (explicit) return explicit.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() || 'https';
    const host = String(req.headers['x-forwarded-host'] ?? req.headers['host'] ?? 'localhost');
    return `${proto}://${host}`;
  }

  // The logged-in C10 user for this app, or null (reuses the C10 session contract, like the C23 AS).
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

  // Parse `scopes` from a query value: space- or comma-delimited.
  const parseScopeParam = (v: unknown): string[] | undefined => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) return undefined;
    return s.split(/[\s,]+/).filter(Boolean);
  };

  // Only a single-slash same-origin path is a safe browser redirect target (C10 safeNext posture).
  const safePath = (v: unknown, dflt: string): string => {
    const s = typeof v === 'string' ? v : '';
    return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : dflt;
  };

  async function recordC3(appId: string, type: string, provider: string, owner: string, data: Record<string, unknown>): Promise<void> {
    try {
      await store.appendAppEvent({ app_id: appId, type, subject: provider, owner, data: { provider, ...data } });
    } catch {
      // C3 is best-effort telemetry — never fail the connect/broker call because the timeline write hiccuped.
    }
  }

  // === discovery =================================================================================
  app.get('/connect/providers', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const configured = new Set(await availableProviders(app_.id));
    const { providerDescriptor } = await import('../connectors/providers');
    return {
      providers: providerIds().map((id) => {
        const d = providerDescriptor(id)!;
        return { id, label: d.label, configured: configured.has(id), default_scopes: d.default_scopes };
      }),
    };
  });

  // === start the connect flow ====================================================================
  app.get('/connect/:provider/start', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const { provider } = req.params as { provider: string };
    const user = await sessionUser(req, app_.id);
    if (!user) {
      // Bounce through the hosted C10 login and come back here (same-origin path — C10 safeNext accepts it).
      return reply.code(302).header('location', `/auth/login?next=${encodeURIComponent(req.url)}`).send();
    }
    const q = req.query as { scopes?: string; return_to?: string };
    try {
      const { authorizeUrl } = await startConnect({
        appId: app_.id,
        owner: user.userId,
        provider,
        redirectUri: `${publicBase(req)}/connect/${encodeURIComponent(provider)}/callback`,
        ...(parseScopeParam(q.scopes) ? { scopes: parseScopeParam(q.scopes) } : {}),
        ...(q.return_to ? { returnTo: safePath(q.return_to, '/') } : {}),
      });
      return reply.code(302).header('location', authorizeUrl).send();
    } catch (e) {
      return errorReply(reply, e);
    }
  });

  // === provider callback → exchange + store ======================================================
  app.get('/connect/:provider/callback', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const { provider } = req.params as { provider: string };
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };

    // The provider denied / errored — bounce back with a flag (we don't know return_to without the request,
    // so land on the app root; the app can surface the error param).
    if (q.error) {
      return reply.code(302).header('location', `/?connect_error=${encodeURIComponent(q.error)}`).send();
    }
    if (!q.code || !q.state) {
      return reply.code(302).header('location', `/?connect_error=${encodeURIComponent('invalid_callback')}`).send();
    }
    const session = await sessionUser(req, app_.id);
    try {
      const { connection, owner, returnTo } = await completeConnect({
        appId: app_.id,
        provider,
        state: q.state,
        code: q.code,
        ...(session ? { sessionOwner: session.userId } : {}),
      });
      await recordC3(app_.id, 'connector.connected', connection.provider, owner, {
        scopes: connection.scopes,
        ...(connection.account_label ? { account_label: connection.account_label } : {}),
      });
      const sep = returnTo.includes('?') ? '&' : '?';
      return reply.code(302).header('location', `${returnTo}${sep}connected=${encodeURIComponent(connection.provider)}`).send();
    } catch (e) {
      if (e instanceof ForgeError) {
        return reply.code(302).header('location', `/?connect_error=${encodeURIComponent(e.code)}`).send();
      }
      return errorReply(reply, e);
    }
  });

  // === list my connections =======================================================================
  app.get('/connect', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const user = await sessionUser(req, app_.id);
    if (!user) return reply.status(401).send(needAuth);
    return { connections: await listConnections(app_.id, user.userId) };
  });

  // === disconnect ================================================================================
  app.delete('/connect/:provider', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const user = await sessionUser(req, app_.id);
    if (!user) return reply.status(401).send(needAuth);
    const { provider } = req.params as { provider: string };
    const disconnected = await disconnect(app_.id, user.userId, provider);
    if (disconnected) await recordC3(app_.id, 'connector.disconnected', provider, user.userId, {});
    return { disconnected };
  });

  // === broker: a fresh, valid access token (session OR service-token) =============================
  app.post('/connect/:provider/token', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const { provider } = req.params as { provider: string };
    const b = (req.body ?? {}) as { owner?: string; scope?: string; require_scope?: string };

    // Owner resolution: prefer the C10 session (user-in-the-loop). Otherwise accept a valid SERVICE token and
    // take `owner` from the body (trusted internal call — a background send). A browser can't forge the token.
    let owner: string | undefined;
    let via: 'session' | 'service';
    const user = await sessionUser(req, app_.id);
    if (user) {
      owner = user.userId;
      via = 'session';
    } else {
      const presented = serviceTokenPresented(req);
      const configured = await resolveServiceToken(app_.id);
      if (!presented || !serviceTokenMatches(presented, configured)) return reply.status(401).send(needAuth);
      owner = trimmed(b.owner);
      via = 'service';
      if (!owner) return reply.status(422).send({ error: { code: 'invalid_input', message: 'a service-authenticated broker call must pass `owner`.', retry: 'change-input' } });
    }

    try {
      const fresh = await getFreshAccessToken({
        appId: app_.id,
        owner,
        provider,
        ...(trimmed(b.require_scope ?? b.scope) ? { requireScope: trimmed(b.require_scope ?? b.scope)! } : {}),
      });
      await recordC3(app_.id, 'connector.token_issued', provider, owner, { via, scopes: fresh.scopes });
      return reply.status(200).send(fresh);
    } catch (e) {
      return errorReply(reply, e);
    }
  });

  // === send a message AS the user (C25 SendMessage) ==============================================
  // The authenticated outbound-send surface: the app's approved-draft/background flow POSTs a composed
  // message here and forge sends it AS the user through their connected provider (MVP: Gmail). Owner is
  // resolved EXACTLY like the broker — the C10 session (user-in-the-loop) OR a valid C10 SERVICE token +
  // `owner` in the body (a background/approved send). A browser can't forge the service token, and `owner`
  // is never trusted from an unauthenticated client. Delegates to the SendMessage Capability in-process.
  //   200 { message } with message.status 'sent' | 'failed' (a provider rejection is a recorded 'failed',
  //        never a silent drop); a broker precondition is a typed error the app relays as "reconnect":
  //   404 not_found (not connected) · 403 insufficient_scope (send not granted) · 409 reconnect_required.
  app.post('/connect/:provider/send', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const { provider } = req.params as { provider: string };
    const b = (req.body ?? {}) as Record<string, unknown>;

    // Owner resolution (identical trust model to the broker): session, else service-token + body.owner.
    let owner: string | undefined;
    let via: 'session' | 'service';
    const user = await sessionUser(req, app_.id);
    if (user) {
      owner = user.userId;
      via = 'session';
    } else {
      const presented = serviceTokenPresented(req);
      const configured = await resolveServiceToken(app_.id);
      if (!presented || !serviceTokenMatches(presented, configured)) return reply.status(401).send(needAuth);
      owner = trimmed(b.owner);
      via = 'service';
      if (!owner) return reply.status(422).send({ error: { code: 'invalid_input', message: 'a service-authenticated send must pass `owner`.', retry: 'change-input' } });
    }

    // Build the Capability input from the body; `provider` comes from the URL (not the client body). The
    // Capability's Zod schema validates recipients/subject/body and returns a clean 422 on bad input.
    const capInput: Record<string, unknown> = {
      app: app_.name,
      owner,
      provider,
      ...(b.channel !== undefined ? { channel: b.channel } : {}),
      to: b.to,
      ...(b.cc !== undefined ? { cc: b.cc } : {}),
      ...(b.bcc !== undefined ? { bcc: b.bcc } : {}),
      subject: b.subject,
      body: b.body,
      ...(b.content_type !== undefined ? { content_type: b.content_type } : {}),
      ...(b.in_reply_to !== undefined ? { in_reply_to: b.in_reply_to } : {}),
      ...(b.references !== undefined ? { references: b.references } : {}),
      ...(b.thread_ref !== undefined ? { thread_ref: b.thread_ref } : {}),
    };

    try {
      const { resource } = await executeCapability('send-message', capInput, SYSTEM_ACTOR);
      const message = resource as EmailDelivery;
      await recordC3(app_.id, message.status === 'sent' ? 'message.sent' : 'message.failed', provider, owner, {
        via,
        channel: message.channel ?? null,
        message_id: message.message_id ?? null,
        ...(message.status === 'failed' && message.error ? { error: message.error } : {}),
      });
      return reply.status(200).send({ message });
    } catch (e) {
      return errorReply(reply, e);
    }
  });
}

const unknownApp = { error: { code: 'not_found', message: 'unknown app (pass `app` or set FORGE_APP_NAME).', retry: 'change-input' } };
const needAuth = { error: { code: 'unauthorized', message: 'a signed-in user (or a valid service token) is required.', retry: 'needs-human' } };
