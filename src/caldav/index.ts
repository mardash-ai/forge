import type { CalDavClient } from './types';
import { tsdavCalDavClient } from './tsdav-client';

export * from './types';

// Injectable, matching the C24 outbound-OAuth-client pattern: the real implementation by default, a
// stub in tests. Unlike the credential VERIFIER (which has no default, because an absent check must
// never read as a pass), a default here is correct — this is a transport, and its absence is a
// deployment error rather than a silent approval.
let client: CalDavClient = tsdavCalDavClient;

export function getCalDavClient(): CalDavClient {
  return client;
}
export function setCalDavClient(c: CalDavClient): void {
  client = c;
}
export function resetCalDavClient(): void {
  client = tsdavCalDavClient;
}
