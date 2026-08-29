import { describe, it, expect } from 'vitest';
import { eventToIcs } from '../src/caldav/ical';
import type { CalDavEvent } from '../src/caldav/types';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/*
 * VALARM — the provider-native alarm on a CalDAV event (Option C, Phase 2).
 *
 * GATE: this capability was deliberately NOT built until the Apple leg was proven. On 2026-08-29
 * Mark ran a live probe against dorinda-test@mardash.ai and confirmed BY PIXELS on icloud.com that
 * a CalDAV-written VEVENT carrying `TRIGGER:-PT30M` both round-trips AND renders as an alert on
 * the event. The serialization asserted below is the one that probe validated against real iCloud
 * — not a format inferred from the RFC and hoped to work.
 *
 * Why an alarm on the PROVIDER event and not only in Dorinda: it then fires from the user's own
 * phone and desktop calendar, without Dorinda being awake or reachable.
 */

const base: CalDavEvent = {
  uid: 'evt-1',
  summary: 'Workout',
  start: '2026-08-30T15:00:00.000Z',
  end: '2026-08-30T16:00:00.000Z',
};

const ics = (e: Partial<CalDavEvent>) => eventToIcs({ ...base, ...e }, new Date('2026-08-29T12:00:00Z'));

describe('eventToIcs — VALARM', () => {
  it('emits no VALARM when no alarms are requested', () => {
    expect(ics({})).not.toContain('BEGIN:VALARM');
  });

  it('emits a display alarm at the requested lead', () => {
    const out = ics({ alarmsMinutesBefore: [30] });
    expect(out).toContain('BEGIN:VALARM');
    expect(out).toContain('ACTION:DISPLAY');
    expect(out).toContain('TRIGGER:-PT30M');
    expect(out).toContain('END:VALARM');
  });

  it('nests the alarm INSIDE the VEVENT — an alarm after END:VEVENT is not the event’s alarm', () => {
    const out = ics({ alarmsMinutesBefore: [15] });
    const vevent = out.indexOf('BEGIN:VEVENT');
    const alarm = out.indexOf('BEGIN:VALARM');
    const endEvent = out.indexOf('END:VEVENT');
    expect(vevent).toBeLessThan(alarm);
    expect(alarm).toBeLessThan(endEvent);
  });

  it('emits one VALARM per lead, in ascending order', () => {
    const out = ics({ alarmsMinutesBefore: [1440, 15] });
    expect(out.match(/BEGIN:VALARM/g)).toHaveLength(2);
    expect(out.indexOf('TRIGGER:-PT15M')).toBeLessThan(out.indexOf('TRIGGER:-PT1440M'));
  });

  it('a lead of 0 means AT START, not "15 minutes before zero"', () => {
    const out = ics({ alarmsMinutesBefore: [0] });
    expect(out).toContain('TRIGGER:PT0S');
    expect(out).not.toContain('TRIGGER:-PT0M');
  });

  it('an EXPLICITLY EMPTY alarm list writes no VALARM — the user asked for silence', () => {
    // Distinct from `undefined` only in intent here, but the caller relies on being able to send
    // "no alarms" without it being read as "unset, use a default".
    expect(ics({ alarmsMinutesBefore: [] })).not.toContain('BEGIN:VALARM');
  });

  it('dedupes and drops nonsense rather than emitting a malformed TRIGGER', () => {
    const out = ics({ alarmsMinutesBefore: [30, 30, -5, Number.NaN, 1.5] });
    expect(out.match(/BEGIN:VALARM/g)).toHaveLength(1);
    expect(out).toContain('TRIGGER:-PT30M');
    expect(out).not.toContain('NaN');
  });

  it('the alarm description is the event summary, escaped like every other text value', () => {
    const out = ics({ summary: 'Lunch; with, Bob', alarmsMinutesBefore: [10] });
    expect(out).toContain(String.raw`DESCRIPTION:Lunch\; with\, Bob`);
  });

  it('keeps CRLF line endings inside the alarm block (RFC 5545; some servers reject bare LF)', () => {
    const out = ics({ alarmsMinutesBefore: [30] });
    expect(out).toContain('BEGIN:VALARM\r\n');
    expect(out).toContain('END:VALARM\r\n');
  });
});

/*
 * ── RFC 5545 TEXT escaping ──────────────────────────────────────────────────
 *
 * Found while wiring VALARM: `.replace(/;/g, '\;')` had been in escapeText since the CalDAV
 * capability shipped. In JavaScript '\;' IS ';' — the backslash before a non-escape character is
 * dropped — so that line replaced a semicolon with itself and every event forge ever wrote carried
 * an unescaped semicolon into the ICS. The comment directly above it stated that semicolons were
 * escaped, so the code and its documentation agreed with each other and neither was right.
 */
describe('escapeText — RFC 5545 §3.3.11', () => {
  // String.raw so the expected ICS text is written EXACTLY once, with no JS escape layer between
  // what is asserted and what a CalDAV server receives. Getting that layering wrong is the very
  // bug under test.
  const summaryOf = (summary: string) =>
    eventToIcs({ ...base, summary }, new Date('2026-08-29T12:00:00Z'))
      .split('\r\n')
      .find((l) => l.startsWith('SUMMARY:'));

  it('escapes semicolons (the arm that silently did nothing)', () => {
    expect(summaryOf('Standup; sprint review')).toBe(String.raw`SUMMARY:Standup\; sprint review`);
  });

  it('escapes commas', () => {
    expect(summaryOf('Lunch, then gym')).toBe(String.raw`SUMMARY:Lunch\, then gym`);
  });

  it('escapes backslashes FIRST, so the escapes it adds are not double-escaped', () => {
    expect(summaryOf(String.raw`a\b;c`)).toBe(String.raw`SUMMARY:a\\b\;c`);
  });

  it('escapes all three together', () => {
    expect(summaryOf(String.raw`a;b,c\d`)).toBe(String.raw`SUMMARY:a\;b\,c\\d`);
  });
});

/*
 * ── Reaching the wire ────────────────────────────────────────────────────────
 *
 * eventToIcs is proven directly above, but "the serializer is right" is not "the alarm reaches
 * iCloud". The remaining links are: the HTTP route passes `write` through by cast (no field
 * whitelist), and the client serializes ONE way for every verb. The second is the one worth
 * enforcing — the estate's most-repeated defect is a create path and an update path that diverge,
 * and an alarm that reached create but not update would be exactly that bug wearing a new hat.
 */
describe('the alarm reaches BOTH verbs, structurally', () => {
  const CLIENT_SRC = readFileSync(path.join(__dirname, '../src/caldav/tsdav-client.ts'), 'utf8');

  it('the write path serializes through exactly ONE eventToIcs call site', () => {
    // Two call sites would mean create and update could drift — one of them gaining alarms and the
    // other silently not. One site makes that divergence inexpressible.
    const calls = CLIENT_SRC.match(/\beventToIcs\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('the route does not whitelist event fields on the way in', () => {
    // A `pick`/explicit field list in the route would drop alarmsMinutesBefore before it ever
    // reached the serializer, with every test above still green.
    const ROUTE_SRC = readFileSync(path.join(__dirname, '../src/api/connect-routes.ts'), 'utf8');
    const writeBlock = ROUTE_SRC.slice(ROUTE_SRC.indexOf("app.post('/connect/:provider/calendar/write'"));
    const decl = writeBlock.slice(0, writeBlock.indexOf('writeCalendarEvent'));
    expect(decl).toContain('b.write as CalDavWrite');
    expect(decl).not.toMatch(/summary\s*:/);
  });
});
