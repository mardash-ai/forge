import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { store } from '../storage/store';
import { getBackends } from '../storage/backends';
import { executeCapability } from '../core/runtime';
import { SYSTEM_ACTOR } from '../shared/domain';
import { nowIso } from '../shared/time';
import { APP_HEADER } from '../shared/session';
import { appCallbackBase, serviceAuthHeaders } from '../shared/app-callback';
import { resolveServiceToken } from '../plugins/auth-identity/index';
import { hasValidServiceToken } from '../shared/service-auth';
import { verifyAccessTokenDetailed, bearerFrom, type VerifiedToken } from '../mcp/verify';
import { scopesSatisfy } from '../mcp/oauth';
import type { ToolRegistration, ToolFamily } from '../mcp/types';
import { startSpan, traceparent, parentFromTraceparent, capPayload, ATTR } from '../plugins/otel-langfuse/index';

// C23 — the REMOTE MCP SERVER the platform hosts for a consuming app, plus the app-facing management
// surface. `POST /mcp` speaks JSON-RPC 2.0 over the Streamable-HTTP transport (request/response; no
// persistent SSE server-push in v1, per O1) and is gated by the OAuth access token the C23 AS issued: it
// serves the app's registered tools as MCP tools and DISPATCHES each `tools/call` to the app's handler (the
// C2 sidecar→app callback), enforcing the tool's scope and recording the call to the C3 audit trail. The
// `/mcp/*` management routes are internal app→sidecar calls (like the C3/C4 routes) that register the tool
// surface, version the instruction block, and schedule proactive prompts via C2.
//
//   POST /mcp                              JSON-RPC: initialize | tools/list | tools/call | ping  (Bearer-gated)
//   GET  /.well-known/oauth-protected-resource   -> points the host at the C23 authorization server
//   POST /mcp/tools    { name, description, input_schema, scope, family, handler_path, … }  -> register a tool
//   GET  /mcp/tools                        -> the app's tool surface
//   DELETE /mcp/tools/:name                -> unregister
//   POST /mcp/instructions  { text, label? } -> append a new instruction/training version
//   GET  /mcp/instructions  ?version=       -> the latest (or a specific) instruction block
//   POST /mcp/proactive  { tool, every?|cron?, target_path, remove? } -> schedule a proactive prompt via C2
//   GET  /mcp/consents ?owner=  +  DELETE /mcp/consents/:client_id ?owner=  -> user connector management

const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_SERVER_VERSION = '1.0.0';
const TOOL_CALL_TIMEOUT_MS = 30_000;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const FAMILIES: ToolFamily[] = ['read', 'write', 'action'];

const invalid = (message: string) => ({ error: { code: 'invalid_input', message, retry: 'change-input' } });
const unknownApp = { error: { code: 'not_found', message: 'unknown app (pass `app` or set FORGE_APP_NAME).', retry: 'change-input' } };

// C36 payload capture gate — tool-call ARGUMENTS + the returned PAYLOAD are recorded on the trace as the
// Langfuse observation input/output by default; ONLY the literal string "false" disables. Read per call so
// an operator toggle needs no process restart. The capture is strictly the application payload — the
// Authorization header / bearer / service token NEVER enter the recorded values.
const tracePayloads = (): boolean => process.env.FORGE_MCP_TRACE_PAYLOADS !== 'false';

export function registerMcpRoutes(app: FastifyInstance, opts: { defaultApp?: () => string | undefined } = {}): void {
  const resolveAppId = async (req: FastifyRequest, explicit?: string): Promise<{ id: string; name: string } | null> => {
    const n =
      (typeof explicit === 'string' && explicit.trim()) ||
      (typeof (req.query as { app?: string })?.app === 'string' && (req.query as { app?: string }).app!.trim()) ||
      (typeof (req.body as { app?: string })?.app === 'string' && (req.body as { app?: string }).app!.trim()) ||
      (Array.isArray(req.headers[APP_HEADER]) ? (req.headers[APP_HEADER] as string[])[0] : (req.headers[APP_HEADER] as string | undefined)) ||
      opts.defaultApp?.();
    if (!n) return null;
    const a = await store.findAppByName(String(n));
    return a && a.type === 'Application' ? { id: a.id, name: String(n) } : null;
  };
  const mcp = () => getBackends().then((b) => b.mcp);

  // issuerBase — the PINNED OAuth authorization-server / issuer origin (RFC 8414). The AS must stay on the
  // certless MACHINE-FACING api host: the browser consent + DCR flow can't present a client cert, so the AS
  // never relocates to a dedicated mTLS host. INDEPENDENT of the browser-facing `/connect/*` callback
  // (connect-routes.ts), which uses FORGE_OAUTH_PUBLIC_URL to pin the USER-FACING app host. Prefer
  // FORGE_MCP_PUBLIC_URL; fall back to FORGE_OAUTH_PUBLIC_URL (back-compat — prod set that before the split);
  // then the forwarded-host header.
  function issuerBase(req: FastifyRequest): string {
    const explicit = process.env.FORGE_MCP_PUBLIC_URL || process.env.FORGE_OAUTH_PUBLIC_URL;
    if (explicit) return explicit.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() || 'https';
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
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() || 'https';
    const fwdHost = String(req.headers['x-forwarded-host'] ?? req.headers['host'] ?? 'localhost').split(',')[0]!.trim();
    const pin = process.env.FORGE_MCP_PUBLIC_URL?.replace(/\/+$/, '');
    const allowed = new Set<string>();
    if (pin) { try { allowed.add(new URL(pin).host); } catch { /* malformed pin — ignore */ } }
    for (const h of (process.env.FORGE_MCP_ALT_HOSTS ?? '').split(',')) { const t = h.trim(); if (t) allowed.add(t); }
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
    if (path === '/mcp' || path.startsWith('/mcp/') || path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
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
  const needServiceToken = { error: { code: 'unauthorized', message: 'a valid x-forge-service-token is required.', retry: 'needs-human' } };
  async function requireServiceToken(req: FastifyRequest, reply: FastifyReply, appId: string): Promise<boolean> {
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
    reply.status(200).send({ resource: `${resourceBase(req)}/mcp`, authorization_servers: [issuerBase(req)] });
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
    const { verified, reason } = await verifyAccessTokenDetailed(app_.id, bearerFrom(req.headers.authorization), `${resourceBase(req)}/mcp`);
    if (!verified) {
      // C36 — a transport auth rejection used to die INVISIBLY (no span, zero trace-side evidence a client
      // was knocking). Emit a short span with the reject reason (invalid_token vs resource_mismatch) + the
      // requested JSON-RPC method, adopting the edge's `traceparent` when present so it lands on the edge
      // trace. NO token material is ever recorded. The wire response stays a uniform invalid_token 401.
      const method = (req.body as { method?: unknown } | undefined)?.method;
      startSpan('mcp.auth_reject', {
        parent: parentFromTraceparent(req.headers.traceparent),
        attributes: { 'mcp.app': app_.name, ...(typeof method === 'string' ? { 'mcp.method': method } : {}) },
      }).end('error', reason ?? 'invalid_token');
      return reply
        .status(401)
        .header('WWW-Authenticate', `Bearer resource_metadata="${resourceBase(req)}/.well-known/oauth-protected-resource/mcp"`)
        .send({ error: 'invalid_token', error_description: 'a valid OAuth access token is required.' });
    }

    const body = req.body as { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> } | undefined;
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
        return reply.status(200).send(rpcResult(id!, {
          protocolVersion: clientProto,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `forge-mcp:${app_.name}`, version: MCP_SERVER_VERSION },
          ...(latest ? { instructions: latest.text } : {}),
        }));
      }
      if (method === 'ping') {
        return reply.status(200).send(rpcResult(id!, {}));
      }
      if (method === 'tools/list') {
        const tools = await (await mcp()).listTools(app_.id);
        return reply.status(200).send(rpcResult(id!, {
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
        }));
      }
      if (method === 'tools/call') {
        return await handleToolCall(req, reply, app_, verified, id!, params);
      }
      return reply.status(200).send(rpcError(id!, -32601, `Method not found: ${method}`));
    } catch (e) {
      return reply.status(200).send(rpcError(id ?? null, -32603, `Internal error: ${String((e as Error)?.message ?? e)}`));
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
    if (!name || typeof name !== 'string') return reply.status(200).send(rpcError(id, -32602, 'tools/call requires a string `name`.'));

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
      return reply.status(200).send(rpcError(id, -32602, `Unknown tool: ${name}`));
    }
    span.setAttribute('mcp.tool.family', tool.family);
    span.setAttribute('mcp.tool.high_risk', tool.high_risk ?? false);

    // Per-tool SCOPE enforcement against the granted token (the platform's job). The app additionally runs
    // its C29 authorize() inside the handler for write/act tools — we pass it the seam context below.
    if (tool.scope && !scopesSatisfy(verified.scopes, [tool.scope])) {
      await recordCall(app_.id, name, verified, false, 'insufficient_scope');
      span.setAttribute(ATTR.AUTHZ_DECISION, 'insufficient_scope').end('error', 'insufficient_scope');
      return reply.status(200).send(rpcError(id, -32001, 'insufficient_scope', { required_scope: tool.scope }));
    }

    // Dispatch to the app's handler (the C2 sidecar→app callback), authenticated as a service.
    const base = await appCallbackBase(store, app_.id);
    if (!base) {
      await recordCall(app_.id, name, verified, false, 'app_unreachable');
      span.end('error', 'app_unreachable');
      return reply.status(200).send(rpcError(id, -32011, 'the app handler is not reachable (never provisioned?).'));
    }
    const serviceToken = await resolveServiceToken(app_.id);
    let ok = false;
    let payload: unknown;
    let httpStatus: number | undefined;
    try {
      const res = await fetch(`${base}${tool.handler_path}`, {
        method: 'POST',
        // `traceparent` propagates THIS trace into the app tier so the proxy edge + dispatch spans join it.
        headers: { 'content-type': 'application/json', traceparent: traceparent(span), ...serviceAuthHeaders(serviceToken) },
        // The C29 governance SEAM: the app's handler gets the user + the tool's safety family/high-risk hint
        // and runs its own authorize() (the platform enforced scope; the app decides allow/stage/deny).
        body: JSON.stringify({ tool: name, arguments: args, user: { id: verified.userId }, family: tool.family, high_risk: tool.high_risk ?? false, client_id: verified.clientId }),
        signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),
      });
      httpStatus = res.status;
      ok = res.ok;
      payload = await res.json().catch(() => ({}));
    } catch (e) {
      payload = { error: String((e as Error)?.message ?? e) };
    }
    await recordCall(app_.id, name, verified, ok, ok ? undefined : `handler_status_${httpStatus ?? 'error'}`);
    if (httpStatus !== undefined) span.setAttribute('http.response.status_code', httpStatus);
    // C36 — the returned payload is the observation OUTPUT, on SUCCESS AND FAILURE alike: an isError /
    // handler_status_* error body is exactly what you need to see on the trace to debug the bounce.
    if (tracePayloads()) span.setAttribute(ATTR.LANGFUSE_OBSERVATION_OUTPUT, capPayload(payload));
    span.end(ok ? 'ok' : 'error', ok ? undefined : `handler_status_${httpStatus ?? 'error'}`);

    // Wrap the app's JSON into an MCP tool result. A structured object rides `structuredContent`; a
    // human-readable rendering rides `content` text. A non-2xx handler → an MCP tool error (isError).
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return reply.status(200).send(rpcResult(id, {
      content: [{ type: 'text', text }],
      ...(payload && typeof payload === 'object' ? { structuredContent: payload } : {}),
      ...(ok ? {} : { isError: true }),
    }));
  }

  // Every host tool call is a C3 fact: who (user), which host (client), which tool, and whether it ran.
  async function recordCall(appId: string, tool: string, verified: VerifiedToken, ok: boolean, reason?: string) {
    await store.appendAppEvent({
      app_id: appId,
      type: 'mcp.tool_call',
      subject: tool,
      owner: verified.userId,
      data: { tool, host: verified.clientId, ok, ...(reason ? { reason } : {}) },
    });
  }

  // === management surface (internal app→sidecar) ==================================================
  app.post('/mcp/tools', async (req, reply) => {
    const b = (req.body ?? {}) as Partial<ToolRegistration> & { app?: string };
    const app_ = await resolveAppId(req, b.app);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    if (!b.name || !TOOL_NAME_RE.test(b.name)) return reply.status(422).send(invalid('a tool `name` (a-zA-Z0-9_- up to 64) is required.'));
    if (!b.handler_path || !b.handler_path.startsWith('/')) return reply.status(422).send(invalid('a `handler_path` app path (e.g. /api/mcp/tools/create_note) is required.'));
    const family: ToolFamily = FAMILIES.includes(b.family as ToolFamily) ? (b.family as ToolFamily) : 'action';
    const now = nowIso();
    const existing = await (await mcp()).getTool(app_.id, b.name);
    const tool: ToolRegistration = {
      name: b.name,
      description: typeof b.description === 'string' ? b.description : '',
      input_schema: (b.input_schema as Record<string, unknown>) ?? { type: 'object' },
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
    return reply.status(200).send({ tool });
  });

  app.get('/mcp/tools', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    return { tools: await (await mcp()).listTools(app_.id) };
  });

  app.delete('/mcp/tools/:name', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    const { name } = req.params as { name: string };
    return { deleted: await (await mcp()).deleteTool(app_.id, name) };
  });

  app.post('/mcp/instructions', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; text?: string; label?: string };
    const app_ = await resolveAppId(req, b.app);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    if (typeof b.text !== 'string' || !b.text.trim()) return reply.status(422).send(invalid('a non-empty instruction `text` is required.'));
    const block = await (await mcp()).appendInstructions(app_.id, { text: b.text, ...(b.label ? { label: b.label } : {}), created_at: nowIso() });
    return reply.status(200).send({ instructions: block });
  });

  app.get('/mcp/instructions', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    const q = req.query as { version?: string };
    const block = q.version ? await (await mcp()).getInstructions(app_.id, Number(q.version)) : await (await mcp()).latestInstructions(app_.id);
    if (!block) return reply.status(404).send({ error: { code: 'not_found', message: 'no instruction block declared.', retry: 'change-input' } });
    return { instructions: block };
  });

  // Proactive scheduling — register (or remove) a per-app C2 job that periodically prompts the connected
  // agent to use a designated tool (the app names the tool + cadence + the app path the fire calls back).
  app.post('/mcp/proactive', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; tool?: string; every?: string; cron?: string; target_path?: string; disabled?: boolean; remove?: boolean };
    const app_ = await resolveAppId(req, b.app);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    if (!b.tool || !TOOL_NAME_RE.test(b.tool)) return reply.status(422).send(invalid('a `tool` name is required.'));
    const jobName = `mcp-proactive-${b.tool}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    try {
      const result = await executeCapability(
        'schedule-job',
        {
          app: app_.name,
          name: jobName,
          ...(b.remove ? { remove: true } : { target_path: b.target_path, ...(b.every ? { every: b.every } : {}), ...(b.cron ? { cron: b.cron } : {}), ...(b.disabled ? { disabled: true } : {}) }),
        },
        SYSTEM_ACTOR,
      );
      // executeCapability wraps as { capability, resource } — surface the ScheduledJob itself.
      return reply.status(200).send({ proactive: (result as { resource?: unknown }).resource ?? result });
    } catch (e) {
      const err = e as { status?: number; toJSON?: () => unknown; message?: string };
      return reply.status(err.status ?? 400).send(typeof err.toJSON === 'function' ? err.toJSON() : invalid(err.message ?? 'could not schedule the proactive job.'));
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

  app.delete('/mcp/consents/:client_id', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    if (!(await requireServiceToken(req, reply, app_.id))) return;
    const { client_id } = req.params as { client_id: string };
    const q = req.query as { owner?: string };
    if (!q.owner) return reply.status(400).send(invalid('an `owner` is required.'));
    return { revoked: await (await mcp()).revokeConsent(app_.id, client_id, q.owner) };
  });
}

// --- JSON-RPC helpers -----------------------------------------------------------
function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}
function rpcError(id: string | number | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
