import { describe, it, expect } from 'vitest';
import { syncCollectionSupport, toCalendar } from '../src/caldav/tsdav-client';

// ⛔ "NOT ADVERTISED" AND "WE NEVER LOOKED" ARE DIFFERENT FACTS.
//
// RFC 6578 requires a server implementing the sync-collection REPORT to advertise it in
// DAV:supported-report-set, so the advert IS the check (Apple plan §5). Whether iCloud advertises it
// on every collection type — shared and subscribed calendars especially — is genuinely unknown, which
// is why the answer is recorded PER CALENDAR rather than per account.
//
// Modelling it as a boolean would force the absent-advert case to become `false`, manufacturing an
// observation out of a missing one. That is the HAT-F-065 defect verbatim: forge-hat's missing
// Anthropic extractor graded against hardcoded defaults and reported product rejections it had never
// observed, and four paid live runs were spent before anyone saw it. Both `absent` and `unknown` route
// to the same ctag fallback, so behaviour is identical either way — what differs is whether a future
// claim of "iCloud does not support sync-collection" is evidence or a guess.

describe('sync-collection capability — recorded, never assumed', () => {
  it('advertised: the report set names sync-collection', () => {
    expect(syncCollectionSupport(['sync-collection', 'calendar-query'])).toBe('advertised');
    // namespace-prefixed spellings vary by server; match the local name
    expect(syncCollectionSupport(['{DAV:}sync-collection'])).toBe('advertised');
    expect(syncCollectionSupport(['d:sync-collection'])).toBe('advertised');
  });

  it('absent: the server DID advertise a report set, and sync-collection is not in it', () => {
    expect(syncCollectionSupport(['calendar-query', 'calendar-multiget'])).toBe('absent');
  });

  it('⛔ unknown: no advert was read — NEVER reported as absent', () => {
    expect(syncCollectionSupport(undefined)).toBe('unknown');
    expect(syncCollectionSupport(null)).toBe('unknown');
    expect(syncCollectionSupport([])).toBe('unknown');
  });

  it('a calendar carries its OWN answer — the capability is per collection, not per account', () => {
    const home = toCalendar({
      url: 'https://p1/cal/home/',
      displayName: 'Home',
      reports: ['sync-collection'],
    });
    const shared = toCalendar({
      url: 'https://p1/cal/shared/',
      displayName: 'Shared',
      reports: ['calendar-query'],
    });
    const unread = toCalendar({ url: 'https://p1/cal/sub/', displayName: 'Sub' });
    expect(home.syncCollection).toBe('advertised');
    expect(shared.syncCollection).toBe('absent');
    expect(unread.syncCollection).toBe('unknown');
    // Three calendars on ONE account with three different answers — which is the whole point.
    expect(new Set([home, shared, unread].map((c) => c.syncCollection)).size).toBe(3);
  });

  it('a subscribed calendar is read-only regardless of anything else', () => {
    const sub = toCalendar({
      url: 'https://p1/cal/sub/',
      displayName: 'Holidays',
      resourcetype: ['collection', 'subscribed'],
      reports: ['sync-collection'],
    });
    expect(sub.readOnly).toBe(true);
  });

  it('a collection that does not hold VEVENTs is not somewhere an event can be written', () => {
    const tasks = toCalendar({
      url: 'https://p1/cal/tasks/',
      displayName: 'Reminders',
      components: ['VTODO'],
    });
    expect(tasks.readOnly).toBe(true);
  });

  it('falls back to the URL when the server gives no display name (never blank in a picker)', () => {
    expect(toCalendar({ url: 'https://p1/cal/x/' }).displayName).toBe('https://p1/cal/x/');
    expect(toCalendar({ url: 'https://p1/cal/x/', displayName: '   ' }).displayName).toBe(
      'https://p1/cal/x/',
    );
  });
});
