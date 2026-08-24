import type { BasicProviderDescriptor } from './providers';

// C24 — VERIFY-BEFORE-STORE for basic-auth (username + password) providers.
//
// An OAuth connect flow proves the credential works as a side effect: the provider itself performs the
// exchange, and a bad credential simply never produces a token. A basic-auth flow has no such
// guarantee — the user pastes a string and we could store it verbatim without ever finding out whether
// it opens anything. That is unacceptable for Apple specifically, because the single most likely user
// error (typing the PRIMARY Apple password instead of an app-specific one) returns a bare 401 with no
// explanatory body. Store it unverified and the user leaves the wizard believing they are connected;
// the failure surfaces hours later as an empty calendar, pointing nowhere near the real cause.
//
// So the credential is probed against the real service BEFORE it is sealed, and the connection record
// is only written on a verified success.

/** A calendar the verifier discovered while proving the credential. Returned so the connect flow can
 *  offer a picker without a SECOND round trip — discovery already fetched them, and asking iCloud
 *  again would be both slower and a chance for the two answers to disagree. */
export interface VerifiedCalendar {
  url: string;
  displayName: string;
  readOnly: boolean;
}

export type VerifyOutcome =
  | { ok: true; account_label?: string; calendars?: VerifiedCalendar[] }
  // The service answered and REJECTED the credential. A definite observation.
  | { ok: false; reason: 'invalid_credentials'; detail?: string }
  // The service could not be reached / answered unusably. NOT a statement about the credential —
  // "we asked and it said no" and "we could not ask" are different facts and must never collapse
  // into one (guardrail #8, corollary b).
  | { ok: false; reason: 'unreachable'; detail?: string };

export interface CredentialVerifier {
  verify(input: {
    descriptor: BasicProviderDescriptor;
    username: string;
    password: string;
  }): Promise<VerifyOutcome>;
}

// ⛔ NO DEFAULT VERIFIER, and never a permissive one.
//
// The obvious shortcut is a fallback that returns `{ ok: true }` when nothing is registered, so the
// flow "works" before the CalDAV capability lands. That would manufacture a verified-connected state
// out of an absent check — the exact defect class as forge-hat's Anthropic lane, where a missing claim
// extractor graded against hardcoded defaults and reported PRODUCT rejections that had never been
// observed (HAT-F-065: a default is not an observation; an absent judge must WITHHOLD, never score).
//
// With nothing registered, connecting REFUSES. A provider whose verifier has not shipped is not a
// provider the user can connect, and saying so out loud is the only honest option.
let verifier: CredentialVerifier | null = null;

export function setCredentialVerifier(v: CredentialVerifier | null): void {
  verifier = v;
}

export function resetCredentialVerifier(): void {
  verifier = null;
}

// Null when no verifier is registered — the caller MUST turn that into a refusal, not a success.
export function getCredentialVerifier(): CredentialVerifier | null {
  return verifier;
}
