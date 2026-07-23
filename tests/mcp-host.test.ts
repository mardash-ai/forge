import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { store } from '../src/storage/store';
import { getBackends } from '../src/storage/backends';
import { registerMcpRoutes } from '../src/api/mcp-routes';
import { newToken } from '../src/plugins/auth-identity/index';
import { expiresAtIso } from '../src/mcp/oauth';
import { nowIso } from '../src/shared/time';
import { initOtelLangfuse } from '../src/plugins/otel-langfuse/index';
import type { Application } from '../src/resources/types';

// C23 — the hosted remote MCP server (Streamable-HTTP JSON-RPC) + the app-facing management surface.
// Exercised through the configured MCP store (filesystem default / Postgres on the pg run) with a STUB app
// server standing in for the consuming app's tool handlers — so tool registration, OAuth-gated dispatch,
// per-tool scope enforcement, C3 attribution, instruction versioning, and C2 proactive scheduling are all
// validated on BOTH backends.
const APP = 'demo';
const APP_ID = 'app_demo';
const SVC_TOKEN = 'test-service-token-abc123'; // Change D — the app→sidecar management-surface service token
let dir: string;
let prevDir: string | undefined;
let prevHost: string | undefined;
let prevPort: string | undefined;
let prevSvc: string | undefined;
let server: FastifyInstance;
let stub: FastifyInstance;
let calls: string[];

const seedApp = async (): Promise<void> => {
  const now = nowIso();
  await store.saveResource({
    id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
    name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web', language: 'typescript', package_manager: 'npm',
  } as Application);
};

// Mint an access grant directly (the OAuth flow itself is covered in mcp-oauth.test.ts). Returns the raw
// bearer the /mcp endpoint verifies.
const mintAccess = async (scopes: string[], owner = 'userA', clientId = 'client1', resource?: string): Promise<string> => {
  const { token, hash } = newToken();
  await (await getBackends()).mcp.putGrant(APP_ID, {
    kind: 'access', token_hash: hash, client_id: clientId, owner, scopes, expires_at: expiresAtIso(3600),
    ...(resource ? { resource } : {}), created_at: nowIso(),
  });
  return token;
};

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevHost = process.env.FORGE_APP_CALLBACK_HOST;
  prevPort = process.env.FORGE_APP_CALLBACK_PORT;
  prevSvc = process.env.AUTH_SERVICE_TOKEN;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-mcp-host-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.AUTH_SERVICE_TOKEN = SVC_TOKEN; // resolveServiceToken picks this up via the env fallback
  await store.init();
  await seedApp();

  // The stub app: the callback target the platform dispatches tool calls to.
  calls = [];
  stub = Fastify({ logger: false });
  stub.post('/api/mcp/tools/get_note', async (req) => {
    calls.push('get_note');
    return { note: 'hello', echoed: (req.body as { arguments?: unknown }).arguments };
  });
  stub.post('/api/mcp/tools/boom', async (_req, reply) => {
    calls.push('boom');
    return reply.status(500).send({ error: 'kaboom' });
  });
  await stub.listen({ port: 0, host: '127.0.0.1' });
  const port = (stub.server.address() as AddressInfo).port;
  process.env.FORGE_APP_CALLBACK_HOST = '127.0.0.1';
  process.env.FORGE_APP_CALLBACK_PORT = String(port);

  server = Fastify({ logger: false });
  registerMcpRoutes(server, { defaultApp: () => APP });
  await server.ready();
});
afterEach(async () => {
  await server.close();
  await stub.close();
  if (prevDir === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prevDir;
  if (prevHost === undefined) delete process.env.FORGE_APP_CALLBACK_HOST; else process.env.FORGE_APP_CALLBACK_HOST = prevHost;
  if (prevPort === undefined) delete process.env.FORGE_APP_CALLBACK_PORT; else process.env.FORGE_APP_CALLBACK_PORT = prevPort;
  if (prevSvc === undefined) delete process.env.AUTH_SERVICE_TOKEN; else process.env.AUTH_SERVICE_TOKEN = prevSvc;
  await rm(dir, { recursive: true, force: true });
});

const rpc = (method: string, params: unknown, bearer?: string, id: number | string = 1) =>
  server.inject({
    method: 'POST', url: '/mcp',
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    payload: { jsonrpc: '2.0', id, method, params } as object,
  });
// The management-surface helpers present the service token (Change D). Ungated routes (`.well-known`) ignore
// it harmlessly; the JSON-RPC `rpc` helper below deliberately does NOT send it (POST /mcp is OAuth-gated).
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  server.inject({ method: 'POST', url, headers: { 'x-forge-service-token': SVC_TOKEN, ...headers }, payload: payload as object });
const get = (url: string, headers: Record<string, string> = {}) =>
  server.inject({ method: 'GET', url, headers: { 'x-forge-service-token': SVC_TOKEN, ...headers } });

const registerTool = (over: Record<string, unknown> = {}) =>
  post('/mcp/tools', { name: 'get_note', description: 'Read a note', input_schema: { type: 'object' }, scope: 'notes:read', family: 'read', handler_path: '/api/mcp/tools/get_note', ...over });

describe('C23 — tool registration + the OAuth-gated MCP endpoint', () => {
  it('requires a valid bearer (401 with the discovery pointer)', async () => {
    const unauth = await rpc('initialize', {});
    expect(unauth.statusCode).toBe(401);
    expect(String(unauth.headers['www-authenticate'])).toContain('resource_metadata=');
  });

  it('initialize returns serverInfo + the latest instruction block; tools/list returns the surface', async () => {
    await registerTool();
    await post('/mcp/instructions', { text: 'v1 preamble' });
    await post('/mcp/instructions', { text: 'v2 — call whats_next each morning', label: 'B' });
    const bearer = await mintAccess(['notes:read']);

    const init = await rpc('initialize', { protocolVersion: '2025-06-18' }, bearer);
    expect(init.statusCode).toBe(200);
    const initR = init.json().result;
    expect(initR.serverInfo.name).toBe('forge-mcp:demo');
    expect(initR.instructions).toBe('v2 — call whats_next each morning'); // latest version served

    const list = await rpc('tools/list', {}, bearer);
    const tools = list.json().result.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'get_note', inputSchema: { type: 'object' } });
  });

  it('dispatches tools/call to the app handler and records the call to C3', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    const res = await rpc('tools/call', { name: 'get_note', arguments: { id: 'n1' } }, bearer);
    expect(res.statusCode).toBe(200);
    const result = res.json().result;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ note: 'hello', echoed: { id: 'n1' } });
    expect(calls).toContain('get_note');

    // Attribution (C3): who, which host, which tool.
    const events = await store.listAppEvents({ app_id: APP_ID, owner: 'userA', subject: 'get_note' });
    expect(events.some((e) => e.type === 'mcp.tool_call' && (e.data as { ok?: boolean }).ok === true && (e.data as { host?: string }).host === 'client1')).toBe(true);
  });

  it('enforces per-tool scope against the granted token', async () => {
    await registerTool({ name: 'send_note', scope: 'notes:write', family: 'action', handler_path: '/api/mcp/tools/get_note' });
    const bearer = await mintAccess(['notes:read']); // lacks notes:write
    const res = await rpc('tools/call', { name: 'send_note', arguments: {} }, bearer);
    expect(res.json().error).toMatchObject({ code: -32001, message: 'insufficient_scope', data: { required_scope: 'notes:write' } });
    expect(calls).not.toContain('get_note'); // never dispatched

    // The denial is still audited (ok:false, reason insufficient_scope).
    const events = await store.listAppEvents({ app_id: APP_ID, owner: 'userA', subject: 'send_note' });
    expect(events.some((e) => (e.data as { reason?: string }).reason === 'insufficient_scope')).toBe(true);
  });

  it('a non-2xx app handler surfaces as an MCP tool error (isError)', async () => {
    await registerTool({ name: 'boom', scope: '', handler_path: '/api/mcp/tools/boom' });
    const bearer = await mintAccess([]);
    const res = await rpc('tools/call', { name: 'boom', arguments: {} }, bearer);
    expect(res.json().result.isError).toBe(true);
  });

  it('unknown tool / unknown method → JSON-RPC errors', async () => {
    const bearer = await mintAccess(['notes:read']);
    expect((await rpc('tools/call', { name: 'nope' }, bearer)).json().error.code).toBe(-32602);
    expect((await rpc('does/not/exist', {}, bearer)).json().error.code).toBe(-32601);
  });
});

describe('C23 — instruction versioning + proactive scheduling (C2)', () => {
  it('appends monotonically-versioned instruction blocks', async () => {
    expect((await post('/mcp/instructions', { text: 'one' })).json().instructions.version).toBe(1);
    expect((await post('/mcp/instructions', { text: 'two' })).json().instructions.version).toBe(2);
    expect((await get('/mcp/instructions')).json().instructions.text).toBe('two');
    expect((await get('/mcp/instructions?version=1')).json().instructions.text).toBe('one');
  });

  it('schedules a proactive prompt as a C2 ScheduledJob', async () => {
    const r = await post('/mcp/proactive', { tool: 'whats_next', every: '6h', target_path: '/api/cron/whats-next' });
    expect(r.statusCode).toBe(200);
    expect(r.json().proactive).toMatchObject({ type: 'ScheduledJob', name: 'mcp-proactive-whats-next', schedule: 'every:6h' });

    const jobs = await store.listResources({ type: 'ScheduledJob', app_id: APP_ID });
    expect(jobs.some((j) => (j as { name?: string }).name === 'mcp-proactive-whats-next')).toBe(true);
  });
});

describe('C23 — MCP tool annotations on the wire', () => {
  it('emits a top-level title + camelCase annotations for a tool registered with hints', async () => {
    await registerTool({
      name: 'archive_note',
      title: '  Archive a note  ', // trimmed on the way in
      read_only_hint: false,
      destructive_hint: true,
      idempotent_hint: true,
      open_world_hint: false,
    });
    const bearer = await mintAccess(['notes:read']);
    const list = await rpc('tools/list', {}, bearer);
    const tool = list.json().result.tools.find((t: { name: string }) => t.name === 'archive_note');
    expect(tool.title).toBe('Archive a note');
    // camelCase on the wire, exactly the declared keys/booleans (false is meaningful — not dropped).
    expect(tool.annotations).toEqual({
      title: 'Archive a note',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('omits `annotations` (and title) entirely for a tool registered with NO hints — no forced defaults', async () => {
    await registerTool(); // plain get_note, no annotation hints
    const bearer = await mintAccess(['notes:read']);
    const list = await rpc('tools/list', {}, bearer);
    const tool = list.json().result.tools.find((t: { name: string }) => t.name === 'get_note');
    expect(tool).toBeTruthy();
    expect(tool.annotations).toBeUndefined();
    expect(tool.title).toBeUndefined();
  });
});

// Change B — the MCP resource identifier (RFC 9728) + AS issuer must resolve to the MACHINE-FACING api host.
// FORGE_MCP_PUBLIC_URL pins it, independent of the browser-facing FORGE_OAUTH_PUBLIC_URL (the app host).
describe('C23 — resource-identifier host split (FORGE_MCP_PUBLIC_URL)', () => {
  it('advertises resource + AS under FORGE_MCP_PUBLIC_URL when it AND FORGE_OAUTH_PUBLIC_URL are both set', async () => {
    const prevMcp = process.env.FORGE_MCP_PUBLIC_URL;
    const prevOauth = process.env.FORGE_OAUTH_PUBLIC_URL;
    process.env.FORGE_OAUTH_PUBLIC_URL = 'https://app.dorinda.ai'; // the browser/app host — must NOT win here
    process.env.FORGE_MCP_PUBLIC_URL = 'https://api.dorinda.ai'; // the machine-facing api host — must win
    try {
      const body = (await get('/.well-known/oauth-protected-resource')).json();
      expect(body.resource).toBe('https://api.dorinda.ai/mcp');
      expect(body.authorization_servers).toEqual(['https://api.dorinda.ai']);
    } finally {
      if (prevMcp === undefined) delete process.env.FORGE_MCP_PUBLIC_URL; else process.env.FORGE_MCP_PUBLIC_URL = prevMcp;
      if (prevOauth === undefined) delete process.env.FORGE_OAUTH_PUBLIC_URL; else process.env.FORGE_OAUTH_PUBLIC_URL = prevOauth;
    }
  });

  it('falls back to FORGE_OAUTH_PUBLIC_URL when FORGE_MCP_PUBLIC_URL is unset (back-compat)', async () => {
    const prevMcp = process.env.FORGE_MCP_PUBLIC_URL;
    const prevOauth = process.env.FORGE_OAUTH_PUBLIC_URL;
    delete process.env.FORGE_MCP_PUBLIC_URL;
    process.env.FORGE_OAUTH_PUBLIC_URL = 'https://legacy.example';
    try {
      const body = (await get('/.well-known/oauth-protected-resource')).json();
      expect(body.resource).toBe('https://legacy.example/mcp');
    } finally {
      if (prevMcp === undefined) delete process.env.FORGE_MCP_PUBLIC_URL; else process.env.FORGE_MCP_PUBLIC_URL = prevMcp;
      if (prevOauth === undefined) delete process.env.FORGE_OAUTH_PUBLIC_URL; else process.env.FORGE_OAUTH_PUBLIC_URL = prevOauth;
    }
  });

  // RFC 9728 §3.1 — a resource at `<host>/mcp` publishes its metadata at the PATH-SUFFIXED well-known
  // URL. Claude's connector validation derives + requires this form; a 404 there was reported to the
  // user as a "server configuration issue" (live-confirmed 2026-07-23). Both discovery docs must serve
  // the path-suffixed URL identically to the root, and the 401 pointer must name the suffixed URL.
  it('serves the protected-resource metadata at the RFC 9728 path-suffixed /mcp URL (Claude connector requirement)', async () => {
    const rootPr = (await get('/.well-known/oauth-protected-resource')).json();
    const suffPrRes = await get('/.well-known/oauth-protected-resource/mcp');
    expect(suffPrRes.statusCode).toBe(200);
    expect(suffPrRes.json()).toEqual(rootPr);
  });

  it('the 401 WWW-Authenticate points at the path-suffixed protected-resource metadata', async () => {
    const unauth = await rpc('initialize', {});
    expect(unauth.statusCode).toBe(401);
    expect(String(unauth.headers['www-authenticate'])).toContain('/.well-known/oauth-protected-resource/mcp"');
  });
});

describe('C23 — connector (consent) management', () => {
  it('lists and revokes a user’s consent, cutting their tokens off', async () => {
    const bearer = await mintAccess(['notes:read'], 'userA', 'clientZ');
    await (await getBackends()).mcp.putConsent(APP_ID, { client_id: 'clientZ', owner: 'userA', scopes: ['notes:read'], created_at: nowIso(), updated_at: nowIso() });

    expect((await get('/mcp/consents?owner=userA')).json().consents).toHaveLength(1);
    await registerTool();
    // token works before revocation
    expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, bearer)).json().result.structuredContent).toBeTruthy();

    const del = await server.inject({ method: 'DELETE', url: '/mcp/consents/clientZ?owner=userA', headers: { 'x-forge-service-token': SVC_TOKEN } });
    expect(del.json().revoked).toBe(true);
    // the token is now dead → 401
    expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, bearer)).statusCode).toBe(401);
    expect((await get('/mcp/consents?owner=userA')).json().consents).toHaveLength(0);
  });
});

// Change D — the app→sidecar MANAGEMENT surface is proxied to the public internet by the consumer and
// carries no OAuth, so every /mcp/* management route MUST require the app's C10 service token. FAIL CLOSED.
describe('Change D — management routes require the x-forge-service-token', () => {
  // A management call WITHOUT any service token (the raw inject helper — no header).
  const noToken = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    server.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });

  it('rejects EVERY management route with 401 when no service token is presented', async () => {
    expect((await noToken('POST', '/mcp/tools', { name: 'get_note', scope: 'notes:read', family: 'read', handler_path: '/api/mcp/tools/get_note' })).statusCode).toBe(401);
    expect((await noToken('GET', '/mcp/tools')).statusCode).toBe(401);
    expect((await noToken('DELETE', '/mcp/tools/get_note')).statusCode).toBe(401);
    expect((await noToken('POST', '/mcp/instructions', { text: 'v1' })).statusCode).toBe(401);
    expect((await noToken('GET', '/mcp/instructions')).statusCode).toBe(401);
    expect((await noToken('POST', '/mcp/proactive', { tool: 'whats_next', every: '6h', target_path: '/api/cron/x' })).statusCode).toBe(401);
    expect((await noToken('GET', '/mcp/consents?owner=userA')).statusCode).toBe(401);
    expect((await noToken('DELETE', '/mcp/consents/clientZ?owner=userA')).statusCode).toBe(401);
  });

  it('rejects a WRONG service token, accepts the CORRECT one', async () => {
    const wrong = await server.inject({ method: 'GET', url: '/mcp/tools', headers: { 'x-forge-service-token': 'not-the-token' } });
    expect(wrong.statusCode).toBe(401);
    const okReg = await post('/mcp/tools', { name: 'get_note', description: 'Read a note', input_schema: { type: 'object' }, scope: 'notes:read', family: 'read', handler_path: '/api/mcp/tools/get_note' });
    expect(okReg.statusCode).toBe(200);
    expect((await get('/mcp/tools')).statusCode).toBe(200);
  });

  it('FAILS CLOSED when AUTH_SERVICE_TOKEN is unset in the environment — never fail open', async () => {
    const prev = process.env.AUTH_SERVICE_TOKEN;
    delete process.env.AUTH_SERVICE_TOKEN;
    try {
      // Even presenting the previously-valid token is rejected: with nothing configured there is nothing to match.
      const r = await server.inject({ method: 'GET', url: '/mcp/tools', headers: { 'x-forge-service-token': SVC_TOKEN } });
      expect(r.statusCode).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.AUTH_SERVICE_TOKEN; else process.env.AUTH_SERVICE_TOKEN = prev;
    }
  });

  it('does NOT gate POST /mcp (OAuth-gated) nor the public .well-known discovery doc', async () => {
    // POST /mcp with no bearer → 401 from the OAUTH gate (not the service-token gate); with a bearer → 200.
    expect((await rpc('initialize', {})).statusCode).toBe(401);
    const bearer = await mintAccess([]);
    expect((await rpc('initialize', {}, bearer)).statusCode).toBe(200);
    // Discovery is public — 200 with no token of any kind.
    expect((await noToken('GET', '/.well-known/oauth-protected-resource')).statusCode).toBe(200);
  });
});

// Change B — per-tool securitySchemes on tools/list (ChatGPT Apps SDK shape).
describe('Change B — per-tool securitySchemes on tools/list', () => {
  it('emits an oauth2 scheme carrying the tool scope, and noauth for a scopeless tool', async () => {
    await registerTool(); // get_note, scope notes:read
    await registerTool({ name: 'ping_pub', scope: '', family: 'read', handler_path: '/api/mcp/tools/get_note' });
    const bearer = await mintAccess(['notes:read']);
    const tools = (await rpc('tools/list', {}, bearer)).json().result.tools;
    const gated = tools.find((t: { name: string }) => t.name === 'get_note');
    const open = tools.find((t: { name: string }) => t.name === 'ping_pub');
    expect(gated.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['notes:read'] }]);
    expect(open.securitySchemes).toEqual([{ type: 'noauth' }]);
  });
});

// Change C — a restrictive CSP on the machine-facing MCP surface.
describe('Change C — Content-Security-Policy on the MCP host', () => {
  it('sets a restrictive CSP on the discovery doc, POST /mcp, and the management surface', async () => {
    const wk = await server.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' });
    expect(wk.headers['content-security-policy']).toContain("default-src 'none'");
    const bearer = await mintAccess([]);
    const ping = await rpc('ping', {}, bearer);
    expect(ping.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    const mgmt = await get('/mcp/tools');
    expect(mgmt.headers['content-security-policy']).toContain("base-uri 'none'");
  });
});

// C36 — payload tracing + failure-path spans on the `mcp.tool_call` trace. The exporter is a
// fire-and-forget fetch to the OTLP collector, so the tests intercept fetch for the collector URL ONLY
// (the tool dispatch to the stub app passes through untouched) and assert on the exported OTLP bodies.
describe('C36 — payload tracing + failure-path spans', () => {
  const OTLP = 'http://otel-collector.test/api/public/otel';
  let exported: unknown[];

  interface WireSpan {
    name: string;
    traceId: string;
    parentSpanId?: string;
    status: { code: number };
    attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number; boolValue?: boolean } }>;
  }
  const spans = (): WireSpan[] =>
    (exported as Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: WireSpan[] }> }> }>)
      .flatMap((b) => b.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
  const spanNamed = (name: string): WireSpan | undefined => spans().filter((s) => s.name === name).at(-1);
  const attr = (s: WireSpan | undefined, key: string): string | number | boolean | undefined => {
    const v = s?.attributes.find((a) => a.key === key)?.value;
    return v === undefined ? undefined : (v.stringValue ?? v.intValue ?? v.boolValue);
  };

  beforeEach(() => {
    exported = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: unknown, init?: RequestInit) => {
      if (String(url).startsWith(OTLP)) {
        exported.push(JSON.parse(String(init?.body)));
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return realFetch(url as Parameters<typeof fetch>[0], init);
    }) as typeof fetch);
    initOtelLangfuse({ endpoint: OTLP, publicKey: 'pk-test', secretKey: 'sk-test' });
  });
  afterEach(() => {
    initOtelLangfuse({ publicKey: '', secretKey: '' }); // disable again so other tests are unaffected
    vi.restoreAllMocks();
    delete process.env.FORGE_MCP_TRACE_PAYLOADS;
  });

  it('records tool-call arguments as the Langfuse observation INPUT and the returned payload as the OUTPUT — never auth material', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    const res = await rpc('tools/call', { name: 'get_note', arguments: { id: 'n1' } }, bearer);
    expect(res.json().result.structuredContent).toBeTruthy();

    const span = spanNamed('mcp.tool_call');
    expect(span).toBeTruthy();
    // The EXACT Langfuse-native keys its OTel ingest maps onto observation input/output.
    expect(attr(span, 'langfuse.observation.input')).toBe(JSON.stringify({ id: 'n1' }));
    expect(String(attr(span, 'langfuse.observation.output'))).toContain('"note":"hello"');
    // Guardrail: neither the OAuth bearer nor the service token ever reaches the wire.
    const wire = JSON.stringify(exported);
    expect(wire).not.toContain(bearer);
    expect(wire).not.toContain(SVC_TOKEN);
  });

  // Change B — the Langfuse-NATIVE user id on the `mcp.tool_call` span, so Langfuse groups traces per
  // user in its Users view. `langfuse.user.id` is the highest-precedence key in the v3 ingest's
  // extractUserId(), and it propagates from NON-root spans too (it is in hasTraceUpdates()'s exact-match
  // list — load-bearing, because this span joins the edge trace as a CHILD when a traceparent arrives).
  it('sets the Langfuse-native user id (langfuse.user.id) to the token owner — alongside mcp.client.user', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    await rpc('tools/call', { name: 'get_note', arguments: { id: 'n1' } }, bearer);

    const span = spanNamed('mcp.tool_call');
    expect(span).toBeTruthy();
    expect(attr(span, 'langfuse.user.id')).toBe('userA');
    expect(attr(span, 'mcp.client.user')).toBe('userA'); // the plain span attribute stays
  });

  it('FORGE_MCP_TRACE_PAYLOADS=false disables payload capture (the span itself still exports)', async () => {
    process.env.FORGE_MCP_TRACE_PAYLOADS = 'false';
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    await rpc('tools/call', { name: 'get_note', arguments: { id: 'n1' } }, bearer);

    const span = spanNamed('mcp.tool_call');
    expect(span).toBeTruthy();
    expect(attr(span, 'langfuse.observation.input')).toBeUndefined();
    expect(attr(span, 'langfuse.observation.output')).toBeUndefined();
    expect(attr(span, 'gen_ai.tool.name')).toBe('get_note'); // context attributes are unaffected
  });

  it('caps each recorded side at 8192 bytes with a …[truncated] suffix', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    await rpc('tools/call', { name: 'get_note', arguments: { blob: 'x'.repeat(20_000) } }, bearer);

    const input = String(attr(spanNamed('mcp.tool_call'), 'langfuse.observation.input'));
    expect(input.endsWith('…[truncated]')).toBe(true);
    expect(Buffer.byteLength(input, 'utf8')).toBeLessThanOrEqual(8192 + Buffer.byteLength('…[truncated]', 'utf8'));
  });

  it('a failing handler records the error payload as the OUTPUT on an error span (failure outcomes stay visible)', async () => {
    await registerTool({ name: 'boom', scope: '', handler_path: '/api/mcp/tools/boom' });
    const bearer = await mintAccess([]);
    expect((await rpc('tools/call', { name: 'boom', arguments: {} }, bearer)).json().result.isError).toBe(true);

    const span = spanNamed('mcp.tool_call');
    expect(span!.status.code).toBe(3); // error
    expect(attr(span, 'error.message')).toBe('handler_status_500');
    expect(String(attr(span, 'langfuse.observation.output'))).toContain('kaboom');
  });

  it('a tools/call for a NONEXISTENT tool still produces a span: error unknown_tool + the requested name + input', async () => {
    const bearer = await mintAccess([]);
    const res = await rpc('tools/call', { name: 'not_a_tool', arguments: { q: 1 } }, bearer);
    expect(res.json().error.code).toBe(-32602); // wire behavior unchanged

    const span = spanNamed('mcp.tool_call');
    expect(span).toBeTruthy();
    expect(span!.status.code).toBe(3);
    expect(attr(span, 'error.message')).toBe('unknown_tool');
    expect(attr(span, 'gen_ai.tool.name')).toBe('not_a_tool');
    expect(attr(span, 'langfuse.observation.input')).toBe(JSON.stringify({ q: 1 }));
  });

  it('a transport auth rejection emits an mcp.auth_reject span with the reason + method — and NO token material', async () => {
    const res = await rpc('tools/call', { name: 'get_note', arguments: {} }, 'not-a-real-bearer-token');
    expect(res.statusCode).toBe(401);

    const span = spanNamed('mcp.auth_reject');
    expect(span).toBeTruthy();
    expect(span!.status.code).toBe(3);
    expect(attr(span, 'error.message')).toBe('invalid_token');
    expect(attr(span, 'mcp.method')).toBe('tools/call');
    expect(JSON.stringify(exported)).not.toContain('not-a-real-bearer-token');
  });

  it('a resource-mismatched token (RFC 8707) rejects with reason resource_mismatch — distinguishable from invalid_token', async () => {
    const prev = process.env.FORGE_MCP_PUBLIC_URL;
    process.env.FORGE_MCP_PUBLIC_URL = 'https://api.example';
    try {
      const wrong = await mintAccess(['notes:read'], 'userA', 'client1', 'https://evil.example/mcp');
      expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, wrong)).statusCode).toBe(401);
      expect(attr(spanNamed('mcp.auth_reject'), 'error.message')).toBe('resource_mismatch');
    } finally {
      if (prev === undefined) delete process.env.FORGE_MCP_PUBLIC_URL; else process.env.FORGE_MCP_PUBLIC_URL = prev;
    }
  });

  it('adopts an incoming W3C traceparent as the parent — the edge + the tool call join ONE trace', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    const edgeTrace = 'ab'.repeat(16);
    const edgeSpan = 'cd'.repeat(8);
    const res = await server.inject({
      method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${bearer}`, traceparent: `00-${edgeTrace}-${edgeSpan}-01` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_note', arguments: {} } } as object,
    });
    expect(res.json().result.structuredContent).toBeTruthy();

    const span = spanNamed('mcp.tool_call');
    expect(span!.traceId).toBe(edgeTrace);
    expect(span!.parentSpanId).toBe(edgeSpan);
  });
});

// Change A — RFC 8707 access-token audience binding enforced by the resource server at POST /mcp.
describe('Change A — RFC 8707 audience binding at /mcp', () => {
  const withResourceHost = async (fn: () => Promise<void>): Promise<void> => {
    const prev = process.env.FORGE_MCP_PUBLIC_URL;
    process.env.FORGE_MCP_PUBLIC_URL = 'https://api.example'; // → the server's resource id is https://api.example/mcp
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.FORGE_MCP_PUBLIC_URL; else process.env.FORGE_MCP_PUBLIC_URL = prev;
    }
  };

  it('a token bound to THIS resource passes, a DIFFERENT resource is rejected (401), an UNBOUND token still passes', async () => {
    await registerTool();
    await withResourceHost(async () => {
      const good = await mintAccess(['notes:read'], 'userA', 'client1', 'https://api.example/mcp');
      const wrong = await mintAccess(['notes:read'], 'userA', 'client1', 'https://evil.example/mcp');
      const unbound = await mintAccess(['notes:read'], 'userA', 'client1'); // no resource → back-compat

      expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, good)).json().result.structuredContent).toBeTruthy();
      expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, wrong)).statusCode).toBe(401);
      expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, unbound)).json().result.structuredContent).toBeTruthy();
    });
  });
});

// Tier-3 — the MCP RESOURCE identifier is PER-HOST (the host the client connected to) while the OAuth AS
// issuer stays PINNED to the certless api host. ChatGPT's connector lives on a dedicated mTLS host
// (mcp.dorinda.ai); Claude + browsers stay on api.dorinda.ai. The forwarded host is honored only when it's
// the primary MCP host or in the FORGE_MCP_ALT_HOSTS allowlist — a spoofed host falls back to the pin.
describe('Tier-3 — per-host MCP resource identifier (dedicated mTLS host)', () => {
  const setEnv = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  // Pin the certless AS host + allowlist the dedicated mTLS alt host for the duration of fn, then restore.
  const withHosts = async (env: { mcp?: string; alt?: string; oauth?: string }, fn: () => Promise<void>): Promise<void> => {
    const prev = { mcp: process.env.FORGE_MCP_PUBLIC_URL, alt: process.env.FORGE_MCP_ALT_HOSTS, oauth: process.env.FORGE_OAUTH_PUBLIC_URL };
    setEnv('FORGE_MCP_PUBLIC_URL', env.mcp); setEnv('FORGE_MCP_ALT_HOSTS', env.alt); setEnv('FORGE_OAUTH_PUBLIC_URL', env.oauth);
    try { await fn(); } finally {
      setEnv('FORGE_MCP_PUBLIC_URL', prev.mcp); setEnv('FORGE_MCP_ALT_HOSTS', prev.alt); setEnv('FORGE_OAUTH_PUBLIC_URL', prev.oauth);
    }
  };
  const wellKnown = (host: string) =>
    server.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': host } });

  it('advertises an ALLOWLISTED forwarded alt host as the resource id, AS issuer stays pinned to api', async () => {
    await withHosts({ mcp: 'https://api.dorinda.ai', alt: 'mcp.dorinda.ai' }, async () => {
      const body = (await wellKnown('mcp.dorinda.ai')).json();
      expect(body.resource).toBe('https://mcp.dorinda.ai/mcp');
      expect(body.authorization_servers).toEqual(['https://api.dorinda.ai']); // issuer pinned to the certless host
    });
  });

  it('the PRIMARY forwarded host (api) → resource + AS both api (back-compat, single-host unchanged)', async () => {
    await withHosts({ mcp: 'https://api.dorinda.ai', alt: 'mcp.dorinda.ai' }, async () => {
      const body = (await wellKnown('api.dorinda.ai')).json();
      expect(body.resource).toBe('https://api.dorinda.ai/mcp');
      expect(body.authorization_servers).toEqual(['https://api.dorinda.ai']);
    });
  });

  it('a SPOOFED forwarded host not in the allowlist falls back to the pin — never advertises it', async () => {
    await withHosts({ mcp: 'https://api.dorinda.ai', alt: 'mcp.dorinda.ai' }, async () => {
      const res = await wellKnown('evil.com');
      const body = res.json();
      expect(body.resource).toBe('https://api.dorinda.ai/mcp'); // fell back to the pin
      expect(body.authorization_servers).toEqual(['https://api.dorinda.ai']);
      expect(res.payload).not.toContain('evil.com'); // evil.com never surfaces anywhere in the doc
    });
  });

  it('POST /mcp: a token bound to the alt host passes VIA that host, is rejected via the pinned api host', async () => {
    await withHosts({ mcp: 'https://api.dorinda.ai', alt: 'mcp.dorinda.ai' }, async () => {
      await registerTool();
      const token = await mintAccess(['notes:read'], 'userA', 'client1', 'https://mcp.dorinda.ai/mcp');
      const call = (host: string) => server.inject({
        method: 'POST', url: '/mcp',
        headers: { authorization: `Bearer ${token}`, 'x-forwarded-proto': 'https', 'x-forwarded-host': host },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_note', arguments: {} } } as object,
      });
      // arrives via the alt host → expectedResource = https://mcp.dorinda.ai/mcp → matches the token's aud → 200
      expect((await call('mcp.dorinda.ai')).json().result.structuredContent).toBeTruthy();
      // arrives via the pinned api host → expectedResource = https://api.dorinda.ai/mcp → aud mismatch → 401
      expect((await call('api.dorinda.ai')).statusCode).toBe(401);
    });
  });
});
