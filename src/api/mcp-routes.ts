import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { store } from '../storage/store';
import { getBackends } from '../storage/backends';
import { executeCapability } from '../core/runtime';
import { SYSTEM_ACTOR } from '../shared/domain';
import { nowIso } from '../shared/time';
import { APP_HEADER } from '../shared/session';
import { appCallbackBase, serviceAuthHeaders } from '../shared/app-callback';
import { resolveServiceToken } from '../plugins/auth-identity/index';
import { verifyAccessToken, bearerFrom, type VerifiedToken } from '../mcp/verify';
import { scopesSatisfy } from '../mcp/oauth';
import type { ToolRegistration, ToolFamily } from '../mcp/types';

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

  function publicBase(req: FastifyRequest): string {
    const explicit = process.env.FORGE_OAUTH_PUBLIC_URL;
    if (explicit) return explicit.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() || 'https';
    const host = String(req.headers['x-forwarded-host'] ?? req.headers['host'] ?? 'localhost');
    return `${proto}://${host}`;
  }

  // === the protected-resource pointer (RFC 9728) — sends the host to our authorization server ======
  app.get('/.well-known/oauth-protected-resource', async (req, reply) => {
    const base = publicBase(req);
    return reply.status(200).send({ resource: `${base}/mcp`, authorization_servers: [base] });
  });

  // === the MCP endpoint (Streamable-HTTP, JSON-RPC 2.0) ============================================
  app.post('/mcp', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);

    // Gate on the OAuth access token; a missing/invalid token → 401 with the discovery pointer so the MCP
    // client kicks off the OAuth flow (RFC 9728 WWW-Authenticate).
    const verified = await verifyAccessToken(app_.id, bearerFrom(req.headers.authorization));
    if (!verified) {
      return reply
        .status(401)
        .header('WWW-Authenticate', `Bearer resource_metadata="${publicBase(req)}/.well-known/oauth-protected-resource"`)
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
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.input_schema ?? { type: 'object' },
            ...(t.output_schema ? { outputSchema: t.output_schema } : {}),
          })),
        }));
      }
      if (method === 'tools/call') {
        return await handleToolCall(reply, app_, verified, id!, params);
      }
      return reply.status(200).send(rpcError(id!, -32601, `Method not found: ${method}`));
    } catch (e) {
      return reply.status(200).send(rpcError(id ?? null, -32603, `Internal error: ${String((e as Error)?.message ?? e)}`));
    }
  });

  // The tool-call handler: scope enforcement → dispatch to the app → wrap the result → C3 attribution.
  async function handleToolCall(
    reply: FastifyReply,
    app_: { id: string; name: string },
    verified: VerifiedToken,
    id: string | number,
    params: Record<string, unknown> | undefined,
  ) {
    const name = params?.name as string | undefined;
    const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
    if (!name || typeof name !== 'string') return reply.status(200).send(rpcError(id, -32602, 'tools/call requires a string `name`.'));
    const tool = await (await mcp()).getTool(app_.id, name);
    if (!tool) return reply.status(200).send(rpcError(id, -32602, `Unknown tool: ${name}`));

    // Per-tool SCOPE enforcement against the granted token (the platform's job). The app additionally runs
    // its C29 authorize() inside the handler for write/act tools — we pass it the seam context below.
    if (tool.scope && !scopesSatisfy(verified.scopes, [tool.scope])) {
      await recordCall(app_.id, name, verified, false, 'insufficient_scope');
      return reply.status(200).send(rpcError(id, -32001, 'insufficient_scope', { required_scope: tool.scope }));
    }

    // Dispatch to the app's handler (the C2 sidecar→app callback), authenticated as a service.
    const base = await appCallbackBase(store, app_.id);
    if (!base) {
      await recordCall(app_.id, name, verified, false, 'app_unreachable');
      return reply.status(200).send(rpcError(id, -32011, 'the app handler is not reachable (never provisioned?).'));
    }
    const serviceToken = await resolveServiceToken(app_.id);
    let ok = false;
    let payload: unknown;
    let httpStatus: number | undefined;
    try {
      const res = await fetch(`${base}${tool.handler_path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...serviceAuthHeaders(serviceToken) },
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
    return { tools: await (await mcp()).listTools(app_.id) };
  });

  app.delete('/mcp/tools/:name', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
    const { name } = req.params as { name: string };
    return { deleted: await (await mcp()).deleteTool(app_.id, name) };
  });

  app.post('/mcp/instructions', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; text?: string; label?: string };
    const app_ = await resolveAppId(req, b.app);
    if (!app_) return reply.status(404).send(unknownApp);
    if (typeof b.text !== 'string' || !b.text.trim()) return reply.status(422).send(invalid('a non-empty instruction `text` is required.'));
    const block = await (await mcp()).appendInstructions(app_.id, { text: b.text, ...(b.label ? { label: b.label } : {}), created_at: nowIso() });
    return reply.status(200).send({ instructions: block });
  });

  app.get('/mcp/instructions', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
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
    const q = req.query as { owner?: string };
    if (!q.owner) return reply.status(400).send(invalid('an `owner` is required.'));
    return { consents: await (await mcp()).listConsents(app_.id, q.owner) };
  });

  app.delete('/mcp/consents/:client_id', async (req, reply) => {
    const app_ = await resolveAppId(req);
    if (!app_) return reply.status(404).send(unknownApp);
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
