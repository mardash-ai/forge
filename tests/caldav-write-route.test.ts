import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { store } from '../src/storage/store';
import { getBackends } from '../src/storage/backends';
import { registerConnectRoutes } from '../src/api/connect-routes';
import { setSecret, sealValue } from '../src/plugins/secrets-local/index';
import { setCalDavClient, resetCalDavClient, type CalDavWrite } from '../src/caldav';

// ⛔ THE CREDENTIAL NEVER LEAVES THIS TIER.
//
// Google/Microsoft hand the consuming app a bearer token via /connect/:provider/token — scoped,
// expiring, revocable at the provider. A basic-auth credential is a PASSWORD: unscoped, non-expiring,
// and revocable only by the user going to Apple. Brokering it outward to save one hop would put a
// long-lived account credential on the wire and into a second service's memory and logs.
//
// So the write happens HERE, and these tests assert the property rather than trusting the intent.

const APP_ID = 'caldav-write-app';
const SERVICE_TOKEN = 'svc-token-value';
const PASSWORD = 'abcd-efgh-ijkl-mnop';

let server: FastifyInstance;
let dir: string;
let prevDir: string | undefined;
let prevKey: string | undefined;

const WRITE: CalDavWrite = {
  kind: 'create',
  calendarUrl: 'https://p1-caldav.icloud.com/1/cal/',
  event: {
    uid: 'evt-1',
    summary: 'Dentist',
    start: '2026-08-25T15:00:00.000Z',
    end: '2026-08-25T16:00:00.000Z',
  },
};

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevKey = process.env.FORGE_SECRETS_KEY;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-caldav-write-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_SECRETS_KEY = 'caldav-write-test-key';
  await store.init();
  const now = new Date().toISOString();
  await store.saveResource({
    id: APP_ID,
    type: 'Application',
    app_id: APP_ID,
    created_at: now,
    updated_at: now,
    name: APP_ID,
    repo_path: '/app',
    platform: 'web',
    framework: 'nextjs',
    template: 'nextjs-web',
    language: 'typescript',
    package_manager: 'npm',
  } as never);
  await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', SERVICE_TOKEN);
  const b = (await getBackends()).connections;
  await b.putConnection(APP_ID, {
    auth_kind: 'basic',
    owner: 'u1',
    provider: 'apple',
    username: 'dorinda-test@mardash.ai',
    password_sealed: await sealValue(PASSWORD),
    scopes: [],
    status: 'connected',
    account_label: 'dorinda-test@mardash.ai',
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  server = Fastify();
  registerConnectRoutes(server, { defaultApp: () => APP_ID });
  await server.ready();
});

afterEach(async () => {
  resetCalDavClient();
  await server.close();
  process.env.FORGE_STATE_DIR = prevDir;
  process.env.FORGE_SECRETS_KEY = prevKey;
  await rm(dir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  server.inject({
    method: 'POST',
    url: '/connect/apple/calendar/write',
    headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    payload: body as never,
  });

describe('POST /connect/:provider/calendar/write', () => {
  it('unseals the stored credential and hands it to the CalDAV client — never to the caller', async () => {
    let sawPassword: string | undefined;
    setCalDavClient({
      probe: async () => ({ ok: false, reason: 'unreachable' }),
      listCalendars: async () => ({ ok: false, reason: 'unreachable' }),
      writeEvent: async (creds) => {
        sawPassword = creds.password;
        return { ok: true, href: 'https://p1-caldav.icloud.com/1/cal/evt-1.ics' };
      },
    });
    const res = await post({ owner: 'u1', write: WRITE });
    expect(res.statusCode).toBe(200);
    // The client got the real credential…
    expect(sawPassword).toBe(PASSWORD);
    // …and the response body carries no trace of it.
    expect(res.payload).not.toContain(PASSWORD);
    expect(res.json()).toEqual({ ok: true, href: 'https://p1-caldav.icloud.com/1/cal/evt-1.ics' });
  });

  it('⛔ NO route anywhere reveals a stored credential', () => {
    const src = readFileSync(path.join(__dirname, '../src/api/connect-routes.ts'), 'utf8');
    // A reveal/export endpoint is the shortcut this design exists to refuse.
    expect(src).not.toMatch(/\/credentials\/reveal/);
    expect(src).not.toMatch(/password_sealed/);
    expect(src).not.toMatch(/openValue\s*\(/);
  });

  it('a failed write is relayed as failed — never as success', async () => {
    setCalDavClient({
      probe: async () => ({ ok: false, reason: 'unreachable' }),
      listCalendars: async () => ({ ok: false, reason: 'unreachable' }),
      writeEvent: async () => ({ ok: false, reason: 'read_only', detail: 'subscribed calendar' }),
    });
    const res = await post({ owner: 'u1', write: WRITE });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ ok: false, reason: 'read_only' });
  });

  it('refuses without a service token, and refuses a service token with no owner', async () => {
    setCalDavClient({
      probe: async () => ({ ok: false, reason: 'unreachable' }),
      listCalendars: async () => ({ ok: false, reason: 'unreachable' }),
      writeEvent: async () => ({ ok: true, href: 'x' }),
    });
    const anon = await server.inject({
      method: 'POST',
      url: '/connect/apple/calendar/write',
      payload: { owner: 'u1', write: WRITE },
    });
    expect(anon.statusCode).toBe(401);
    expect((await post({ write: WRITE })).statusCode).toBe(422);
  });

  it('an OAUTH provider on this path is wrong_auth_kind (it has /token instead)', async () => {
    // Provision Google's client creds first: without them the provider resolves as NOT CONFIGURED and
    // answers 503 before the auth_kind check is ever reached — the test would pass on the wrong error.
    await setSecret(APP_ID, 'GOOGLE_CONNECT_CLIENT_ID', 'id');
    await setSecret(APP_ID, 'GOOGLE_CONNECT_CLIENT_SECRET', 'secret');
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/calendar/write',
      headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
      payload: { owner: 'u1', write: WRITE },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('wrong_auth_kind');
  });

  it('a user with no connection gets not-connected, not a crash', async () => {
    const res = await post({ owner: 'nobody', write: WRITE });
    expect(res.statusCode).toBe(404);
  });

  it('requires a write with a kind', async () => {
    expect((await post({ owner: 'u1' })).statusCode).toBe(422);
    expect((await post({ owner: 'u1', write: {} })).statusCode).toBe(422);
  });
});
