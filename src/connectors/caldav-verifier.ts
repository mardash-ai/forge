import { getCalDavClient } from '../caldav';
import type { CredentialVerifier, VerifyOutcome } from './credential-verifier';
import type { BasicProviderDescriptor } from './providers';

// The CredentialVerifier for CalDAV providers (today: Apple/iCloud).
//
// Verification IS discovery: a PROPFIND for the current-user-principal and its calendar-home-set. That
// single round trip proves three things at once — the credential authenticates, the account actually has
// a calendar service, and the partition-host redirect resolves. Nothing weaker is worth storing a
// password on the strength of.
//
// ⛔ It deliberately requires at least one calendar. A web-created Apple Account authenticates fine and
// exposes NO calendar service at all until it has been signed in on a real Apple device once — so
// "credentials work" and "this account can hold a calendar" are genuinely different questions, and only
// the second one means the connection will do anything. Accepting an authenticated-but-calendar-less
// account would produce a card that says Connected above a permanently empty calendar, with the true
// cause (a provisioning step nobody documented) invisible.
// See knowledge/context/a-web-created-apple-account-has-no-calendar.md.
export const caldavCredentialVerifier: CredentialVerifier = {
  async verify(input: {
    descriptor: BasicProviderDescriptor;
    username: string;
    password: string;
  }): Promise<VerifyOutcome> {
    const probe = await getCalDavClient().probe({
      username: input.username,
      password: input.password,
      serverUrl: input.descriptor.service_endpoint,
    });

    if (!probe.ok)
      return { ok: false, reason: probe.reason, ...(probe.detail ? { detail: probe.detail } : {}) };

    if (probe.calendars.length === 0) {
      return {
        ok: false,
        reason: 'invalid_credentials',
        detail:
          'The credential authenticated, but the account exposes no calendars. An Apple Account created ' +
          'in a browser has no iCloud Calendar service until it has been signed in on an Apple device once.',
      };
    }

    // The account label is the username: iCloud's principal does not carry a friendlier display name,
    // and inventing one would be worse than showing the address the user typed.
    return { ok: true, account_label: input.username };
  },
};
