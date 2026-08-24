import { DAVClient } from 'tsdav';
import type { CalDavClient, CalDavCredentials, CalDavProbe, CalDavCalendar } from './types';

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

// A subscribed or otherwise non-writable collection must be reported read-only. iCloud expresses this
// through the supported privilege set / resource type; tsdav normalises some of it, but a calendar whose
// component set does not include VEVENT is not somewhere we can put an event either.
function toCalendar(c: {
  url: string;
  displayName?: unknown;
  ctag?: unknown;
  components?: unknown;
  resourcetype?: unknown;
}): CalDavCalendar {
  const components = Array.isArray(c.components) ? (c.components as string[]) : [];
  const subscribed =
    Array.isArray(c.resourcetype) && c.resourcetype.some((r) => /subscribed/i.test(String(r)));
  const name = typeof c.displayName === 'string' && c.displayName.trim() ? c.displayName.trim() : c.url;
  return {
    url: c.url,
    displayName: name,
    readOnly: subscribed || (components.length > 0 && !components.includes('VEVENT')),
    ...(typeof c.ctag === 'string' ? { ctag: c.ctag } : {}),
  };
}

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
};
