import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { authDir, authFile } from '../../shared/paths';
import { newId } from '../../shared/ids';
import { nowIso } from '../../shared/time';

// C10 identity store — the platform-owned, multi-user, DURABLE user/session/token
// store behind the auth-identity Implementation. One JSON doc per app under the
// (gitignored) state dir. It is DELIBERATELY not a Forge Resource: password hashes
// and session material must never be reachable through the generic `/resources`
// read API, so this store is private like the C5 secrets vault.
//
// Durability: survives restart (a plain file). Concurrency: every mutation is a
// read-modify-write of the whole per-app doc, serialized by a per-app async lock
// (so two concurrent signups can't clobber each other), and the file is replaced
// atomically (temp + rename) so a reader never sees a half-written doc — the same
// discipline the notifications store uses.

export type Provider = 'google';

export interface StoredUser {
  id: string;
  // Canonical (lowercased, trimmed) email — the uniqueness key.
  email: string;
  email_verified: boolean;
  // Argon2/bcrypt-class hash string (scrypt); absent for an OAuth-only account.
  password_hash?: string;
  provider?: Provider;
  provider_user_id?: string;
  name?: string;
  // The designated owner/first user (migration hook, spec §8).
  is_owner: boolean;
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

// A verify/reset token record. The RAW token is never stored — the key is its
// SHA-256 hash, so a leak of this store can't be used to verify/reset an account.
interface StoredToken {
  user_id: string;
  expires_at: string;
  used_at?: string;
}

interface AuthDoc {
  users: Record<string, StoredUser>;
  email_index: Record<string, string>; // emailLower -> userId
  provider_index: Record<string, string>; // "provider:providerUserId" -> userId
  sessions: Record<string, StoredSession>;
  verify_tokens: Record<string, StoredToken>; // tokenHash -> record
  reset_tokens: Record<string, StoredToken>; // tokenHash -> record
}

function emptyDoc(): AuthDoc {
  return { users: {}, email_index: {}, provider_index: {}, sessions: {}, verify_tokens: {}, reset_tokens: {} };
}

export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

// --- durable I/O + per-app lock -------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

async function read(appId: string): Promise<AuthDoc> {
  try {
    const parsed = JSON.parse(await readFile(authFile(appId), 'utf8')) as Partial<AuthDoc>;
    return { ...emptyDoc(), ...parsed } as AuthDoc;
  } catch {
    return emptyDoc();
  }
}

async function writeAtomic(appId: string, doc: AuthDoc): Promise<void> {
  await mkdir(authDir(), { recursive: true });
  const file = authFile(appId);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  // Mode 0600 — the doc holds password hashes; keep it owner-only, like the vault.
  await writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

// Serialize a read-modify-write for one app. The lock tail never rejects, so a
// failed mutation can't wedge the next waiter.
function mutate<T>(appId: string, fn: (doc: AuthDoc) => T | Promise<T>): Promise<T> {
  const prev = locks.get(appId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const doc = await read(appId);
    const result = await fn(doc);
    await writeAtomic(appId, doc);
    return result;
  });
  locks.set(
    appId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// --- users ----------------------------------------------------------------------

export class EmailTakenError extends Error {
  constructor() {
    super('email already registered');
    this.name = 'EmailTakenError';
  }
}

export async function createUser(
  appId: string,
  input: {
    email: string;
    password_hash?: string;
    provider?: Provider;
    provider_user_id?: string;
    name?: string;
    email_verified?: boolean;
    is_owner?: boolean;
  },
): Promise<StoredUser> {
  const email = canonicalEmail(input.email);
  return mutate(appId, (doc) => {
    if (doc.email_index[email]) throw new EmailTakenError();
    const now = nowIso();
    const user: StoredUser = {
      id: newId('user'),
      email,
      email_verified: input.email_verified ?? false,
      ...(input.password_hash ? { password_hash: input.password_hash } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.provider_user_id ? { provider_user_id: input.provider_user_id } : {}),
      ...(input.name ? { name: input.name } : {}),
      is_owner: input.is_owner ?? false,
      created_at: now,
      updated_at: now,
    };
    doc.users[user.id] = user;
    doc.email_index[email] = user.id;
    if (input.provider && input.provider_user_id) {
      doc.provider_index[`${input.provider}:${input.provider_user_id}`] = user.id;
    }
    return user;
  });
}

export async function getUser(appId: string, userId: string): Promise<StoredUser | null> {
  const doc = await read(appId);
  return doc.users[userId] ?? null;
}

export async function findByEmail(appId: string, email: string): Promise<StoredUser | null> {
  const doc = await read(appId);
  const id = doc.email_index[canonicalEmail(email)];
  return id ? doc.users[id] ?? null : null;
}

export async function findByProvider(
  appId: string,
  provider: Provider,
  providerUserId: string,
): Promise<StoredUser | null> {
  const doc = await read(appId);
  const id = doc.provider_index[`${provider}:${providerUserId}`];
  return id ? doc.users[id] ?? null : null;
}

// Patch a user's mutable fields (verification, password, provider link, name, owner).
export async function updateUser(
  appId: string,
  userId: string,
  patch: Partial<Pick<StoredUser, 'email_verified' | 'password_hash' | 'provider' | 'provider_user_id' | 'name' | 'is_owner'>>,
): Promise<StoredUser | null> {
  return mutate(appId, (doc) => {
    const user = doc.users[userId];
    if (!user) return null;
    Object.assign(user, patch);
    user.updated_at = nowIso();
    if (patch.provider && patch.provider_user_id) {
      doc.provider_index[`${patch.provider}:${patch.provider_user_id}`] = user.id;
    }
    return user;
  });
}

export async function countUsers(appId: string): Promise<number> {
  return Object.keys((await read(appId)).users).length;
}

export async function listUsers(appId: string): Promise<StoredUser[]> {
  return Object.values((await read(appId)).users).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

// --- sessions -------------------------------------------------------------------

export async function createSession(appId: string, userId: string, ttlSeconds: number): Promise<StoredSession> {
  return mutate(appId, (doc) => {
    const now = Date.now();
    const session: StoredSession = {
      id: newId('sess'),
      user_id: userId,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
      last_seen_at: new Date(now).toISOString(),
      revoked: false,
    };
    doc.sessions[session.id] = session;
    return session;
  });
}

export async function getSession(appId: string, sessionId: string): Promise<StoredSession | null> {
  const doc = await read(appId);
  return doc.sessions[sessionId] ?? null;
}

// Sliding expiry: extend a live (unrevoked, unexpired) session and return it.
export async function touchSession(appId: string, sessionId: string, ttlSeconds: number): Promise<StoredSession | null> {
  return mutate(appId, (doc) => {
    const s = doc.sessions[sessionId];
    if (!s || s.revoked || new Date(s.expires_at).getTime() <= Date.now()) return null;
    const now = Date.now();
    s.last_seen_at = new Date(now).toISOString();
    s.expires_at = new Date(now + ttlSeconds * 1000).toISOString();
    return s;
  });
}

export async function revokeSession(appId: string, sessionId: string): Promise<boolean> {
  return mutate(appId, (doc) => {
    const s = doc.sessions[sessionId];
    if (!s) return false;
    s.revoked = true;
    return true;
  });
}

export async function revokeAllUserSessions(appId: string, userId: string): Promise<number> {
  return mutate(appId, (doc) => {
    let n = 0;
    for (const s of Object.values(doc.sessions)) {
      if (s.user_id === userId && !s.revoked) {
        s.revoked = true;
        n++;
      }
    }
    return n;
  });
}

export async function activeSessionCount(appId: string): Promise<number> {
  const doc = await read(appId);
  const now = Date.now();
  return Object.values(doc.sessions).filter((s) => !s.revoked && new Date(s.expires_at).getTime() > now).length;
}

// --- verify / reset tokens ------------------------------------------------------

export async function putVerifyToken(appId: string, tokenHash: string, userId: string, ttlSeconds: number): Promise<void> {
  await mutate(appId, (doc) => {
    doc.verify_tokens[tokenHash] = { user_id: userId, expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  });
}

export async function putResetToken(appId: string, tokenHash: string, userId: string, ttlSeconds: number): Promise<void> {
  await mutate(appId, (doc) => {
    doc.reset_tokens[tokenHash] = { user_id: userId, expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  });
}

// Consume a single-use token: valid only if present, unexpired, and unused. Marks
// it used (single-use) and returns the user id — or null for any failure.
export async function consumeVerifyToken(appId: string, tokenHash: string): Promise<string | null> {
  return mutate(appId, (doc) => consume(doc.verify_tokens, tokenHash));
}

export async function consumeResetToken(appId: string, tokenHash: string): Promise<string | null> {
  return mutate(appId, (doc) => consume(doc.reset_tokens, tokenHash));
}

function consume(bag: Record<string, StoredToken>, tokenHash: string): string | null {
  const rec = bag[tokenHash];
  if (!rec) return null;
  if (rec.used_at) return null;
  if (new Date(rec.expires_at).getTime() <= Date.now()) return null;
  rec.used_at = nowIso();
  return rec.user_id;
}
