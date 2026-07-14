// P26 — the C10 identity domain types + the pluggable IdentityBackend interface.
//
// This is the SEMANTIC seam: the interface exposes the identity OPERATIONS the C10 hosted-auth
// routes need (create a user, rotate a refresh token, …), NOT storage primitives — so a filesystem
// implementation (read-modify-write a JSON doc) and a Postgres implementation (SQL + transactions)
// both satisfy the identical method set, and the auth routes never know which is running.
//
// The types below are the SAME shapes the legacy `plugins/auth-identity/store.ts` exported; that
// module now re-exports them + forwards to the configured backend, so every existing importer and
// test is unchanged (contract stability).

export type Provider = 'google';

export interface StoredUser {
  id: string;
  // Canonical (lowercased, trimmed) email — the uniqueness key.
  email: string;
  email_verified: boolean;
  // scrypt hash string (argon2/bcrypt-class); absent for an OAuth-only account.
  password_hash?: string;
  provider?: Provider;
  provider_user_id?: string;
  name?: string;
  // The designated owner/first user (migration hook, spec §8).
  is_owner: boolean;
  // O4 ownership model (baked in now so household/C31 needs NO second migration): every user is a
  // member of a personal GROUP-OF-ONE, auto-created at signup. Downstream per-user data is scoped
  // by (owner, group_id, visibility); the personal group is the default group_id for a solo account.
  // Optional on the type so the legacy filesystem backend (which has no groups table) stays valid;
  // the Postgres backend always sets it.
  personal_group_id?: string;
  created_at: string;
  updated_at: string;
}

export interface StoredSession {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked: boolean;
}

// A REFRESH-token record (P8). The RAW opaque token is never stored — the key AND `id` are its
// SHA-256 hash. Rotation is single-use: redeeming revokes it (`revoked_at`) and links its successor
// (`rotated_to`), so re-presenting an already-rotated token is a DETECTABLE reuse.
export interface StoredRefreshToken {
  id: string; // sha256(raw) — the key and the record id
  user_id: string;
  session_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  rotated_from?: string;
  rotated_to?: string;
}

// O4 — a group (a household/team, or a personal group-of-one). Carried by identity so the
// membership foundation exists before multi-member (C31) ships.
export type GroupKind = 'personal' | 'household';
export type GroupRole = 'owner' | 'member';

export interface StoredGroup {
  id: string;
  kind: GroupKind;
  name: string;
  created_at: string;
}

export interface GroupMembership {
  group_id: string;
  role: GroupRole;
}

// The resolved ownership SCOPE for a user — the primitive downstream stores use to stamp/read
// (owner, group_id, visibility) rows. A solo account resolves to its personal group-of-one.
export interface UserScope {
  owner: string; // the user id (the per-user `owner` the shipped stores already use)
  personal_group_id: string;
  memberships: GroupMembership[];
}

// The outcome of an administrative identity delete (account closure / right-to-be-forgotten). `deleted`
// is false when the identity was already absent (the op is idempotent — a no-op, not an error); `email`
// is the (canonical) address that was freed for re-registration, or null when there was nothing to delete.
export interface DeleteUserResult {
  deleted: boolean;
  email: string | null;
}

export interface NewUser {
  email: string;
  password_hash?: string;
  provider?: Provider;
  provider_user_id?: string;
  name?: string;
  email_verified?: boolean;
  is_owner?: boolean;
}

export type UpdateUserPatch = Partial<
  Pick<StoredUser, 'email_verified' | 'password_hash' | 'provider' | 'provider_user_id' | 'name' | 'is_owner'>
>;

export interface PutRefreshTokenInput {
  tokenHash: string;
  userId: string;
  sessionId: string;
  ttlSeconds: number;
  rotatedFrom?: string;
}

export interface RedeemOpts {
  refreshTtlSeconds: number;
  sessionTtlSeconds: number;
  graceSeconds?: number;
  now?: number;
}

export type RefreshRedeem =
  | { outcome: 'invalid' }
  | { outcome: 'reuse'; userId: string; sessionId: string }
  | { outcome: 'rotated'; userId: string; sessionId: string };

// A single-use verify/reset token record (raw token never stored — keyed by its SHA-256 hash).
export interface StoredSingleUseToken {
  hash: string;
  user_id: string;
  expires_at: string;
  used_at?: string;
}

// A full per-app identity snapshot — the unit of backfill (FS → PG) and dual-write mirror (PG → FS).
// It carries EXACT records (ids preserved), so a round-trip through either backend is faithful.
export interface IdentitySnapshot {
  users: StoredUser[];
  groups: StoredGroup[];
  memberships: Array<{ group_id: string; user_id: string; role: GroupRole; created_at: string }>;
  sessions: StoredSession[];
  refresh_tokens: StoredRefreshToken[];
  verify_tokens: StoredSingleUseToken[];
  reset_tokens: StoredSingleUseToken[];
}

// The migration surface a concrete backend exposes so data can move between implementations without
// going through the id-generating create* methods (which would mint different ids). Not part of the
// hot-path IdentityBackend contract — only the backfill/dual-write plumbing uses it.
export interface MigratableIdentityBackend {
  exportApp(appId: string): Promise<IdentitySnapshot>;
  importApp(appId: string, snapshot: IdentitySnapshot): Promise<void>; // replace the app's identity state
}

// Thrown by createUser when the (canonical) email already exists for the app.
export class EmailTakenError extends Error {
  constructor() {
    super('email already registered');
    this.name = 'EmailTakenError';
  }
}

export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

// The pluggable backend contract. Every method is app-scoped by `appId` (the single-app data-plane
// sidecar passes its own app id; the multi-app control plane passes per request). Implementations:
// FsIdentityBackend (JSON doc per app, the legacy default) and PgIdentityBackend (Postgres, the
// migration target). The P27 read-modify-write races are eliminated per-backend: the FS impl keeps
// the per-app async mutex + atomic temp+rename; the PG impl runs each mutation in ONE transaction.
export interface IdentityBackend {
  // users
  createUser(appId: string, input: NewUser): Promise<StoredUser>;
  getUser(appId: string, userId: string): Promise<StoredUser | null>;
  findByEmail(appId: string, email: string): Promise<StoredUser | null>;
  findByProvider(appId: string, provider: Provider, providerUserId: string): Promise<StoredUser | null>;
  updateUser(appId: string, userId: string, patch: UpdateUserPatch): Promise<StoredUser | null>;
  // Administrative teardown: remove a login identity + ALL its credentials/sessions/tokens (and its O4
  // personal group-of-one) so it can no longer authenticate and its email/handle is freed. Idempotent —
  // absent identity ⇒ { deleted: false }. Does NOT touch the consumer's own domain rows.
  deleteUser(appId: string, userId: string): Promise<DeleteUserResult>;
  countUsers(appId: string): Promise<number>;
  listUsers(appId: string): Promise<StoredUser[]>;
  // O4 scope
  getUserScope(appId: string, userId: string): Promise<UserScope | null>;
  // sessions
  createSession(appId: string, userId: string, ttlSeconds: number): Promise<StoredSession>;
  getSession(appId: string, sessionId: string): Promise<StoredSession | null>;
  touchSession(appId: string, sessionId: string, ttlSeconds: number): Promise<StoredSession | null>;
  revokeSession(appId: string, sessionId: string): Promise<boolean>;
  revokeAllUserSessions(appId: string, userId: string): Promise<number>;
  activeSessionCount(appId: string): Promise<number>;
  // refresh tokens
  putRefreshToken(appId: string, input: PutRefreshTokenInput): Promise<StoredRefreshToken>;
  getRefreshToken(appId: string, tokenHash: string): Promise<StoredRefreshToken | null>;
  revokeSessionRefreshTokens(appId: string, sessionId: string): Promise<number>;
  revokeAllUserRefreshTokens(appId: string, userId: string): Promise<number>;
  activeRefreshTokenCount(appId: string): Promise<number>;
  redeemRefreshToken(appId: string, presentedHash: string, successorHash: string, opts: RedeemOpts): Promise<RefreshRedeem>;
  // verify / reset tokens
  putVerifyToken(appId: string, tokenHash: string, userId: string, ttlSeconds: number): Promise<void>;
  putResetToken(appId: string, tokenHash: string, userId: string, ttlSeconds: number): Promise<void>;
  consumeVerifyToken(appId: string, tokenHash: string): Promise<string | null>;
  consumeResetToken(appId: string, tokenHash: string): Promise<string | null>;
  // lifecycle (test isolation + shutdown). Optional: only backends with external resources implement.
  close?(): Promise<void>;
  __truncateAllForTests?(): Promise<void>;
}
