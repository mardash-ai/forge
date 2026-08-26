import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import pkgJson from '../package.json';
import { store } from '../src/storage/store';
import { getBackends } from '../src/storage/backends';
import {
  registerMcpRoutes,
  subscribeToolListChanged,
  broadcastToolListChanged,
  toolListSubscriberCount,
  toTimelineEvent,
  type McpToolCallTimelineEvent,
} from '../src/api/mcp-routes';
import { newToken } from '../src/plugins/auth-identity/index';
import { expiresAtIso } from '../src/mcp/oauth';
import { nowIso } from '../src/shared/time';
import { _resetRegistrationDebounce, initOtel, _setMcpLogOverride } from '../src/plugins/otel/index';
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
let lastDispatchBody: Record<string, unknown> | undefined;

const seedApp = async (): Promise<void> => {
  const now = nowIso();
  await store.saveResource({
    id: APP_ID,
    type: 'Application',
    app_id: APP_ID,
    created_at: now,
    updated_at: now,
    name: APP,
    repo_path: '/app',
    platform: 'web',
    framework: 'nextjs',
    template: 'nextjs-web',
    language: 'typescript',
    package_manager: 'npm',
  } as Application);
};

// Mint an access grant directly (the OAuth flow itself is covered in mcp-oauth.test.ts). Returns the raw
// bearer the /mcp endpoint verifies.
const mintAccess = async (
  scopes: string[],
  owner = 'userA',
  clientId = 'client1',
  resource?: string,
): Promise<string> => {
  const { token, hash } = newToken();
  await (
    await getBackends()
  ).mcp.putGrant(APP_ID, {
    kind: 'access',
    token_hash: hash,
    client_id: clientId,
    owner,
    scopes,
    expires_at: expiresAtIso(3600),
    ...(resource ? { resource } : {}),
    created_at: nowIso(),
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
    lastDispatchBody = req.body as Record<string, unknown>;
    return {
      note: 'hello',
      echoed: (req.body as { arguments?: unknown }).arguments,
    };
  });
  stub.post('/api/mcp/tools/boom', async (_req, reply) => {
    calls.push('boom');
    return reply.status(500).send({ error: 'kaboom' });
  });
  // A handler that returns a CallToolResult-shaped object (has a `content` array).
  // Used to verify the platform passes content + structuredContent through verbatim
  // instead of double-wrapping the whole handler response.
  stub.post('/api/mcp/tools/structured_reply', async () => {
    calls.push('structured_reply');
    return {
      content: [{ type: 'text', text: 'structured result' }],
      structuredContent: { result: 'hello-structured', count: 3 },
    };
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
  if (prevDir === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevDir;
  if (prevHost === undefined) delete process.env.FORGE_APP_CALLBACK_HOST;
  else process.env.FORGE_APP_CALLBACK_HOST = prevHost;
  if (prevPort === undefined) delete process.env.FORGE_APP_CALLBACK_PORT;
  else process.env.FORGE_APP_CALLBACK_PORT = prevPort;
  if (prevSvc === undefined) delete process.env.AUTH_SERVICE_TOKEN;
  else process.env.AUTH_SERVICE_TOKEN = prevSvc;
  await rm(dir, { recursive: true, force: true });
});

const rpc = (method: string, params: unknown, bearer?: string, id: number | string = 1) =>
  server.inject({
    method: 'POST',
    url: '/mcp',
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    payload: { jsonrpc: '2.0', id, method, params } as object,
  });
// The management-surface helpers present the service token (Change D). Ungated routes (`.well-known`) ignore
// it harmlessly; the JSON-RPC `rpc` helper below deliberately does NOT send it (POST /mcp is OAuth-gated).
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  server.inject({
    method: 'POST',
    url,
    headers: { 'x-forge-service-token': SVC_TOKEN, ...headers },
    payload: payload as object,
  });
const get = (url: string, headers: Record<string, string> = {}) =>
  server.inject({
    method: 'GET',
    url,
    headers: { 'x-forge-service-token': SVC_TOKEN, ...headers },
  });

const registerTool = (over: Record<string, unknown> = {}) =>
  post('/mcp/tools', {
    name: 'get_note',
    description: 'Read a note',
    input_schema: { type: 'object' },
    scope: 'notes:read',
    family: 'read',
    handler_path: '/api/mcp/tools/get_note',
    ...over,
  });

describe('C23 — tool registration + the OAuth-gated MCP endpoint', () => {
  it('requires a valid bearer (401 with the discovery pointer)', async () => {
    const unauth = await rpc('initialize', {});
    expect(unauth.statusCode).toBe(401);
    expect(String(unauth.headers['www-authenticate'])).toContain('resource_metadata=');
  });

  it('RFC 6750: a PRESENTED-but-invalid bearer carries error="invalid_token" in the challenge; a bare request must not', async () => {
    // A client holding a dead token (revoked grant, 7-day expiry) needs the error code to know it
    // should re-authorize rather than dead-end at "can't connect"; a request with NO credentials
    // MUST NOT carry an error code (RFC 6750 §3.1). Observed live 2026-08-26: Claude showed
    // "issue → Reconnect" against a revoked grant — the code is the recovery signal hosts key off.
    const bare = await rpc('initialize', {});
    expect(bare.statusCode).toBe(401);
    expect(String(bare.headers['www-authenticate'])).not.toContain('error=');

    const presented = await rpc('initialize', {}, 'not-a-real-token');
    expect(presented.statusCode).toBe(401);
    const challenge = String(presented.headers['www-authenticate']);
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain('resource_metadata=');
  });

  it('initialize returns serverInfo + the latest instruction block; tools/list returns the surface', async () => {
    await registerTool();
    await post('/mcp/instructions', { text: 'v1 preamble' });
    await post('/mcp/instructions', {
      text: 'v2 — call whats_next each morning',
      label: 'B',
    });
    const bearer = await mintAccess(['notes:read']);

    const init = await rpc('initialize', { protocolVersion: '2025-06-18' }, bearer);
    expect(init.statusCode).toBe(200);
    const initR = init.json().result;
    expect(initR.serverInfo.name).toBe('forge-mcp:demo');
    expect(initR.instructions).toBe('v2 — call whats_next each morning'); // latest version served

    const list = await rpc('tools/list', {}, bearer);
    const tools = list.json().result.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'get_note',
      inputSchema: { type: 'object' },
    });
  });

  // ── tools/list_changed — clients must learn about a changed tool surface WITHOUT a user reconnect ──
  describe('notifications/tools/list_changed', () => {
    it('initialize advertises tools.listChanged:true (tells clients to watch for surface changes)', async () => {
      const bearer = await mintAccess(['notes:read']);
      const init = await rpc('initialize', { protocolVersion: '2025-06-18' }, bearer);
      // false here = "my tools never change" → clients cache forever and only a manual reconnect helps.
      expect(init.json().result.capabilities).toMatchObject({
        tools: { listChanged: true },
      });
    });

    it('REGISTERING a tool pushes list_changed to every connected stream', async () => {
      const frames: string[] = [];
      const unsub = subscribeToolListChanged(APP_ID, {
        write: (f) => frames.push(f),
        clientName: 'Claude',
        userAgent: 'test-agent',
      });
      try {
        await registerTool();
        expect(frames).toHaveLength(1);
        expect(frames[0]).toContain('event: message');
        const data = JSON.parse(frames[0]!.split('data: ')[1]!);
        expect(data).toEqual({
          jsonrpc: '2.0',
          method: 'notifications/tools/list_changed',
        });
      } finally {
        unsub();
      }
    });

    it('DELETING a tool (the prune path) also pushes list_changed', async () => {
      await registerTool();
      const frames: string[] = [];
      const unsub = subscribeToolListChanged(APP_ID, {
        write: (f) => frames.push(f),
        clientName: 'Claude',
        userAgent: 'test-agent',
      });
      try {
        const del = await server.inject({
          method: 'DELETE',
          url: '/mcp/tools/get_note',
          headers: { 'x-forge-service-token': SVC_TOKEN },
        });
        expect(del.statusCode).toBe(200);
        expect(frames).toHaveLength(1);
        expect(frames[0]).toContain('notifications/tools/list_changed');
      } finally {
        unsub();
      }
    });

    it('only notifies the app whose surface changed, and unsubscribe stops delivery (no leak)', async () => {
      const mine: string[] = [];
      const other: string[] = [];
      const unsubMine = subscribeToolListChanged(APP_ID, {
        write: (f) => mine.push(f),
      });
      const unsubOther = subscribeToolListChanged('app_someone_else', {
        write: (f) => other.push(f),
      });
      try {
        await registerTool();
        expect(mine).toHaveLength(1);
        expect(other).toHaveLength(0); // a different app's clients are untouched
      } finally {
        unsubMine();
        unsubOther();
      }
      expect(toolListSubscriberCount(APP_ID)).toBe(0); // unsubscribed → registry drained
      await registerTool();
      expect(mine).toHaveLength(1); // no delivery after unsubscribe
    });

    it('a dead client (throwing writer) is dropped and never fails the registration', async () => {
      const unsub = subscribeToolListChanged(APP_ID, {
        write: () => {
          throw new Error('socket closed');
        },
      });
      try {
        const res = await post('/mcp/tools', {
          name: 'get_note',
          description: 'd',
          handler_path: '/api/mcp/tools/get_note',
          family: 'read',
        });
        expect(res.statusCode).toBe(200); // registration still succeeds
        expect(toolListSubscriberCount(APP_ID)).toBe(0); // the broken stream was pruned
      } finally {
        unsub();
      }
    });

    it('broadcast to an app with no streams is a no-op (returns 0)', () => {
      expect(broadcastToolListChanged('app_nobody_listening')).toBe(0);
    });

    // GET /mcp/streams — the LIVE feed behind the operator dashboard.
    it('GET /mcp/streams reports 0 when no AI is holding the channel (the honest empty state)', async () => {
      const res = await get('/mcp/streams');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ count: 0, streams: [] });
      expect(res.json().observed_at).toBeTruthy(); // stamped per read — never a cached figure
    });

    it('GET /mcp/streams reports each attached stream with its client + user agent, live', async () => {
      const unsub = subscribeToolListChanged(APP_ID, {
        write: () => {},
        clientName: 'Claude',
        userAgent: 'Claude-User/1.0',
      });
      try {
        const res = await get('/mcp/streams');
        const body = res.json();
        expect(body.count).toBe(1);
        expect(body.streams[0]).toMatchObject({
          client_name: 'Claude',
          user_agent: 'Claude-User/1.0',
        });
        expect(typeof body.streams[0].held_seconds).toBe('number');
      } finally {
        unsub();
      }
      // Detaching is reflected IMMEDIATELY — the snapshot is the registry, not a cached copy.
      expect((await get('/mcp/streams')).json().count).toBe(0);
    });

    it('GET /mcp/streams is service-token gated (not public)', async () => {
      const res = await server.inject({ method: 'GET', url: '/mcp/streams' });
      expect(res.statusCode).toBe(401);
    });
  });

  it('dispatches tools/call to the app handler and records the call to C3', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    const res = await rpc('tools/call', { name: 'get_note', arguments: { id: 'n1' } }, bearer);
    expect(res.statusCode).toBe(200);
    const result = res.json().result;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      note: 'hello',
      echoed: { id: 'n1' },
    });
    expect(calls).toContain('get_note');

    // Attribution (C3): who, which host, which tool.
    const events = await store.listAppEvents({
      app_id: APP_ID,
      owner: 'userA',
      subject: 'get_note',
    });
    expect(
      events.some(
        (e) =>
          e.type === 'mcp.tool_call' &&
          (e.data as { ok?: boolean }).ok === true &&
          (e.data as { host?: string }).host === 'client1',
      ),
    ).toBe(true);
  });

  it('forwards the DCR client NAME to the app handler so it can label the connection ("Connected" per AI)', async () => {
    await registerTool();
    // The client registered itself (DCR) with a human name — e.g. Claude / ChatGPT.
    await (
      await getBackends()
    ).mcp.putClient(APP_ID, {
      client_id: 'client1',
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      token_endpoint_auth_method: 'none',
      created_at: nowIso(),
    });
    const bearer = await mintAccess(['notes:read']); // grant for client1
    lastDispatchBody = undefined;
    const res = await rpc('tools/call', { name: 'get_note', arguments: { id: 'n1' } }, bearer);
    expect(res.statusCode).toBe(200);
    expect(lastDispatchBody).toMatchObject({
      client_id: 'client1',
      client_name: 'Claude',
    });
  });

  it('omits client_name when the client has no registered name (back-compat)', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']); // client1, no putClient registration
    lastDispatchBody = undefined;
    await rpc('tools/call', { name: 'get_note', arguments: {} }, bearer);
    const body = lastDispatchBody as Record<string, unknown> | undefined;
    expect(body?.client_id).toBe('client1');
    expect(body && 'client_name' in body).toBe(false);
  });

  it('enforces per-tool scope against the granted token', async () => {
    await registerTool({
      name: 'send_note',
      scope: 'notes:write',
      family: 'action',
      handler_path: '/api/mcp/tools/get_note',
    });
    const bearer = await mintAccess(['notes:read']); // lacks notes:write
    const res = await rpc('tools/call', { name: 'send_note', arguments: {} }, bearer);
    expect(res.json().error).toMatchObject({
      code: -32001,
      message: 'insufficient_scope',
      data: { required_scope: 'notes:write' },
    });
    expect(calls).not.toContain('get_note'); // never dispatched

    // The denial is still audited (ok:false, reason insufficient_scope).
    const events = await store.listAppEvents({
      app_id: APP_ID,
      owner: 'userA',
      subject: 'send_note',
    });
    expect(events.some((e) => (e.data as { reason?: string }).reason === 'insufficient_scope')).toBe(true);
  });

  it('a non-2xx app handler surfaces as an MCP tool error (isError)', async () => {
    await registerTool({
      name: 'boom',
      scope: '',
      handler_path: '/api/mcp/tools/boom',
    });
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
    const r = await post('/mcp/proactive', {
      tool: 'whats_next',
      every: '6h',
      target_path: '/api/cron/whats-next',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().proactive).toMatchObject({
      type: 'ScheduledJob',
      name: 'mcp-proactive-whats-next',
      schedule: 'every:6h',
    });

    const jobs = await store.listResources({
      type: 'ScheduledJob',
      app_id: APP_ID,
    });
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
      if (prevMcp === undefined) delete process.env.FORGE_MCP_PUBLIC_URL;
      else process.env.FORGE_MCP_PUBLIC_URL = prevMcp;
      if (prevOauth === undefined) delete process.env.FORGE_OAUTH_PUBLIC_URL;
      else process.env.FORGE_OAUTH_PUBLIC_URL = prevOauth;
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
      if (prevMcp === undefined) delete process.env.FORGE_MCP_PUBLIC_URL;
      else process.env.FORGE_MCP_PUBLIC_URL = prevMcp;
      if (prevOauth === undefined) delete process.env.FORGE_OAUTH_PUBLIC_URL;
      else process.env.FORGE_OAUTH_PUBLIC_URL = prevOauth;
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
    expect(String(unauth.headers['www-authenticate'])).toContain(
      '/.well-known/oauth-protected-resource/mcp"',
    );
  });
});

describe('C23 — connector (consent) management', () => {
  it('lists and revokes a user’s consent, cutting their tokens off', async () => {
    const bearer = await mintAccess(['notes:read'], 'userA', 'clientZ');
    await (
      await getBackends()
    ).mcp.putConsent(APP_ID, {
      client_id: 'clientZ',
      owner: 'userA',
      scopes: ['notes:read'],
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    expect((await get('/mcp/consents?owner=userA')).json().consents).toHaveLength(1);
    await registerTool();
    // token works before revocation
    expect(
      (await rpc('tools/call', { name: 'get_note', arguments: {} }, bearer)).json().result.structuredContent,
    ).toBeTruthy();

    const del = await server.inject({
      method: 'DELETE',
      url: '/mcp/consents/clientZ?owner=userA',
      headers: { 'x-forge-service-token': SVC_TOKEN },
    });
    expect(del.json().revoked).toBe(true);
    // the token is now dead → 401
    expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, bearer)).statusCode).toBe(401);
    expect((await get('/mcp/consents?owner=userA')).json().consents).toHaveLength(0);
  });

  /**
   * C34 account teardown. Deleting an account MUST cut every connected AI off. Observed live
   * 2026-07-24: after purging an account its Claude connector still worked and RE-CREATED rows under
   * the DEAD owner id, because the MCP access token outlived the account. Revoking per-client requires
   * knowing the clients; teardown needs ONE owner-scoped call — and it has to kill the TOKENS, not just
   * the consent rows, or the AI keeps working until the token expires.
   */
  it('DELETE /mcp/consents revokes EVERY connector for an owner — live tokens included', async () => {
    const bearerA = await mintAccess(['notes:read'], 'userA', 'clientOne');
    const bearerB = await mintAccess(['notes:read'], 'userA', 'clientTwo');
    const other = await mintAccess(['notes:read'], 'userB', 'clientOne');
    for (const client_id of ['clientOne', 'clientTwo']) {
      await (
        await getBackends()
      ).mcp.putConsent(APP_ID, {
        client_id,
        owner: 'userA',
        scopes: ['notes:read'],
        created_at: nowIso(),
        updated_at: nowIso(),
      });
    }
    await (
      await getBackends()
    ).mcp.putConsent(APP_ID, {
      client_id: 'clientOne',
      owner: 'userB',
      scopes: ['notes:read'],
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    await registerTool();

    // All three tokens work before teardown.
    for (const b of [bearerA, bearerB, other]) {
      expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, b)).statusCode).toBe(200);
    }

    const res = await server.inject({
      method: 'DELETE',
      url: '/mcp/consents?owner=userA',
      headers: { 'x-forge-service-token': SVC_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revoked_consents).toBe(2);
    expect((res.json().clients as string[]).sort()).toEqual(['clientOne', 'clientTwo']);

    // THE POINT: every one of that owner's tokens is dead — the AIs are cut off immediately.
    expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, bearerA)).statusCode).toBe(401);
    expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, bearerB)).statusCode).toBe(401);
    expect((await get('/mcp/consents?owner=userA')).json().consents).toHaveLength(0);

    // ...and ANOTHER user's connector is untouched — teardown is owner-scoped, never a blast radius.
    expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, other)).statusCode).toBe(200);
    expect((await get('/mcp/consents?owner=userB')).json().consents).toHaveLength(1);
  });

  it('sweeps an ORPHAN token that has no consent row (nothing may survive teardown)', async () => {
    const orphan = await mintAccess(['notes:read'], 'userC', 'clientGhost'); // token, but no consent
    await registerTool();
    expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, orphan)).statusCode).toBe(200);

    const res = await server.inject({
      method: 'DELETE',
      url: '/mcp/consents?owner=userC',
      headers: { 'x-forge-service-token': SVC_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revoked_consents).toBe(0);
    expect(res.json().revoked_grants).toBeGreaterThanOrEqual(1);
    expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, orphan)).statusCode).toBe(401);
  });

  it('requires a service token and an owner (never a blind, unauthenticated teardown)', async () => {
    expect(
      (
        await server.inject({
          method: 'DELETE',
          url: '/mcp/consents?owner=userA',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await server.inject({
          method: 'DELETE',
          url: '/mcp/consents?owner=userA',
          headers: { 'x-forge-service-token': 'wrong' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await server.inject({
          method: 'DELETE',
          url: '/mcp/consents',
          headers: { 'x-forge-service-token': SVC_TOKEN },
        })
      ).statusCode,
    ).toBe(400);
  });
});

// Change D — the app→sidecar MANAGEMENT surface is proxied to the public internet by the consumer and
// carries no OAuth, so every /mcp/* management route MUST require the app's C10 service token. FAIL CLOSED.
describe('Change D — management routes require the x-forge-service-token', () => {
  // A management call WITHOUT any service token (the raw inject helper — no header).
  const noToken = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
    server.inject({
      method,
      url,
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  it('rejects EVERY management route with 401 when no service token is presented', async () => {
    expect(
      (
        await noToken('POST', '/mcp/tools', {
          name: 'get_note',
          scope: 'notes:read',
          family: 'read',
          handler_path: '/api/mcp/tools/get_note',
        })
      ).statusCode,
    ).toBe(401);
    expect((await noToken('GET', '/mcp/tools')).statusCode).toBe(401);
    expect((await noToken('DELETE', '/mcp/tools/get_note')).statusCode).toBe(401);
    expect((await noToken('POST', '/mcp/instructions', { text: 'v1' })).statusCode).toBe(401);
    expect((await noToken('GET', '/mcp/instructions')).statusCode).toBe(401);
    expect(
      (
        await noToken('POST', '/mcp/proactive', {
          tool: 'whats_next',
          every: '6h',
          target_path: '/api/cron/x',
        })
      ).statusCode,
    ).toBe(401);
    expect((await noToken('GET', '/mcp/consents?owner=userA')).statusCode).toBe(401);
    expect((await noToken('DELETE', '/mcp/consents/clientZ?owner=userA')).statusCode).toBe(401);
  });

  it('rejects a WRONG service token, accepts the CORRECT one', async () => {
    const wrong = await server.inject({
      method: 'GET',
      url: '/mcp/tools',
      headers: { 'x-forge-service-token': 'not-the-token' },
    });
    expect(wrong.statusCode).toBe(401);
    const okReg = await post('/mcp/tools', {
      name: 'get_note',
      description: 'Read a note',
      input_schema: { type: 'object' },
      scope: 'notes:read',
      family: 'read',
      handler_path: '/api/mcp/tools/get_note',
    });
    expect(okReg.statusCode).toBe(200);
    expect((await get('/mcp/tools')).statusCode).toBe(200);
  });

  it('FAILS CLOSED when AUTH_SERVICE_TOKEN is unset in the environment — never fail open', async () => {
    const prev = process.env.AUTH_SERVICE_TOKEN;
    delete process.env.AUTH_SERVICE_TOKEN;
    try {
      // Even presenting the previously-valid token is rejected: with nothing configured there is nothing to match.
      const r = await server.inject({
        method: 'GET',
        url: '/mcp/tools',
        headers: { 'x-forge-service-token': SVC_TOKEN },
      });
      expect(r.statusCode).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.AUTH_SERVICE_TOKEN;
      else process.env.AUTH_SERVICE_TOKEN = prev;
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
    await registerTool({
      name: 'ping_pub',
      scope: '',
      family: 'read',
      handler_path: '/api/mcp/tools/get_note',
    });
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
    const wk = await server.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource',
    });
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
    attributes: Array<{
      key: string;
      value: { stringValue?: string; intValue?: number; boolValue?: boolean };
    }>;
  }
  const spans = (): WireSpan[] =>
    (
      exported as Array<{
        resourceSpans: Array<{ scopeSpans: Array<{ spans: WireSpan[] }> }>;
      }>
    ).flatMap((b) => b.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)));
  const spanNamed = (name: string): WireSpan | undefined =>
    spans()
      .filter((s) => s.name === name)
      .at(-1);
  const attr = (s: WireSpan | undefined, key: string): string | number | boolean | undefined => {
    const v = s?.attributes.find((a) => a.key === key)?.value;
    return v === undefined ? undefined : (v.stringValue ?? v.intValue ?? v.boolValue);
  };

  beforeEach(() => {
    exported = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/v1/traces')) {
        // C36 trace payloads (resourceSpans) — captured for span assertions below.
        exported.push(JSON.parse(String(init?.body)));
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      if (u.includes('/v1/metrics')) {
        // Metrics payloads (resourceMetrics) — not needed by C36 span tests; discard silently.
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return realFetch(url as Parameters<typeof fetch>[0], init);
    }) as typeof fetch);
    initOtel({
      endpoint: OTLP,
      tracesEndpoint: 'https://collector.example/v1/traces',
    });
  });
  afterEach(() => {
    initOtel({ tracesEndpoint: 'https://collector.example/v1/traces' }); // disable again so other tests are unaffected
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
    expect(Buffer.byteLength(input, 'utf8')).toBeLessThanOrEqual(
      8192 + Buffer.byteLength('…[truncated]', 'utf8'),
    );
  });

  it('a failing handler records the error payload as the OUTPUT on an error span (failure outcomes stay visible)', async () => {
    await registerTool({
      name: 'boom',
      scope: '',
      handler_path: '/api/mcp/tools/boom',
    });
    const bearer = await mintAccess([]);
    expect((await rpc('tools/call', { name: 'boom', arguments: {} }, bearer)).json().result.isError).toBe(
      true,
    );

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
      if (prev === undefined) delete process.env.FORGE_MCP_PUBLIC_URL;
      else process.env.FORGE_MCP_PUBLIC_URL = prev;
    }
  });

  it('adopts an incoming W3C traceparent as the parent — the edge + the tool call join ONE trace', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    const edgeTrace = 'ab'.repeat(16);
    const edgeSpan = 'cd'.repeat(8);
    const res = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${bearer}`,
        traceparent: `00-${edgeTrace}-${edgeSpan}-01`,
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_note', arguments: {} },
      } as object,
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
      if (prev === undefined) delete process.env.FORGE_MCP_PUBLIC_URL;
      else process.env.FORGE_MCP_PUBLIC_URL = prev;
    }
  };

  it('a token bound to THIS resource passes, a DIFFERENT resource is rejected (401), an UNBOUND token still passes', async () => {
    await registerTool();
    await withResourceHost(async () => {
      const good = await mintAccess(['notes:read'], 'userA', 'client1', 'https://api.example/mcp');
      const wrong = await mintAccess(['notes:read'], 'userA', 'client1', 'https://evil.example/mcp');
      const unbound = await mintAccess(['notes:read'], 'userA', 'client1'); // no resource → back-compat

      expect(
        (await rpc('tools/call', { name: 'get_note', arguments: {} }, good)).json().result.structuredContent,
      ).toBeTruthy();
      expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, wrong)).statusCode).toBe(401);
      expect(
        (await rpc('tools/call', { name: 'get_note', arguments: {} }, unbound)).json().result
          .structuredContent,
      ).toBeTruthy();
    });
  });
});

// Tier-3 — the MCP RESOURCE identifier is PER-HOST (the host the client connected to) while the OAuth AS
// issuer stays PINNED to the certless api host. ChatGPT's connector lives on a dedicated mTLS host
// (mcp.dorinda.ai); Claude + browsers stay on api.dorinda.ai. The forwarded host is honored only when it's
// the primary MCP host or in the FORGE_MCP_ALT_HOSTS allowlist — a spoofed host falls back to the pin.
describe('Tier-3 — per-host MCP resource identifier (dedicated mTLS host)', () => {
  const setEnv = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  // Pin the certless AS host + allowlist the dedicated mTLS alt host for the duration of fn, then restore.
  const withHosts = async (
    env: { mcp?: string; alt?: string; oauth?: string },
    fn: () => Promise<void>,
  ): Promise<void> => {
    const prev = {
      mcp: process.env.FORGE_MCP_PUBLIC_URL,
      alt: process.env.FORGE_MCP_ALT_HOSTS,
      oauth: process.env.FORGE_OAUTH_PUBLIC_URL,
    };
    setEnv('FORGE_MCP_PUBLIC_URL', env.mcp);
    setEnv('FORGE_MCP_ALT_HOSTS', env.alt);
    setEnv('FORGE_OAUTH_PUBLIC_URL', env.oauth);
    try {
      await fn();
    } finally {
      setEnv('FORGE_MCP_PUBLIC_URL', prev.mcp);
      setEnv('FORGE_MCP_ALT_HOSTS', prev.alt);
      setEnv('FORGE_OAUTH_PUBLIC_URL', prev.oauth);
    }
  };
  const wellKnown = (host: string) =>
    server.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': host },
    });

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
      const call = (host: string) =>
        server.inject({
          method: 'POST',
          url: '/mcp',
          headers: {
            authorization: `Bearer ${token}`,
            'x-forwarded-proto': 'https',
            'x-forwarded-host': host,
          },
          payload: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'get_note', arguments: {} },
          } as object,
        });
      // arrives via the alt host → expectedResource = https://mcp.dorinda.ai/mcp → matches the token's aud → 200
      expect((await call('mcp.dorinda.ai')).json().result.structuredContent).toBeTruthy();
      // arrives via the pinned api host → expectedResource = https://api.dorinda.ai/mcp → aud mismatch → 401
      expect((await call('api.dorinda.ai')).statusCode).toBe(401);
    });
  });
});

// ── Structured JSON logs + OTLP metrics + _meta.traceparent on tool results ──────────────────
//
// This block validates the data-plane MCP observability revision:
//   1. One structured JSON log line per tool call (tool, client, duration_ms, outcome, error_class)
//   2. OTLP RED metrics + registration-health gauge exported to the /v1/metrics endpoint
//   3. W3C traceparent correlation id stamped on every MCP tool-result `_meta` field
//
// The log override (`_setMcpLogOverride`) routes mcpLog output to an in-memory array so we can
// assert without touching stdout. Fetch is mocked to intercept both /v1/traces and /v1/metrics.
describe('Structured logs + OTLP metrics + _meta.traceparent', () => {
  const OTLP = 'http://otel-collector.test/api/public/otel';
  let mcpLogs: Record<string, unknown>[];
  let exportedMetrics: unknown[];

  type MetricMsg = {
    resourceMetrics: Array<{
      scopeMetrics: Array<{
        metrics: Array<{ name: string; [k: string]: unknown }>;
      }>;
    }>;
  };
  const allMetrics = () =>
    (exportedMetrics as MetricMsg[]).flatMap((b) =>
      b.resourceMetrics.flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics)),
    );
  const metricNamed = (name: string) => allMetrics().find((m) => m.name === name);

  beforeEach(() => {
    mcpLogs = [];
    exportedMetrics = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(((url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/v1/traces')) return Promise.resolve(new Response('{}', { status: 200 }));
      if (u.includes('/v1/metrics')) {
        exportedMetrics.push(JSON.parse(String(init?.body)));
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return realFetch(url as Parameters<typeof fetch>[0], init);
    }) as typeof fetch);
    initOtel({
      endpoint: OTLP,
      tracesEndpoint: 'https://collector.example/v1/traces',
    });
    _setMcpLogOverride((fields) => mcpLogs.push(fields));
  });
  afterEach(() => {
    initOtel({ tracesEndpoint: 'https://collector.example/v1/traces' });
    _setMcpLogOverride(undefined);
    vi.restoreAllMocks();
    delete process.env.FORGE_MCP_TRACE_PAYLOADS;
  });

  // ── 1. Structured JSON log lines ──────────────────────────────────────────

  it('emits a structured log line for a successful tool call with required fields', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    await rpc('tools/call', { name: 'get_note', arguments: { id: 'n1' } }, bearer);

    const log = mcpLogs.find((l) => l['event'] === 'mcp.tool_call' && l['tool'] === 'get_note');
    expect(log).toBeTruthy();
    expect(log!['outcome']).toBe('ok');
    expect(typeof log!['duration_ms']).toBe('number');
    expect(log!['duration_ms'] as number).toBeGreaterThanOrEqual(0);
    expect(log!['app']).toBe(APP);
    expect(log!['error_class']).toBeUndefined();
    // 0.77.0: the transport line carries the user id — the per-user dashboard joins dp lines
    // (client attribution) to app dispatch lines (owner) on it.
    expect(typeof log!['user']).toBe('string');
    expect((log!['user'] as string).length).toBeGreaterThan(0);
  });

  it('emits a structured log line with error_class for an unknown tool', async () => {
    const bearer = await mintAccess([]);
    await rpc('tools/call', { name: 'no_such_tool', arguments: {} }, bearer);

    const log = mcpLogs.find((l) => l['event'] === 'mcp.tool_call' && l['tool'] === 'no_such_tool');
    expect(log).toBeTruthy();
    expect(log!['outcome']).toBe('error');
    expect(log!['error_class']).toBe('unknown_tool');
    expect(typeof log!['duration_ms']).toBe('number');
  });

  it('emits a structured log line with error_class for a scope failure', async () => {
    await registerTool({
      name: 'write_note',
      scope: 'notes:write',
      family: 'action',
      handler_path: '/api/mcp/tools/get_note',
    });
    const bearer = await mintAccess(['notes:read']);
    await rpc('tools/call', { name: 'write_note', arguments: {} }, bearer);

    const log = mcpLogs.find((l) => l['event'] === 'mcp.tool_call' && l['tool'] === 'write_note');
    expect(log).toBeTruthy();
    expect(log!['outcome']).toBe('error');
    expect(log!['error_class']).toBe('insufficient_scope');
  });

  it('emits a structured log line with error_class for a handler error', async () => {
    await registerTool({
      name: 'boom',
      scope: '',
      handler_path: '/api/mcp/tools/boom',
    });
    const bearer = await mintAccess([]);
    const res = await rpc('tools/call', { name: 'boom', arguments: {} }, bearer);
    expect(res.json().result.isError).toBe(true);

    const log = mcpLogs.find((l) => l['event'] === 'mcp.tool_call' && l['tool'] === 'boom');
    expect(log).toBeTruthy();
    expect(log!['outcome']).toBe('error');
    expect(String(log!['error_class'])).toMatch(/^handler_status_/);
  });

  it('emits a structured log line for auth rejection (mcp.auth_reject)', async () => {
    await rpc('tools/call', { name: 'get_note', arguments: {} }, 'not-a-real-token');

    const log = mcpLogs.find((l) => l['event'] === 'mcp.auth_reject');
    expect(log).toBeTruthy();
    expect(log!['reason']).toBe('invalid_token');
    expect(log!['app']).toBe(APP);
  });

  it('emits a structured log for tool registration (mcp.tool_register)', async () => {
    await registerTool();

    const log = mcpLogs.find((l) => l['event'] === 'mcp.tool_register');
    expect(log).toBeTruthy();
    expect(log!['tool']).toBe('get_note');
    expect(log!['app']).toBe(APP);
    expect(typeof log!['tools_count']).toBe('number');
  });

  it('emits a structured log for tool deregistration (mcp.tool_unregister)', async () => {
    await registerTool();
    await server.inject({
      method: 'DELETE',
      url: '/mcp/tools/get_note',
      headers: { 'x-forge-service-token': SVC_TOKEN },
    });

    const log = mcpLogs.find((l) => l['event'] === 'mcp.tool_unregister');
    expect(log).toBeTruthy();
    expect(log!['tool']).toBe('get_note');
  });

  it('emits a structured log for tools/list_changed push (mcp.tools_list_changed)', async () => {
    const unsub = subscribeToolListChanged(APP_ID, { write: () => {} });
    try {
      await registerTool();
    } finally {
      unsub();
    }

    const log = mcpLogs.find((l) => l['event'] === 'mcp.tools_list_changed');
    expect(log).toBeTruthy();
    expect(typeof (log!['notified'] as number)).toBe('number');
  });

  // ── 2. OTLP metrics ──────────────────────────────────────────────────────

  it('exports mcp.tool.calls + mcp.tool.duration_ms metrics on a successful tool call', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    await rpc('tools/call', { name: 'get_note', arguments: {} }, bearer);

    expect(metricNamed('mcp.tool.calls')).toBeTruthy();
    expect(metricNamed('mcp.tool.duration_ms')).toBeTruthy();
    expect(metricNamed('mcp.tool.errors')).toBeUndefined();
  });

  it('exports mcp.tool.errors metric on a tool call error', async () => {
    await registerTool({
      name: 'boom',
      scope: '',
      handler_path: '/api/mcp/tools/boom',
    });
    const bearer = await mintAccess([]);
    await rpc('tools/call', { name: 'boom', arguments: {} }, bearer);

    expect(metricNamed('mcp.tool.errors')).toBeTruthy();
    expect(metricNamed('mcp.tool.calls')).toBeTruthy();
  });

  it('exports mcp.tool.calls + errors for unknown-tool call', async () => {
    const bearer = await mintAccess([]);
    await rpc('tools/call', { name: 'nope', arguments: {} }, bearer);

    expect(metricNamed('mcp.tool.calls')).toBeTruthy();
    expect(metricNamed('mcp.tool.errors')).toBeTruthy();
  });

  it('exports mcp.tools.registered gauge after tool registration with the correct count', async () => {
    // The registration gauge is debounced (0.79.27) so a 31-tool surface cannot emit 31 identical
    // points into one batch — which Managed Prometheus rejects wholesale. Clear the window so this
    // test's emit is not collapsed into an identical one from an earlier test in this file.
    _resetRegistrationDebounce();
    await registerTool();

    type Gauge = {
      gauge?: {
        dataPoints: Array<{
          asInt: string;
          attributes: Array<{ key: string; value: { stringValue: string } }>;
        }>;
      };
    };
    const gauge = metricNamed('mcp.tools.registered') as Gauge | undefined;
    expect(gauge).toBeTruthy();
    // OTLP/JSON encodes int64 as a STRING (0.84.0). A JSON number was the bug: the app tier already
    // sent strings, so one metric name arrived in two encodings.
    expect(gauge!.gauge!.dataPoints[0]!.asInt).toBe('1');
    const appAttr = gauge!.gauge!.dataPoints[0]!.attributes.find((a) => a.key === 'app');
    expect(appAttr?.value.stringValue).toBe(APP);
  });

  it('exports mcp.tools.registered gauge with count 0 after the last tool is deleted', async () => {
    await registerTool();
    exportedMetrics = []; // reset so the delete batch is isolated
    await server.inject({
      method: 'DELETE',
      url: '/mcp/tools/get_note',
      headers: { 'x-forge-service-token': SVC_TOKEN },
    });

    type Gauge = { gauge?: { dataPoints: Array<{ asInt: number }> } };
    const gauge = metricNamed('mcp.tools.registered') as Gauge | undefined;
    expect(gauge).toBeTruthy();
    expect(gauge!.gauge!.dataPoints[0]!.asInt).toBe('0');
  });

  it('metrics include correct tool + app labels on the data points', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    await rpc('tools/call', { name: 'get_note', arguments: {} }, bearer);

    type DataPoint = {
      attributes: Array<{ key: string; value: { stringValue: string } }>;
    };
    const callMetric = metricNamed('mcp.tool.calls') as { sum?: { dataPoints: DataPoint[] } } | undefined;
    expect(callMetric).toBeTruthy();
    const dp = callMetric!.sum!.dataPoints[0]!;
    // Plain `tool`/`app` keys (0.76.0) — the same label schema consumer apps emit, so the
    // shared Prometheus metric family groups by tool instead of collapsing to an unlabeled bucket.
    expect(dp.attributes.find((a) => a.key === 'tool')?.value.stringValue).toBe('get_note');
    expect(dp.attributes.find((a) => a.key === 'app')?.value.stringValue).toBe(APP);
  });

  it('does NOT export metrics when OTLP is disabled (no keys)', async () => {
    initOtel({ tracesEndpoint: 'https://collector.example/v1/traces' });
    exportedMetrics = [];
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    await rpc('tools/call', { name: 'get_note', arguments: {} }, bearer);
    expect(exportedMetrics).toHaveLength(0);
  });

  // ── 3. _meta.traceparent on tool-call results ─────────────────────────────

  it('stamps _meta.traceparent on a SUCCESSFUL tool call result', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    const res = await rpc('tools/call', { name: 'get_note', arguments: {} }, bearer);
    const result = res.json().result;

    expect(typeof result._meta?.traceparent).toBe('string');
    expect(result._meta.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('stamps _meta.traceparent on an ERROR tool call result (isError)', async () => {
    await registerTool({
      name: 'boom',
      scope: '',
      handler_path: '/api/mcp/tools/boom',
    });
    const bearer = await mintAccess([]);
    const res = await rpc('tools/call', { name: 'boom', arguments: {} }, bearer);
    const result = res.json().result;

    expect(result.isError).toBe(true);
    expect(typeof result._meta?.traceparent).toBe('string');
    expect(result._meta.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('_meta.traceparent carries the same trace id as the inbound edge traceparent', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    const edgeTrace = 'a1b2c3d4'.repeat(4);
    const edgeSpan = 'e5f60718'.repeat(2);
    const res = await server.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${bearer}`,
        traceparent: `00-${edgeTrace}-${edgeSpan}-01`,
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_note', arguments: {} },
      } as object,
    });
    expect(res.json().result._meta?.traceparent).toMatch(new RegExp(`^00-${edgeTrace}-`));
  });
});

// ── C23 regression: CallToolResult pass-through (no double-wrapping) ───────────────────────────
//
// When an app handler returns a CallToolResult-shaped object (has a `content` array), the platform
// must pass content, structuredContent, and isError through VERBATIM — not re-wrap the entire
// handler response as another `content` text block. Before this fix, the wire `structuredContent`
// was the OUTER CallToolResult object (containing `content`, `structuredContent`, and `isError` keys
// at the top level), which did NOT match the tool's registered output_schema and confused clients
// that expected the schema's shape in structuredContent.
//
// The regression test is intentionally RED before the fix and GREEN after: without the fix,
// result.structuredContent would be `{ content: [...], structuredContent: {...} }` instead of
// `{ result: 'hello-structured', count: 3 }`, causing the schema-validation assertions to fail.
describe('C23 — CallToolResult pass-through (regression: no double-wrapping)', () => {
  it('[regression] a schema-bearing tool whose handler returns a CallToolResult-shaped object has its structuredContent passed through verbatim — NOT re-wrapped', async () => {
    // Register with an output_schema: {result: string, count: number}
    await registerTool({
      name: 'schema_tool',
      description: 'A tool with a registered output_schema',
      scope: 'notes:read',
      family: 'read',
      handler_path: '/api/mcp/tools/structured_reply',
      output_schema: {
        type: 'object',
        properties: { result: { type: 'string' }, count: { type: 'number' } },
        required: ['result', 'count'],
      },
    });
    const bearer = await mintAccess(['notes:read']);
    const res = await rpc('tools/call', { name: 'schema_tool', arguments: {} }, bearer);
    expect(res.statusCode).toBe(200);
    const result = res.json().result;

    // structuredContent must be the handler's OWN structuredContent — validated against the
    // registered output_schema. Before the fix, this was the outer CallToolResult wrapper object
    // (e.g. { content: [...], structuredContent: {...} }) which fails schema validation.
    expect(result.structuredContent).toEqual({ result: 'hello-structured', count: 3 });
    const sc = result.structuredContent as Record<string, unknown>;
    // These assertions are the schema-validation: required fields must exist at the TOP LEVEL.
    expect(typeof sc['result']).toBe('string'); // present in output_schema
    expect(typeof sc['count']).toBe('number'); // present in output_schema
    // The outer wrapper keys must NOT appear in structuredContent (double-wrapping smoke test).
    expect('content' in sc).toBe(false);
    expect('structuredContent' in sc).toBe(false);

    // content must be the handler's content — not a JSON.stringify of the whole handler response.
    expect(result.content).toEqual([{ type: 'text', text: 'structured result' }]);
    const contentText = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    // Before the fix, contentText was a JSON dump of the entire handler response (containing "content"
    // and "structuredContent" keys) — not the handler's intended text.
    expect(contentText).not.toContain('"content"');
    expect(contentText).not.toContain('"structuredContent"');
    expect(contentText).toBe('structured result');

    expect(calls).toContain('structured_reply');
  });

  it('[regression] bare (non-CallToolResult-shaped) handler payloads are still auto-wrapped — no regression for existing tools', async () => {
    // get_note returns { note: 'hello', echoed: {...} } — no `content` array → bare payload path.
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    const res = await rpc('tools/call', { name: 'get_note', arguments: { id: 'n42' } }, bearer);
    const result = res.json().result;

    // Bare payload: structuredContent = the handler's full response object
    expect(result.structuredContent).toMatchObject({ note: 'hello', echoed: { id: 'n42' } });
    // content = auto-generated text wrapping the JSON-stringified bare payload
    expect((result.content as Array<{ type: string; text: string }>)[0]!.type).toBe('text');
    expect(JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text)).toMatchObject({
      note: 'hello',
    });
    expect(result.isError).toBeUndefined();
  });
});

// ── C23 regression: serverInfo.version must report the published version (not 1.0.0) ──────────
//
// The MCP initialize response's serverInfo.version was hardcoded to '1.0.0' — the sidecar's
// fallback — so MCP clients (Claude, ChatGPT) always saw version 1.0.0 regardless of the actual
// deployed forge version. Fixed to read from the platform's own package.json.
describe('C23 — serverInfo.version reports the published platform version', () => {
  it('initialize returns the actual package version in serverInfo.version — not the 1.0.0 fallback', async () => {
    const bearer = await mintAccess([]);
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' }, bearer);
    expect(init.statusCode).toBe(200);
    const { serverInfo } = init.json().result as { serverInfo: { name: string; version: string } };

    // The name still identifies as forge-mcp:<appName>
    expect(serverInfo.name).toBe('forge-mcp:demo');

    // Version must be the actual package.json version, not the hardcoded 1.0.0 fallback.
    expect(serverInfo.version).not.toBe('1.0.0');
    expect(serverInfo.version).toBe(pkgJson.version);
  });
});

// ── toTimelineEvent — C23 caller projection ────────────────────────────────────────────────────
//
// Every `mcp.tool_call` AppEvent written by `recordCall` carries `data.host` (the OAuth client id
// of the calling MCP host). `toTimelineEvent` projects that raw C3 fact into a structured shape
// where the caller is ALWAYS present — either the literal client id or the explicit sentinel
// `'unattributed'` for legacy/migrated events. The two key invariants:
//   1. A known caller is preserved verbatim and never confused with the sentinel.
//   2. A missing/empty/non-string host NEVER silently omits the field — it becomes `'unattributed'`.
describe('toTimelineEvent — C23 caller projection', () => {
  const BASE_AT = '2026-08-06T12:00:00.000Z';

  const mkEvent = (
    data: Record<string, unknown>,
    overrides: Partial<{
      id: string;
      app_id: string;
      type: string;
      subject: string;
      owner: string;
      at: string;
    }> = {},
  ) => ({
    id: 'aevt_test_001',
    app_id: 'app_demo',
    type: 'mcp.tool_call',
    subject: 'get_note',
    owner: 'user_abc',
    data,
    at: BASE_AT,
    ...overrides,
  });

  // ── Attributed path ────────────────────────────────────────────────────────────────────────

  it('ATTRIBUTED: projects data.host as caller, preserving tool/ok/user/at and kind', () => {
    const event = mkEvent({ tool: 'get_note', host: 'mcpc_abc123', ok: true });
    const te: McpToolCallTimelineEvent = toTimelineEvent(event);

    expect(te.caller).toBe('mcpc_abc123'); // data.host preserved verbatim
    expect(te.kind).toBe('mcp.tool_call');
    expect(te.tool).toBe('get_note');
    expect(te.ok).toBe(true);
    expect(te.user).toBe('user_abc');
    expect(te.at).toBe(BASE_AT);
    expect(te.reason).toBeUndefined(); // no reason on a successful call
  });

  it('ATTRIBUTED: reason is included when data.reason is set (e.g. insufficient_scope)', () => {
    const event = mkEvent({
      tool: 'write_note',
      host: 'mcpc_xyz456',
      ok: false,
      reason: 'insufficient_scope',
    });
    const te = toTimelineEvent(event);

    expect(te.caller).toBe('mcpc_xyz456');
    expect(te.ok).toBe(false);
    expect(te.reason).toBe('insufficient_scope');
  });

  it('ATTRIBUTED: caller is the exact string even when it contains special characters', () => {
    const event = mkEvent({
      tool: 'ping',
      host: 'client:with/slashes?and=equals',
      ok: true,
    });
    expect(toTimelineEvent(event).caller).toBe('client:with/slashes?and=equals');
  });

  it('ATTRIBUTED: falls back to event.subject when data.tool is absent', () => {
    // Defensive: the raw event might lack data.tool but always has subject (it IS the tool name).
    const event = mkEvent({ host: 'mcpc_abc', ok: true }); // no data.tool
    const te = toTimelineEvent(event);
    expect(te.tool).toBe('get_note'); // from event.subject
    expect(te.caller).toBe('mcpc_abc');
  });

  it('ATTRIBUTED: ok=false is preserved faithfully — never coerced to true', () => {
    const event = mkEvent({ tool: 'boom', host: 'mcpc_abc', ok: false });
    expect(toTimelineEvent(event).ok).toBe(false);
  });

  // ── Integration: a real recordCall event carries the caller ───────────────────────────────

  it('INTEGRATION: a real mcp.tool_call event recorded via the dispatch path carries caller through toTimelineEvent', async () => {
    await registerTool();
    const bearer = await mintAccess(['notes:read']);
    await rpc('tools/call', { name: 'get_note', arguments: { id: 'n1' } }, bearer);

    const events = await store.listAppEvents({
      app_id: APP_ID,
      owner: 'userA',
      subject: 'get_note',
    });
    const callEvent = events.find(
      (e) => e.type === 'mcp.tool_call' && (e.data as { ok?: boolean }).ok === true,
    );
    expect(callEvent).toBeTruthy();

    const te = toTimelineEvent(callEvent!);
    // `caller` is the client id the grant was minted for — never undefined, never empty.
    expect(te.caller).toBe('client1'); // same as the clientId used in mintAccess
    expect(te.caller).not.toBe('unattributed');
    expect(te.kind).toBe('mcp.tool_call');
    expect(te.ok).toBe(true);
    expect(te.user).toBe('userA');
  });

  // ── Unattributed path — the explicit sentinel ─────────────────────────────────────────────

  it('UNATTRIBUTED: emits caller="unattributed" when data.host is absent', () => {
    // Legacy event: recorded before C23 host attribution existed.
    const event = mkEvent({ tool: 'ping', ok: true }); // no host key
    const te = toTimelineEvent(event);

    expect(te.caller).toBe('unattributed');
    // The sentinel must be distinguishable from any real client id (never empty, never undefined).
    expect(te.caller).not.toBe('');
    expect(te.caller).not.toBeUndefined();
  });

  it('UNATTRIBUTED: emits caller="unattributed" when data.host is an empty string', () => {
    const event = mkEvent({ tool: 'ping', host: '', ok: true });
    expect(toTimelineEvent(event).caller).toBe('unattributed');
  });

  it('UNATTRIBUTED: emits caller="unattributed" when data.host is null', () => {
    const event = mkEvent({ tool: 'ping', host: null, ok: true });
    expect(toTimelineEvent(event).caller).toBe('unattributed');
  });

  it('UNATTRIBUTED: emits caller="unattributed" when data.host is a non-string (number)', () => {
    const event = mkEvent({ tool: 'ping', host: 42, ok: true });
    expect(toTimelineEvent(event).caller).toBe('unattributed');
  });

  it('UNATTRIBUTED: user is undefined when event.owner is absent', () => {
    const event = mkEvent({ tool: 'ping', ok: true }, { owner: undefined as unknown as string });
    const te = toTimelineEvent(event);
    expect(te.user).toBeUndefined();
    expect(te.caller).toBe('unattributed');
  });

  // ── Shape completeness ────────────────────────────────────────────────────────────────────

  it('SHAPE: the output always includes at/kind/tool/caller/ok and never emits reason when absent', () => {
    const event = mkEvent({ tool: 'x', host: 'c', ok: true });
    const te = toTimelineEvent(event);
    const keys = Object.keys(te);

    expect(keys).toContain('at');
    expect(keys).toContain('kind');
    expect(keys).toContain('tool');
    expect(keys).toContain('caller');
    expect(keys).toContain('ok');
    expect(keys).toContain('user');
    expect(keys).not.toContain('reason'); // not present on a successful, reason-free call
  });

  it('SHAPE: caller field is never silently absent — present on every emitted event', () => {
    // The invariant: no matter the input, toTimelineEvent ALWAYS emits caller.
    const inputs = [
      mkEvent({ tool: 't', host: 'real-client', ok: true }),
      mkEvent({ tool: 't', ok: true }), // no host
      mkEvent({ tool: 't', host: '', ok: false }), // empty host
    ];
    for (const event of inputs) {
      const te = toTimelineEvent(event);
      expect('caller' in te).toBe(true);
      expect(typeof te.caller).toBe('string');
      expect(te.caller.length).toBeGreaterThan(0);
    }
  });
});
