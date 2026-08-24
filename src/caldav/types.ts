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

export interface CalDavClient {
  // Authenticate + discover the principal and its calendar-home-set. This is the whole of what
  // verify-before-store needs, and the first thing that exercises the partition-host redirect.
  probe(creds: CalDavCredentials): Promise<CalDavProbe>;
}
