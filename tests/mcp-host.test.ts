import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import type { Application } from '../src/resources/types';

// C23 — the hosted remote MCP server (Streamable-HTTP JSON-RPC) + the app-facing management surface.
// Exercised through the configured MCP store (filesystem default / Postgres on the pg run) with a STUB app
// server standing in for the consuming app's tool handlers — so tool registration, OAuth-gated dispatch,
// per-tool scope enforcement, C3 attribution, instruction versioning, and C2 proactive scheduling are all
// validated on BOTH backends.
const APP = 'demo';
const APP_ID = 'app_demo';
let dir: string;
let prevDir: string | undefined;
let prevHost: string | undefined;
let prevPort: string | undefined;
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
const mintAccess = async (scopes: string[], owner = 'userA', clientId = 'client1'): Promise<string> => {
  const { token, hash } = newToken();
  await (await getBackends()).mcp.putGrant(APP_ID, {
    kind: 'access', token_hash: hash, client_id: clientId, owner, scopes, expires_at: expiresAtIso(3600), created_at: nowIso(),
  });
  return token;
};

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevHost = process.env.FORGE_APP_CALLBACK_HOST;
  prevPort = process.env.FORGE_APP_CALLBACK_PORT;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-mcp-host-'));
  process.env.FORGE_STATE_DIR = dir;
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
  await rm(dir, { recursive: true, force: true });
});

const rpc = (method: string, params: unknown, bearer?: string, id: number | string = 1) =>
  server.inject({
    method: 'POST', url: '/mcp',
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    payload: { jsonrpc: '2.0', id, method, params } as object,
  });
const post = (url: string, payload: unknown) => server.inject({ method: 'POST', url, payload: payload as object });
const get = (url: string) => server.inject({ method: 'GET', url });

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

describe('C23 — connector (consent) management', () => {
  it('lists and revokes a user’s consent, cutting their tokens off', async () => {
    const bearer = await mintAccess(['notes:read'], 'userA', 'clientZ');
    await (await getBackends()).mcp.putConsent(APP_ID, { client_id: 'clientZ', owner: 'userA', scopes: ['notes:read'], created_at: nowIso(), updated_at: nowIso() });

    expect((await get('/mcp/consents?owner=userA')).json().consents).toHaveLength(1);
    await registerTool();
    // token works before revocation
    expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, bearer)).json().result.structuredContent).toBeTruthy();

    const del = await server.inject({ method: 'DELETE', url: '/mcp/consents/clientZ?owner=userA' });
    expect(del.json().revoked).toBe(true);
    // the token is now dead → 401
    expect((await rpc('tools/call', { name: 'get_note', arguments: {} }, bearer)).statusCode).toBe(401);
    expect((await get('/mcp/consents?owner=userA')).json().consents).toHaveLength(0);
  });
});
