import { randomBytes } from 'node:crypto';
import { getBackends } from '../storage/backends';
import { sealValue, openValue } from '../plugins/secrets-local/index';
import { nowIso } from '../shared/time';
import { ForgeError, notFound, dependencyUnavailable } from '../shared/errors';
import { resolveProvider } from './config';
import { getOutboundOAuthClient, newPkcePair } from './oauth-client';
import { parseScopes, scopeString } from '../mcp/oauth';
import type {
  Connection,
  OAuthConnection,
  BasicConnection,
  ConnectRequest,
  ConnectionView,
  FreshToken,
} from './types';
import { getCredentialVerifier, type VerifiedCalendar } from './credential-verifier';
import { getCalDavClient } from '../caldav';
import type { CalDavWrite, CalDavWriteResult } from '../caldav';
import { toConnectionView } from './types';

// C24 — the connector-vault SERVICE: the core behavior the routes (and a future outbound-delivery
// capability) call. It owns the connect handshake, encryption-at-rest under the C5 master key, transparent
// auto-refresh, the broker (get a FRESH access token), and disconnect. All I/O to the provider goes through
// the swappable OutboundOAuthClient (so tests run with a mocked provider, no network); all persistence goes
// through the P26 `connections` store domain (filesystem default / Postgres). The store only ever holds
// SEALED tokens — plaintext never lands at rest.

const CONNECT_REQUEST_TTL_SECONDS = 10 * 60; // a consent round-trip is short-lived
const REFRESH_SKEW_SECONDS = 60; // refresh a token this close to (or past) expiry

// Typed failures the routes map to HTTP.
export const connectorNotConfigured = (provider: string) =>
  dependencyUnavailable(
    `Connector "${provider}" is not configured for this app: the operator must provision its OAuth client ` +
      `credentials (see the C24 operator config). Until then, connecting is unavailable.`,
    { provider, capability: 'Connectors' },
  );
export const unknownProvider = (provider: string) =>
  notFound(`Unknown connector provider "${provider}".`, { provider });
export const notConnected = (provider: string) =>
  notFound(`No "${provider}" connection for this user. Connect the account first.`, { provider });
// A `basic` provider reached an OAuth-only entrypoint (start / callback / refresh). This is a
// ROUTING mistake, not a configuration one, and it must not masquerade as `connectorNotConfigured`:
// that error tells the operator to provision client credentials, which for Apple would send them
// hunting for an APPLE_CONNECT_CLIENT_ID that does not and will never exist. Guardrail #7 — a
// diagnostic that hides its cause costs more than the bug.
export const wrongAuthKind = (provider: string, expected: 'oauth2' | 'basic') =>
  new ForgeError({
    code: 'wrong_auth_kind',
    message:
      expected === 'oauth2'
        ? `Connector "${provider}" authenticates with a username + password, not OAuth. Use ` +
          `POST /connect/${provider}/credentials instead of the redirect handshake.`
        : `Connector "${provider}" authenticates with OAuth. Use GET /connect/${provider} instead of ` +
          `submitting credentials.`,
    status: 400,
    // The caller must call a DIFFERENT endpoint — retrying this one never helps.
    retry: 'change-input',
    details: { provider, expected_auth_kind: expected },
  });
// The service answered and rejected the credential. The message carries the ONE piece of guidance that
// resolves the overwhelmingly common case: Apple returns a bare 401 for a primary password used where
// an app-specific password is required, and the user has no way to know that from the provider's
// response. Copy lives here, next to the failure, rather than in the web tier — every consumer of this
// API gets it, and it cannot drift out of sync with the condition that produces it.
export const credentialRejected = (provider: string, hint: string, detail?: string) =>
  new ForgeError({
    code: 'credential_rejected',
    message: `The ${provider} credential was rejected. ${hint}`,
    status: 401,
    retry: 'change-input',
    details: { provider, ...(detail ? { detail } : {}) },
  });

// We could not ASK. Deliberately distinct from credentialRejected: telling a user their password is
// wrong when the truth is that iCloud was unreachable sends them to reset a working credential — and
// on Apple, changing the primary password silently revokes every app-specific password they hold.
export const verificationUnavailable = (provider: string, detail?: string) =>
  new ForgeError({
    code: 'verification_unavailable',
    message:
      `Could not reach ${provider} to verify the credential. Nothing was saved — this is not a ` +
      `statement about whether the credential is correct. Try again shortly.`,
    status: 503,
    retry: 'retry',
    details: { provider, ...(detail ? { detail } : {}) },
  });

// No verifier is registered for a basic provider. Refuse — never store an unverified credential.
export const verifierUnavailable = (provider: string) =>
  dependencyUnavailable(
    `Connector "${provider}" cannot be connected: no credential verifier is registered for it, so a ` +
      `submitted credential could not be checked before storage. This is a deployment gap, not a user error.`,
    { provider, capability: 'Connectors' },
  );

export const reconnectRequired = (provider: string, detail: string) =>
  new ForgeError({
    code: 'reconnect_required',
    message: `The "${provider}" connection can no longer be refreshed (${detail}). The user must reconnect.`,
    status: 409,
    retry: 'needs-human',
    details: { provider },
  });

const backend = () => getBackends().then((b) => b.connections);

function expiresAt(ttlSeconds: number, from: Date = new Date()): string {
  return new Date(from.getTime() + ttlSeconds * 1000).toISOString();
}

// --- start: mint a pending request + the provider authorize URL -----------------
export interface StartConnectInput {
  appId: string;
  owner: string; // from the C10 session — never client-passed
  provider: string;
  redirectUri: string; // the exact callback URI (must match the provider's registered redirect)
  scopes?: string[]; // optional override; defaults to the provider's default_scopes
  returnTo?: string; // same-origin path to bounce back to after connect
}

export interface StartConnectResult {
  authorizeUrl: string;
  state: string;
}

export async function startConnect(input: StartConnectInput): Promise<StartConnectResult> {
  const resolved = await resolveProvider(input.appId, input.provider);
  if (!resolved) {
    // Distinguish "unknown provider" from "known but unconfigured" for a precise error.
    const { providerDescriptor } = await import('./providers');
    if (!providerDescriptor(input.provider)) throw unknownProvider(input.provider);
    throw connectorNotConfigured(input.provider);
  }
  if (resolved.auth_kind !== 'oauth2') throw wrongAuthKind(input.provider, 'oauth2');
  const { descriptor, clientId } = resolved;
  const scopes = input.scopes && input.scopes.length ? input.scopes : descriptor.default_scopes;
  const state = randomBytes(32).toString('base64url');
  const { verifier, challenge } = newPkcePair();

  const req: ConnectRequest = {
    state,
    owner: input.owner,
    provider: descriptor.id,
    code_verifier: verifier,
    redirect_uri: input.redirectUri,
    scopes,
    ...(input.returnTo ? { return_to: input.returnTo } : {}),
    created_at: nowIso(),
    expires_at: expiresAt(CONNECT_REQUEST_TTL_SECONDS),
  };
  await (await backend()).putRequest(input.appId, req);

  const authorizeUrl = getOutboundOAuthClient().authorizeUrl({
    provider: descriptor,
    clientId,
    redirectUri: input.redirectUri,
    state,
    scopes,
    codeChallenge: challenge,
  });
  return { authorizeUrl, state };
}

// --- connect with CREDENTIALS (basic auth) -------------------------------------
//
// The basic-auth counterpart to start+callback. There is no redirect, no consent screen, no one-shot
// state: the user submits a username + password once and we either verify and store it, or refuse.
//
// ⛔ ORDER IS THE WHOLE POINT: verify against the real service FIRST, seal and store only on success.
// Storing first and verifying later (or never) produces a connection the card renders as healthy while
// nothing works — and for a PASSWORD, an unverified store is worse than useless: the user believes the
// credential is in use somewhere, so when they later debug they will not suspect it.

export interface ConnectWithCredentialsInput {
  appId: string;
  provider: string;
  owner: string;
  username: string;
  password: string;
}

export interface ConnectWithCredentialsResult {
  connection: ConnectionView;
  /** Discovered at verification time, so the caller can offer a calendar picker immediately. */
  calendars: VerifiedCalendar[];
}

export async function connectWithCredentials(
  input: ConnectWithCredentialsInput,
): Promise<ConnectWithCredentialsResult> {
  const username = input.username.trim();
  // The password is NOT trimmed: an app-specific password is generated, and silently mutating a
  // credential the user pasted correctly would produce an inexplicable rejection.
  const password = input.password;
  if (!username || !password) {
    throw new ForgeError({
      code: 'invalid_input',
      message: 'Both a username and a password are required to connect this provider.',
      status: 422,
      retry: 'change-input',
      details: { provider: input.provider },
    });
  }

  const resolved = await resolveProvider(input.appId, input.provider);
  if (!resolved) {
    const { providerDescriptor } = await import('./providers');
    if (!providerDescriptor(input.provider)) throw unknownProvider(input.provider);
    throw connectorNotConfigured(input.provider);
  }
  if (resolved.auth_kind !== 'basic') throw wrongAuthKind(input.provider, 'basic');
  const { descriptor } = resolved;

  const verifier = getCredentialVerifier();
  if (!verifier) throw verifierUnavailable(input.provider);

  const outcome = await verifier
    .verify({ descriptor, username, password })
    .catch(
      (e: unknown) =>
        ({ ok: false, reason: 'unreachable', detail: String((e as Error)?.message ?? e) }) as const,
    );

  if (!outcome.ok) {
    // Three outcomes, three different things said to the user. Collapsing "rejected" into
    // "unavailable" (or the reverse) is how a user ends up resetting a primary password that was
    // never the problem — which, on Apple, revokes every app-specific password they hold.
    if (outcome.reason === 'unreachable') {
      throw verificationUnavailable(input.provider, outcome.detail);
    }
    throw credentialRejected(
      input.provider,
      `Check that you used an ${descriptor.password_label.toLowerCase()} — not your main account ` +
        `password, which is rejected without explanation. Generate one at ${descriptor.credential_help_url}.`,
      outcome.detail,
    );
  }

  const store = await backend();
  const existing = await store.getConnection(input.appId, input.owner, descriptor.id);
  const now = nowIso();
  const conn: BasicConnection = {
    auth_kind: 'basic',
    owner: input.owner,
    provider: descriptor.id,
    username,
    password_sealed: await sealValue(password),
    // Basic auth grants no scopes — the credential's reach is whatever the provider gives it. An empty
    // list is the honest representation; inventing scope strings here would imply a grant we never made.
    scopes: [],
    status: 'connected',
    account_label: outcome.account_label ?? username,
    connected_at: existing?.connected_at ?? now,
    updated_at: now,
  };
  await store.putConnection(input.appId, conn);
  return { connection: toConnectionView(conn), calendars: outcome.calendars ?? [] };
}

// --- calendar writes for BASIC-auth providers ---------------------------------
//
// ⛔ WHY THE WRITE HAPPENS HERE AND NOT IN THE CONSUMING APP.
//
// Google and Microsoft hand the app a BEARER TOKEN via `/connect/:provider/token`: scoped to the
// granted permissions, short-lived, and revocable at the provider without touching the user's account.
// Handing that to dorinda-api is a bounded delegation, and dorinda-api calls Graph itself.
//
// A basic-auth provider has no such thing. The credential IS a password — unscoped, non-expiring, and
// revocable only by the user going to Apple and revoking it. Brokering it outward would put a
// long-lived account credential on the wire and into a second service's memory and logs, to save one
// hop. So there is deliberately NO reveal endpoint: the sealed credential never leaves the data-plane,
// and the data-plane performs the write. This is also what BUILDING_A_CAPABILITY §0 already requires —
// anything that calls a third-party API with a secret runs on the data-plane tier.

export interface CalendarWriteInput {
  appId: string;
  provider: string;
  owner: string;
  write: CalDavWrite;
}

export async function writeCalendarEvent(input: CalendarWriteInput): Promise<CalDavWriteResult> {
  const resolved = await resolveProvider(input.appId, input.provider);
  if (!resolved) {
    const { providerDescriptor } = await import('./providers');
    if (!providerDescriptor(input.provider)) throw unknownProvider(input.provider);
    throw connectorNotConfigured(input.provider);
  }
  if (resolved.auth_kind !== 'basic') throw wrongAuthKind(input.provider, 'basic');

  const store = await backend();
  const conn = await store.getConnection(input.appId, input.owner, input.provider);
  if (!conn) throw notConnected(input.provider);
  if (conn.auth_kind !== 'basic') throw wrongAuthKind(input.provider, 'basic');

  // Opened here, used immediately, never returned to the caller and never logged.
  const password = await openValue(conn.password_sealed);

  const creds = {
    username: conn.username,
    password,
    serverUrl: resolved.descriptor.service_endpoint,
  };

  const write = await resolveWriteTarget(creds, input.write);
  if ('unresolved' in write) return write.unresolved;

  return getCalDavClient().writeEvent(creds, write.write);
}

/**
 * Address a create that arrived without a calendar.
 *
 * ⛔ THIS IS THE HALF THAT WAS MISSING. dorinda-api sent `calendarUrl: ''` under a comment
 * asserting "the calendar is chosen by forge from the connection's discovered home when omitted."
 * Forge had never implemented it, so the empty string flowed into icsHref() and became the
 * relative href "/dorinda-<uid>.ics". Each repo was self-consistent and fully green; the first
 * thing to ever evaluate the PAIR was a real user's calendar write (estate guardrail #5).
 *
 * The consuming app is right to not know the collection URL — it lives on a per-account partition
 * host (pNN-caldav.icloud.com) discovered at login and cannot be constructed. So resolution belongs
 * here, and this function makes the emitter's comment true.
 *
 * Every outcome is TYPED. If discovery fails we relay ITS reason; if the account genuinely has
 * nowhere to write we say `no_writable_calendar`. Neither is ever reported as `unreachable`, and
 * neither ever falls through to a write against a guessed URL.
 */
async function resolveWriteTarget(
  creds: { username: string; password: string; serverUrl: string },
  write: CalDavWrite,
): Promise<{ write: CalDavWrite } | { unresolved: CalDavWriteResult }> {
  if (write.kind !== 'create' || trimmedUrl(write.calendarUrl)) return { write };

  const listed = await getCalDavClient().listCalendars(creds);
  if (!listed.ok) {
    return {
      unresolved: {
        ok: false,
        reason: listed.reason,
        ...(listed.detail ? { detail: listed.detail } : {}),
      },
    };
  }

  // `readOnly` already covers both ineligible shapes: a subscribed collection, and a collection
  // that does not accept VEVENT (which is how iCloud's Reminders lists arrive here). See
  // caldav/tsdav-client.ts#toCalendar.
  const writable = listed.calendars.filter((c) => !c.readOnly && trimmedUrl(c.url));
  const target =
    // iCloud names the account's default calendar "Home"; prefer it when present so the same
    // account resolves to the same collection every time rather than drifting with server order.
    writable.find((c) => c.displayName.trim().toLowerCase() === 'home') ?? writable[0];

  if (!target) {
    return {
      unresolved: {
        ok: false,
        reason: 'no_writable_calendar',
        detail: `no writable calendar in ${listed.calendars.length} discovered collection(s)`,
      },
    };
  }

  return { write: { ...write, calendarUrl: target.url } };
}

/** An absolute http(s) URL, or undefined. Guards against '' satisfying a truthiness check upstream. */
function trimmedUrl(value: string | undefined): string | undefined {
  const v = (value ?? '').trim();
  if (!v) return undefined;
  return /^https?:\/\//i.test(v) ? v : undefined;
}

// --- complete: consume the request, exchange the code, store sealed tokens ------
export interface CompleteConnectInput {
  appId: string;
  provider: string;
  state: string;
  code: string;
  // The session owner at the callback, when present — must match the request's owner (defense in depth).
  sessionOwner?: string;
}

export interface CompleteConnectResult {
  connection: ConnectionView;
  owner: string; // the user the connection belongs to (for C3 attribution)
  returnTo: string;
}

export async function completeConnect(input: CompleteConnectInput): Promise<CompleteConnectResult> {
  const store = await backend();
  const req = await store.consumeRequest(input.appId, input.state); // one-shot
  if (!req || req.provider !== input.provider) {
    throw new ForgeError({
      code: 'invalid_state',
      message: 'Unknown or already-used connect request (state mismatch). Start the connect flow again.',
      status: 400,
      retry: 'change-input',
    });
  }
  if (req.expires_at <= nowIso()) {
    throw new ForgeError({
      code: 'invalid_state',
      message: 'The connect request expired. Start the connect flow again.',
      status: 400,
      retry: 'change-input',
    });
  }
  // If a session is present on the callback, it MUST be the same user who started (the state alone is
  // one-shot + unguessable, but this closes the gap where a leaked state could be replayed by another user).
  if (input.sessionOwner && input.sessionOwner !== req.owner) {
    throw new ForgeError({
      code: 'owner_mismatch',
      message: 'The signed-in user does not match the account that started this connection.',
      status: 403,
      retry: 'needs-human',
    });
  }

  const resolved = await resolveProvider(input.appId, input.provider);
  if (!resolved) throw connectorNotConfigured(input.provider);
  if (resolved.auth_kind !== 'oauth2') throw wrongAuthKind(input.provider, 'oauth2');
  const { descriptor, clientId, clientSecret } = resolved;

  let tokens;
  try {
    tokens = await getOutboundOAuthClient().exchangeCode({
      provider: descriptor,
      clientId,
      clientSecret,
      code: input.code,
      redirectUri: req.redirect_uri,
      codeVerifier: req.code_verifier,
    });
  } catch (e) {
    throw new ForgeError({
      code: 'connect_failed',
      message: `Could not complete the "${descriptor.id}" connection: ${String((e as Error)?.message ?? e)}`,
      status: 502,
      retry: 'retry',
      details: { provider: descriptor.id },
    });
  }

  const now = nowIso();
  const grantedScopes = tokens.scope ? parseScopes(tokens.scope) : req.scopes;
  const existing = await store.getConnection(input.appId, req.owner, descriptor.id);
  // SCOPE NARROWING GUARD: Microsoft (and any provider without `include_granted_scopes`) can return a
  // SUBSET of the previously-stored scopes on a partial re-consent — overwriting the stored list would
  // silently revoke already-granted capabilities (e.g. losing Mail.Send after re-consenting Mail.Read
  // only). We ALWAYS take the UNION so the stored set is a superset of every grant ever received. Google
  // avoids this with `include_granted_scopes=true` (the provider merges on their side); Microsoft has
  // no such mechanism, so the fix must live here.
  const mergedScopes = unionScopes(existing?.scopes ?? [], grantedScopes);
  const conn: OAuthConnection = {
    auth_kind: 'oauth2',
    owner: req.owner,
    provider: descriptor.id,
    access_sealed: await sealValue(tokens.access_token),
    // Keep the prior refresh token if the provider returned none on this exchange (Google omits it on a
    // re-consent that reuses an earlier grant).
    ...(await resolveRefreshSealed(tokens.refresh_token, existing)),
    access_expires_at: expiresAt(tokens.expires_in, new Date(now)),
    scopes: mergedScopes,
    status: 'connected',
    ...(tokens.account_label
      ? { account_label: tokens.account_label }
      : existing?.account_label
        ? { account_label: existing.account_label }
        : {}),
    connected_at: existing?.connected_at ?? now,
    updated_at: now,
  };
  await store.putConnection(input.appId, conn);
  return { connection: toConnectionView(conn), owner: req.owner, returnTo: safeReturnTo(req.return_to) };
}

async function resolveRefreshSealed(
  refreshToken: string | undefined,
  existing: Connection | null,
): Promise<Pick<OAuthConnection, 'refresh_sealed'>> {
  if (refreshToken) return { refresh_sealed: await sealValue(refreshToken) };
  // Only an OAuth connection carries a refresh token; a basic one never does.
  if (existing?.auth_kind === 'oauth2' && existing.refresh_sealed) {
    return { refresh_sealed: existing.refresh_sealed };
  }
  return {};
}

// Only allow a single-slash same-origin path (the C10 safeNext posture) — never an open redirect.
function safeReturnTo(returnTo: string | undefined): string {
  if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.startsWith('/\\'))
    return '/';
  return returnTo;
}

// --- management -----------------------------------------------------------------
export async function listConnections(appId: string, owner: string): Promise<ConnectionView[]> {
  const conns = await (await backend()).listConnections(appId, owner);
  return conns.map(toConnectionView);
}

/**
 * Disconnect EVERY provider an owner has connected — the C34 account-teardown counterpart to the
 * per-provider {@link disconnect}. Each is revoked AT THE PROVIDER before its local tokens are
 * dropped, so deleting an account also withdraws the live Google/Gmail/Calendar grant rather than
 * orphaning it. Without this, a purged account leaves a working refresh token on the provider's side
 * and the app still listed under the user's third-party access — a deletion that doesn't delete.
 *
 * Idempotent (no connections ⇒ `{ providers: [], disconnected: 0 }`) and best-effort per provider:
 * one provider failing never blocks the rest, since stranding the others' tokens would be worse.
 */
export async function disconnectAll(
  appId: string,
  owner: string,
): Promise<{ providers: string[]; disconnected: number }> {
  const conns = await (await backend()).listConnections(appId, owner);
  const providers: string[] = [];
  for (const conn of conns) {
    try {
      if (await disconnect(appId, owner, conn.provider)) providers.push(conn.provider);
    } catch {
      // Keep going — one provider's failure must not strand the others' tokens.
    }
  }
  return { providers, disconnected: providers.length };
}

export async function disconnect(appId: string, owner: string, provider: string): Promise<boolean> {
  const store = await backend();
  const conn = await store.getConnection(appId, owner, provider);
  if (!conn) return false;
  // Best-effort revoke at the provider (when it supports it), then drop the local tokens regardless.
  // Remote revocation is an OAuth affordance. A basic provider's app-specific password lives at the
  // provider and can only be revoked BY THE USER there — deleting our sealed copy is the whole of what
  // disconnect can honestly do, so say nothing and drop it (the caller still reports success, because
  // locally it IS gone).
  const resolved = await resolveProvider(appId, provider);
  if (
    resolved?.auth_kind === 'oauth2' &&
    resolved.descriptor.revoke_endpoint &&
    conn.auth_kind === 'oauth2'
  ) {
    try {
      const refresh = conn.refresh_sealed
        ? await openValue(conn.refresh_sealed)
        : await openValue(conn.access_sealed);
      await getOutboundOAuthClient().revoke({ provider: resolved.descriptor, token: refresh });
    } catch {
      // Never let a provider revoke failure block the local disconnect.
    }
  }
  return store.deleteConnection(appId, owner, provider);
}

// --- broker: a FRESH, valid access token (transparent auto-refresh) -------------
// In-process mutex per (app, owner, provider) so parallel calls don't stampede the provider's refresh
// endpoint (and don't race two refreshes that could each rotate the refresh token out from under the other).
const refreshLocks = new Map<string, Promise<unknown>>();
function withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = refreshLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  refreshLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export interface GetTokenInput {
  appId: string;
  owner: string;
  provider: string;
  // Optional: require the connection to hold this scope (else a clear error the app can act on).
  requireScope?: string;
}

export async function getFreshAccessToken(input: GetTokenInput): Promise<FreshToken> {
  const store = await backend();
  const key = `${input.appId} ${input.owner} ${input.provider}`;
  return withRefreshLock(key, async () => {
    const conn = await store.getConnection(input.appId, input.owner, input.provider);
    if (!conn) throw notConnected(input.provider);
    if (input.requireScope && !conn.scopes.includes(input.requireScope)) {
      throw new ForgeError({
        code: 'insufficient_scope',
        message: `The "${input.provider}" connection was not granted the required scope "${input.requireScope}". The user must reconnect and grant it.`,
        status: 403,
        retry: 'needs-human',
        details: { provider: input.provider, required_scope: input.requireScope },
      });
    }

    // ⛔ A basic connection has no bearer token to hand out, ever. Refuse BEFORE reading any token
    // field, so the failure names the real cause instead of dying on an undefined ciphertext.
    if (conn.auth_kind !== 'oauth2') throw wrongAuthKind(input.provider, 'oauth2');

    // Still valid (with skew)? Return the stored access token.
    if (new Date(conn.access_expires_at).getTime() - REFRESH_SKEW_SECONDS * 1000 > Date.now()) {
      return freshFrom(conn, await openValue(conn.access_sealed));
    }

    // Expired → refresh. No refresh token ⇒ the user must reconnect.
    if (!conn.refresh_sealed) {
      await store.putConnection(input.appId, { ...conn, status: 'expired', updated_at: nowIso() });
      throw reconnectRequired(input.provider, 'no refresh token on file');
    }
    const resolved = await resolveProvider(input.appId, input.provider);
    if (!resolved) throw connectorNotConfigured(input.provider);
    if (resolved.auth_kind !== 'oauth2') throw wrongAuthKind(input.provider, 'oauth2');

    let tokens;
    try {
      tokens = await getOutboundOAuthClient().refresh({
        provider: resolved.descriptor,
        clientId: resolved.clientId,
        clientSecret: resolved.clientSecret,
        refreshToken: await openValue(conn.refresh_sealed),
      });
    } catch (e) {
      // A hard refresh failure (revoked/expired refresh) ⇒ mark expired + require reconnect.
      await store.putConnection(input.appId, { ...conn, status: 'expired', updated_at: nowIso() });
      throw reconnectRequired(input.provider, String((e as Error)?.message ?? e));
    }

    const now = nowIso();
    const updated: OAuthConnection = {
      ...conn,
      access_sealed: await sealValue(tokens.access_token),
      ...(tokens.refresh_token ? { refresh_sealed: await sealValue(tokens.refresh_token) } : {}),
      access_expires_at: expiresAt(tokens.expires_in, new Date(now)),
      ...(tokens.scope ? { scopes: parseScopes(tokens.scope) } : {}),
      status: 'connected',
      updated_at: now,
    };
    await store.putConnection(input.appId, updated);
    return freshFrom(updated, tokens.access_token);
  });
}

function freshFrom(conn: OAuthConnection, accessToken: string): FreshToken {
  return {
    access_token: accessToken,
    provider: conn.provider,
    scopes: conn.scopes,
    expires_at: conn.access_expires_at,
    ...(conn.account_label ? { account_label: conn.account_label } : {}),
  };
}

// Return the SET UNION of two scope lists — always a superset. Used by completeConnect to prevent a
// partial Microsoft re-consent from NARROWING the stored grant (Microsoft has no `include_granted_scopes`
// so the callback's scope list can be smaller than the previously-stored set).
export function unionScopes(existing: string[], incoming: string[]): string[] {
  const s = new Set([...existing, ...incoming]);
  return [...s].sort(); // deterministic order for tests + storage
}

// Re-exported for callers building a discovery surface.
export { scopeString };
