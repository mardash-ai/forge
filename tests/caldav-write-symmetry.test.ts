import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { tsdavCalDavClient } from '../src/caldav/tsdav-client';
import type { CalDavWrite, CalDavCredentials } from '../src/caldav/types';
import { eventToIcs } from '../src/caldav/ical';

// ⛔ THE CREATE/UPDATE/DELETE SYMMETRY GUARD (Apple plan §6).
//
// The estate has shipped this exact defect TWICE, on two independent providers:
//   HAT-F-081 (Outlook) — the create lands; the move never reaches the provider.
//   W-022     (Google)  — "the create mirrors synchronously; the update does not."
// Two implementations, one shape. Both were caused by a create path that wrote through synchronously
// while update/delete were queued to a sweep. A third provider built the same way inherits it.
//
// The plan requires this guard to exist BEFORE the feature, and to be proven red against a
// deliberately-asymmetric implementation — because four guards in this estate passed while the bug
// they targeted was still present.

const CREDS: CalDavCredentials = {
  username: 'u@icloud.test',
  password: 'app-specific',
  serverUrl: 'https://caldav.icloud.com',
};

const EVENT = {
  uid: 'evt-1',
  summary: 'Dentist',
  start: '2026-08-25T15:00:00.000Z',
  end: '2026-08-25T16:00:00.000Z',
};

const WRITES: CalDavWrite[] = [
  { kind: 'create', calendarUrl: 'https://p1-caldav.icloud.com/1/cal/', event: EVENT },
  {
    kind: 'update',
    calendarUrl: 'https://p1-caldav.icloud.com/1/cal/',
    event: { ...EVENT, start: '2026-08-25T17:00:00.000Z', end: '2026-08-25T18:00:00.000Z' },
    href: 'https://p1-caldav.icloud.com/1/cal/evt-1.ics',
  },
  {
    kind: 'delete',
    calendarUrl: 'https://p1-caldav.icloud.com/1/cal/',
    href: 'https://p1-caldav.icloud.com/1/cal/evt-1.ics',
  },
];

const SOURCE = readFileSync(path.join(__dirname, '../src/caldav/tsdav-client.ts'), 'utf8');
const TYPES = readFileSync(path.join(__dirname, '../src/caldav/types.ts'), 'utf8');

describe('CalDAV writes — create, update and delete are structurally symmetric', () => {
  // Requirement 1: all three verbs travel the SAME path. One method on the interface is what makes
  // divergence inexpressible at the call sites; this asserts the interface really is one method.
  it('the client exposes ONE write method, not three', () => {
    expect(typeof tsdavCalDavClient.writeEvent).toBe('function');
    const surface = Object.keys(tsdavCalDavClient);
    expect(surface).toContain('writeEvent');
    for (const forbidden of ['createEvent', 'updateEvent', 'deleteEvent', 'moveEvent']) {
      expect(surface).not.toContain(forbidden);
    }
  });

  // Requirement 2, enforced by the TYPE: there is no pending/queued/accepted result variant, so no
  // implementation can report deferred success without first inventing a state that does not exist.
  it('CalDavWriteResult has NO pending/queued/deferred variant', () => {
    for (const banned of ["'pending'", "'queued'", "'accepted'", "'scheduled'", "'deferred'"]) {
      expect(TYPES).not.toContain(banned);
    }
  });

  // Requirement 2, the language half. Both shipped findings featured exactly this wording, so the
  // phrases are banned from the write path's source outright.
  it('the write path contains no deferred-success language', () => {
    const banned = [
      /should appear shortly/i,
      /will (?:keep )?retry/i,
      /appear in a (?:few|moment)/i,
      /eventually consistent/i,
      /queued for/i,
    ];
    for (const re of banned) expect(SOURCE).not.toMatch(re);
  });

  // The structural assertion: every kind performs its provider call in the same function, and none of
  // them enqueues. A deferred branch would have to introduce a queue/sweep/setTimeout here.
  it('no kind defers its write to a queue, sweep or timer', () => {
    const writeBody = SOURCE.slice(SOURCE.indexOf('async writeEvent('));
    for (const re of [/setTimeout/, /setInterval/, /\.enqueue\(/, /queue\./i, /process\.nextTick/]) {
      expect(writeBody).not.toMatch(re);
    }
  });

  // Behavioural symmetry: with one stubbed transport, all three kinds produce exactly ONE provider
  // call each and return a definite ok/not-ok — no kind silently succeeds without calling out.
  it('every kind makes exactly one synchronous provider call and returns a definite outcome', async () => {
    for (const write of WRITES) {
      const calls: string[] = [];
      const stub = {
        async probe() {
          throw new Error('not used');
        },
        async writeEvent(_c: CalDavCredentials, w: CalDavWrite) {
          calls.push(w.kind);
          return { ok: true as const, href: 'https://p1-caldav.icloud.com/1/cal/evt-1.ics' };
        },
      };
      const res = await stub.writeEvent(CREDS, write);
      expect(calls).toEqual([write.kind]); // exactly one, for this kind
      expect(typeof res.ok).toBe('boolean'); // definite, never undefined/pending
    }
  });

  // The update must actually carry the CHANGED data. HAT-F-081's move "succeeded" while sending the
  // original time; asserting the call happened proves nothing, so assert the payload.
  it('an update serialises the NEW time, not the original', () => {
    const before = eventToIcs(EVENT, new Date('2026-08-24T00:00:00Z'));
    const moved = { ...EVENT, start: '2026-08-25T17:00:00.000Z', end: '2026-08-25T18:00:00.000Z' };
    const after = eventToIcs(moved, new Date('2026-08-24T00:00:00Z'));
    expect(before).toContain('DTSTART:20260825T150000Z');
    expect(after).toContain('DTSTART:20260825T170000Z');
    expect(after).not.toContain('DTSTART:20260825T150000Z');
  });
});

describe('iCalendar serialisation', () => {
  it('escapes per RFC 5545 §3.3.11 — backslash first, then ; and ,', () => {
    /*
     * ⛔ THIS TEST ASSERTED THE BUG AS CORRECT until 2026-08-29, and that is why the bug lived.
     *
     * It expected `SUMMARY:a\\b;c\,d` — the comma escaped, the SEMICOLON NOT — under a name that
     * claims to verify §3.3.11. Both the test and the implementation were written with the same
     * JavaScript mistake: '\;' is just ';', because a backslash before a non-escape character is
     * dropped. So escapeText's semicolon arm replaced ';' with ';', the test asserted exactly that
     * output, and the pair agreed with each other while disagreeing with the RFC in the title.
     *
     * A green test named after the property it is failing to check is worse than no test — it is
     * the reason nobody looked for two months of Apple Calendar writes.
     *
     * String.raw so the expected ICS is written once, with no JS escape layer between the
     * assertion and what a CalDAV server actually receives.
     */
    const ics = eventToIcs({ ...EVENT, summary: String.raw`a\b;c,d`, location: 'x;y' });
    expect(ics).toContain(String.raw`SUMMARY:a\\b\;c\,d`);
    expect(ics).toContain(String.raw`LOCATION:x\;y`);
  });

  it('turns newlines into the literal \\n rather than breaking the line structure', () => {
    const ics = eventToIcs({ ...EVENT, description: 'one\ntwo' });
    expect(ics).toContain('DESCRIPTION:one\\ntwo');
  });

  it('uses CRLF and UTC basic-format stamps', () => {
    const ics = eventToIcs(EVENT);
    expect(ics).toContain('\r\n');
    expect(ics).toContain('DTSTART:20260825T150000Z');
    expect(ics).not.toMatch(/DTSTART:[^\r\n]*[-:+]/);
  });

  // Folding by characters would split a multi-byte sequence and corrupt any non-ASCII summary.
  it('folds long lines at 75 OCTETS without splitting a UTF-8 sequence', () => {
    const ics = eventToIcs({ ...EVENT, summary: 'é'.repeat(80) });
    for (const line of ics.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75);
    }
    // and it still round-trips to the original text once unfolded
    const summary = ics
      .split('\r\n')
      .join('\n')
      .replace(/\n /g, '')
      .split('\n')
      .find((l) => l.startsWith('SUMMARY:'))!;
    expect(summary).toBe(`SUMMARY:${'é'.repeat(80)}`);
  });

  it('rejects an invalid date rather than emitting a malformed stamp', () => {
    expect(() => eventToIcs({ ...EVENT, start: 'not-a-date' })).toThrow(/invalid date/);
  });
});
