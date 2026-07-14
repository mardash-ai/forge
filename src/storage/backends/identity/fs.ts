import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { authDir, authFile } from '../../../shared/paths';
import { newId } from '../../../shared/ids';
import { nowIso } from '../../../shared/time';
import {
  EmailTakenError,
  canonicalEmail,
  type IdentityBackend,
  type MigratableIdentityBackend,
  type IdentitySnapshot,
  type StoredUser,
  type StoredSession,
  type StoredRefreshToken,
  type NewUser,
  type UpdateUserPatch,
  type PutRefreshTokenInput,
  type RedeemOpts,
  type RefreshRedeem,
  type UserScope,
} from './types';

// P26 — the FILESYSTEM identity backend: the legacy behavior, unchanged, moved behind the
// IdentityBackend interface. One JSON doc per app under the (gitignored) state dir; every mutation is
// a read-modify-write serialized by a per-app async lock and written atomically (temp + rename), so a
// reader never sees a half-written doc and two concurrent mutations never lose an update. This is the
// DEFAULT backend — nothing regresses when Postgres is not selected.

interface StoredToken {
  user_id: string;
  expires_at: string;
  used_at?: string;
}

interface AuthDoc {
  users: Record<string, StoredUser>;
  email_index: Record<string, string>;
  provider_index: Record<string, string>;
  sessions: Record<string, StoredSession>;
  verify_tokens: Record<string, StoredToken>;
  reset_tokens: Record<string, StoredToken>;
  refresh_tokens: Record<string, StoredRefreshToken>;
}

function emptyDoc(): AuthDoc {
  return { users: {}, email_index: {}, provider_index: {}, sessions: {}, verify_tokens: {}, reset_tokens: {}, refresh_tokens: {} };
}

// A solo account is a GROUP-OF-ONE. The filesystem backend has no groups table, so it synthesizes a
// stable personal group id from the user id — coherent with the O4 model the Postgres backend stores
// for real (and where multi-member households later live).
function personalGroupId(userId: string): string {
  return `grp_${userId}`;
}

function consume(bag: Record<string, StoredToken>, tokenHash: string): string | null {
  const rec = bag[tokenHash];
  if (!rec) return null;
  if (rec.used_at) return null;
  if (new Date(rec.expires_at).getTime() <= Date.now()) return null;
  rec.used_at = nowIso();
  return rec.user_id;
}

export class FsIdentityBackend implements IdentityBackend, MigratableIdentityBackend {
  private locks = new Map<string, Promise<unknown>>();

  private async read(appId: string): Promise<AuthDoc> {
    try {
      const parsed = JSON.parse(await readFile(authFile(appId), 'utf8')) as Partial<AuthDoc>;
      return { ...emptyDoc(), ...parsed } as AuthDoc;
    } catch {
      return emptyDoc();
    }
  }

  private async writeAtomic(appId: string, doc: AuthDoc): Promise<void> {
    await mkdir(authDir(), { recursive: true });
    const file = authFile(appId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    // Mode 0600 — the doc holds password hashes; keep it owner-only, like the vault.
    await writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }

  // Serialize a read-modify-write for one app. The lock tail never rejects, so a failed mutation
  // can't wedge the next waiter.
  private mutate<T>(appId: string, fn: (doc: AuthDoc) => T | Promise<T>): Promise<T> {
    const prev = this.locks.get(appId) ?? Promise.resolve();
    const run = prev.then(async () => {
      const doc = await this.read(appId);
      const result = await fn(doc);
      await this.writeAtomic(appId, doc);
      return result;
    });
    this.locks.set(
      appId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async createUser(appId: string, input: NewUser): Promise<StoredUser> {
    const email = canonicalEmail(input.email);
    return this.mutate(appId, (doc) => {
      if (doc.email_index[email]) throw new EmailTakenError();
      const now = nowIso();
      const id = newId('user');
      const user: StoredUser = {
        id,
        email,
        email_verified: input.email_verified ?? false,
        ...(input.password_hash ? { password_hash: input.password_hash } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.provider_user_id ? { provider_user_id: input.provider_user_id } : {}),
        ...(input.name ? { name: input.name } : {}),
        is_owner: input.is_owner ?? false,
        personal_group_id: personalGroupId(id),
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

  async getUser(appId: string, userId: string): Promise<StoredUser | null> {
    return (await this.read(appId)).users[userId] ?? null;
  }

  async findByEmail(appId: string, email: string): Promise<StoredUser | null> {
    const doc = await this.read(appId);
    const id = doc.email_index[canonicalEmail(email)];
    return id ? doc.users[id] ?? null : null;
  }

  async findByProvider(appId: string, provider: string, providerUserId: string): Promise<StoredUser | null> {
    const doc = await this.read(appId);
    const id = doc.provider_index[`${provider}:${providerUserId}`];
    return id ? doc.users[id] ?? null : null;
  }

  async updateUser(appId: string, userId: string, patch: UpdateUserPatch): Promise<StoredUser | null> {
    return this.mutate(appId, (doc) => {
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

  async deleteUser(appId: string, userId: string): Promise<{ deleted: boolean; email: string | null }> {
    return this.mutate(appId, (doc) => {
      const user = doc.users[userId];
      if (!user) return { deleted: false, email: null };
      const email = user.email;
      // Remove the user row + its lookup indexes (frees the email/handle for re-registration).
      delete doc.users[userId];
      if (doc.email_index[email] === userId) delete doc.email_index[email];
      for (const [key, id] of Object.entries(doc.provider_index)) {
        if (id === userId) delete doc.provider_index[key];
      }
      // Remove every credential/session artifact so nothing can authenticate as this identity again.
      for (const [id, s] of Object.entries(doc.sessions)) if (s.user_id === userId) delete doc.sessions[id];
      for (const [id, r] of Object.entries(doc.refresh_tokens)) if (r.user_id === userId) delete doc.refresh_tokens[id];
      for (const [h, t] of Object.entries(doc.verify_tokens)) if (t.user_id === userId) delete doc.verify_tokens[h];
      for (const [h, t] of Object.entries(doc.reset_tokens)) if (t.user_id === userId) delete doc.reset_tokens[h];
      return { deleted: true, email };
    });
  }

  async countUsers(appId: string): Promise<number> {
    return Object.keys((await this.read(appId)).users).length;
  }

  async listUsers(appId: string): Promise<StoredUser[]> {
    return Object.values((await this.read(appId)).users).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  }

  async getUserScope(appId: string, userId: string): Promise<UserScope | null> {
    const user = (await this.read(appId)).users[userId];
    if (!user) return null;
    const gid = user.personal_group_id ?? personalGroupId(userId);
    return { owner: userId, personal_group_id: gid, memberships: [{ group_id: gid, role: 'owner' }] };
  }

  async createSession(appId: string, userId: string, ttlSeconds: number): Promise<StoredSession> {
    return this.mutate(appId, (doc) => {
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

  async getSession(appId: string, sessionId: string): Promise<StoredSession | null> {
    return (await this.read(appId)).sessions[sessionId] ?? null;
  }

  async touchSession(appId: string, sessionId: string, ttlSeconds: number): Promise<StoredSession | null> {
    return this.mutate(appId, (doc) => {
      const s = doc.sessions[sessionId];
      if (!s || s.revoked || new Date(s.expires_at).getTime() <= Date.now()) return null;
      const now = Date.now();
      s.last_seen_at = new Date(now).toISOString();
      s.expires_at = new Date(now + ttlSeconds * 1000).toISOString();
      return s;
    });
  }

  async revokeSession(appId: string, sessionId: string): Promise<boolean> {
    return this.mutate(appId, (doc) => {
      const s = doc.sessions[sessionId];
      if (!s) return false;
      s.revoked = true;
      return true;
    });
  }

  async revokeAllUserSessions(appId: string, userId: string): Promise<number> {
    return this.mutate(appId, (doc) => {
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

  async activeSessionCount(appId: string): Promise<number> {
    const doc = await this.read(appId);
    const now = Date.now();
    return Object.values(doc.sessions).filter((s) => !s.revoked && new Date(s.expires_at).getTime() > now).length;
  }

  async putRefreshToken(appId: string, input: PutRefreshTokenInput): Promise<StoredRefreshToken> {
    return this.mutate(appId, (doc) => {
      const now = Date.now();
      const rec: StoredRefreshToken = {
        id: input.tokenHash,
        user_id: input.userId,
        session_id: input.sessionId,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + input.ttlSeconds * 1000).toISOString(),
        revoked_at: null,
        ...(input.rotatedFrom ? { rotated_from: input.rotatedFrom } : {}),
      };
      doc.refresh_tokens[input.tokenHash] = rec;
      return rec;
    });
  }

  async getRefreshToken(appId: string, tokenHash: string): Promise<StoredRefreshToken | null> {
    return (await this.read(appId)).refresh_tokens[tokenHash] ?? null;
  }

  async revokeSessionRefreshTokens(appId: string, sessionId: string): Promise<number> {
    return this.mutate(appId, (doc) => {
      let n = 0;
      const iso = nowIso();
      for (const r of Object.values(doc.refresh_tokens)) {
        if (r.session_id === sessionId && !r.revoked_at) {
          r.revoked_at = iso;
          n++;
        }
      }
      return n;
    });
  }

  async revokeAllUserRefreshTokens(appId: string, userId: string): Promise<number> {
    return this.mutate(appId, (doc) => {
      let n = 0;
      const iso = nowIso();
      for (const r of Object.values(doc.refresh_tokens)) {
        if (r.user_id === userId && !r.revoked_at) {
          r.revoked_at = iso;
          n++;
        }
      }
      return n;
    });
  }

  async activeRefreshTokenCount(appId: string): Promise<number> {
    const doc = await this.read(appId);
    const now = Date.now();
    return Object.values(doc.refresh_tokens).filter((r) => !r.revoked_at && new Date(r.expires_at).getTime() > now).length;
  }

  async redeemRefreshToken(appId: string, presentedHash: string, successorHash: string, opts: RedeemOpts): Promise<RefreshRedeem> {
    const grace = opts.graceSeconds ?? 0;
    return this.mutate(appId, (doc) => {
      const nowMs = opts.now ?? Date.now();
      const iso = new Date(nowMs).toISOString();
      const rec = doc.refresh_tokens[presentedHash];
      if (!rec) return { outcome: 'invalid' };
      if (new Date(rec.expires_at).getTime() <= nowMs) return { outcome: 'invalid' };

      const mintSuccessor = (): void => {
        doc.refresh_tokens[successorHash] = {
          id: successorHash,
          user_id: rec.user_id,
          session_id: rec.session_id,
          created_at: iso,
          expires_at: new Date(nowMs + opts.refreshTtlSeconds * 1000).toISOString(),
          revoked_at: null,
          rotated_from: rec.id,
        };
        const s = doc.sessions[rec.session_id];
        if (s) {
          s.last_seen_at = iso;
          s.expires_at = new Date(nowMs + opts.sessionTtlSeconds * 1000).toISOString();
        }
      };
      const sessionLive = (): boolean => {
        const s = doc.sessions[rec.session_id];
        return Boolean(s && !s.revoked && new Date(s.expires_at).getTime() > nowMs);
      };

      if (rec.revoked_at) {
        if (rec.rotated_to) {
          const withinGrace = nowMs - new Date(rec.revoked_at).getTime() < grace * 1000;
          if (withinGrace && sessionLive()) {
            mintSuccessor();
            return { outcome: 'rotated', userId: rec.user_id, sessionId: rec.session_id };
          }
          for (const r of Object.values(doc.refresh_tokens)) {
            if (r.session_id === rec.session_id && !r.revoked_at) r.revoked_at = iso;
          }
          const s = doc.sessions[rec.session_id];
          if (s) s.revoked = true;
          return { outcome: 'reuse', userId: rec.user_id, sessionId: rec.session_id };
        }
        return { outcome: 'invalid' };
      }

      if (!sessionLive()) return { outcome: 'invalid' };
      rec.revoked_at = iso;
      rec.rotated_to = successorHash;
      mintSuccessor();
      return { outcome: 'rotated', userId: rec.user_id, sessionId: rec.session_id };
    });
  }

  async putVerifyToken(appId: string, tokenHash: string, userId: string, ttlSeconds: number): Promise<void> {
    await this.mutate(appId, (doc) => {
      doc.verify_tokens[tokenHash] = { user_id: userId, expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
    });
  }

  async putResetToken(appId: string, tokenHash: string, userId: string, ttlSeconds: number): Promise<void> {
    await this.mutate(appId, (doc) => {
      doc.reset_tokens[tokenHash] = { user_id: userId, expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
    });
  }

  async consumeVerifyToken(appId: string, tokenHash: string): Promise<string | null> {
    return this.mutate(appId, (doc) => consume(doc.verify_tokens, tokenHash));
  }

  async consumeResetToken(appId: string, tokenHash: string): Promise<string | null> {
    return this.mutate(appId, (doc) => consume(doc.reset_tokens, tokenHash));
  }

  // --- migration surface (backfill target / dual-write mirror) -------------
  async exportApp(appId: string): Promise<IdentitySnapshot> {
    const doc = await this.read(appId);
    const users = Object.values(doc.users);
    return {
      users,
      // FS has no groups table — a solo account IS a group-of-one; synthesize the records.
      groups: users.map((u) => ({ id: u.personal_group_id ?? personalGroupId(u.id), kind: 'personal' as const, name: u.email, created_at: u.created_at })),
      memberships: users.map((u) => ({ group_id: u.personal_group_id ?? personalGroupId(u.id), user_id: u.id, role: 'owner' as const, created_at: u.created_at })),
      sessions: Object.values(doc.sessions),
      refresh_tokens: Object.values(doc.refresh_tokens),
      verify_tokens: Object.entries(doc.verify_tokens).map(([hash, t]) => ({ hash, user_id: t.user_id, expires_at: t.expires_at, ...(t.used_at ? { used_at: t.used_at } : {}) })),
      reset_tokens: Object.entries(doc.reset_tokens).map(([hash, t]) => ({ hash, user_id: t.user_id, expires_at: t.expires_at, ...(t.used_at ? { used_at: t.used_at } : {}) })),
    };
  }

  async importApp(appId: string, snap: IdentitySnapshot): Promise<void> {
    await this.mutate(appId, (doc) => {
      doc.users = {}; doc.email_index = {}; doc.provider_index = {};
      doc.sessions = {}; doc.verify_tokens = {}; doc.reset_tokens = {}; doc.refresh_tokens = {};
      for (const u of snap.users) {
        doc.users[u.id] = u;
        doc.email_index[u.email] = u.id;
        if (u.provider && u.provider_user_id) doc.provider_index[`${u.provider}:${u.provider_user_id}`] = u.id;
      }
      for (const s of snap.sessions) doc.sessions[s.id] = s;
      for (const r of snap.refresh_tokens) doc.refresh_tokens[r.id] = r;
      for (const t of snap.verify_tokens) doc.verify_tokens[t.hash] = { user_id: t.user_id, expires_at: t.expires_at, ...(t.used_at ? { used_at: t.used_at } : {}) };
      for (const t of snap.reset_tokens) doc.reset_tokens[t.hash] = { user_id: t.user_id, expires_at: t.expires_at, ...(t.used_at ? { used_at: t.used_at } : {}) };
    });
  }
}
