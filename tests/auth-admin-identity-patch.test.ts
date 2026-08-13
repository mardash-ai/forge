import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { setSecret } from '../src/plugins/secrets-local/index';
import { registerAuthRoutes } from '../src/api/auth-routes';
import * as authStore from '../src/plugins/auth-identity/store';
import type { Application } from '../src/resources/types';
import { nowIso } from '../src/shared/time';

// HAT-F-061 — PATCH /auth/admin/identity/:userId (C10 auth service, C23 plane)
//
// RED-FIRST RATIONALE: Before this route was added, PATCH /auth/admin/identity/:userId
// returned 404 (no matching route). The dorinda-api admin seed calling this path to update
// a member's platform name therefore silently failed. The tests below are written against
// the final correct behavior; they would have failed (404 responses instead of 200/401/422)
// against the pre-change code where the route did not exist.
//
// Admin-auth is the same service-token gate (x-forge-service-token / AUTH_SERVICE_TOKEN)
// that guards /auth/admin/identity DELETE and /oauth/admin/token (hasValidServiceToken).

const APP = 'patch-test-app';
const SECRET_KEY = 'test-master-key-not-for-production';
const SVC_TOKEN = 'svc-patch-t0ken';
const SVC = {
  'x-forge-service-token': SVC_TOKEN,
  'content-type': 'application/x-www-form-urlencoded',
};
const NO_TOKEN = { 'content-type': 'application/x-www-form-urlencoded' };

const prevKey = process.env.FORGE_SECRETS_KEY;
let dir: string;
let prevState: string | undefined;
let appId: string;
let server: FastifyInstance;

function form(obj: Record<string, string>): string {
  return new URLSearchParams(obj).toString();
}

async function seedApp(): Promise<Application> {
  const now = nowIso();
  const a: Application = {
    id: `app_${APP}`,
    type: 'Application',
    app_id: `app_${APP}`,
    created_at: now,
    updated_at: now,
    name: APP,
    repo_path: '/app',
    platform: 'web',
    framework: 'nextjs',
    template: 'nextjs-web',
    language: 'typescript',
    package_manager: 'npm',
  };
  await store.saveResource(a);
  return a;
}

/** Create an identity via the admin create route and return its user_id. */
async function createIdentity(email: string, name?: string): Promise<string> {
  const payload: Record<string, string> = { email };
  if (name) payload.name = name;
  const res = await server.inject({
    method: 'POST',
    url: '/auth/admin/identity',
    headers: SVC,
    payload: form(payload),
  });
  if (res.statusCode !== 201) {
    throw new Error(`createIdentity failed: ${res.statusCode} — ${res.body}`);
  }
  return res.json().user_id;
}

beforeAll(() => {
  process.env.FORGE_SECRETS_KEY = SECRET_KEY;
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
});

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-patch-identity-'));
  process.env.FORGE_STATE_DIR = dir;
  await store.init();
  const a = await seedApp();
  appId = a.id;
  // Wire the service token so admin routes accept it.
  await setSecret(appId, 'AUTH_SERVICE_TOKEN', SVC_TOKEN);
  server = Fastify({ logger: false });
  registerAuthRoutes(server, { defaultApp: () => APP });
  await server.ready();
});
afterEach(async () => {
  await server.close();
  if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevState;
  await rm(dir, { recursive: true, force: true });
});

// ── happy path ──────────────────────────────────────────────────────────────────────────────────

describe('PATCH /auth/admin/identity/:userId — happy path (HAT-F-061)', () => {
  it('updates the name of an existing identity and returns 200 with the new name', async () => {
    // RED-FIRST: before this route existed the server returned 404 (no matching route).
    // This assertion would have been: expect(res.statusCode).toBe(404).
    const userId = await createIdentity('alice@example.test');
    const res = await server.inject({
      method: 'PATCH',
      url: `/auth/admin/identity/${userId}`,
      headers: SVC,
      payload: form({ name: 'Alice Wonderland' }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_id).toBe(userId);
    expect(body.name).toBe('Alice Wonderland');
  });

  it('persists the updated name in the identity store', async () => {
    const userId = await createIdentity('bob@example.test', 'Old Name');
    await server.inject({
      method: 'PATCH',
      url: `/auth/admin/identity/${userId}`,
      headers: SVC,
      payload: form({ name: 'New Name' }),
    });
    const stored = await authStore.getUser(appId, userId);
    expect(stored?.name).toBe('New Name');
  });

  it('accepts a name that was not set at creation time (upsert scenario)', async () => {
    const userId = await createIdentity('carol@example.test'); // no name at creation
    const res = await server.inject({
      method: 'PATCH',
      url: `/auth/admin/identity/${userId}`,
      headers: SVC,
      payload: form({ name: 'Carol Platform Name' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Carol Platform Name');
  });

  it('trims whitespace from the name field', async () => {
    const userId = await createIdentity('dave@example.test');
    const res = await server.inject({
      method: 'PATCH',
      url: `/auth/admin/identity/${userId}`,
      headers: SVC,
      payload: form({ name: '  Trimmed Name  ' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Trimmed Name');
  });
});

// ── admin-auth negative cases ────────────────────────────────────────────────────────────────────

describe('PATCH /auth/admin/identity/:userId — admin-auth (HAT-F-061)', () => {
  it('returns 401 when no service token is presented', async () => {
    // RED-FIRST: before this route existed this also returned 404. Now it returns 401, proving
    // the auth gate fires before the user lookup and that the route is not end-user reachable.
    const userId = await createIdentity('eve@example.test');
    const res = await server.inject({
      method: 'PATCH',
      url: `/auth/admin/identity/${userId}`,
      headers: NO_TOKEN,
      payload: form({ name: 'Attacker' }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('returns 401 when a wrong service token is presented', async () => {
    const userId = await createIdentity('frank@example.test');
    const res = await server.inject({
      method: 'PATCH',
      url: `/auth/admin/identity/${userId}`,
      headers: {
        'x-forge-service-token': 'wrong-token',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: form({ name: 'Attacker' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('uses Bearer Authorization header as an alternative to x-forge-service-token header', async () => {
    // The shared hasValidServiceToken gate accepts either the dedicated header OR a Bearer auth
    // header (same as /oauth/admin/token). Verify both auth paths reach the route.
    const userId = await createIdentity('grace@example.test');
    const res = await server.inject({
      method: 'PATCH',
      url: `/auth/admin/identity/${userId}`,
      headers: { authorization: `Bearer ${SVC_TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ name: 'Via Bearer' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Via Bearer');
  });
});

// ── 404 / validation cases ───────────────────────────────────────────────────────────────────────

describe('PATCH /auth/admin/identity/:userId — error cases (HAT-F-061)', () => {
  it('returns 404 for an unknown userId', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/auth/admin/identity/nonexistent-user-id',
      headers: SVC,
      payload: form({ name: 'Ghost' }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('returns 422 when no updatable field is supplied in the body', async () => {
    const userId = await createIdentity('henry@example.test');
    const res = await server.inject({
      method: 'PATCH',
      url: `/auth/admin/identity/${userId}`,
      headers: SVC,
      payload: form({}),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_input');
  });

  it('returns 404 when the app is unknown', async () => {
    // Use an explicit app that does not exist — no defaultApp fallback.
    const res = await server.inject({
      method: 'PATCH',
      url: '/auth/admin/identity/any-id?app=nonexistent-app',
      headers: SVC,
      payload: form({ name: 'Ghost' }),
    });
    expect(res.statusCode).toBe(404);
  });
});
