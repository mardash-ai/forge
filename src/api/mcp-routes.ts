import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import pkgJson from '../../package.json';
import { store } from '../storage/store';
import { getBackends } from '../storage/backends';
import type { AppEvent } from '../events/app-events';
import { executeCapability } from '../core/runtime';
import { SYSTEM_ACTOR } from '../shared/domain';
import { nowIso } from '../shared/time';
import { APP_HEADER, verifySessionToken } from '../shared/session';
import { appCallbackBase, serviceAuthHeaders } from '../shared/app-callback';
import {
  resolveServiceToken,
  resolveSessionBearerEnabled,
  resolveAuthConfig,
} from '../plugins/auth-identity/index';
import * as authStore from '../plugins/auth-identity/store';
import { hasValidServiceToken } from '../shared/service-auth';
import { verifyAccessTokenDetailed, bearerFrom, type VerifiedToken } from '../mcp/verify';
import { scopesSatisfy } from '../mcp/oauth';
import type { ToolRegistration, ToolFamily } from '../mcp/types';
import {
  startSpan,
  traceparent,
  parentFromTraceparent,
  capPayload,
  ATTR,
  mcpLog,
  recordToolCallMetric,
  recordMcpRegistrationMetric,
} from '../plugins/otel/index';

// C23 — the REMOTE MCP SERVER the platform hosts for a consuming app, plus the app-facing management
// surface. `POST /mcp` speaks JSON-RPC 2.0 over the Streamable-HTTP transport (request/response), and
// `GET /mcp` is the STANDALONE server→client SSE stream over which we push server-initiated
// notifications (today `notifications/tools/list_changed`, so a connected client re-fetches `tools/list`
// when the surface changes instead of caching it until the user reconnects). Both are gated by the
// OAuth access token the C23 AS issued: it
// serves the app's registered tools as MCP tools and DISPATCHES each `tools/call` to the app's handler (the
// C2 sidecar→app callback), enforcing the tool's scope and recording the call to the C3 audit trail. The
// `/mcp/*` management routes are internal app→sidecar calls (like the C3/C4 routes) that register the tool
// surface, version the instruction block, and schedule proactive prompts via C2.
//
//   POST /mcp                              JSON-RPC: initialize | tools/list | tools/call | ping  (Bearer-gated)
//   GET  /mcp                              SSE server→client stream: pushes notifications/tools/list_changed (Bearer-gated)
//   GET  /.well-known/oauth-protected-resource   -> points the host at the C23 authorization server
//   POST /mcp/tools    { name, description, input_schema, scope, family, handler_path, … }  -> register a tool
//   GET  /mcp/tools                        -> the app's tool surface
//   DELETE /mcp/tools/:name                -> unregister
//   POST /mcp/instructions  { text, label? } -> append a new instruction/training version
//   GET  /mcp/instructions  ?version=       -> the latest (or a specific) instruction block
//   POST /mcp/proactive  { tool, every?|cron?, target_path, remove? } -> schedule a proactive prompt via C2
//   GET  /mcp/consents ?owner=  +  DELETE /mcp/consents/:client_id ?owner=  -> user connector management

const MCP_PROTOCOL_VERSION = '2025-06-18';
// Report the actual platform version (from package.json) so MCP clients (Claude, ChatGPT) see
// the deployed forge version rather than the sidecar's hardcoded 1.0.0 fallback.
const MCP_SERVER_VERSION = pkgJson.version;
const TOOL_CALL_TIMEOUT_MS = 30_000;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const FAMILIES: ToolFamily[] = ['read', 'write', 'action'];

const invalid = (message: string) => ({
  error: { code: 'invalid_input', message, retry: 'change-input' },
});
const unknownApp = {
  error: {
    code: 'not_found',
    message: 'unknown app (pass `app` or set FORGE_APP_NAME).',
    retry: 'change-input',
  },
};

// C36 payload capture gate — tool-call ARGUMENTS + the returned PAYLOAD are recorded on the trace as the
// Langfuse observation input/output by default; ONLY the literal string "false" disables. Read per call so
// an operator toggle needs no process restart. The capture is strictly the application payload — the
// Authorization header / bearer / service token NEVER enter the recorded values.
const tracePayloads = (): boolean => process.env.FORGE_MCP_TRACE_PAYLOADS !== 'false';

// ── tools/list_changed — server→client push over the Streamable-HTTP GET stream ──────────────────
//
// WHY: MCP clients CACHE `tools/list`. Before this, the server advertised `tools.listChanged: false`
// ("my tool surface never changes"), so a client that connected before a tool was added kept serving
// the stale set until the USER manually reconnected the connector — a terrible upgrade story for a
// live product. The spec's answer is `notifications/tools/list_changed`, which needs a server→client
// channel: the Streamable-HTTP standalone `GET /mcp` SSE stream. We now hold those streams open per
// app and push the notification the moment the tool surface changes (register / delete), so compliant
// clients re-fetch on their own with no user action.
//
// SCOPE (v1, honest): the registry is IN-PROCESS. The data-plane runs as a single instance today, so
// the app's management POST and the client's open stream land on the same process. If the data-plane
// is ever scaled horizontally, this needs a cross-instance fanout (Postgres LISTEN/NOTIFY) — a client
// attached to replica A would otherwise miss a registration that hit replica B.
type SseWriter = (frame: string) => void;

/** One attached server→client stream, with the identity needed to report it on the operator dashboard. */
interface StreamSubscriber {
  write: SseWriter;
  /** DCR-registered client name ("Claude"/"ChatGPT") — WHICH AI is holding the channel. */
  clientName: string;
  /**
   * The User-Agent seen on the stream request. For a HOSTED connector (ChatGPT / claude.ai) this is the
   * VENDOR'S server UA — the end user's device is invisible to us, because their backend (not the phone
   * or browser) dials our endpoint. A LOCAL client (Claude Desktop / Claude Code) connects straight from
   * the user's machine, so its UA is the one signal that legitimately distinguishes hosted vs desktop.
   */
  userAgent: string;
  openedAt: number;
}

const toolListSubscribers = new Map<string, Set<StreamSubscriber>>();

/** Attach a server→client stream for `appId`. Returns an unsubscribe fn (call on connection close). */
export function subscribeToolListChanged(
  appId: string,
  sub: { write: SseWriter; clientName?: string; userAgent?: string },
): () => void {
  const entry: StreamSubscriber = {
    write: sub.write,
    clientName: sub.clientName ?? 'unknown',
    userAgent: sub.userAgent ?? '',
    openedAt: Date.now(),
  };
  const set = toolListSubscribers.get(appId) ?? new Set<StreamSubscriber>();
  set.add(entry);
  toolListSubscribers.set(appId, set);
  return () => {
    const s = toolListSubscribers.get(appId);
    if (!s) return;
    s.delete(entry);
    if (s.size === 0) toolListSubscribers.delete(appId);
  };
}

/** One attached stream as reported to the operator dashboard. */
export interface ToolListStreamInfo {
  client_name: string;
  user_agent: string;
  opened_at: string;
  held_seconds: number;
}

/**
 * LIVE snapshot of the attached streams for an app — read straight from the in-memory registry at call
 * time, so it can never be stale (there is no cache to invalidate; if a socket dropped, it is already
 * gone from this map).
 */
export function toolListStreamSnapshot(appId: string): ToolListStreamInfo[] {
  const now = Date.now();
  return [...(toolListSubscribers.get(appId) ?? [])].map((s) => ({
    client_name: s.clientName,
    user_agent: s.userAgent,
    opened_at: new Date(s.openedAt).toISOString(),
    held_seconds: Math.round((now - s.openedAt) / 1000),
  }));
}

/**
 * Push `notifications/tools/list_changed` to every open stream for `appId`. Returns how many streams
 * were notified. Best-effort: a write failure (client vanished) drops that subscriber and never throws,
 * so a dead connection can't fail a tool registration.
 */
export function broadcastToolListChanged(appId: string): number {
  const subs = toolListSubscribers.get(appId);
  const attached = subs?.size ?? 0;
  let sent = 0;
  if (subs && attached > 0) {
    // A JSON-RPC notification (no `id`) framed as an SSE `message` event, per Streamable HTTP.
    const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`;
    for (const sub of [...subs]) {
      try {
        sub.write(frame);
        sent += 1;
      } catch {
        subs.delete(sub);
      }
    }
    if (subs.size === 0) toolListSubscribers.delete(appId);
  }
  // OBSERVABILITY (the point): `notified=0` is the loud diagnostic — the tool surface changed but NO
  // client was holding the stream, so every connected AI is still serving a stale `tools/list` and will
  // keep doing so until it reconnects. Anything >0 proves a real client is consuming the push channel.
  mcpLog({
    event: 'mcp.tools_list_changed',
    app: appId,
    notified: sent,
    attached,
  });
  startSpan('mcp.tools_list_changed', {
    attributes: {
      'mcp.app': appId,
      'mcp.streams_notified': sent,
      'mcp.streams_attached': attached,
    },
  }).end('ok');
  return sent;
}

/** Test-only: how many streams are currently attached for an app. */
export function toolListSubscriberCount(appId: string): number {
  return toolListSubscribers.get(appId)?.size ?? 0;
}

// ── C23 timeline projection ──────────────────────────────────────────────────────────────────────
//
// `recordCall` writes every tool call as a C3 `mcp.tool_call` AppEvent; `data.host` is the OAuth
// client id the token was issued to (the calling MCP host: Claude, ChatGPT, etc.).
// `toTimelineEvent` is the CANONICAL projection from that raw fact to a structured timeline shape
// that a consumer (UI, agent, analytics) can use directly. The caller MUST always be present and
// distinguishable — legacy/migrated events whose host was not captured carry the explicit sentinel
// `'unattributed'` rather than an omitted field or an empty string, so a reader can tell "I know
// who called" from "I do not know who called" without extra null checks.

/** The structured timeline shape emitted by toTimelineEvent for every `mcp.tool_call` AppEvent. */
export interface McpToolCallTimelineEvent {
  /** ISO-8601 timestamp of when the call was recorded. */
  at: string;
  kind: 'mcp.tool_call';
  /** The tool name that was invoked. */
  tool: string;
  /**
   * The OAuth client id of the calling MCP host (Claude, ChatGPT, etc.), taken from `data.host`
   * as written by `recordCall`. When the host cannot be determined — legacy events, records
   * migrated before C23, or a call path that bypassed attribution — the value is the explicit
   * sentinel `'unattributed'` so a reader can always distinguish a known caller from an absent one
   * without inspecting for `undefined` or an empty string.
   */
  caller: string;
  /** The owner (user id) the token was issued to, if known. */
  user: string | undefined;
  /** Whether the tool call completed successfully. */
  ok: boolean;
  /** Set when the call was rejected or failed for a specific reason (e.g. `insufficient_scope`). */
  reason?: string;
}

/**
 * Projects a `mcp.tool_call` C3 AppEvent onto a structured McpToolCallTimelineEvent.
 *
 * The caller field is always populated: `data.host` when present and non-empty, otherwise the
 * explicit sentinel `'unattributed'`. A consumer MUST treat `'unattributed'` as a distinct,
 * known state — not as a missing value — so dashboards and audit logs read "unattributed" rather
 * than silently omitting the caller column.
 *
 * @example
 * // Attributed — data.host was captured by recordCall:
 * toTimelineEvent(event) // → { caller: 'mcpc_abc123', … }
 *
 * // Unattributed — legacy event or bypassed attribution:
 * toTimelineEvent(event) // → { caller: 'unattributed', … }
 */
export function toTimelineEvent(event: AppEvent): McpToolCallTimelineEvent {
  const data = event.data as {
    tool?: unknown;
    host?: unknown;
    ok?: unknown;
    reason?: unknown;
  };
  const rawHost = data.host;
  const caller = typeof rawHost === 'string' && rawHost.length > 0 ? rawHost : 'unattributed';
  return {
    at: event.at,
    kind: 'mcp.tool_call',
    tool: typeof data.tool === 'string' ? data.tool : (event.subject ?? ''),
    caller,
    user: event.owner,
    ok: data.ok === true,
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
  };
}

export function registerMcpRoutes(
  app: FastifyInstance,
  opts: { defaultApp?: () => string | undefined } = {},
): void {
  const resolveAppId = async (
    req: FastifyRequest,
    explicit?: string,
  ): Promise<{ id: string; name: string } | null> => {
    const n =
      (typeof explicit === 'string' && explicit.trim()) ||
      (typeof (req.query as { app?: string })?.app === 'string' &&
        (req.query as { app?: string }).app!.trim()) ||
      (typeof (req.body as { app?: string })?.app === 'string' &&
        (req.body as { app?: string }).app!.trim()) ||
      (Array.isArray(req.headers[APP_HEADER])
        ? (req.headers[APP_HEADER] as string[])[0]
        : (req.headers[APP_HEADER] as string | undefined)) ||
      opts.defaultApp?.();
    if (!n) return null;
    const a = await store.findAppByName(String(n));
    return a && a.type === 'Application' ? { id: a.id, name: String(n) } : null;
  };
  const mcp = () => getBackends().then((b) => b.mcp);

  // SESSION-BEARER fallback (test-flagged tenants only). When MCP_ACCEPT_SESSION_BEARER=true is set
  // for an app, a forge-session JWT (the C10 signed session token) is accepted as an OAuth bearer at
  // the MCP endpoint — letting a seeded member's connector authenticate AS the member without going
  // through the browser-based OAuth authorize flow. NEVER active on apps without the flag.
  //
  // The synthetic VerifiedToken is granted all registered tool scopes for the app so per-tool scope
  // enforcement passes unchanged. `clientId` is the sentinel 'session-bearer' for observability.
  // Security: the flag must be explicitly set in the app's C5 vault or env — it is off by default,
  // and it never affects the standard OAuth access-token path or non-test-flagged tenants.
  async function verifySessionBearer(appId: string, rawToken: string | null): Promise<VerifiedToken | null> {
    if (!rawToken) return null;
    try {
      if (!(await resolveSessionBearerEnabled(appId))) return null;
      const cfg = await resolveAuthConfig(appId);
      if (!cfg.sessionSecret) return null;
      const claims = verifySessionToken(rawToken, cfg.sessionSecret);
      if (!claims) return null;
      const session = await authStore.getSession(appId, claims.sessionId);
      if (!session || session.revoked || new Date(session.expires_at).getTime() <= Date.now()) return null;
      // Grant all registered tool scopes so per-tool enforcement passes for the member.
      const tools = await (await mcp()).listTools(appId);
      const scopes = [...new Set(tools.map((t) => t.scope).filter(Boolean))];
      return { userId: claims.userId, scopes, clientId: 'session-bearer' };
    } catch {
      return null;
    }
  }

  // issuerBase — the PINNED OAuth authorization-server / issuer origin (RFC 8414). The AS must stay on the
  // certless MACHINE-FACING api host: the browser consent + DCR flow can't present a client cert, so the AS
  // never relocates to a dedicated mTLS host. INDEPENDENT of the browser-facing `/connect/*` callback
  // (connect-routes.ts), which uses FORGE_OAUTH_PUBLIC_URL to pin the USER-FACING app host. Prefer
  // FORGE_MCP_PUBLIC_URL; fall back to FORGE_OAUTH_PUBLIC_URL (back-compat — prod set that before the split);
  // then the forwarded-host header.
  function issuerBase(req: FastifyRequest): string {
    const explicit = process.env.FORGE_MCP_PUBLIC_URL || process.env.FORGE_OAUTH_PUBLIC_URL;
    if (explicit) return explicit.replace(/\/+$/, '');
    const proto =
      String(req.headers['x-forwarded-proto'] ?? '')
        .split(',')[0]!
        .trim() || 'https';
    const host = String(req.headers['x-forwarded-host'] ?? req.headers['host'] ?? 'localhost');
    return `${proto}://${host}`;
  }

  // resourceBase — the MCP RESOURCE identifier origin (RFC 8707 / RFC 9728): the public host the client
  // actually CONNECTED to, which may DIFFER from the pinned issuer above. ChatGPT's connector lives on a
  // dedicated mTLS host (mcp.dorinda.ai) while Claude + browsers stay on the certless api host — a request
  // arriving via mcp.dorinda.ai must advertise `resource=https://mcp.dorinda.ai/mcp` so the client echoes
  // THAT into its token and our audience check (verifyAccessToken) expects the same value. So this is
  // PER-REQUEST, unlike the pinned issuerBase.
  //
  // Anti-spoofing (fail safe): the forwarded host is honored ONLY when it is the primary MCP host
  // (FORGE_MCP_PUBLIC_URL) or an explicitly-allowlisted alternate (FORGE_MCP_ALT_HOSTS — comma-separated
  // hostnames). A forged X-Forwarded-Host would otherwise poison the advertised resource, so an
  // un-allowlisted host NEVER wins: we fall back to the pin (then FORGE_OAUTH_PUBLIC_URL, then — dev only —
  // the forwarded origin). Trailing slashes trimmed.
  function resourceBase(req: FastifyRequest): string {
    const proto =
      String(req.headers['x-forwarded-proto'] ?? '')
        .split(',')[0]!
        .trim() || 'https';
    const fwdHost = String(req.headers['x-forwarded-host'] ?? req.headers['host'] ?? 'localhost')
      .split(',')[0]!
      .trim();
    const pin = process.env.FORGE_MCP_PUBLIC_URL?.replace(/\/+$/, '');
    const allowed = new Set<string>();
    if (pin) {
      try {
        allowed.add(new URL(pin).host);
      } catch {
        /* malformed pin — ignore */
      }
    }
    for (const h of (process.env.FORGE_MCP_ALT_HOSTS ?? '').split(',')) {
      const t = h.trim();
      if (t) allowed.add(t);
    }
    if (fwdHost && allowed.has(fwdHost)) return `${proto}://${fwdHost}`;
    return pin ?? process.env.FORGE_OAUTH_PUBLIC_URL?.replace(/\/+$/, '') ?? `${proto}://${fwdHost}`;
  }

  // Change C — a restrictive Content-Security-Policy on this MACHINE-FACING JSON surface (POST /mcp, the
  // RFC 9728 discovery doc, and the /mcp/* management routes). These responses are never a browsing context,
  // so lock everything down + forbid framing/base-uri hijacks. Scoped by URL so it never touches the HTML
  // OAuth consent page (oauth-routes.ts) — which needs inline styles — even though routes share one instance.
  const MCP_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
  app.addHook('onSend', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (
      path === '/mcp' ||
      path.startsWith('/mcp/') ||
      path === '/.well-known/oauth-protected-resource' ||
      path === '/.well-known/oauth-protected-resource/mcp'
    ) {
      reply.header('content-security-policy', MCP_CSP);
    }
  });

  // Change D (security) — the app→sidecar MANAGEMENT surface carries NO OAuth (unlike POST /mcp) yet the
  // consumer proxies `/mcp/*` to the PUBLIC internet, so without a gate an unauthenticated caller could
  // register/rewrite tools + instruction blocks, schedule proactive prompts, or revoke a user's consent.
  // Every management route requires the app's C10 service token (`x-forge-service-token`, constant-time
  // compare — the same principal + verifier the C2 cron fire / C24 broker / billing admin ops present).
  // FAIL CLOSED: an app with no configured AUTH_SERVICE_TOKEN rejects. This gate is deliberately NOT on
  // `POST /mcp` (OAuth-token gated) nor the public `.well-known/oauth-protected-resource` discovery doc.
  const needServiceToken = {
    error: {
      code: 'unauthorized',
      message: 'a valid x-forge-service-token is required.',
      retry: 'needs-human',
    },
  };
  async function requireServiceToken(
    req: FastifyRequest,
    reply: FastifyReply,
    appId: string,
  ): Promise<boolean> {
    if (await hasValidServiceToken(req, appId)) return true;
    reply.status(401).send(needServiceToken);
    return false;
  }

  // === the protected-resource pointer (RFC 9728) — advertises the PER-REQUEST resource id + the PINNED AS ===
  // `resource` names the host the client connected to (resourceBase, per-host); `authorization_servers` points
  // at the pinned certless OAuth AS (issuerBase) — the two diverge for a request via a dedicated mTLS host.
  // Served at BOTH the root well-known AND the resource-path-suffixed URL (`…/oauth-protected-resource/mcp`):
  // per RFC 9728 §3.1 the metadata URL for a resource at `<host>/mcp` is the path-suffixed form, and Claude's
  // connector validation REQUIRES it — a 404 there is reported to the user as a "server configuration issue"
  // (verified live 2026-07-23 via the edge access log). The WWW-Authenticate pointer (POST /mcp 401 below)
  // advertises this same path-suffixed URL so discovery loops back to the canonical location.
  const protectedResourceHandler = async (req: FastifyRequest, reply: FastifyReply) =>
    reply.status(200).send({
      resource: `${resourceBase(req)}/mcp`,
      authorization_servers: [issuerBase(req)],
    });
  app.get('/.well-known/oauth-protected-resource', protectedResourceHandler);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceHandler);

  // === the MCP endpoint (Streamable-HTTP, JSON-RPC 2.0) ============================================
  app.post('/mcp', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);

    // Gate on the OAuth access token; a missing/invalid token → 401 with the discovery pointer so the MCP
    // client kicks off the OAuth flow (RFC 9728 WWW-Authenticate). Change A (RFC 8707): pass THIS server's
    // resource id as the expected audience — a token bound to a DIFFERENT resource is rejected here, while a
    // token with no bound resource still verifies (back-compat with tokens issued before aud-binding). The
    // resource id is PER-HOST (resourceBase): a token minted for the dedicated mTLS host is accepted only on
    // that host, and the WWW-Authenticate pointer names the same host so discovery loops back consistently.
    //
    // Session-bearer fallback: for test-flagged tenants (MCP_ACCEPT_SESSION_BEARER=true) the bearer may be
    // a forge-session JWT instead of an OAuth access token — lets seeded members authenticate as themselves
    // without the browser-based authorize flow. Inactive unless the flag is set; production unaffected.
    const rawBearer = bearerFrom(req.headers.authorization);
    const { verified: oauthVerified, reason: oauthReason } = await verifyAccessTokenDetailed(
      app_.id,
      rawBearer,
      `${resourceBase(req)}/mcp`,
    );
    const verified = oauthVerified ?? (await verifySessionBearer(app_.id, rawBearer));
    const reason: string | undefined = verified ? undefined : (oauthReason ?? 'invalid_token');
    if (!verified) {
      // C36 — a transport auth rejection used to die INVISIBLY (no span, zero trace-side evidence a client
      // was knocking). Emit a short span with the reject reason (invalid_token vs resource_mismatch) + the
      // requested JSON-RPC method, adopting the edge's `traceparent` when present so it lands on the edge
      // trace. NO token material is ever recorded. The wire response stays a uniform invalid_token 401.
      const method = (req.body as { method?: unknown } | undefined)?.method;
      const rejectReason = reason ?? 'invalid_token';
      const rejectSpan = startSpan('mcp.auth_reject', {
        parent: parentFromTraceparent(req.headers.traceparent),
        attributes: {
          'mcp.app': app_.name,
          ...(typeof method === 'string' ? { 'mcp.method': method } : {}),
        },
      });
      rejectSpan.end('error', rejectReason);
      mcpLog({
        event: 'mcp.auth_reject',
        trace_id: rejectSpan.traceId,
        app: app_.name,
        reason: rejectReason,
        ...(typeof method === 'string' ? { method } : {}),
      });
      return reply
        .status(401)
        .header(
          'WWW-Authenticate',
          `Bearer resource_metadata="${resourceBase(req)}/.well-known/oauth-protected-resource/mcp"`,
        )
        .send({
          error: 'invalid_token',
          error_description: 'a valid OAuth access token is required.',
        });
    }

    const body = req.body as
      | {
          jsonrpc?: string;
          id?: string | number;
          method?: string;
          params?: Record<string, unknown>;
        }
      | undefined;
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return reply.status(200).send(rpcError(body?.id ?? null, -32600, 'Invalid Request'));
    }
    const { id, method, params } = body;
    const isNotification = id === undefined;

    try {
      // JSON-RPC notifications (no id) get no response body — e.g. notifications/initialized.
      if (isNotification) {
        return reply.status(202).send();
      }
      if (method === 'initialize') {
        const latest = await (await mcp()).latestInstructions(app_.id);
        const clientProto = (params?.protocolVersion as string) || MCP_PROTOCOL_VERSION;
        return reply.status(200).send(
          rpcResult(id!, {
            protocolVersion: clientProto,
            // listChanged: TRUE — we push `notifications/tools/list_changed` over the standalone
            // `GET /mcp` SSE stream whenever the tool surface changes, so clients re-fetch `tools/list`
            // automatically instead of serving a cached surface until the user reconnects.
            capabilities: { tools: { listChanged: true } },
            serverInfo: {
              name: `forge-mcp:${app_.name}`,
              version: MCP_SERVER_VERSION,
            },
            ...(latest ? { instructions: latest.text } : {}),
          }),
        );
      }
      if (method === 'ping') {
        return reply.status(200).send(rpcResult(id!, {}));
      }
      if (method === 'tools/list') {
        const tools = await (await mcp()).listTools(app_.id);
        return reply.status(200).send(
          rpcResult(id!, {
            tools: tools.map((t) => {
              // MCP tool annotations on the wire — camelCase, built from the snake_case registration hints.
              // Only the keys the app declared appear; the whole object is omitted when it would be empty.
              const annotations: Record<string, unknown> = {
                ...(t.title ? { title: t.title } : {}),
                ...(t.read_only_hint !== undefined ? { readOnlyHint: t.read_only_hint } : {}),
                ...(t.destructive_hint !== undefined ? { destructiveHint: t.destructive_hint } : {}),
                ...(t.idempotent_hint !== undefined ? { idempotentHint: t.idempotent_hint } : {}),
                ...(t.open_world_hint !== undefined ? { openWorldHint: t.open_world_hint } : {}),
              };
              return {
                name: t.name,
                description: t.description,
                ...(t.title ? { title: t.title } : {}),
                inputSchema: t.input_schema ?? { type: 'object' },
                ...(t.output_schema ? { outputSchema: t.output_schema } : {}),
                ...(Object.keys(annotations).length ? { annotations } : {}),
                // Change B — per-tool securitySchemes (ChatGPT Apps SDK shape). Every tool is OAuth-gated by its
                // `scope`, so advertise an oauth2 scheme referencing that scope; a scopeless tool advertises
                // `noauth`. This only DECLARES the requirement — the platform still enforces scope on each call.
                securitySchemes: t.scope ? [{ type: 'oauth2', scopes: [t.scope] }] : [{ type: 'noauth' }],
              };
            }),
          }),
        );
      }
      if (method === 'tools/call') {
        return await handleToolCall(req, reply, app_, verified, id!, params);
      }
      return reply.status(200).send(rpcError(id!, -32601, `Method not found: ${method}`));
    } catch (e) {
      return reply
        .status(200)
        .send(rpcError(id ?? null, -32603, `Internal error: ${String((e as Error)?.message ?? e)}`));
    }
  });

  // The tool-call handler: scope enforcement → dispatch to the app → wrap the result → C3 attribution.
  async function handleToolCall(
    req: FastifyRequest,
    reply: FastifyReply,
    app_: { id: string; name: string },
    verified: VerifiedToken,
    id: string | number,
    params: Record<string, unknown> | undefined,
  ) {
    const name = params?.name as string | undefined;
    const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
    if (!name || typeof name !== 'string')
      return reply.status(200).send(rpcError(id, -32602, 'tools/call requires a string `name`.'));

    // Duration tracking for the structured log + RED metrics — started before the tool lookup so
    // every exit path (unknown tool, scope failure, app unreachable, dispatch) has an honest elapsed time.
    const startMs = Date.now();

    // ── Observability (C36): the transport span of this tool call's trace, started BEFORE the tool lookup
    // so a call to a NONEXISTENT tool still produces a span (it used to fail pre-span — zero visibility).
    // When the edge proxy sent a W3C `traceparent`, this span ADOPTS it as its parent so edge + tool join
    // ONE trace; otherwise it roots a fresh trace. The app CONTINUES the trace via the `traceparent` we
    // inject into the callback below, so the whole path (edge → transport → proxy edge → C29 gate → domain
    // → Postgres → app-event) is ONE trace. Fire-and-forget — never blocks/fails a call.
    // Payload capture: the tool-call ARGUMENTS ride the span as the Langfuse observation INPUT (and the
    // returned payload as the OUTPUT, below) — env-gated (FORGE_MCP_TRACE_PAYLOADS, default on) and
    // byte-capped; arguments/payload only, never the Authorization header or any token/secret.
    const span = startSpan('mcp.tool_call', {
      kind: 1, // INTERNAL — the app adds the downstream server/child spans
      parent: parentFromTraceparent(req.headers.traceparent),
      attributes: {
        [ATTR.GEN_AI_OPERATION_NAME]: 'execute_tool',
        [ATTR.GEN_AI_TOOL_NAME]: name,
        [ATTR.MCP_CLIENT_USER]: verified.userId,
        // Langfuse-NATIVE user id (Users view): its OTel ingest maps `langfuse.user.id` onto the
        // trace-level userId — including from THIS non-root span (the key triggers a trace-update
        // event, verified against the Langfuse v3 ingestion source; see ATTR.LANGFUSE_USER_ID).
        // `mcp.client.user` above stays as the plain span attribute the C36 dashboards/tests read.
        [ATTR.LANGFUSE_USER_ID]: verified.userId,
        [ATTR.MCP_CLIENT_HOST]: verified.clientId,
        'mcp.app': app_.name,
        ...(tracePayloads() ? { [ATTR.LANGFUSE_OBSERVATION_INPUT]: capPayload(args) } : {}),
      },
    });

    const tool = await (await mcp()).getTool(app_.id, name);
    if (!tool) {
      span.end('error', 'unknown_tool');
      const dur = Date.now() - startMs;
      mcpLog({
        event: 'mcp.tool_call',
        trace_id: span.traceId,
        app: app_.name,
        tool: name,
        client: verified.clientId,
        user: verified.userId,
        duration_ms: dur,
        outcome: 'error',
        error_class: 'unknown_tool',
      });
      recordToolCallMetric({
        tool: name,
        app: app_.name,
        outcome: 'error',
        duration_ms: dur,
        error_class: 'unknown_tool',
      });
      return reply.status(200).send(rpcError(id, -32602, `Unknown tool: ${name}`));
    }
    span.setAttribute('mcp.tool.family', tool.family);
    span.setAttribute('mcp.tool.high_risk', tool.high_risk ?? false);

    // Per-tool SCOPE enforcement against the granted token (the platform's job). The app additionally runs
    // its C29 authorize() inside the handler for write/act tools — we pass it the seam context below.
    if (tool.scope && !scopesSatisfy(verified.scopes, [tool.scope])) {
      await recordCall(app_.id, name, verified, false, 'insufficient_scope');
      span.setAttribute(ATTR.AUTHZ_DECISION, 'insufficient_scope').end('error', 'insufficient_scope');
      const dur = Date.now() - startMs;
      mcpLog({
        event: 'mcp.tool_call',
        trace_id: span.traceId,
        app: app_.name,
        tool: name,
        client: verified.clientId,
        user: verified.userId,
        duration_ms: dur,
        outcome: 'error',
        error_class: 'insufficient_scope',
      });
      recordToolCallMetric({
        tool: name,
        app: app_.name,
        outcome: 'error',
        duration_ms: dur,
        error_class: 'insufficient_scope',
      });
      return reply.status(200).send(
        rpcError(id, -32001, 'insufficient_scope', {
          required_scope: tool.scope,
        }),
      );
    }

    // Dispatch to the app's handler (the C2 sidecar→app callback), authenticated as a service.
    const base = await appCallbackBase(store, app_.id);
    if (!base) {
      await recordCall(app_.id, name, verified, false, 'app_unreachable');
      span.end('error', 'app_unreachable');
      const dur = Date.now() - startMs;
      mcpLog({
        event: 'mcp.tool_call',
        trace_id: span.traceId,
        app: app_.name,
        tool: name,
        client: verified.clientId,
        user: verified.userId,
        duration_ms: dur,
        outcome: 'error',
        error_class: 'app_unreachable',
      });
      recordToolCallMetric({
        tool: name,
        app: app_.name,
        outcome: 'error',
        duration_ms: dur,
        error_class: 'app_unreachable',
      });
      return reply
        .status(200)
        .send(rpcError(id, -32011, 'the app handler is not reachable (never provisioned?).'));
    }
    const serviceToken = await resolveServiceToken(app_.id);
    // The DCR-registered client NAME (e.g. "Claude", "ChatGPT") — the opaque `mcpc_…` client_id alone
    // can't tell an app WHICH AI host is calling, so a consumer can't render "Connected" per platform.
    // Forward the human name so the app can label the connection it records. Best-effort (never blocks a
    // tool call). Only the public client_name is passed — never a secret.
    const clientName = (await (await mcp()).getClient(app_.id, verified.clientId).catch(() => null))
      ?.client_name;
    let ok = false;
    let payload: unknown;
    let httpStatus: number | undefined;
    try {
      const res = await fetch(`${base}${tool.handler_path}`, {
        method: 'POST',
        // `traceparent` propagates THIS trace into the app tier so the proxy edge + dispatch spans join it.
        headers: {
          'content-type': 'application/json',
          traceparent: traceparent(span),
          ...serviceAuthHeaders(serviceToken),
        },
        // The C29 governance SEAM: the app's handler gets the user + the tool's safety family/high-risk hint
        // and runs its own authorize() (the platform enforced scope; the app decides allow/stage/deny).
        // `user.group_id` is set for member-scoped tokens (group_id on the OAuth grant, or session-bearer
        // for test tenants) so the app can apply per-actor privacy grading correctly.
        body: JSON.stringify({
          tool: name,
          arguments: args,
          user: { id: verified.userId, ...(verified.groupId ? { group_id: verified.groupId } : {}) },
          family: tool.family,
          high_risk: tool.high_risk ?? false,
          client_id: verified.clientId,
          ...(clientName ? { client_name: clientName } : {}),
        }),
        signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),
      });
      httpStatus = res.status;
      ok = res.ok;
      payload = await res.json().catch(() => ({}));
    } catch (e) {
      payload = { error: String((e as Error)?.message ?? e) };
    }
    const errorClass = ok ? undefined : `handler_status_${httpStatus ?? 'error'}`;
    const duration_ms = Date.now() - startMs;
    await recordCall(app_.id, name, verified, ok, errorClass);
    if (httpStatus !== undefined) span.setAttribute('http.response.status_code', httpStatus);
    // C36 — the returned payload is the observation OUTPUT, on SUCCESS AND FAILURE alike: an isError /
    // handler_status_* error body is exactly what you need to see on the trace to debug the bounce.
    if (tracePayloads()) span.setAttribute(ATTR.LANGFUSE_OBSERVATION_OUTPUT, capPayload(payload));
    span.end(ok ? 'ok' : 'error', errorClass);

    // Structured log (one line per tool call — always on, not OTel-gated) + RED metrics (OTel-gated).
    mcpLog({
      event: 'mcp.tool_call',
      trace_id: span.traceId,
      app: app_.name,
      tool: name,
      client: clientName ?? verified.clientId,
      user: verified.userId,
      duration_ms,
      outcome: ok ? 'ok' : 'error',
      ...(errorClass ? { error_class: errorClass } : {}),
    });
    recordToolCallMetric({
      tool: name,
      app: app_.name,
      outcome: ok ? 'ok' : 'error',
      duration_ms,
      ...(errorClass ? { error_class: errorClass } : {}),
    });

    // Assemble the MCP tool result.  `_meta.traceparent` stamps the W3C correlation id so a
    // CHAT-VISIBLE failure is directly searchable in traces.
    //
    // CALLRESULT PASS-THROUGH: when the app handler already returns a CallToolResult-shaped object
    // (presence of a `content` array), emit content, structuredContent, and isError VERBATIM.
    // Re-wrapping such a response would double-nest it — the wire `structuredContent` would be the
    // OUTER CallToolResult object (containing `content`/`structuredContent`/`isError` keys at the
    // top level) rather than the handler's intended payload, breaking schema-bearing tools.
    //
    // Bare (non-CallToolResult-shaped) payloads are auto-wrapped as before — no regression for
    // existing tools that return plain objects or strings.
    const isCallToolResult =
      typeof payload === 'object' &&
      payload !== null &&
      Array.isArray((payload as Record<string, unknown>)['content']);

    if (isCallToolResult) {
      const ctResult = payload as { content: unknown[]; structuredContent?: unknown; isError?: boolean };
      return reply.status(200).send(
        rpcResult(id, {
          content: ctResult.content,
          ...(ctResult.structuredContent !== undefined
            ? { structuredContent: ctResult.structuredContent }
            : {}),
          ...(ctResult.isError ? { isError: true } : {}),
          _meta: { traceparent: traceparent(span) },
        }),
      );
    }

    // Bare payload — auto-wrap into a valid CallToolResult. A non-2xx handler → isError: true.
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return reply.status(200).send(
      rpcResult(id, {
        content: [{ type: 'text', text }],
        ...(payload && typeof payload === 'object' ? { structuredContent: payload } : {}),
        ...(ok ? {} : { isError: true }),
        _meta: { traceparent: traceparent(span) },
      }),
    );
  }

  // Every host tool call is a C3 fact: who (user), which host (client), which tool, and whether it ran.
  async function recordCall(
    appId: string,
    tool: string,
    verified: VerifiedToken,
    ok: boolean,
    reason?: string,
  ) {
    await store.appendAppEvent({
      app_id: appId,
      type: 'mcp.tool_call',
      subject: tool,
      owner: verified.userId,
      data: {
        tool,
        host: verified.clientId,
        ok,
        ...(reason ? { reason } : {}),
      },
    });
  }

  // === management surface (internal app→sidecar) ==================================================
  // GET /mcp — the Streamable-HTTP STANDALONE server→client stream. The client opens it once and holds
  // it; we push server-initiated JSON-RPC notifications (today: `notifications/tools/list_changed`) so a
  // connected client re-fetches `tools/list` the moment the surface changes — no user reconnect. Same
  // OAuth gate as POST /mcp (it is the same protected resource). Carries NO request/response traffic.
  app.get('/mcp', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);

    const rawBearerGet = bearerFrom(req.headers.authorization);
    const { verified: oauthVerifiedGet } = await verifyAccessTokenDetailed(
      app_.id,
      rawBearerGet,
      `${resourceBase(req)}/mcp`,
    );
    const verified = oauthVerifiedGet ?? (await verifySessionBearer(app_.id, rawBearerGet));
    if (!verified) {
      return reply
        .status(401)
        .header(
          'WWW-Authenticate',
          `Bearer resource_metadata="${resourceBase(req)}/.well-known/oauth-protected-resource/mcp"`,
        )
        .send({
          error: 'invalid_token',
          error_description: 'a valid OAuth access token is required.',
        });
    }

    // Take over the socket — this is a long-lived stream, not a buffered Fastify reply.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stop an intermediary (Traefik/nginx) from buffering the stream — without this the client can
      // sit waiting on a proxy buffer and never see a notification.
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n'); // flush headers through proxies immediately

    // OBSERVABILITY: a stream open is the ONLY proof a client actually consumes the push channel (vs.
    // caching `tools/list` and needing a user reconnect). Client name comes from the DCR registration
    // (e.g. "Claude"/"ChatGPT") so the log says WHICH AI is holding the channel; the UA distinguishes a
    // hosted connector (vendor infra) from a local desktop client.
    const clientName =
      (await (await mcp()).getClient(app_.id, verified.clientId).catch(() => null))?.client_name ?? 'unknown';
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
    const unsubscribe = subscribeToolListChanged(app_.id, {
      write: (frame) => res.write(frame),
      clientName,
      userAgent,
    });
    const openedAt = Date.now();
    mcpLog({
      event: 'mcp.stream_open',
      app: app_.name,
      client: clientName,
      attached: toolListSubscriberCount(app_.id),
    });
    startSpan('mcp.stream_open', {
      attributes: { 'mcp.app': app_.name, 'mcp.client_name': clientName },
    }).end('ok');
    // Idle keep-alive so a proxy doesn't reap a quiet connection (comment frames are ignored by clients).
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* socket gone — the close handler cleans up */
      }
    }, 25_000);
    heartbeat.unref?.();

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearInterval(heartbeat);
      unsubscribe();
      // A very SHORT-lived stream is itself a finding (a proxy or the client is dropping it), which
      // would silently defeat the whole mechanism — so record how long it actually stayed open.
      const heldMs = Date.now() - openedAt;
      mcpLog({
        event: 'mcp.stream_close',
        app: app_.name,
        client: clientName,
        held_ms: heldMs,
        attached: toolListSubscriberCount(app_.id),
      });
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  app.post('/mcp/tools', async (req, reply) => {
    const b = (req.body ?? {}) as Partial<ToolRegistration> & { app?: string };
    const app_ = await resolveAppId(req, b.app);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    if (!b.name || !TOOL_NAME_RE.test(b.name))
      return reply.status(422).send(invalid('a tool `name` (a-zA-Z0-9_- up to 64) is required.'));
    if (!b.handler_path || !b.handler_path.startsWith('/'))
      return reply
        .status(422)
        .send(invalid('a `handler_path` app path (e.g. /api/mcp/tools/create_note) is required.'));
    const family: ToolFamily = FAMILIES.includes(b.family as ToolFamily)
      ? (b.family as ToolFamily)
      : 'action';
    const now = nowIso();
    const existing = await (await mcp()).getTool(app_.id, b.name);
    const tool: ToolRegistration = {
      name: b.name,
      description: typeof b.description === 'string' ? b.description : '',
      input_schema: (b.input_schema as Record<string, unknown>) ?? {
        type: 'object',
      },
      ...(b.output_schema ? { output_schema: b.output_schema as Record<string, unknown> } : {}),
      scope: typeof b.scope === 'string' ? b.scope : '',
      family,
      ...(b.high_risk !== undefined ? { high_risk: Boolean(b.high_risk) } : {}),
      // MCP tool-annotation hints — stored only when the app supplied them (no forced defaults). `title`
      // must be a trimmed non-empty string; the booleans ride through as-declared (false is meaningful).
      ...(typeof b.title === 'string' && b.title.trim() ? { title: b.title.trim() } : {}),
      ...(b.read_only_hint !== undefined ? { read_only_hint: Boolean(b.read_only_hint) } : {}),
      ...(b.destructive_hint !== undefined ? { destructive_hint: Boolean(b.destructive_hint) } : {}),
      ...(b.idempotent_hint !== undefined ? { idempotent_hint: Boolean(b.idempotent_hint) } : {}),
      ...(b.open_world_hint !== undefined ? { open_world_hint: Boolean(b.open_world_hint) } : {}),
      handler_path: b.handler_path,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    await (await mcp()).putTool(app_.id, tool);
    // The tool surface changed → tell every connected client to re-fetch `tools/list` (MCP
    // `notifications/tools/list_changed`). Without this a client keeps serving its cached tool set
    // until the USER manually reconnects the connector.
    broadcastToolListChanged(app_.id);
    // Registration-health metric: the current registered-tool count after this change.
    const toolsAfterPut = await (await mcp()).listTools(app_.id);
    recordMcpRegistrationMetric({
      app: app_.name,
      tools_count: toolsAfterPut.length,
    });
    mcpLog({
      event: 'mcp.tool_register',
      app: app_.name,
      tool: tool.name,
      tools_count: toolsAfterPut.length,
    });
    return reply.status(200).send({ tool });
  });

  app.get('/mcp/tools', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    return { tools: await (await mcp()).listTools(app_.id) };
  });

  // GET /mcp/streams — LIVE snapshot of the attached tool-refresh (SSE) streams, for the operator
  // dashboard. Read from the in-process registry at request time, so it is real-time BY CONSTRUCTION:
  // there is no cache and no persisted copy to go stale — a dropped socket is already absent here.
  // `count: 0` is the meaningful answer that no AI is holding the push channel.
  app.get('/mcp/streams', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    const streams = toolListStreamSnapshot(app_.id);
    return { count: streams.length, streams, observed_at: nowIso() };
  });

  app.delete('/mcp/tools/:name', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    const { name } = req.params as { name: string };
    const deleted = await (await mcp()).deleteTool(app_.id, name);
    // A removed tool is also a surface change (the prune path) — notify so clients drop it promptly.
    if (deleted) {
      broadcastToolListChanged(app_.id);
      const toolsAfterDel = await (await mcp()).listTools(app_.id);
      recordMcpRegistrationMetric({
        app: app_.name,
        tools_count: toolsAfterDel.length,
      });
      mcpLog({
        event: 'mcp.tool_unregister',
        app: app_.name,
        tool: name,
        tools_count: toolsAfterDel.length,
      });
    }
    return { deleted };
  });

  app.post('/mcp/instructions', async (req, reply) => {
    const b = (req.body ?? {}) as {
      app?: string;
      text?: string;
      label?: string;
    };
    const app_ = await resolveAppId(req, b.app);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    if (typeof b.text !== 'string' || !b.text.trim())
      return reply.status(422).send(invalid('a non-empty instruction `text` is required.'));
    const block = await (
      await mcp()
    ).appendInstructions(app_.id, {
      text: b.text,
      ...(b.label ? { label: b.label } : {}),
      created_at: nowIso(),
    });
    return reply.status(200).send({ instructions: block });
  });

  app.get('/mcp/instructions', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    const q = req.query as { version?: string };
    const block = q.version
      ? await (await mcp()).getInstructions(app_.id, Number(q.version))
      : await (await mcp()).latestInstructions(app_.id);
    if (!block)
      return reply.status(404).send({
        error: {
          code: 'not_found',
          message: 'no instruction block declared.',
          retry: 'change-input',
        },
      });
    return { instructions: block };
  });

  // Proactive scheduling — register (or remove) a per-app C2 job that periodically prompts the connected
  // agent to use a designated tool (the app names the tool + cadence + the app path the fire calls back).
  app.post('/mcp/proactive', async (req, reply) => {
    const b = (req.body ?? {}) as {
      app?: string;
      tool?: string;
      every?: string;
      cron?: string;
      target_path?: string;
      disabled?: boolean;
      remove?: boolean;
    };
    const app_ = await resolveAppId(req, b.app);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    if (!b.tool || !TOOL_NAME_RE.test(b.tool))
      return reply.status(422).send(invalid('a `tool` name is required.'));
    const jobName = `mcp-proactive-${b.tool}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    try {
      const result = await executeCapability(
        'schedule-job',
        {
          app: app_.name,
          name: jobName,
          ...(b.remove
            ? { remove: true }
            : {
                target_path: b.target_path,
                ...(b.every ? { every: b.every } : {}),
                ...(b.cron ? { cron: b.cron } : {}),
                ...(b.disabled ? { disabled: true } : {}),
              }),
        },
        SYSTEM_ACTOR,
      );
      // executeCapability wraps as { capability, resource } — surface the ScheduledJob itself.
      return reply.status(200).send({
        proactive: (result as { resource?: unknown }).resource ?? result,
      });
    } catch (e) {
      const err = e as {
        status?: number;
        toJSON?: () => unknown;
        message?: string;
      };
      return reply
        .status(err.status ?? 400)
        .send(
          typeof err.toJSON === 'function'
            ? err.toJSON()
            : invalid(err.message ?? 'could not schedule the proactive job.'),
        );
    }
  });

  // User connector management — the app builds the UX; the platform lists + revokes consent (which also
  // cuts the user's live tokens for that client off).
  app.get('/mcp/consents', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    const q = req.query as { owner?: string };
    if (!q.owner) return reply.status(400).send(invalid('an `owner` is required.'));
    return { consents: await (await mcp()).listConsents(app_.id, q.owner) };
  });

  // Revoke EVERY connector this user has authorized — the C34 account-teardown counterpart to the
  // per-client revoke below. Deleting an account MUST cut the connected AIs off: an MCP access token
  // outlives the account otherwise, and the next tool call succeeds against a deleted owner. Observed
  // live 2026-07-24 — a purged account's Claude connector kept working and RE-CREATED rows under the
  // dead owner id. Both halves matter: the consent record AND the live tokens.
  app.delete('/mcp/consents', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    const q = req.query as { owner?: string };
    if (!q.owner) return reply.status(400).send(invalid('an `owner` is required.'));

    const store = await mcp();
    const consents = await store.listConsents(app_.id, q.owner);
    for (const c of consents) {
      // The per-client revoke drops that client's consent AND its live tokens, transactionally.
      await store.revokeConsent(app_.id, c.client_id, q.owner);
    }
    // Sweep any grant left WITHOUT a consent row — an orphan token is precisely what must not survive —
    // so the result is "this owner holds no MCP credentials", whatever the prior state was.
    const orphanGrants = await store.revokeUserGrants(app_.id, q.owner);

    return {
      clients: consents.map((c) => c.client_id),
      revoked_consents: consents.length,
      revoked_grants: orphanGrants,
    };
  });

  app.delete('/mcp/consents/:client_id', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    const { client_id } = req.params as { client_id: string };
    const q = req.query as { owner?: string };
    if (!q.owner) return reply.status(400).send(invalid('an `owner` is required.'));
    return {
      revoked: await (await mcp()).revokeConsent(app_.id, client_id, q.owner),
    };
  });
}

// --- JSON-RPC helpers -----------------------------------------------------------
function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}
function rpcError(id: string | number | null, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}
