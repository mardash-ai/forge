import type { CalDavEvent } from './types';

// Minimal RFC 5545 serialisation — only what a calendar event needs. Deliberately hand-written rather
// than pulled from a library: the surface is small, and every escaping rule below is one an
// interoperability bug would otherwise hide.

// RFC 5545 §3.3.11: backslash, semicolon and comma are escaped; newlines become the literal \n.
// Order matters — backslash must be escaped FIRST or it would double-escape the escapes we add after.
function escapeText(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
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
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  // CRLF throughout — RFC 5545 requires it, and some servers reject bare LF.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// The object path for a UID within a collection. iCloud is tolerant here, but a stable, derivable
// href means an update can address an object we created without a round trip to find it.
export function icsHref(calendarUrl: string, uid: string): string {
  const base = calendarUrl.endsWith('/') ? calendarUrl : `${calendarUrl}/`;
  return `${base}${encodeURIComponent(uid)}.ics`;
}
