/**
 * http-gating-gaps.test.ts
 *
 * Proves each HTTP security gate was wired correctly. Each test verifies that the route
 * returns 401 (service token gate) or 403 (Twilio signature gate) when credentials are
 * absent or invalid. Without the fix that introduced the gate, these tests would fail.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { store } from '../src/storage/store';
import { registerAuthRoutes } from '../src/api/auth-routes';
import { registerAppEventRoutes } from '../src/api/app-events-routes';
import { registerNotificationRoutes } from '../src/api/notifications-routes';
import { registerSearchRoutes } from '../src/api/search-routes';
import { registerBlobRoutes } from '../src/api/blobs-routes';
import { registerOwnerRoutes } from '../src/api/owner-routes';
import { registerIncidentRoutes } from '../src/api/incident-routes';
import { registerAuthzRoutes } from '../src/api/authz-routes';
import { registerMembershipRoutes } from '../src/api/membership-routes';
import { registerSmsRoutes } from '../src/api/sms-routes';
import type { Application } from '../src/resources/types';
import { nowIso } from '../src/shared/time';

const APP = 'gating-test';
const APP_ID = 'app_gating_test';

let dir: string;
const prevKey = process.env.FORGE_SECRETS_KEY;
const prevStateDir = process.env.FORGE_STATE_DIR;

beforeAll(() => {
  process.env.FORGE_SECRETS_KEY = 'test-master-key-not-for-production';
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'forge-gating-'));
  process.env.FORGE_STATE_DIR = dir;
  await store.init();
  const now = nowIso();
  const app: Application = {
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
  };
  await store.saveResource(app);
});

afterEach(async () => {
  if (prevStateDir === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevStateDir;
  await rm(dir, { recursive: true, force: true });
});

// Helper: start a Fastify server with a specific route registrar, run a test, then close.
async function withServer(
  register: (app: FastifyInstance) => void,
  fn: (server: FastifyInstance) => Promise<void>,
): Promise<void> {
  const server = Fastify({ logger: false });
  register(server);
  await server.ready();
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

// ── Gap 1: POST /auth/admin/seed-owner — service token gate ──────────────────────────────────

describe('Gap 1: POST /auth/admin/seed-owner service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerAuthRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'POST',
          url: '/auth/admin/seed-owner',
          headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'app.test' },
          payload: new URLSearchParams({ email: 'owner@example.com', password: 'pass-123456' }).toString(),
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('unauthorized');
      },
    );
  });
});

// ── Gap 2: App-facing module service token gates ──────────────────────────────────────────────

describe('Gap 2: POST /app-events service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerAppEventRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'POST',
          url: '/app-events',
          payload: { app: APP, type: 'test.event' },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('unauthorized');
      },
    );
  });
});

describe('Gap 2: GET /app-events service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerAppEventRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'GET',
          url: `/app-events?app=${APP}`,
        });
        expect(res.statusCode).toBe(401);
      },
    );
  });
});

describe('Gap 2: POST /notifications service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerNotificationRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'POST',
          url: '/notifications',
          payload: { app: APP, key: 'k', title: 'Hi' },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('unauthorized');
      },
    );
  });
});

describe('Gap 2: GET /notifications service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerNotificationRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'GET',
          url: `/notifications?app=${APP}`,
        });
        expect(res.statusCode).toBe(401);
      },
    );
  });
});

describe('Gap 2: POST /index (search) service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerSearchRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'POST',
          url: '/index',
          payload: { app: APP, owner: 'u1', type: 'doc', id: 'd1', title: 'Doc' },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('unauthorized');
      },
    );
  });
});

describe('Gap 2: POST /search service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerSearchRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'POST',
          url: '/search',
          payload: { app: APP, owner: 'u1', q: 'hello' },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('unauthorized');
      },
    );
  });
});

describe('Gap 2: POST /owner/claim-legacy service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerOwnerRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'POST',
          url: '/owner/claim-legacy',
          payload: { app: APP, owner: 'user-1' },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('unauthorized');
      },
    );
  });
});

describe('Gap 2: POST /status/incidents service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerIncidentRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'POST',
          url: '/status/incidents',
          payload: { app: APP, title: 'Outage', status: 'investigating', impact: 'major' },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('unauthorized');
      },
    );
  });
});

describe('Gap 2: GET /status/incidents service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerIncidentRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'GET',
          url: `/status/incidents?app=${APP}`,
        });
        expect(res.statusCode).toBe(401);
      },
    );
  });
});

describe('Gap 2: POST /authorize service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerAuthzRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'POST',
          url: '/authorize',
          payload: { app: APP, owner: 'u1', action: { class: 'read', resource: 'doc' } },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('unauthorized');
      },
    );
  });
});

describe('Gap 2: GET /policies service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerAuthzRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'GET',
          url: `/policies?app=${APP}`,
        });
        expect(res.statusCode).toBe(401);
      },
    );
  });
});

describe('Gap 2: PUT /roles (membership) service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerMembershipRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'PUT',
          url: '/roles',
          payload: { app: APP, roles: [] },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('unauthorized');
      },
    );
  });
});

describe('Gap 2: POST /groups/ensure (membership) service token gate', () => {
  it('returns 401 without a service token', async () => {
    await withServer(
      (s) => registerMembershipRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        const res = await server.inject({
          method: 'POST',
          url: '/groups/ensure',
          payload: { app: APP, owner: 'u1' },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('unauthorized');
      },
    );
  });
});

// ── Gap 3: POST /hooks/sms/twilio — Twilio HMAC-SHA1 signature gate ──────────────────────────

describe('Gap 3: POST /hooks/sms/twilio Twilio signature gate', () => {
  // The webhook URL reconstruction uses x-forwarded-proto/x-forwarded-host when present;
  // when absent: proto defaults to 'https', host comes from the Host header (Fastify
  // inject sets Host to 'localhost').
  const TEST_AUTH_TOKEN = 'test-hmac-auth-token';
  const WEBHOOK_URL = 'https://localhost/hooks/sms/twilio';

  function computeSignature(authToken: string, url: string, params: Record<string, string>): string {
    const sortedKeys = Object.keys(params).sort();
    const toSign = url + sortedKeys.map((k) => `${k}${params[k] ?? ''}`).join('');
    return createHmac('sha1', authToken).update(toSign, 'utf8').digest('base64');
  }

  it('returns 403 when X-Twilio-Signature is absent and TWILIO_AUTH_TOKEN is set', async () => {
    const prevToken = process.env.TWILIO_AUTH_TOKEN;
    const prevSid = process.env.TWILIO_ACCOUNT_SID;
    const prevFrom = process.env.TWILIO_FROM_NUMBER;
    process.env.TWILIO_AUTH_TOKEN = TEST_AUTH_TOKEN;
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_FROM_NUMBER = '+15550000001';
    try {
      await withServer(
        (s) => registerSmsRoutes(s, { defaultApp: () => APP }),
        async (server) => {
          const payload = 'From=%2B15551111111&Body=STOP';
          const res = await server.inject({
            method: 'POST',
            url: '/hooks/sms/twilio',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            payload,
            // No X-Twilio-Signature header — should be rejected.
          });
          expect(res.statusCode).toBe(403);
          // Returns empty TwiML (no info leakage).
          expect(res.payload).toContain('<Response/>');
        },
      );
    } finally {
      if (prevToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
      else process.env.TWILIO_AUTH_TOKEN = prevToken;
      if (prevSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
      else process.env.TWILIO_ACCOUNT_SID = prevSid;
      if (prevFrom === undefined) delete process.env.TWILIO_FROM_NUMBER;
      else process.env.TWILIO_FROM_NUMBER = prevFrom;
    }
  });

  it('returns 403 when X-Twilio-Signature is wrong (invalid HMAC)', async () => {
    const prevToken = process.env.TWILIO_AUTH_TOKEN;
    const prevSid = process.env.TWILIO_ACCOUNT_SID;
    const prevFrom = process.env.TWILIO_FROM_NUMBER;
    process.env.TWILIO_AUTH_TOKEN = TEST_AUTH_TOKEN;
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_FROM_NUMBER = '+15550000001';
    try {
      await withServer(
        (s) => registerSmsRoutes(s, { defaultApp: () => APP }),
        async (server) => {
          const payload = 'From=%2B15551111111&Body=STOP';
          const res = await server.inject({
            method: 'POST',
            url: '/hooks/sms/twilio',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'x-twilio-signature': 'aGVsbG8gd29ybGQ=', // wrong signature
            },
            payload,
          });
          expect(res.statusCode).toBe(403);
          expect(res.payload).toContain('<Response/>');
        },
      );
    } finally {
      if (prevToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
      else process.env.TWILIO_AUTH_TOKEN = prevToken;
      if (prevSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
      else process.env.TWILIO_ACCOUNT_SID = prevSid;
      if (prevFrom === undefined) delete process.env.TWILIO_FROM_NUMBER;
      else process.env.TWILIO_FROM_NUMBER = prevFrom;
    }
  });

  it('passes with a valid Twilio HMAC-SHA1 signature', async () => {
    const prevToken = process.env.TWILIO_AUTH_TOKEN;
    const prevSid = process.env.TWILIO_ACCOUNT_SID;
    const prevFrom = process.env.TWILIO_FROM_NUMBER;
    process.env.TWILIO_AUTH_TOKEN = TEST_AUTH_TOKEN;
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_FROM_NUMBER = '+15550000001';
    try {
      await withServer(
        (s) => registerSmsRoutes(s, { defaultApp: () => APP }),
        async (server) => {
          // The handler reconstructs the URL from x-forwarded-proto + x-forwarded-host.
          // Supply them explicitly so the URL is deterministic in tests.
          const webhookUrl = 'https://test.example.com/hooks/sms/twilio';
          const rawPayload = 'From=%2B15551111111&Body=HELP';
          const params: Record<string, string> = {};
          new URLSearchParams(rawPayload).forEach((v, k) => {
            params[k] = v;
          });
          const signature = computeSignature(TEST_AUTH_TOKEN, webhookUrl, params);
          const res = await server.inject({
            method: 'POST',
            url: '/hooks/sms/twilio',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'x-forwarded-proto': 'https',
              'x-forwarded-host': 'test.example.com',
              'x-twilio-signature': signature,
            },
            payload: rawPayload,
          });
          // A valid signature with HELP → 200 with TwiML
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toContain('text/xml');
        },
      );
    } finally {
      if (prevToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
      else process.env.TWILIO_AUTH_TOKEN = prevToken;
      if (prevSid === undefined) delete process.env.TWILIO_ACCOUNT_SID;
      else process.env.TWILIO_ACCOUNT_SID = prevSid;
      if (prevFrom === undefined) delete process.env.TWILIO_FROM_NUMBER;
      else process.env.TWILIO_FROM_NUMBER = prevFrom;
    }
  });
});

// ── Gap 4: SMS routes registered on the data plane ───────────────────────────────────────────

describe('Gap 4: registerSmsRoutes exported and callable', () => {
  it('registerSmsRoutes can be called and mounts /auth/phone/send-code and /auth/phone/verify-code', async () => {
    await withServer(
      (s) => registerSmsRoutes(s, { defaultApp: () => APP }),
      async (server) => {
        // /auth/phone/send-code must exist (422 = route found but missing body params)
        const res = await server.inject({
          method: 'POST',
          url: '/auth/phone/send-code',
          payload: {},
        });
        expect(res.statusCode).toBe(422);

        // /auth/phone/verify-code must exist
        const res2 = await server.inject({
          method: 'POST',
          url: '/auth/phone/verify-code',
          payload: {},
        });
        expect(res2.statusCode).toBe(422);
      },
    );
  });
});
