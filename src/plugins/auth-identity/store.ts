// C10 identity store — the platform-owned, multi-user, DURABLE user/session/token store behind the
// auth-identity Implementation.
//
// P26: this module is now a thin FACADE. The actual persistence lives behind the pluggable
// IdentityBackend interface (src/storage/backends/identity), selected by config —
// FORGE_IDENTITY_BACKEND=filesystem (default; one JSON doc per app under the gitignored state dir,
// per-app async mutex + atomic temp+rename) or =postgres (transactional, multi-replica-safe). The
// exported function signatures + types are UNCHANGED, so `api/auth-routes.ts`, `inspect`, and the
// test suite are contract-stable and don't know which backend runs. It remains deliberately NOT a
// Forge Resource: password hashes + session material never surface through the generic `/resources`
// read API, like the C5 secrets vault.

import { getBackends } from '../../storage/backends';
import type {
  Provider as BackendProvider,
  StoredUser as BackendStoredUser,
  StoredSession as BackendStoredSession,
  StoredRefreshToken as BackendStoredRefreshToken,
  RefreshRedeem as BackendRefreshRedeem,
  NewUser,
  UpdateUserPatch,
  PutRefreshTokenInput,
  RedeemOpts,
} from '../../storage/backends/identity/types';

// Re-export the domain types + shared helpers at their original path (importers are unchanged).
export type Provider = BackendProvider;
export type StoredUser = BackendStoredUser;
export type StoredSession = BackendStoredSession;
export type StoredRefreshToken = BackendStoredRefreshToken;
export type RefreshRedeem = BackendRefreshRedeem;
export { EmailTakenError, canonicalEmail } from '../../storage/backends/identity/types';

const backend = () => getBackends().then((b) => b.identity);

// --- users ----------------------------------------------------------------------

export async function createUser(appId: string, input: NewUser): Promise<StoredUser> {
  return (await backend()).createUser(appId, input);
}

export async function getUser(appId: string, userId: string): Promise<StoredUser | null> {
  return (await backend()).getUser(appId, userId);
}

export async function findByEmail(appId: string, email: string): Promise<StoredUser | null> {
  return (await backend()).findByEmail(appId, email);
}

export async function findByProvider(appId: string, provider: Provider, providerUserId: string): Promise<StoredUser | null> {
  return (await backend()).findByProvider(appId, provider, providerUserId);
}

export async function updateUser(appId: string, userId: string, patch: UpdateUserPatch): Promise<StoredUser | null> {
  return (await backend()).updateUser(appId, userId, patch);
}

export async function countUsers(appId: string): Promise<number> {
  return (await backend()).countUsers(appId);
}

export async function listUsers(appId: string): Promise<StoredUser[]> {
  return (await backend()).listUsers(appId);
}

// --- sessions -------------------------------------------------------------------

export async function createSession(appId: string, userId: string, ttlSeconds: number): Promise<StoredSession> {
  return (await backend()).createSession(appId, userId, ttlSeconds);
}

export async function getSession(appId: string, sessionId: string): Promise<StoredSession | null> {
  return (await backend()).getSession(appId, sessionId);
}

export async function touchSession(appId: string, sessionId: string, ttlSeconds: number): Promise<StoredSession | null> {
  return (await backend()).touchSession(appId, sessionId, ttlSeconds);
}

export async function revokeSession(appId: string, sessionId: string): Promise<boolean> {
  return (await backend()).revokeSession(appId, sessionId);
}

export async function revokeAllUserSessions(appId: string, userId: string): Promise<number> {
  return (await backend()).revokeAllUserSessions(appId, userId);
}

export async function activeSessionCount(appId: string): Promise<number> {
  return (await backend()).activeSessionCount(appId);
}

// --- refresh tokens (P8) --------------------------------------------------------

export async function putRefreshToken(appId: string, input: PutRefreshTokenInput): Promise<StoredRefreshToken> {
  return (await backend()).putRefreshToken(appId, input);
}

export async function getRefreshToken(appId: string, tokenHash: string): Promise<StoredRefreshToken | null> {
  return (await backend()).getRefreshToken(appId, tokenHash);
}

export async function revokeSessionRefreshTokens(appId: string, sessionId: string): Promise<number> {
  return (await backend()).revokeSessionRefreshTokens(appId, sessionId);
}

export async function revokeAllUserRefreshTokens(appId: string, userId: string): Promise<number> {
  return (await backend()).revokeAllUserRefreshTokens(appId, userId);
}

export async function activeRefreshTokenCount(appId: string): Promise<number> {
  return (await backend()).activeRefreshTokenCount(appId);
}

export async function redeemRefreshToken(
  appId: string,
  presentedHash: string,
  successorHash: string,
  opts: RedeemOpts,
): Promise<RefreshRedeem> {
  return (await backend()).redeemRefreshToken(appId, presentedHash, successorHash, opts);
}

// --- verify / reset tokens ------------------------------------------------------

export async function putVerifyToken(appId: string, tokenHash: string, userId: string, ttlSeconds: number): Promise<void> {
  return (await backend()).putVerifyToken(appId, tokenHash, userId, ttlSeconds);
}

export async function putResetToken(appId: string, tokenHash: string, userId: string, ttlSeconds: number): Promise<void> {
  return (await backend()).putResetToken(appId, tokenHash, userId, ttlSeconds);
}

export async function consumeVerifyToken(appId: string, tokenHash: string): Promise<string | null> {
  return (await backend()).consumeVerifyToken(appId, tokenHash);
}

export async function consumeResetToken(appId: string, tokenHash: string): Promise<string | null> {
  return (await backend()).consumeResetToken(appId, tokenHash);
}
