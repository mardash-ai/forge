import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { toCalendarForTest } from '../src/caldav/tsdav-client';

// ⛔ AP-5's SECOND HALF, MADE OURS.
//
// ACCEPTANCE_TESTING.md §5a-Apple AP-5 requires that iCloud's scheduling collections —
// `schedule-inbox`, `schedule-outbox`, `notification` (RFC 6638) — are **never offered** as
// calendars a user or a write can land on. Until now that held for exactly one reason: tsdav's
// `fetchCalendars` keeps only collections whose `resourcetype` includes `calendar`, and the
// scheduling collections carry `schedule-inbox` / `schedule-outbox` instead.
//
// That is an UPSTREAM ACCIDENT, not a guarantee we make:
//   - `src/caldav/` contained no mention of scheduling collections at all;
//   - `types.ts` advertises the tsdav boundary as deliberately swappable ("the ONLY file in the
//     repo that imports tsdav … so the library is swappable"), so replacing it silently removes
//     the protection;
//   - and `connectors/service.ts#resolveWriteTarget` picks `writable[0]`, so a scheduling inbox
//     that ever reached the list could RECEIVE AN UNADDRESSED CREATE — a user's event filed into
//     the mailbox iCloud uses to deliver invitations.
//
// The exclusion is now stated here, in our code, and asserted. A future client swap fails this
// test instead of quietly filing events into an inbox.

const SRC = readFileSync(path.join(__dirname, '../src/caldav/tsdav-client.ts'), 'utf8');

const cal = (resourcetype: string[], components = ['VEVENT']) =>
  toCalendarForTest({
    url: `https://p42-caldav.icloud.com/1/${resourcetype[0]}/`,
    displayName: resourcetype[0],
    components,
    resourcetype,
  });

describe('CalDAV scheduling collections are never offered as writable calendars', () => {
  // These advertise VEVENT — that is precisely why the component check alone does not exclude them.
  for (const rt of ['schedule-inbox', 'schedule-outbox', 'notification']) {
    it(`${rt} is not writable, even though it advertises VEVENT`, () => {
      const c = cal([rt, 'collection']);
      expect(c.readOnly, `${rt} must never be writable`).toBe(true);
    });
  }

  it('an ordinary calendar collection is still writable', () => {
    expect(cal(['calendar', 'collection']).readOnly).toBe(false);
  });

  it('subscribed and non-VEVENT collections remain excluded (no regression)', () => {
    expect(cal(['calendar', 'subscribed']).readOnly).toBe(true);
    expect(cal(['calendar'], ['VTODO']).readOnly).toBe(true); // Reminders — AP-5's first half
  });

  it('⛔ the exclusion lives in OUR source, not in the library', () => {
    // If this ever passes only because tsdav filters upstream, the guarantee is not ours to keep.
    expect(SRC).toMatch(/schedule-inbox|scheduling/i);
  });
});
