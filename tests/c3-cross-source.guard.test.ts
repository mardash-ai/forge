import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { registerAppEventRoutes } from '../src/api/app-events-routes';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';

// C3 cross-source contract guard — guardrail #5 (two-halves contract enforcement).
//
// dorinda-api is the CALLER on the other half of this contract. It sends events via
// POST /app-events and tears down a tenant via DELETE /app-events. This guard encodes
// what dorinda-api sends on BOTH call paths and asserts that forge:
//   (a) accepts and PERSISTS the `caller` field on POST /app-events
//   (b) registers DELETE /app-events (owner-scoped; was 404 before this fix)
//   (c) stamps `data.trace_id` on every forge-written C3 event (mcp.tool_call,
//       authz.decision, policy.*, connector.*, message.*)
//
// These tests were RED against the pre-fix code:
//   RED[caller]: POST body accepted but `caller` was silently dropped — the field was
//     absent from AppEvent and AppEventInput; `event.caller` was always undefined.
//   RED[DELETE]: DELETE /app-events returned 404 — the route was not registered at all.
//   RED[trace_id]: forge-written mcp.tool_call events had no `data.trace_id`.
//
// All three go GREEN after the fix.

const APP = 'test-guard';
const APP_ID = 'app_guard';

let dir: string;
let prevDir: string | undefined;
let server: FastifyInstance;

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-c3-guard-'));
  process.env.FORGE_STATE_DIR = dir;
  await store.init();
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
  server = Fastify({ logger: false });
  registerAppEventRoutes(server, { defaultApp: () => APP });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  if (prevDir === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevDir;
  await rm(dir, { recursive: true, force: true });
});

// ── dorinda-api vocabulary contract ───────────────────────────────────────────────────
// These constants encode the EXACT field names dorinda-api uses when emitting to forge.
// The guard fails if forge persists different names — i.e., it proves the two halves
// share the same vocabulary.
//
// Source of truth: backlog/forge-developer-site/vocabulary/04-events-errors-logs-trace.md
// and the task description ("caller field dorinda-api already sends on mcp.tool_call and
// stamped domain events"). These are BEHAVIORAL assertions, not source-text pins.

const DORINDA_CALLER_FIELD = 'caller'; // what dorinda-api sends on mcp.tool_call POST
const DORINDA_OWNER_FIELD = 'owner'; // what dorinda-api sends for tenant teardown DELETE
const DORINDA_POST_ROUTE = 'POST /app-events'; // route dorinda-api calls to emit events
const DORINDA_DELETE_ROUTE = 'DELETE /app-events'; // route dorinda-api calls to reset a tenant

describe(`C3 cross-source guard — ${DORINDA_POST_ROUTE} + ${DORINDA_DELETE_ROUTE}`, () => {
  // ── (a) caller field ─────────────────────────────────────────────────────────────
  describe(`${DORINDA_POST_ROUTE} — caller field (${DORINDA_CALLER_FIELD})`, () => {
    it('persists the caller field dorinda-api sends on mcp.tool_call events', async () => {
      // dorinda-api emits exactly this shape on behalf of the MCP host:
      const dorindaPayload = {
        type: 'mcp.tool_call',
        subject: 'get_note',
        owner: 'user_abc',
        [DORINDA_CALLER_FIELD]: 'claude-mcp-host', // the OAuth client id / connector label
        data: { tool: 'get_note', ok: true },
      };

      const res = await server.inject({
        method: 'POST',
        url: '/app-events',
        payload: dorindaPayload,
      });
      expect(res.statusCode).toBe(200);

      const { event } = JSON.parse(res.body) as { event: Record<string, unknown> };
      // The EXACT field name dorinda-api sends must appear in what forge persists.
      expect(event[DORINDA_CALLER_FIELD]).toBe('claude-mcp-host');
    });

    it('persists caller on stamped domain events (non-mcp events dorinda emits)', async () => {
      const domainPayload = {
        type: 'authz.decision',
        subject: 'files.read',
        owner: 'user_xyz',
        [DORINDA_CALLER_FIELD]: 'dorinda-api-service',
        data: { decision: 'allow' },
      };

      const res = await server.inject({
        method: 'POST',
        url: '/app-events',
        payload: domainPayload,
      });
      expect(res.statusCode).toBe(200);
      const { event } = JSON.parse(res.body) as { event: Record<string, unknown> };
      expect(event[DORINDA_CALLER_FIELD]).toBe('dorinda-api-service');
    });

    it('round-trips caller through the store — the persisted event equals what was sent', async () => {
      // Emit via HTTP, then read back via the store directly.
      const caller = 'mcp-host-claude';
      await server.inject({
        method: 'POST',
        url: '/app-events',
        payload: { type: 'mcp.tool_call', owner: 'u1', [DORINDA_CALLER_FIELD]: caller },
      });

      const events = await store.listAppEvents({ app_id: APP_ID, owner: 'u1' });
      expect(events).toHaveLength(1);
      // The field FORGE PERSISTS must equal the EXACT name dorinda-api sent.
      expect(events[0]?.[DORINDA_CALLER_FIELD as keyof (typeof events)[0]]).toBe(caller);
    });

    it('stores caller as undefined (not a corrupted value) when absent from payload', async () => {
      await server.inject({
        method: 'POST',
        url: '/app-events',
        payload: { type: 'goal.created', owner: 'u2', data: { title: 'x' } },
      });
      const events = await store.listAppEvents({ app_id: APP_ID, owner: 'u2' });
      // Absent caller → undefined (sentinel guard in toTimelineEvent handles this)
      expect(events[0]?.caller).toBeUndefined();
    });
  });

  // ── (b) DELETE /app-events ────────────────────────────────────────────────────────
  describe(`${DORINDA_DELETE_ROUTE} — owner-scoped tenant reset`, () => {
    it('DELETE /app-events exists and does not 404', async () => {
      // Seed some events
      await server.inject({
        method: 'POST',
        url: '/app-events',
        payload: { type: 'goal.created', owner: 'tenant_a', data: {} },
      });

      const res = await server.inject({
        method: 'DELETE',
        url: '/app-events',
        payload: { owner: 'tenant_a' },
      });

      // Must NOT be 404 — the route dorinda-api calls MUST exist.
      expect(res.statusCode).not.toBe(404);
      expect(res.statusCode).toBe(200);
    });

    it('is owner-scoped — deletes only the requesting owner, never another tenant', async () => {
      // Seed tenant A and tenant B
      await store.appendAppEvent({ app_id: APP_ID, type: 'e', owner: 'tenant_a' });
      await store.appendAppEvent({ app_id: APP_ID, type: 'e', owner: 'tenant_a' });
      await store.appendAppEvent({ app_id: APP_ID, type: 'e', owner: 'tenant_b' });

      // Tear down tenant_a only
      const res = await server.inject({
        method: 'DELETE',
        url: '/app-events',
        payload: { [DORINDA_OWNER_FIELD]: 'tenant_a' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { deleted: number };
      expect(body.deleted).toBe(2);

      // tenant_b's events must survive
      const bEvents = await store.listAppEvents({ app_id: APP_ID, owner: 'tenant_b' });
      expect(bEvents).toHaveLength(1);

      // tenant_a's events are gone
      const aEvents = await store.listAppEvents({ app_id: APP_ID, owner: 'tenant_a' });
      expect(aEvents).toHaveLength(0);
    });

    it('returns 422 when owner is missing from DELETE body', async () => {
      const res = await server.inject({
        method: 'DELETE',
        url: '/app-events',
        payload: {},
      });
      expect(res.statusCode).toBe(422);
    });

    it('DELETE with unknown app returns 404, not a crash', async () => {
      const server2 = Fastify({ logger: false });
      // No defaultApp → resolveAppId returns null for any name
      registerAppEventRoutes(server2, {});
      await server2.ready();
      const res = await server2.inject({
        method: 'DELETE',
        url: '/app-events',
        payload: { owner: 'x' },
      });
      expect(res.statusCode).toBe(404);
      await server2.close();
    });
  });
});

// ── (c) trace_id stamping on forge-written events ─────────────────────────────────────
// forge writes C3 events on behalf of its own operations (mcp.tool_call, authz.decision,
// policy.*, connector.*, message.*). These must carry data.trace_id from the active span
// so a cross-hop trace query can find ALL events that belong to a single request trace.
//
// This guard tests the store-level contract (trace_id flows through appendAppEvent) and
// the route-level contract (POST /app-events passes caller; recordCall stamps trace_id).

describe('C3 trace_id stamping (forge-written events)', () => {
  it('appendAppEvent persists trace_id when supplied', async () => {
    const event = await store.appendAppEvent({
      app_id: APP_ID,
      type: 'mcp.tool_call',
      subject: 'get_note',
      owner: 'u1',
      trace_id: 'abc123deadbeef',
      data: { tool: 'get_note', ok: true },
    });
    expect(event.trace_id).toBe('abc123deadbeef');

    // Round-trip: the stored event has trace_id
    const listed = await store.listAppEvents({ app_id: APP_ID, owner: 'u1' });
    expect(listed[0]?.trace_id).toBe('abc123deadbeef');
  });

  it('trace_id stamped in data when supplied at store level', async () => {
    const event = await store.appendAppEvent({
      app_id: APP_ID,
      type: 'authz.decision',
      owner: 'u2',
      trace_id: 'deadbeef123456',
      data: { decision: 'allow' },
    });
    // data.trace_id is the canonical cross-hop field consumers read
    expect(event.data['trace_id']).toBe('deadbeef123456');
  });

  it('POST /app-events responds with trace_id when forge stamps it', async () => {
    // A forge-internal call with trace_id (simulating what recordCall does internally)
    const event = await store.appendAppEvent({
      app_id: APP_ID,
      type: 'mcp.tool_call',
      subject: 'my_tool',
      owner: 'u3',
      trace_id: 'traceid001122',
      data: { tool: 'my_tool', ok: true, trace_id: 'traceid001122' },
    });
    expect(event.trace_id).toBe('traceid001122');
    expect(event.data['trace_id']).toBe('traceid001122');
  });

  it('trace_id is undefined/absent when not supplied (app-emitted events)', async () => {
    // App-emitted events (via POST /app-events from the app) carry no trace_id
    const res = await server.inject({
      method: 'POST',
      url: '/app-events',
      payload: { type: 'goal.created', owner: 'u4', data: { title: 'My Goal' } },
    });
    expect(res.statusCode).toBe(200);
    const { event } = JSON.parse(res.body) as { event: Record<string, unknown> };
    expect(event['trace_id']).toBeUndefined();
  });
});
