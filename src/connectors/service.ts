import { randomBytes } from 'node:crypto';
import { getBackends } from '../storage/backends';
import { sealValue, openValue } from '../plugins/secrets-local/index';
import { nowIso } from '../shared/time';
import { ForgeError, notFound, dependencyUnavailable } from '../shared/errors';
import { resolveProvider } from './config';
import { getOutboundOAuthClient, newPkcePair } from './oauth-client';
import { parseScopes, scopeString } from '../mcp/oauth';
import type { Connection, ConnectRequest, ConnectionView, FreshToken } from './types';
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
    throw new ForgeError({ code: 'invalid_state', message: 'Unknown or already-used connect request (state mismatch). Start the connect flow again.', status: 400, retry: 'change-input' });
  }
  if (req.expires_at <= nowIso()) {
    throw new ForgeError({ code: 'invalid_state', message: 'The connect request expired. Start the connect flow again.', status: 400, retry: 'change-input' });
  }
  // If a session is present on the callback, it MUST be the same user who started (the state alone is
  // one-shot + unguessable, but this closes the gap where a leaked state could be replayed by another user).
  if (input.sessionOwner && input.sessionOwner !== req.owner) {
    throw new ForgeError({ code: 'owner_mismatch', message: 'The signed-in user does not match the account that started this connection.', status: 403, retry: 'needs-human' });
  }

  const resolved = await resolveProvider(input.appId, input.provider);
  if (!resolved) throw connectorNotConfigured(input.provider);
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
    throw new ForgeError({ code: 'connect_failed', message: `Could not complete the "${descriptor.id}" connection: ${String((e as Error)?.message ?? e)}`, status: 502, retry: 'retry', details: { provider: descriptor.id } });
  }

  const now = nowIso();
  const grantedScopes = tokens.scope ? parseScopes(tokens.scope) : req.scopes;
  const existing = await store.getConnection(input.appId, req.owner, descriptor.id);
  const conn: Connection = {
    owner: req.owner,
    provider: descriptor.id,
    access_sealed: await sealValue(tokens.access_token),
    // Keep the prior refresh token if the provider returned none on this exchange (Google omits it on a
    // re-consent that reuses an earlier grant).
    ...(await resolveRefreshSealed(tokens.refresh_token, existing)),
    access_expires_at: expiresAt(tokens.expires_in, new Date(now)),
    scopes: grantedScopes,
    status: 'connected',
    ...(tokens.account_label ? { account_label: tokens.account_label } : existing?.account_label ? { account_label: existing.account_label } : {}),
    connected_at: existing?.connected_at ?? now,
    updated_at: now,
  };
  await store.putConnection(input.appId, conn);
  return { connection: toConnectionView(conn), owner: req.owner, returnTo: safeReturnTo(req.return_to) };
}

async function resolveRefreshSealed(
  refreshToken: string | undefined,
  existing: Connection | null,
): Promise<Pick<Connection, 'refresh_sealed'>> {
  if (refreshToken) return { refresh_sealed: await sealValue(refreshToken) };
  if (existing?.refresh_sealed) return { refresh_sealed: existing.refresh_sealed };
  return {};
}

// Only allow a single-slash same-origin path (the C10 safeNext posture) — never an open redirect.
function safeReturnTo(returnTo: string | undefined): string {
  if (!returnTo || !returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.startsWith('/\\')) return '/';
  return returnTo;
}

// --- management -----------------------------------------------------------------
export async function listConnections(appId: string, owner: string): Promise<ConnectionView[]> {
  const conns = await (await backend()).listConnections(appId, owner);
  return conns.map(toConnectionView);
}

export async function disconnect(appId: string, owner: string, provider: string): Promise<boolean> {
  const store = await backend();
  const conn = await store.getConnection(appId, owner, provider);
  if (!conn) return false;
  // Best-effort revoke at the provider (when it supports it), then drop the local tokens regardless.
  const resolved = await resolveProvider(appId, provider);
  if (resolved?.descriptor.revoke_endpoint) {
    try {
      const refresh = conn.refresh_sealed ? await openValue(conn.refresh_sealed) : await openValue(conn.access_sealed);
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
  refreshLocks.set(key, run.then(() => undefined, () => undefined));
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
      throw new ForgeError({ code: 'insufficient_scope', message: `The "${input.provider}" connection was not granted the required scope "${input.requireScope}". The user must reconnect and grant it.`, status: 403, retry: 'needs-human', details: { provider: input.provider, required_scope: input.requireScope } });
    }

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
    const updated: Connection = {
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

function freshFrom(conn: Connection, accessToken: string): FreshToken {
  return {
    access_token: accessToken,
    provider: conn.provider,
    scopes: conn.scopes,
    expires_at: conn.access_expires_at,
    ...(conn.account_label ? { account_label: conn.account_label } : {}),
  };
}

// Re-exported for callers building a discovery surface.
export { scopeString };
