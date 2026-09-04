import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { registerAppEventRoutes } from '../src/api/app-events-routes';
import { registerNotificationRoutes } from '../src/api/notifications-routes';
import { registerSearchRoutes } from '../src/api/search-routes';
import { registerBlobRoutes } from '../src/api/blobs-routes';
import { registerAuthRoutes } from '../src/api/auth-routes';
import { registerOwnerRoutes } from '../src/api/owner-routes';
import { registerThemeRoutes } from '../src/api/theme-routes';
import { registerStatusRoutes } from '../src/api/status-routes';
import { registerIncidentRoutes } from '../src/api/incident-routes';
import { registerAuthzRoutes } from '../src/api/authz-routes';
import { registerOAuthRoutes } from '../src/api/oauth-routes';
import { registerMcpRoutes } from '../src/api/mcp-routes';
import { registerConnectRoutes } from '../src/api/connect-routes';
import { registerMembershipRoutes } from '../src/api/membership-routes';
import { registerBillingRoutes } from '../src/api/billing-routes';
import { registerTenantRoutes } from '../src/api/tenant-routes';
import { registerSmsRoutes } from '../src/api/sms-routes';
import { setCredentialVerifier } from '../src/connectors/credential-verifier';
import { caldavCredentialVerifier } from '../src/connectors/caldav-verifier';

// Assembled data-plane server boot test.
//
// Regression guard for FST_ERR_CTP_ALREADY_PRESENT at src/api/sms-routes.ts — the bug that
// prevented forge-data-plane-00028 from ever binding port 3718.
//
// Root cause: registerAuthRoutes registered application/x-www-form-urlencoded on the root
// Fastify scope. registerSmsRoutes then tried to register the SAME content type in a child
// scope that inherited a COPY of the parent's parser map. Fastify threw FST_ERR_CTP_ALREADY_PRESENT
// at plugin load time, before the server ever called listen().
//
// The fix: removeContentTypeParser before addContentTypeParser in the twilio child scope so it
// can override the inherited parser with the raw-string variant needed for HMAC-SHA1 verification.
//
// This test:
// 1. Assembles a Fastify instance in the same order as src/data-plane/server.ts (no auto-start).
// 2. Calls server.ready() — throws if any plugin registration fails (was the crash site).
// 3. Hits GET /health via inject() — confirms the server is functional.
//
// RED at 1.57.x (before fix): server.ready() threw FST_ERR_CTP_ALREADY_PRESENT.
// GREEN at current (after fix): server.ready() resolves; /health returns 200.

const DEFAULT_APP = 'boot-test-app';
const SECRET_KEY = 'test-master-key-not-for-production';

let dir: string;
let prevState: string | undefined;
let prevKey: string | undefined;
let prevAppName: string | undefined;
let server: FastifyInstance;

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  prevKey = process.env.FORGE_SECRETS_KEY;
  prevAppName = process.env.FORGE_APP_NAME;

  dir = await mkdtemp(path.join(tmpdir(), 'forge-dp-boot-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_SECRETS_KEY = SECRET_KEY;
  process.env.FORGE_APP_NAME = DEFAULT_APP;
  await store.init();

  // Build the Fastify instance mirroring src/data-plane/server.ts, WITHOUT calling listen() or
  // startScheduler() — we only need to prove that route registration completes without error.
  server = Fastify({ logger: false });

  // /health is registered directly on app in data-plane/server.ts (not via a register* helper).
  server.get('/health', async () => ({ status: 'ok', service: 'forge-data-plane' }));

  // Same registration order as the data-plane server.
  registerAppEventRoutes(server, { defaultApp: () => DEFAULT_APP });
  registerNotificationRoutes(server, { defaultApp: () => DEFAULT_APP });
  registerSearchRoutes(server, { defaultApp: () => DEFAULT_APP });
  registerBlobRoutes(server, { defaultApp: () => DEFAULT_APP });
  // ↓ registers application/x-www-form-urlencoded on the root scope
  registerAuthRoutes(server, { defaultApp: () => DEFAULT_APP });
  registerOwnerRoutes(server, { defaultApp: () => DEFAULT_APP });
  registerThemeRoutes(server, { defaultApp: () => DEFAULT_APP });
  registerStatusRoutes(server, { defaultApp: () => DEFAULT_APP, planeLabel: 'Forge data plane' });
  registerIncidentRoutes(server, { defaultApp: () => DEFAULT_APP });
  registerAuthzRoutes(server, { defaultApp: () => DEFAULT_APP });
  registerOAuthRoutes(server, { defaultApp: () => DEFAULT_APP });
  registerMcpRoutes(server, { defaultApp: () => DEFAULT_APP });
  setCredentialVerifier(caldavCredentialVerifier);
  registerConnectRoutes(server, { defaultApp: () => DEFAULT_APP });
  registerMembershipRoutes(server, { defaultApp: () => DEFAULT_APP });
  registerBillingRoutes(server, { defaultApp: () => DEFAULT_APP });
  registerTenantRoutes(server, { defaultApp: () => DEFAULT_APP });
  // ↓ child scope tries to add the SAME content type — FST_ERR_CTP_ALREADY_PRESENT before fix
  registerSmsRoutes(server, { defaultApp: () => DEFAULT_APP });
});

afterEach(async () => {
  await server.close();
  if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevState;
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
  if (prevAppName === undefined) delete process.env.FORGE_APP_NAME;
  else process.env.FORGE_APP_NAME = prevAppName;
  await rm(dir, { recursive: true, force: true });
});

describe('assembled data-plane server (FST_ERR_CTP_ALREADY_PRESENT regression)', () => {
  it('boots without throwing FST_ERR_CTP_ALREADY_PRESENT or any other plugin error', async () => {
    // server.ready() finalizes all plugin registrations — this is where FST_ERR_CTP_ALREADY_PRESENT
    // surfaced before the fix. Must resolve cleanly.
    await expect(server.ready()).resolves.not.toThrow();
  });

  it('health endpoint returns 200 ok after boot', async () => {
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  it('registerSmsRoutes mounts after registerAuthRoutes without throwing', async () => {
    // Focused regression: a fresh instance with just auth + SMS routes — the minimal pair that
    // triggered FST_ERR_CTP_ALREADY_PRESENT. Proves the fix is at the source, not masked by order.
    const s = Fastify({ logger: false });
    registerAuthRoutes(s, { defaultApp: () => DEFAULT_APP });
    registerSmsRoutes(s, { defaultApp: () => DEFAULT_APP });
    await expect(s.ready()).resolves.not.toThrow();
    await s.close();
  });
});
