import type { CalDavEvent } from './types';

// Minimal RFC 5545 serialisation — only what a calendar event needs. Deliberately hand-written rather
// than pulled from a library: the surface is small, and every escaping rule below is one an
// interoperability bug would otherwise hide.

// RFC 5545 §3.3.11: backslash, semicolon and comma are escaped; newlines become the literal \n.
// Order matters — backslash must be escaped FIRST or it would double-escape the escapes we add after.
//
// ⛔ The semicolon arm read `.replace(/;/g, '\;')` until 2026-08-29. In JavaScript '\;' IS ';' —
// a backslash before a non-escape character is simply dropped — so that line replaced a semicolon
// with a semicolon and did nothing, for every event forge has ever written. The comment above it
// asserted the property was handled, which is precisely why nobody looked: the code and its own
// documentation agreed, and neither was true. The comma arm right beside it was correct, which is
// what makes the pair readable as working.
function escapeText(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

// UTC "basic format" — 20260824T153000Z. iCloud accepts fractional-free UTC stamps; an offset form
// invites per-client timezone interpretation we would then have to defend against.
function toIcsUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${iso}`);
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

// RFC 5545 §3.1: lines are folded at 75 OCTETS, and a continuation begins with one space. Folding by
// characters would split a multi-byte UTF-8 sequence and corrupt any non-ASCII summary — the reason
// this counts bytes rather than string length.
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    const limit = start === 0 ? 75 : 74; // continuations spend one octet on the leading space
    let end = Math.min(start + limit, bytes.length);
    // Never cut inside a UTF-8 continuation byte (10xxxxxx).
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    out.push((start === 0 ? '' : ' ') + bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return out.join('\r\n');
}

/**
 * VALARM blocks for an event's alarm leads (minutes before start).
 *
 * The serialization here is PIXEL-PROVEN, not inferred: on 2026-08-29 a live probe wrote
 * `TRIGGER:-PT30M` to a real iCloud calendar over CalDAV and a human confirmed on icloud.com that
 * the alert both persisted and RENDERED on the event. A VALARM a server stores but no client ever
 * displays is indistinguishable from a working one at the protocol boundary, so that check could
 * not be skipped.
 *
 * A lead of 0 is "at start" and must be `TRIGGER:PT0S` — `-PT0M` is a negative zero duration that
 * some clients reject outright. Leads are deduped and sorted so the nearest alarm comes first, and
 * anything that is not a non-negative integer is dropped rather than serialized into a malformed
 * TRIGGER that would fail the whole PUT.
 */
function alarmLines(event: CalDavEvent): string[] {
  const leads = [...new Set(event.alarmsMinutesBefore ?? [])]
    .filter((m) => Number.isInteger(m) && m >= 0)
    .sort((a, b) => a - b);
  return leads.flatMap((m) => [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(event.summary)}`,
    m === 0 ? 'TRIGGER:PT0S' : `TRIGGER:-PT${m}M`,
    'END:VALARM',
  ]);
}

export function eventToIcs(event: CalDavEvent, now: Date = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dorinda//Forge CalDAV//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${escapeText(event.uid)}`,
    `DTSTAMP:${toIcsUtc(now.toISOString())}`,
    `DTSTART:${toIcsUtc(event.start)}`,
    `DTEND:${toIcsUtc(event.end)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
    // Provider-native alarms, INSIDE the VEVENT — a VALARM after END:VEVENT is not the event's
    // alarm and is silently ignored by every client that reads it.
    ...alarmLines(event),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // CRLF throughout — RFC 5545 requires it, and some servers reject bare LF.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// The object path for a UID within a collection. iCloud is tolerant here, but a stable, derivable
// href means an update can address an object we created without a round trip to find it.
//
// ⛔ THE BASE MUST BE ABSOLUTE, and this function is where that is enforced.
//
// In production this was called with `calendarUrl: ''` and returned the ROOT-RELATIVE
// "/dorinda-<uid>.ics". tsdav could not parse that as a URL, so a two-repo contract defect
// surfaced to a real user as "Apple Calendar couldn't be reached" — a network story for an
// addressing bug. A relative object path is never a thing we can legitimately want: there is no
// base to resolve it against once it leaves this process. Refusing it here makes the whole class
// unrepresentable no matter which caller gets the contract wrong next.
export function icsHref(calendarUrl: string, uid: string): string {
  let parsed: URL;
  try {
    parsed = new URL(calendarUrl);
  } catch {
    throw new Error(
      `icsHref: calendarUrl must be an absolute http(s) collection URL, got ${JSON.stringify(calendarUrl)}. ` +
        'A create must be addressed to a discovered calendar — see connectors/service.ts#resolveWriteTarget.',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`icsHref: calendarUrl must be http(s), got ${JSON.stringify(calendarUrl)}.`);
  }
  const base = calendarUrl.endsWith('/') ? calendarUrl : `${calendarUrl}/`;
  return `${base}${encodeURIComponent(uid)}.ics`;
}
