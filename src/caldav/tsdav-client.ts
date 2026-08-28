import { DAVClient } from 'tsdav';
import type {
  CalDavClient,
  CalDavListResult,
  CalDavCredentials,
  CalDavProbe,
  CalDavCalendar,
  CalDavWrite,
  CalDavWriteResult,
} from './types';
import { eventToIcs, icsHref } from './ical';

// The `tsdav`-backed implementation of the internal CalDAV surface. The ONLY file in the repo that
// imports tsdav — see ./types.ts for why that boundary exists.

// iCloud answers a wrong-credential Basic auth with a bare 401 and no useful body. Anything else —
// DNS failure, TLS error, timeout, 5xx — is us failing to ask, not the credential failing to work.
// Classifying these apart is the whole reason `probe` does not return a boolean.
function classify(e: unknown): { reason: 'invalid_credentials' | 'unreachable'; detail: string } {
  const msg = String((e as Error)?.message ?? e);
  // tsdav surfaces the HTTP status in the message for auth failures.
  if (/\b401\b|unauthor/i.test(msg)) return { reason: 'invalid_credentials', detail: msg };
  if (/\b403\b/.test(msg)) return { reason: 'invalid_credentials', detail: msg };
  return { reason: 'unreachable', detail: msg };
}

// Write failures carry statuses the read path never sees. 404 on an update/delete means the object is
// gone (someone deleted it on another device); 412 means our etag is stale — a genuine conflict, not a
// transport problem, and NOT something to retry blindly over. 403 on a write is read-only far more
// often than it is bad credentials, which is why writes classify it differently from reads.
function classifyWrite(status: number | undefined, msg: string): CalDavWriteResult & { ok: false } {
  if (status === 401) return { ok: false, reason: 'invalid_credentials', detail: msg };
  if (status === 403) return { ok: false, reason: 'read_only', detail: msg };
  if (status === 404 || status === 410) return { ok: false, reason: 'not_found', detail: msg };
  if (status === 409 || status === 412) return { ok: false, reason: 'conflict', detail: msg };
  return { ok: false, reason: 'unreachable', detail: msg };
}

function statusFrom(e: unknown): number | undefined {
  const anyE = e as { status?: number; statusCode?: number; message?: string };
  if (typeof anyE?.status === 'number') return anyE.status;
  if (typeof anyE?.statusCode === 'number') return anyE.statusCode;
  const m = /\b(4\d\d|5\d\d)\b/.exec(String(anyE?.message ?? e));
  return m ? Number(m[1]) : undefined;
}

// A subscribed or otherwise non-writable collection must be reported read-only. iCloud expresses this
// through the supported privilege set / resource type; tsdav normalises some of it, but a calendar whose
// component set does not include VEVENT is not somewhere we can put an event either.
// RFC 6578's report name, as it reaches us AFTER the library has parsed it.
//
// ⛔ THE SPELLING IS NOT THE WIRE SPELLING, and assuming it was produced a false 'absent' against the
// real iCloud account on 2026-08-24. The server advertises `<sync-collection/>`; tsdav normalises the
// supported-report-set to camelCase, so what actually arrives is:
//   ["aclPrincipalPropSet","principalMatch","principalPropertySearch","syncCollection",
//    "calendarQuery","calendarMultiget","freeBusyQuery","calendarSearch"]
// A /sync-collection/i test never matches "syncCollection", so every collection on a server that
// fully supports it was reported as NOT supporting it.
//
// The unit tests passed throughout, because they fed the WIRE spelling — a format I invented rather
// than observed. That is the whole HAT-F-065 shape a second time: the three-state model exists to
// stop us manufacturing an observation, and the classifier manufactured one. Only the live probe
// could see it, which is why C4 runs before any acceptance bar leans on CalDAV.
//
// Normalising both sides (strip non-alphanumerics, casefold) matches the wire form, the camelCase
// form, and any namespace-prefixed spelling, so the check no longer depends on which layer we read.
const normalizeReportName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function syncCollectionSupport(reports: unknown): CalDavCalendar['syncCollection'] {
  // Absent/unusable advert => we did not observe it. NOT 'absent'.
  if (reports === undefined || reports === null) return 'unknown';
  const flat = Array.isArray(reports) ? reports.map((r) => String(r)) : [String(reports)];
  if (flat.length === 0) return 'unknown';
  return flat.some((r) => normalizeReportName(r).includes('synccollection')) ? 'advertised' : 'absent';
}

function toCalendar(c: {
  url: string;
  displayName?: unknown;
  ctag?: unknown;
  components?: unknown;
  resourcetype?: unknown;
  reports?: unknown;
}): CalDavCalendar {
  const components = Array.isArray(c.components) ? (c.components as string[]) : [];
  const resourcetypes = Array.isArray(c.resourcetype) ? c.resourcetype.map((r) => String(r)) : [];
  const subscribed = resourcetypes.some((r) => /subscribed/i.test(r));

  // ⛔ RFC 6638 SCHEDULING COLLECTIONS ARE NEVER A PLACE TO PUT AN EVENT.
  //
  // `schedule-inbox`, `schedule-outbox` and `notification` are the mailboxes iCloud uses to deliver
  // and queue invitations. They ADVERTISE VEVENT — that is their whole purpose — so the component
  // check below cannot exclude them, and a scheduling inbox looks exactly like a writable calendar.
  //
  // Today tsdav's fetchCalendars happens to drop them (it keeps only `resourcetype` containing
  // `calendar`). That is an upstream accident, not a guarantee we make: types.ts advertises this
  // boundary as deliberately swappable, and connectors/service.ts#resolveWriteTarget picks
  // `writable[0]` — so a scheduling inbox that ever reached the list could RECEIVE A USER'S EVENT.
  // Stated here so the protection survives a client swap. See
  // tests/caldav-scheduling-collections-excluded.test.ts (ACCEPTANCE_TESTING.md AP-5).
  const scheduling = resourcetypes.some((r) => /schedule-inbox|schedule-outbox|notification/i.test(r));
  const name = typeof c.displayName === 'string' && c.displayName.trim() ? c.displayName.trim() : c.url;
  return {
    url: c.url,
    displayName: name,
    readOnly: scheduling || subscribed || (components.length > 0 && !components.includes('VEVENT')),
    syncCollection: syncCollectionSupport(c.reports),
    ...(typeof c.ctag === 'string' ? { ctag: c.ctag } : {}),
  };
}

/** Test seam: {@link toCalendar} is pure mapping, and AP-5's exclusions are asserted against it. */
export const toCalendarForTest = toCalendar;

async function davClientFor(creds: CalDavCredentials): Promise<DAVClient> {
  const client = new DAVClient({
    serverUrl: creds.serverUrl,
    credentials: { username: creds.username, password: creds.password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
  await client.login();
  return client;
}

export { syncCollectionSupport, toCalendar };

export const tsdavCalDavClient: CalDavClient = {
  async probe(creds: CalDavCredentials): Promise<CalDavProbe> {
    try {
      // The class form (not createDAVClient) because we need the resolved ACCOUNT — its principalUrl
      // and calendar-home-set — and the functional form binds those internally without exposing them.
      const client = new DAVClient({
        serverUrl: creds.serverUrl,
        credentials: { username: creds.username, password: creds.password },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      });
      await client.login();

      // Discovery has ALREADY followed the partition redirect by this point — the account's
      // homeUrl is typically on pNN-caldav.icloud.com rather than the discovery root. Carrying
      // those URLs forward (never rebuilding them from serverUrl) is what makes later calls land.
      const account = client.account;
      if (!account?.homeUrl) {
        return {
          ok: false,
          reason: 'unreachable',
          detail: 'discovery returned no calendar-home-set',
        };
      }

      const calendars = await client.fetchCalendars();
      return {
        ok: true,
        principal: {
          principalUrl: account.principalUrl ?? '',
          calendarHomeUrl: account.homeUrl,
        },
        calendars: calendars.map((c) => toCalendar(c as Parameters<typeof toCalendar>[0])),
      };
    } catch (e) {
      const { reason, detail } = classify(e);
      return { ok: false, reason, detail };
    }
  },

  async listCalendars(creds: CalDavCredentials): Promise<CalDavListResult> {
    try {
      const client = await davClientFor(creds);
      const calendars = await client.fetchCalendars();
      return { ok: true, calendars: calendars.map((c) => toCalendar(c as Parameters<typeof toCalendar>[0])) };
    } catch (e) {
      const { reason, detail } = classify(e);
      return { ok: false, reason, detail };
    }
  },

  // ⛔ THE SINGLE WRITE PATH — all three verbs, one function, one transport.
  //
  // Every branch below performs its provider call SYNCHRONOUSLY and returns a definite outcome. There
  // is no queue, no sweep, no "we'll retry later" for any kind. That symmetry is the entire point:
  // HAT-F-081 and W-022 are the same defect on two providers, both created by a create path that wrote
  // through while update/delete were deferred. Anyone tempted to defer one kind has to do it inside
  // this function, in plain sight, and tests/caldav-write-symmetry.test.ts fails the moment they do.
  async writeEvent(creds: CalDavCredentials, write: CalDavWrite): Promise<CalDavWriteResult> {
    try {
      const client = await davClientFor(creds);

      if (write.kind === 'delete') {
        const res = await client.deleteObject({
          url: write.href,
          ...(write.etag ? { etag: write.etag } : {}),
        });
        if (!res.ok) return classifyWrite(res.status, res.statusText ?? 'delete rejected');
        return { ok: true, href: write.href };
      }

      const ics = eventToIcs(write.event);

      if (write.kind === 'create') {
        // Belt and braces with service.ts#resolveWriteTarget, which addresses every create before
        // it gets here. If one ever arrives unaddressed that is an upstream programming error, and
        // the honest answer is a typed refusal — NOT a guessed URL, and not the relative href this
        // line produced in production.
        if (!write.calendarUrl) {
          return {
            ok: false,
            reason: 'no_writable_calendar',
            detail: 'create reached the transport with no calendarUrl — it was never addressed',
          };
        }
        const href = icsHref(write.calendarUrl, write.event.uid);
        const res = await client.createObject({
          url: href,
          data: ics,
          headers: { 'content-type': 'text/calendar; charset=utf-8' },
        });
        if (!res.ok) return classifyWrite(res.status, res.statusText ?? 'create rejected');
        return { ok: true, href, ...(etagOf(res) ? { etag: etagOf(res)! } : {}) };
      }

      const res = await client.updateObject({
        url: write.href,
        data: ics,
        headers: {
          'content-type': 'text/calendar; charset=utf-8',
          ...(write.etag ? { 'if-match': write.etag } : {}),
        },
      });
      if (!res.ok) return classifyWrite(res.status, res.statusText ?? 'update rejected');
      return { ok: true, href: write.href, ...(etagOf(res) ? { etag: etagOf(res)! } : {}) };
    } catch (e) {
      return classifyWrite(statusFrom(e), String((e as Error)?.message ?? e));
    }
  },
};

function etagOf(res: { headers?: Headers | Record<string, string> }): string | undefined {
  const h = res.headers;
  if (!h) return undefined;
  const v =
    typeof (h as Headers).get === 'function'
      ? (h as Headers).get('etag')
      : (h as Record<string, string>)['etag'];
  return v ?? undefined;
}
