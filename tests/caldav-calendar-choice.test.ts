import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { store } from '../src/storage/store';
import { getBackends } from '../src/storage/backends';
import { registerConnectRoutes } from '../src/api/connect-routes';
import { setSecret, sealValue } from '../src/plugins/secrets-local/index';
import { setCalDavClient, resetCalDavClient, type CalDavWrite } from '../src/caldav';

// The CHOICE half of the 2026-08-26 incident fix. resolveWriteTarget (see
// caldav-create-resolves-calendar.test.ts) makes an unaddressed create resolvable; THIS file pins
// the never-fallback contract around it (Mark's law):
//   - the wizard picker's choice is PERSISTED (PUT /connect/:provider/calendar) and used with no
//     discovery round trip and no drift;
//   - a discovered resolution is persisted ONCE, so existing connections self-heal and the round
//     trip never repeats.

const APP_ID = 'caldav-choice-app';
const SERVICE_TOKEN = 'svc-token-value';
const PASSWORD = 'abcd-efgh-ijkl-mnop';
const HOME = 'https://p161-caldav.icloud.com/1/calendars/home/';
const WORK = 'https://p161-caldav.icloud.com/1/calendars/work/';

let server: FastifyInstance;
let dir: string;
let prevDir: string | undefined;
let prevKey: string | undefined;

const CREATE_NO_CAL: CalDavWrite = {
  kind: 'create',
  event: {
    uid: 'dorinda-evt-9',
    summary: 'Dentist',
    start: '2026-08-27T15:00:00.000Z',
    end: '2026-08-27T16:00:00.000Z',
  },
};

async function seedConnection(calendarUrl?: string) {
  const b = (await getBackends()).connections;
  await b.putConnection(APP_ID, {
    auth_kind: 'basic',
    owner: 'u1',
    provider: 'apple',
    username: 'daria@icloud.example',
    password_sealed: await sealValue(PASSWORD),
    scopes: [],
    status: 'connected',
    account_label: 'daria@icloud.example',
    connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...(calendarUrl ? { calendar_url: calendarUrl } : {}),
  } as never);
}

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevKey = process.env.FORGE_SECRETS_KEY;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-caldav-choice-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_SECRETS_KEY = 'caldav-choice-test-key';
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

const putCal = (body: unknown) =>
  server.inject({
    method: 'PUT',
    url: '/connect/apple/calendar',
    headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
    payload: body as never,
  });

describe('stored choice — used without discovery, never drifting', () => {
  it('PUT persists the choice; the next unaddressed create writes THERE, no listCalendars call', async () => {
    await seedConnection();
    expect((await putCal({ owner: 'u1', calendarUrl: WORK })).statusCode).toBe(200);
    let listed = 0;
    let sawUrl: string | undefined;
    setCalDavClient({
      probe: async () => ({ ok: false, reason: 'unreachable' }),
      listCalendars: async () => {
        listed++;
        return { ok: true, calendars: [] };
      },
      writeEvent: async (_c, w) => {
        sawUrl = (w as { calendarUrl: string }).calendarUrl;
        return { ok: true, href: `${WORK}dorinda-evt-9.ics` };
      },
    });
    const res = await post({ owner: 'u1', write: CREATE_NO_CAL });
    expect(res.statusCode).toBe(200);
    expect(listed).toBe(0);
    expect(sawUrl).toBe(WORK);
  });

  it('a DISCOVERED resolution is persisted once — the second write skips discovery', async () => {
    await seedConnection();
    let listed = 0;
    setCalDavClient({
      probe: async () => ({ ok: false, reason: 'unreachable' }),
      listCalendars: async () => {
        listed++;
        return {
          ok: true,
          calendars: [
            {
              url: HOME,
              displayName: 'Home',
              readOnly: false,
              syncCollection: 'advertised' as const,
            },
          ],
        };
      },
      writeEvent: async () => ({ ok: true, href: `${HOME}dorinda-evt-9.ics` }),
    });
    expect((await post({ owner: 'u1', write: CREATE_NO_CAL })).statusCode).toBe(200);
    expect(listed).toBe(1);
    const b = (await getBackends()).connections;
    const conn = (await b.getConnection(APP_ID, 'u1', 'apple')) as { calendar_url?: string } | null;
    expect(conn?.calendar_url).toBe(HOME);
    expect((await post({ owner: 'u1', write: CREATE_NO_CAL })).statusCode).toBe(200);
    expect(listed).toBe(1); // still one — the resolution was persisted
  });

  it('refuses a relative or missing calendarUrl, without auth, and without owner on a service call', async () => {
    await seedConnection();
    expect((await putCal({ owner: 'u1', calendarUrl: '/1/calendars/home/' })).statusCode).toBe(422);
    expect((await putCal({ owner: 'u1' })).statusCode).toBe(422);
    const noAuth = await server.inject({
      method: 'PUT',
      url: '/connect/apple/calendar',
      payload: { calendarUrl: WORK } as never,
    });
    expect(noAuth.statusCode).toBe(401);
    expect((await putCal({ calendarUrl: WORK })).statusCode).toBe(422);
  });
});
