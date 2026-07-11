import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { registerAuthzRoutes } from '../src/api/authz-routes';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';

// C29 — the authorization/policy HTTP surface. Exercised through the configured policy store (filesystem
// on the default run, Postgres on the pg run) + the C3 audit trail — so this whole suite validates the
// store + routes on BOTH backends.
const APP = 'demo';
const APP_ID = 'app_demo';
let dir: string;
let prev: string | undefined;
let server: FastifyInstance;

const seedApp = async (): Promise<void> => {
  const now = nowIso();
  await store.saveResource({
    id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
    name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web', language: 'typescript', package_manager: 'npm',
  } as Application);
};

beforeEach(async () => {
  prev = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-authz-'));
  process.env.FORGE_STATE_DIR = dir;
  await store.init();
  await seedApp();
  server = Fastify({ logger: false });
  registerAuthzRoutes(server, { defaultApp: () => APP });
  await server.ready();
});
afterEach(async () => {
  await server.close();
  if (prev === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prev;
  await rm(dir, { recursive: true, force: true });
});

const post = (url: string, payload: unknown) => server.inject({ method: 'POST', url, payload: payload as object });
const get = (url: string) => server.inject({ method: 'GET', url });

describe('C29 — policy CRUD', () => {
  it('create → list → get → delete a policy', async () => {
    const c = await post('/policies', { owner: 'A', effect: 'allow', priority: 5, match: { type: ['read'] }, reason: 'reads ok' });
    expect(c.statusCode).toBe(200);
    const policy = c.json().policy;
    expect(policy).toMatchObject({ effect: 'allow', priority: 5, owner: 'A' });
    expect(typeof policy.id).toBe('string');
    expect(policy.created_at).toBeTruthy();

    expect((await get('/policies?owner=A')).json().policies.map((p: { id: string }) => p.id)).toContain(policy.id);
    expect((await get(`/policies/${policy.id}`)).json().policy.id).toBe(policy.id);

    expect((await server.inject({ method: 'DELETE', url: `/policies/${policy.id}` })).json().deleted).toBe(true);
    expect((await get(`/policies/${policy.id}`)).statusCode).toBe(404);
  });

  it('validates: missing effect → 422; unknown app → 404', async () => {
    expect((await post('/policies', { owner: 'A', priority: 1 })).statusCode).toBe(422);
    const bare = Fastify({ logger: false });
    registerAuthzRoutes(bare); // no default app
    await bare.ready();
    expect((await bare.inject({ method: 'POST', url: '/policies', payload: { effect: 'allow', app: 'nope' } })).statusCode).toBe(404);
    await bare.close();
  });
});

describe('C29 — POST /authorize (deterministic + C3 audit)', () => {
  it('a matching allow policy → allow, and the decision is recorded to C3', async () => {
    await post('/policies', { owner: 'A', effect: 'allow', match: { type: ['read'] } });
    const r = await post('/authorize', { owner: 'A', action: { tool: 'get_note', type: 'read', reversibility: 'reversible' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ decision: 'allow', high_risk: false, action_class: 'get_note' });

    // Recorded to the C3 audit trail (owner-scoped), keyed by the action class.
    const events = await store.listAppEvents({ app_id: APP_ID, owner: 'A', subject: 'get_note' });
    expect(events.some((e) => e.type === 'authz.decision' && (e.data as { decision?: string }).decision === 'allow')).toBe(true);
  });

  it('high-risk action always stages (needs-approval), even with a matching allow policy (safety floor)', async () => {
    await post('/policies', { owner: 'A', effect: 'allow', priority: 999, match: { tool: ['send_email'] } });
    const r = await post('/authorize', { owner: 'A', action: { tool: 'send_email', type: 'send', channel: 'email', contact: 'x@y.com' } });
    const d = r.json();
    expect(d.decision).toBe('needs-approval');
    expect(d.high_risk).toBe(true);
    expect(d.rule).toMatch(/^safety-floor:/);
  });

  it('no policy → the conservative default; owner-scoping isolates A from B', async () => {
    expect((await post('/authorize', { owner: 'A', action: { type: 'read', reversibility: 'reversible' } })).json().decision).toBe('needs-approval');
    // A policy for A doesn't help B.
    await post('/policies', { owner: 'A', effect: 'allow', match: { type: ['read'] } });
    expect((await post('/authorize', { owner: 'A', action: { type: 'read', reversibility: 'reversible' } })).json().decision).toBe('allow');
    expect((await post('/authorize', { owner: 'B', action: { type: 'read', reversibility: 'reversible' } })).json().decision).toBe('needs-approval');
  });

  it('validates input: missing owner/action → 400', async () => {
    expect((await post('/authorize', { action: { type: 'read' } })).statusCode).toBe(400);
    expect((await post('/authorize', { owner: 'A' })).statusCode).toBe(400);
  });
});

describe('C29 — progressive autonomy (approvals via C3)', () => {
  it('records approvals and surfaces "approved N times" with a policy suggestion at the threshold', async () => {
    for (let i = 0; i < 3; i++) await post('/authz/approvals', { owner: 'A', action_class: 'send_email:email' });
    const r = (await get('/authz/approvals?owner=A&action_class=send_email:email&threshold=3')).json();
    expect(r).toMatchObject({ action_class: 'send_email:email', approvals: 3, suggest_policy: true });
    // A different owner has its own count (owner-scoped).
    expect((await get('/authz/approvals?owner=B&action_class=send_email:email')).json().approvals).toBe(0);
  });
});
