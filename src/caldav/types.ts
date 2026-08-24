// The INTERNAL CalDAV surface. Everything the platform needs from CalDAV is expressed here, in our own
// vocabulary, and `tsdav` sits behind it as one implementation.
//
// Why the indirection is not ceremony (Apple plan §9): tsdav is effectively a SINGLE-MAINTAINER project
// (there is a calcom fork, which is itself a signal). It is the right choice today — 2.3.1, MIT, two
// dependencies, ~117k weekly downloads, documented iCloud app-specific-password support — and hand-rolling
// WebDAV XML was rejected because none of that swamp is our product. The way to take that bet responsibly
// is to make it swappable: product code never imports tsdav, retry/backoff/logging policy lives in OUR
// code rather than being inherited, and replacing the library is one file.

export interface CalDavCredentials {
  // The Apple Account email. For iCloud this is the Basic-auth username.
  username: string;
  // An APP-SPECIFIC password. The primary account password is rejected by iCloud with a bare 401.
  password: string;
  // Discovery root, e.g. https://caldav.icloud.com — never a partition host, which differs per account.
  serverUrl: string;
}

export interface CalDavCalendar {
  // The collection URL. After discovery this is usually on a PARTITION host (pNN-caldav.icloud.com),
  // not the discovery root — so it must be carried, never reconstructed from serverUrl.
  url: string;
  displayName: string;
  // Whether the collection accepts writes. Subscribed calendars are read-only at the protocol level,
  // regardless of any product setting.
  readOnly: boolean;
  // Opaque per-collection tag used to detect "has anything changed" cheaply.
  ctag?: string;

  // ⛔ THREE STATES, NOT A BOOLEAN — and recorded PER CALENDAR, never per account.
  //
  // RFC 6578 requires a server implementing the sync-collection REPORT to advertise it in
  // DAV:supported-report-set, so the advert IS the check. But whether iCloud advertises it on every
  // collection type — shared and subscribed calendars especially — is genuinely unknown (Apple plan
  // §5, marked ❓), which is exactly why the answer is stored per collection.
  //
  // `unknown` exists because "the server did not advertise it" and "we never read the advert" are
  // different facts, and collapsing them into `false` would manufacture an observation out of a
  // missing one — the estate's own HAT-F-065 rule (a default is not an observation). Both `absent`
  // and `unknown` route to the ctag fallback, so behaviour is identical and safe; what differs is
  // what we are entitled to SAY about the server, and therefore whether a future report claiming
  // "iCloud does not support sync-collection" is evidence or a guess.
  syncCollection: 'advertised' | 'absent' | 'unknown';
}

export interface CalDavPrincipal {
  principalUrl: string;
  calendarHomeUrl: string;
}

// The outcome of proving a credential opens an account. Deliberately NOT a boolean: "the server said no"
// and "we never reached the server" are different facts, and a caller that cannot tell them apart will
// eventually tell a user their password is wrong when the truth was a timeout.
export type CalDavProbe =
  | { ok: true; principal: CalDavPrincipal; calendars: CalDavCalendar[] }
  | { ok: false; reason: 'invalid_credentials'; detail?: string }
  | { ok: false; reason: 'unreachable'; detail?: string };

// Reads fail the same three ways writes do, and for the same reason: a caller that cannot tell
// "the account has no calendars" from "we could not reach iCloud" will eventually render an empty
// calendar as fact. Guardrail #8's corollary — loading, loaded-and-empty, and the-fetch-failed are
// three different states and must never share one appearance.
export type CalDavListResult =
  | { ok: true; calendars: CalDavCalendar[] }
  | { ok: false; reason: 'invalid_credentials' | 'unreachable'; detail?: string };

export interface CalDavClient {
  // Authenticate + discover the principal and its calendar-home-set. This is the whole of what
  // verify-before-store needs, and the first thing that exercises the partition-host redirect.
  probe(creds: CalDavCredentials): Promise<CalDavProbe>;

  // The ongoing read path. Distinct from `probe`, which exists to VERIFY a credential at connect
  // time; this is what a sweep calls, and it carries the per-calendar sync capability forward.
  listCalendars(creds: CalDavCredentials): Promise<CalDavListResult>;

  // The SINGLE write path for create, update and delete. See CalDavWrite for why it is one method.
  writeEvent(creds: CalDavCredentials, write: CalDavWrite): Promise<CalDavWriteResult>;
}

// --- writes -------------------------------------------------------------------
//
// ⛔ ONE VERB, THREE KINDS — deliberately a single method rather than
// createEvent/updateEvent/deleteEvent.
//
// The estate has shipped the same defect twice on two independent providers: HAT-F-081 (Outlook — the
// create lands, the move never reaches the provider) and W-022 (Google — "the create mirrors
// synchronously; the update does not"). Two implementations, one shape: create was written through
// synchronously while update/delete were queued to a sweep, so the asymmetry was STRUCTURAL and no
// amount of care at the call sites would have prevented it.
//
// Separate methods are what make that divergence expressible. With one method taking a discriminated
// `kind`, an implementation cannot make create synchronous and update deferred without the difference
// being visible inside a single function body — and `tests/caldav-write-symmetry.test.ts` asserts all
// three kinds traverse the identical transport.

export interface CalDavEvent {
  // Stable identity. For a create we mint it; for update/delete it identifies the existing object.
  uid: string;
  summary: string;
  start: string; // ISO 8601 instant
  end: string; // ISO 8601 instant
  location?: string;
  description?: string;
}

export type CalDavWrite =
  | { kind: 'create'; calendarUrl: string; event: CalDavEvent }
  | { kind: 'update'; calendarUrl: string; event: CalDavEvent; href: string; etag?: string }
  | { kind: 'delete'; calendarUrl: string; href: string; etag?: string };

// ⛔ There is NO `pending` / `queued` / `accepted` state, and there must never be one.
//
// Plan §6 requirement 2: no deferred-success language, ever. A reply may not say "it should appear
// shortly" or "it will keep retrying" — those are claims about the future that no tool result can
// support, and BOTH shipped findings featured exactly that wording. Either the provider accepted the
// write (say so) or it did not (say that plainly and leave the user able to act). Making the absence
// of a pending state a property of the TYPE means no future implementation can reintroduce the
// language without first inventing a variant that does not exist.
export type CalDavWriteResult =
  | { ok: true; href: string; etag?: string }
  | {
      ok: false;
      reason: 'not_found' | 'conflict' | 'read_only' | 'invalid_credentials' | 'unreachable';
      detail?: string;
    };
