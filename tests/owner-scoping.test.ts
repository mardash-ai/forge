import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { registerAppEventRoutes } from '../src/api/app-events-routes';
import { registerNotificationRoutes } from '../src/api/notifications-routes';
import { registerOwnerRoutes } from '../src/api/owner-routes';
import type { Application } from '../src/resources/types';
import { nowIso } from '../src/shared/time';

// C11 — owner-scoping over the real HTTP surface (C3 app-events + C4 notifications + the
// `claim-legacy` migration), driven through Fastify.inject (no sockets). Proves that a read scoped
// to one owner never returns another owner's data, and that the one-time cutover migration claims
// legacy (owner-less) records for a seeded owner.
const APP = 'demo';
let dir: string;
let prevState: string | undefined;
let server: FastifyInstance;

async function seedApp(): Promise<Application> {
  const now = nowIso();
  const a: Application = {
    id: `app_${APP}`, type: 'Application', app_id: `app_${APP}`, created_at: now, updated_at: now,
    name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web',
    language: 'typescript', package_manager: 'npm',
  };
  await store.saveResource(a);
  return a;
}

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-owner-'));
  process.env.FORGE_STATE_DIR = dir;
  await store.init();
  await seedApp();
  server = Fastify({ logger: false });
  registerAppEventRoutes(server, { defaultApp: () => APP });
  registerNotificationRoutes(server, { defaultApp: () => APP });
  registerOwnerRoutes(server, { defaultApp: () => APP });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevState;
  await rm(dir, { recursive: true, force: true });
});

function post(url: string, body: unknown, target: FastifyInstance = server) {
  return target.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}
async function get(url: string) {
  return (await server.inject({ method: 'GET', url })).json();
}

describe('C11 owner-scoping over HTTP (C3 + C4)', () => {
  it('C3: a feed scoped to owner A never returns owner B’s events', async () => {
    await post('/app-events', { type: 'goal.created', subject: 'g1', owner: 'A' });
    await post('/app-events', { type: 'goal.created', subject: 'g2', owner: 'B' });

    const aFeed = (await get('/app-events?owner=A')).events as Array<{ subject: string; owner: string }>;
    const bFeed = (await get('/app-events?owner=B')).events as Array<{ subject: string; owner: string }>;
    expect(aFeed.map((e) => e.subject)).toEqual(['g1']);
    expect(bFeed.map((e) => e.subject)).toEqual(['g2']);
    expect(aFeed.some((e) => e.owner === 'B')).toBe(false);
  });

  it('C4: a notification list scoped to owner A never returns owner B’s — same key stays distinct', async () => {
    await post('/notifications', { key: 'cold:g1', title: "A's", owner: 'A' });
    await post('/notifications', { key: 'cold:g1', title: "B's", owner: 'B' });

    const aList = (await get('/notifications?owner=A')).notifications as Array<{ title: string; owner: string }>;
    expect(aList.map((n) => n.title)).toEqual(["A's"]);
    expect(aList.some((n) => n.owner === 'B')).toBe(false);
    // Dismiss A's — B's identically-keyed notification is untouched.
    await post('/notifications/dismiss', { key: 'cold:g1', owner: 'A' });
    expect(((await get('/notifications?owner=A')).notifications as unknown[]).length).toBe(0);
    expect(((await get('/notifications?owner=B')).notifications as unknown[]).length).toBe(1);
  });

  it('claim-legacy migrates owner-less C3 + C4 records to a seeded owner, and is idempotent', async () => {
    // Pre-C11 records (no owner) + one already-owned each.
    await post('/app-events', { type: 'legacy-evt' });
    await post('/notifications', { key: 'legacy-note', title: 'legacy' });
    await post('/app-events', { type: 'owned-evt', owner: 'owner-1' });

    // Before the migration, owner-scoped reads don't see the legacy records.
    expect(((await get('/app-events?owner=owner-1')).events as unknown[]).map((e: any) => e.type)).toEqual(['owned-evt']);
    expect(((await get('/notifications?owner=owner-1')).notifications as unknown[]).length).toBe(0);

    const claim = await post('/owner/claim-legacy', { owner: 'owner-1' });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().claimed).toMatchObject({ app_events: 1, notifications: 1, agent_runs: 0 });

    // After: owner-1 now sees the (formerly legacy) records under an owner-scoped read.
    expect(((await get('/app-events?owner=owner-1')).events as unknown[]).map((e: any) => e.type).sort()).toEqual(['legacy-evt', 'owned-evt']);
    expect(((await get('/notifications?owner=owner-1')).notifications as unknown[]).map((n: any) => n.key)).toEqual(['legacy-note']);

    // Idempotent — a second run claims nothing.
    expect((await post('/owner/claim-legacy', { owner: 'owner-1' })).json().claimed).toMatchObject({ app_events: 0, notifications: 0 });
  });

  it('claim-legacy validates input: 422 without an owner, 404 for an unknown app', async () => {
    expect((await post('/owner/claim-legacy', {})).statusCode).toBe(422);
    // A server WITHOUT a defaultApp + an unknown app name → 404.
    const bare = Fastify({ logger: false });
    registerOwnerRoutes(bare);
    await bare.ready();
    expect((await post('/owner/claim-legacy', { owner: 'x', app: 'nope' }, bare)).statusCode).toBe(404);
    await bare.close();
  });
});
