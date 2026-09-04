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
import { registerIngestRoutes } from '../src/api/ingest-routes';
import { registerSmsRoutes } from '../src/api/sms-routes';
import { setCredentialVerifier } from '../src/connectors/credential-verifier';
import { caldavCredentialVerifier } from '../src/connectors/caldav-verifier';

// Assembled control-plane server boot test.
//
// Mirrors src/api/server.ts route assembly without importing the file (which calls main() at module
// evaluation time and would try to bind port 3717). Proves the control plane route assembly —
// which also registers registerAuthRoutes then registerSmsRoutes in the same order — completes
// without throwing FST_ERR_CTP_ALREADY_PRESENT or any other Fastify plugin error.

const DEFAULT_APP = 'cp-boot-test-app';
const SECRET_KEY = 'test-master-key-not-for-production';

let dir: string;
let prevState: string | undefined;
let prevKey: string | undefined;
let server: FastifyInstance;

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  prevKey = process.env.FORGE_SECRETS_KEY;

  dir = await mkdtemp(path.join(tmpdir(), 'forge-cp-boot-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_SECRETS_KEY = SECRET_KEY;
  await store.init();

  // Build a Fastify instance mirroring src/api/server.ts, WITHOUT calling listen() or
  // startScheduler() — the purpose is to prove route registration completes cleanly.
  server = Fastify({ logger: false });

  // /health is registered directly on app in api/server.ts (not via a register* helper).
  server.get('/health', async () => ({ status: 'ok', service: 'forge' }));

  // Same registration order as the control-plane server.
  registerAppEventRoutes(server);
  registerNotificationRoutes(server);
  registerSearchRoutes(server);
  registerBlobRoutes(server);
  // ↓ registers application/x-www-form-urlencoded on the root scope
  registerAuthRoutes(server);
  registerOwnerRoutes(server);
  registerThemeRoutes(server);
  registerStatusRoutes(server, { planeLabel: 'Forge control plane' });
  registerIncidentRoutes(server);
  registerAuthzRoutes(server);
  // ↓ also registers application/x-www-form-urlencoded (guarded by hasContentTypeParser)
  registerOAuthRoutes(server);
  registerMcpRoutes(server);
  setCredentialVerifier(caldavCredentialVerifier);
  registerConnectRoutes(server);
  registerMembershipRoutes(server);
  registerBillingRoutes(server);
  registerTenantRoutes(server);
  // ↓ SMS routes: child scope registers raw-string parser — fixed to use removeContentTypeParser first
  registerSmsRoutes(server, { defaultApp: () => DEFAULT_APP });
  registerIngestRoutes(server);
});

afterEach(async () => {
  await server.close();
  if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevState;
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
  await rm(dir, { recursive: true, force: true });
});

describe('assembled control-plane server (route registration smoke)', () => {
  it('boots without throwing any plugin error', async () => {
    await expect(server.ready()).resolves.not.toThrow();
  });

  it('health endpoint returns 200 ok after boot', async () => {
    await server.ready();
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string };
    expect(body.status).toBe('ok');
  });
});
