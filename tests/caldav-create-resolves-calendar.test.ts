import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { store } from '../src/storage/store';
import { getBackends } from '../src/storage/backends';
import { registerConnectRoutes } from '../src/api/connect-routes';
import { setSecret, sealValue } from '../src/plugins/secrets-local/index';
import { setCalDavClient, resetCalDavClient } from '../src/caldav';
import type { CalDavCalendar, CalDavWrite } from '../src/caldav/types';
import { icsHref } from '../src/caldav/ical';

// ⛔ THE DEFECT THIS FILE EXISTS FOR — it reached a real user in production.
//
// dorinda-api sent `calendarUrl: ""` on every Apple create, under a source comment asserting
// "the calendar is chosen by forge from the connection's discovered home when omitted."
// Forge did no such thing: it passed the empty string to icsHref(), which cheerfully produced
// the RELATIVE href "/dorinda-<uid>.ics". tsdav then failed to parse it as a URL, the write
// 502'd with reason `unreachable`, and the user was told Apple Calendar could not be reached —
// a network story for what was in fact a contract defect two repos wide.
//
// Both sides were internally consistent and fully green. The emitter's tests asserted it sent a
// create; the receiver's tests always supplied a real calendarUrl (see caldav-write-route.test.ts,
// where every fixture is 'https://p1-caldav.icloud.com/1/cal/'). Nothing in either suite could
// ever have evaluated the PAIR. That is estate guardrail #5, and this file is the missing pair
// assertion: forge must make the emitter's comment TRUE, and must refuse to invent a relative
// href if it ever cannot.

const APP_ID = 'caldav-resolve-app';
const SERVICE_TOKEN = 'svc-token-value';
const PASSWORD = 'abcd-efgh-ijkl-mnop';

const EVENT = {
  uid: 'dorinda-b6245585',
  summary: 'Dentist appointment',
  start: '2026-08-27T19:00:00.000Z',
  end: '2026-08-27T20:00:00.000Z',
};

// A create with NO calendarUrl — exactly what dorinda-api means to send.
const CREATE_UNADDRESSED = { kind: 'create', event: EVENT } as unknown as CalDavWrite;

const cal = (over: Partial<CalDavCalendar> & { url: string }): CalDavCalendar => ({
  displayName: over.url,
  readOnly: false,
  syncCollection: 'unknown',
  ...over,
});

let server: FastifyInstance;
let dir: string;
let prevDir: string | undefined;
let prevKey: string | undefined;

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevKey = process.env.FORGE_SECRETS_KEY;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-caldav-resolve-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_SECRETS_KEY = 'caldav-resolve-test-key';
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
    connected_at: now,
    updated_at: now,
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

describe('icsHref refuses to invent a relative object path', () => {
  // THE precise line that produced "/dorinda-b6245585-....ics" in production.
  it('throws on an empty base rather than returning a root-relative href', () => {
    expect(() => icsHref('', 'evt-1')).toThrow();
  });

  it('throws on any non-absolute base', () => {
    for (const bad of ['/1/cal/', 'cal/', '   ', '//p1-caldav.icloud.com/1/cal/']) {
      expect(() => icsHref(bad, 'evt-1')).toThrow();
    }
  });

  it('still builds a normal href from an absolute collection URL', () => {
    expect(icsHref('https://p1-caldav.icloud.com/1/cal/', 'evt-1')).toBe(
      'https://p1-caldav.icloud.com/1/cal/evt-1.ics',
    );
    // A missing trailing slash is the caller's business, not a reason to fail.
    expect(icsHref('https://p1-caldav.icloud.com/1/cal', 'evt-1')).toBe(
      'https://p1-caldav.icloud.com/1/cal/evt-1.ics',
    );
  });
});

describe('a create with no calendarUrl is ADDRESSED by forge, not passed through empty', () => {
  it('resolves the discovered calendar home and writes there', async () => {
    let sawUrl: string | undefined;
    setCalDavClient({
      probe: async () => ({ ok: false, reason: 'unreachable' }),
      listCalendars: async () => ({
        ok: true,
        calendars: [cal({ url: 'https://p42-caldav.icloud.com/1/calendars/home/', displayName: 'Home' })],
      }),
      writeEvent: async (_creds, write) => {
        sawUrl = (write as { calendarUrl?: string }).calendarUrl;
        return { ok: true, href: `${sawUrl}${EVENT.uid}.ics` };
      },
    });
    const res = await post({ owner: 'u1', write: CREATE_UNADDRESSED });
    expect(res.statusCode).toBe(200);
    // The write must carry a real, ABSOLUTE, partition-host collection URL.
    expect(sawUrl).toBe('https://p42-caldav.icloud.com/1/calendars/home/');
    expect(res.json().href).toMatch(/^https:\/\/p42-caldav\.icloud\.com\//);
  });

  it('never chooses a read-only collection — Reminders (VTODO) and subscribed calendars are ineligible', async () => {
    let sawUrl: string | undefined;
    setCalDavClient({
      probe: async () => ({ ok: false, reason: 'unreachable' }),
      listCalendars: async () => ({
        ok: true,
        calendars: [
          // toCalendar() marks a non-VEVENT collection read-only, which is how Reminders lands here.
          cal({
            url: 'https://p42-caldav.icloud.com/1/calendars/reminders/',
            displayName: 'Reminders',
            readOnly: true,
          }),
          cal({
            url: 'https://p42-caldav.icloud.com/1/calendars/holidays/',
            displayName: 'US Holidays',
            readOnly: true,
          }),
          cal({ url: 'https://p42-caldav.icloud.com/1/calendars/home/', displayName: 'Home' }),
        ],
      }),
      writeEvent: async (_creds, write) => {
        sawUrl = (write as { calendarUrl?: string }).calendarUrl;
        return { ok: true, href: 'x' };
      },
    });
    expect((await post({ owner: 'u1', write: CREATE_UNADDRESSED })).statusCode).toBe(200);
    expect(sawUrl).toBe('https://p42-caldav.icloud.com/1/calendars/home/');
  });

  it('⛔ reports a TYPED failure when nothing writable exists — never `unreachable`, and never a write', async () => {
    let wrote = false;
    setCalDavClient({
      probe: async () => ({ ok: false, reason: 'unreachable' }),
      listCalendars: async () => ({
        ok: true,
        calendars: [cal({ url: 'https://p42-caldav.icloud.com/1/calendars/holidays/', readOnly: true })],
      }),
      writeEvent: async () => {
        wrote = true;
        return { ok: true, href: 'x' };
      },
    });
    const res = await post({ owner: 'u1', write: CREATE_UNADDRESSED });
    expect(res.statusCode).toBe(502);
    // "we could not reach Apple" is a NETWORK claim. This is an account fact, and saying the wrong
    // one is what sent the production investigation looking for a connectivity problem.
    expect(res.json().reason).toBe('no_writable_calendar');
    expect(res.json().reason).not.toBe('unreachable');
    expect(wrote).toBe(false);
  });

  it('relays a discovery failure honestly instead of guessing a calendar', async () => {
    setCalDavClient({
      probe: async () => ({ ok: false, reason: 'unreachable' }),
      listCalendars: async () => ({ ok: false, reason: 'invalid_credentials', detail: '401' }),
      writeEvent: async () => ({ ok: true, href: 'x' }),
    });
    const res = await post({ owner: 'u1', write: CREATE_UNADDRESSED });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ ok: false, reason: 'invalid_credentials' });
  });

  it('an explicitly addressed create is untouched, and costs no discovery round trip', async () => {
    let listed = 0;
    let sawUrl: string | undefined;
    setCalDavClient({
      probe: async () => ({ ok: false, reason: 'unreachable' }),
      listCalendars: async () => {
        listed += 1;
        return { ok: true, calendars: [cal({ url: 'https://other.icloud.com/x/' })] };
      },
      writeEvent: async (_creds, write) => {
        sawUrl = (write as { calendarUrl?: string }).calendarUrl;
        return { ok: true, href: 'x' };
      },
    });
    const explicit = { kind: 'create', calendarUrl: 'https://p1-caldav.icloud.com/1/cal/', event: EVENT };
    expect((await post({ owner: 'u1', write: explicit })).statusCode).toBe(200);
    expect(sawUrl).toBe('https://p1-caldav.icloud.com/1/cal/');
    expect(listed).toBe(0);
  });
});
