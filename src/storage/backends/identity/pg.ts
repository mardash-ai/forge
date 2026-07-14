import type { Pool, PoolClient } from 'pg';
import { newId } from '../../../shared/ids';
import { nowIso } from '../../../shared/time';
import {
  EmailTakenError,
  canonicalEmail,
  type IdentityBackend,
  type StoredUser,
  type StoredSession,
  type StoredRefreshToken,
  type NewUser,
  type UpdateUserPatch,
  type PutRefreshTokenInput,
  type RedeemOpts,
  type RefreshRedeem,
  type UserScope,
  type GroupMembership,
  type GroupRole,
  type MigratableIdentityBackend,
  type IdentitySnapshot,
  type StoredGroup,
} from './types';

// P26 — the POSTGRES identity backend: the migration target for C10. Same IdentityBackend contract
// the filesystem backend satisfies, so the auth routes never change. Every MUTATION runs in ONE
// transaction, which is where the P27 read-modify-write race is eliminated structurally (no lock, no
// torn write — the DB serializes). All rows are app-scoped by `app_id` (the sidecar's single app; the
// control plane's per-request app). The O4 ownership model is baked in: creating a user also creates
// a personal GROUP-OF-ONE + an owner membership in the same transaction, so multi-member households
// (C31) light up later with NO second migration.

// ---------------------------------------------------------------------------
// Schema (idempotent). Called once at boot / first use.
// ---------------------------------------------------------------------------
export async function ensureIdentitySchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_identity_users (
      app_id            text        NOT NULL,
      id                text        NOT NULL,
      email             text        NOT NULL,
      email_verified    boolean     NOT NULL DEFAULT false,
      password_hash     text,
      provider          text,
      provider_user_id  text,
      name              text,
      is_owner          boolean     NOT NULL DEFAULT false,
      personal_group_id text,
      created_at        timestamptz NOT NULL,
      updated_at        timestamptz NOT NULL,
      PRIMARY KEY (app_id, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS forge_identity_users_email
      ON forge_identity_users (app_id, email);
    CREATE UNIQUE INDEX IF NOT EXISTS forge_identity_users_provider
      ON forge_identity_users (app_id, provider, provider_user_id)
      WHERE provider IS NOT NULL AND provider_user_id IS NOT NULL;

    -- O4: groups (personal group-of-one now; households later) + memberships.
    CREATE TABLE IF NOT EXISTS forge_identity_groups (
      app_id     text        NOT NULL,
      id         text        NOT NULL,
      kind       text        NOT NULL DEFAULT 'personal',
      name       text        NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL,
      PRIMARY KEY (app_id, id)
    );
    CREATE TABLE IF NOT EXISTS forge_identity_group_members (
      app_id     text        NOT NULL,
      group_id   text        NOT NULL,
      user_id    text        NOT NULL,
      role       text        NOT NULL DEFAULT 'member',
      created_at timestamptz NOT NULL,
      PRIMARY KEY (app_id, group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS forge_identity_group_members_user
      ON forge_identity_group_members (app_id, user_id);

    CREATE TABLE IF NOT EXISTS forge_identity_sessions (
      app_id       text        NOT NULL,
      id           text        NOT NULL,
      user_id      text        NOT NULL,
      created_at   timestamptz NOT NULL,
      expires_at   timestamptz NOT NULL,
      last_seen_at timestamptz NOT NULL,
      revoked      boolean     NOT NULL DEFAULT false,
      PRIMARY KEY (app_id, id)
    );
    CREATE INDEX IF NOT EXISTS forge_identity_sessions_user
      ON forge_identity_sessions (app_id, user_id);

    CREATE TABLE IF NOT EXISTS forge_identity_refresh_tokens (
      app_id       text        NOT NULL,
      id           text        NOT NULL,   -- sha256(raw opaque token)
      user_id      text        NOT NULL,
      session_id   text        NOT NULL,
      created_at   timestamptz NOT NULL,
      expires_at   timestamptz NOT NULL,
      revoked_at   timestamptz,
      rotated_from text,
      rotated_to   text,
      PRIMARY KEY (app_id, id)
    );
    CREATE INDEX IF NOT EXISTS forge_identity_refresh_session
      ON forge_identity_refresh_tokens (app_id, session_id);
    CREATE INDEX IF NOT EXISTS forge_identity_refresh_user
      ON forge_identity_refresh_tokens (app_id, user_id);

    CREATE TABLE IF NOT EXISTS forge_identity_verify_tokens (
      app_id text NOT NULL, id text NOT NULL, user_id text NOT NULL,
      expires_at timestamptz NOT NULL, used_at timestamptz,
      PRIMARY KEY (app_id, id)
    );
    CREATE TABLE IF NOT EXISTS forge_identity_reset_tokens (
      app_id text NOT NULL, id text NOT NULL, user_id text NOT NULL,
      expires_at timestamptz NOT NULL, used_at timestamptz,
      PRIMARY KEY (app_id, id)
    );
  `);
}

// ---------------------------------------------------------------------------
// Row → domain mapping (parity with the FS backend: absent optionals are OMITTED, timestamps ISO).
// ---------------------------------------------------------------------------
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

interface UserRow {
  id: string; email: string; email_verified: boolean; password_hash: string | null;
  provider: string | null; provider_user_id: string | null; name: string | null;
  is_owner: boolean; personal_group_id: string | null; created_at: Date; updated_at: Date;
}

function rowToUser(r: UserRow): StoredUser {
  return {
    id: r.id,
    email: r.email,
    email_verified: r.email_verified,
    ...(r.password_hash != null ? { password_hash: r.password_hash } : {}),
    ...(r.provider != null ? { provider: r.provider as StoredUser['provider'] } : {}),
    ...(r.provider_user_id != null ? { provider_user_id: r.provider_user_id } : {}),
    ...(r.name != null ? { name: r.name } : {}),
    is_owner: r.is_owner,
    ...(r.personal_group_id != null ? { personal_group_id: r.personal_group_id } : {}),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

interface SessionRow { id: string; user_id: string; created_at: Date; expires_at: Date; last_seen_at: Date; revoked: boolean; }
function rowToSession(r: SessionRow): StoredSession {
  return {
    id: r.id, user_id: r.user_id,
    created_at: iso(r.created_at), expires_at: iso(r.expires_at), last_seen_at: iso(r.last_seen_at),
    revoked: r.revoked,
  };
}

interface RefreshRow { id: string; user_id: string; session_id: string; created_at: Date; expires_at: Date; revoked_at: Date | null; rotated_from: string | null; rotated_to: string | null; }
function rowToRefresh(r: RefreshRow): StoredRefreshToken {
  return {
    id: r.id, user_id: r.user_id, session_id: r.session_id,
    created_at: iso(r.created_at), expires_at: iso(r.expires_at),
    revoked_at: isoOrNull(r.revoked_at),
    ...(r.rotated_from != null ? { rotated_from: r.rotated_from } : {}),
    ...(r.rotated_to != null ? { rotated_to: r.rotated_to } : {}),
  };
}

export class PgIdentityBackend implements IdentityBackend, MigratableIdentityBackend {
  constructor(private readonly pool: Pool) {}

  private async withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }

  // --- users ---------------------------------------------------------------
  async createUser(appId: string, input: NewUser): Promise<StoredUser> {
    const email = canonicalEmail(input.email);
    const id = newId('user');
    const groupId = newId('grp');
    const now = nowIso();
    return this.withTx(async (c) => {
      const inserted = await c.query<UserRow>(
        `INSERT INTO forge_identity_users
           (app_id,id,email,email_verified,password_hash,provider,provider_user_id,name,is_owner,personal_group_id,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         ON CONFLICT (app_id, email) DO NOTHING
         RETURNING *`,
        [
          appId, id, email, input.email_verified ?? false, input.password_hash ?? null,
          input.provider ?? null, input.provider_user_id ?? null, input.name ?? null,
          input.is_owner ?? false, groupId, now,
        ],
      );
      if (inserted.rowCount === 0) throw new EmailTakenError();
      // O4: personal group-of-one + owner membership, same transaction.
      await c.query(
        `INSERT INTO forge_identity_groups (app_id,id,kind,name,created_at) VALUES ($1,$2,'personal',$3,$4)`,
        [appId, groupId, email, now],
      );
      await c.query(
        `INSERT INTO forge_identity_group_members (app_id,group_id,user_id,role,created_at) VALUES ($1,$2,$3,'owner',$4)`,
        [appId, groupId, id, now],
      );
      return rowToUser(inserted.rows[0]!);
    });
  }

  async getUser(appId: string, userId: string): Promise<StoredUser | null> {
    const r = await this.pool.query<UserRow>('SELECT * FROM forge_identity_users WHERE app_id=$1 AND id=$2', [appId, userId]);
    return r.rows[0] ? rowToUser(r.rows[0]) : null;
  }

  async findByEmail(appId: string, email: string): Promise<StoredUser | null> {
    const r = await this.pool.query<UserRow>('SELECT * FROM forge_identity_users WHERE app_id=$1 AND email=$2', [appId, canonicalEmail(email)]);
    return r.rows[0] ? rowToUser(r.rows[0]) : null;
  }

  async findByProvider(appId: string, provider: string, providerUserId: string): Promise<StoredUser | null> {
    const r = await this.pool.query<UserRow>(
      'SELECT * FROM forge_identity_users WHERE app_id=$1 AND provider=$2 AND provider_user_id=$3',
      [appId, provider, providerUserId],
    );
    return r.rows[0] ? rowToUser(r.rows[0]) : null;
  }

  async updateUser(appId: string, userId: string, patch: UpdateUserPatch): Promise<StoredUser | null> {
    return this.withTx(async (c) => {
      const cur = await c.query<UserRow>('SELECT * FROM forge_identity_users WHERE app_id=$1 AND id=$2 FOR UPDATE', [appId, userId]);
      if (cur.rowCount === 0) return null;
      const u = cur.rows[0]!;
      const next = {
        email_verified: patch.email_verified ?? u.email_verified,
        password_hash: patch.password_hash ?? u.password_hash,
        provider: patch.provider ?? u.provider,
        provider_user_id: patch.provider_user_id ?? u.provider_user_id,
        name: patch.name ?? u.name,
        is_owner: patch.is_owner ?? u.is_owner,
      };
      const upd = await c.query<UserRow>(
        `UPDATE forge_identity_users
           SET email_verified=$3, password_hash=$4, provider=$5, provider_user_id=$6, name=$7, is_owner=$8, updated_at=$9
         WHERE app_id=$1 AND id=$2 RETURNING *`,
        [appId, userId, next.email_verified, next.password_hash, next.provider, next.provider_user_id, next.name, next.is_owner, nowIso()],
      );
      return rowToUser(upd.rows[0]!);
    });
  }

  async deleteUser(appId: string, userId: string): Promise<{ deleted: boolean; email: string | null }> {
    return this.withTx(async (c) => {
      // Lock + read the row so we return the freed email and the personal group to also delete.
      const cur = await c.query<{ email: string; personal_group_id: string | null }>(
        'SELECT email, personal_group_id FROM forge_identity_users WHERE app_id=$1 AND id=$2 FOR UPDATE',
        [appId, userId],
      );
      if (cur.rowCount === 0) return { deleted: false, email: null };
      const { email, personal_group_id } = cur.rows[0]!;
      // Credentials/sessions/tokens first, then the O4 personal group-of-one + memberships, then the user.
      await c.query('DELETE FROM forge_identity_refresh_tokens WHERE app_id=$1 AND user_id=$2', [appId, userId]);
      await c.query('DELETE FROM forge_identity_sessions WHERE app_id=$1 AND user_id=$2', [appId, userId]);
      await c.query('DELETE FROM forge_identity_verify_tokens WHERE app_id=$1 AND user_id=$2', [appId, userId]);
      await c.query('DELETE FROM forge_identity_reset_tokens WHERE app_id=$1 AND user_id=$2', [appId, userId]);
      await c.query('DELETE FROM forge_identity_group_members WHERE app_id=$1 AND user_id=$2', [appId, userId]);
      if (personal_group_id) {
        await c.query('DELETE FROM forge_identity_groups WHERE app_id=$1 AND id=$2', [appId, personal_group_id]);
      }
      await c.query('DELETE FROM forge_identity_users WHERE app_id=$1 AND id=$2', [appId, userId]);
      return { deleted: true, email };
    });
  }

  async countUsers(appId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM forge_identity_users WHERE app_id=$1', [appId]);
    return Number(r.rows[0]!.n);
  }

  async listUsers(appId: string): Promise<StoredUser[]> {
    const r = await this.pool.query<UserRow>('SELECT * FROM forge_identity_users WHERE app_id=$1 ORDER BY created_at ASC, id ASC', [appId]);
    return r.rows.map(rowToUser);
  }

  async getUserScope(appId: string, userId: string): Promise<UserScope | null> {
    const u = await this.pool.query<{ personal_group_id: string | null }>(
      'SELECT personal_group_id FROM forge_identity_users WHERE app_id=$1 AND id=$2', [appId, userId],
    );
    if (u.rowCount === 0) return null;
    const m = await this.pool.query<{ group_id: string; role: GroupRole }>(
      'SELECT group_id, role FROM forge_identity_group_members WHERE app_id=$1 AND user_id=$2 ORDER BY created_at ASC', [appId, userId],
    );
    const memberships: GroupMembership[] = m.rows.map((row) => ({ group_id: row.group_id, role: row.role }));
    const personal = u.rows[0]!.personal_group_id ?? (memberships[0]?.group_id ?? `grp_${userId}`);
    return { owner: userId, personal_group_id: personal, memberships };
  }

  // --- sessions ------------------------------------------------------------
  async createSession(appId: string, userId: string, ttlSeconds: number): Promise<StoredSession> {
    const now = Date.now();
    const s: StoredSession = {
      id: newId('sess'), user_id: userId,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlSeconds * 1000).toISOString(),
      last_seen_at: new Date(now).toISOString(),
      revoked: false,
    };
    await this.pool.query(
      `INSERT INTO forge_identity_sessions (app_id,id,user_id,created_at,expires_at,last_seen_at,revoked)
       VALUES ($1,$2,$3,$4,$5,$6,false)`,
      [appId, s.id, s.user_id, s.created_at, s.expires_at, s.last_seen_at],
    );
    return s;
  }

  async getSession(appId: string, sessionId: string): Promise<StoredSession | null> {
    const r = await this.pool.query<SessionRow>('SELECT * FROM forge_identity_sessions WHERE app_id=$1 AND id=$2', [appId, sessionId]);
    return r.rows[0] ? rowToSession(r.rows[0]) : null;
  }

  async touchSession(appId: string, sessionId: string, ttlSeconds: number): Promise<StoredSession | null> {
    const now = Date.now();
    const r = await this.pool.query<SessionRow>(
      `UPDATE forge_identity_sessions
         SET last_seen_at=$3, expires_at=$4
       WHERE app_id=$1 AND id=$2 AND revoked=false AND expires_at > $5
       RETURNING *`,
      [appId, sessionId, new Date(now).toISOString(), new Date(now + ttlSeconds * 1000).toISOString(), new Date(now).toISOString()],
    );
    return r.rows[0] ? rowToSession(r.rows[0]) : null;
  }

  async revokeSession(appId: string, sessionId: string): Promise<boolean> {
    const r = await this.pool.query('UPDATE forge_identity_sessions SET revoked=true WHERE app_id=$1 AND id=$2', [appId, sessionId]);
    return (r.rowCount ?? 0) > 0;
  }

  async revokeAllUserSessions(appId: string, userId: string): Promise<number> {
    const r = await this.pool.query('UPDATE forge_identity_sessions SET revoked=true WHERE app_id=$1 AND user_id=$2 AND revoked=false', [appId, userId]);
    return r.rowCount ?? 0;
  }

  async activeSessionCount(appId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM forge_identity_sessions WHERE app_id=$1 AND revoked=false AND expires_at > now()', [appId],
    );
    return Number(r.rows[0]!.n);
  }

  // --- refresh tokens ------------------------------------------------------
  async putRefreshToken(appId: string, input: PutRefreshTokenInput): Promise<StoredRefreshToken> {
    const now = Date.now();
    const rec: StoredRefreshToken = {
      id: input.tokenHash, user_id: input.userId, session_id: input.sessionId,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + input.ttlSeconds * 1000).toISOString(),
      revoked_at: null,
      ...(input.rotatedFrom ? { rotated_from: input.rotatedFrom } : {}),
    };
    await this.pool.query(
      `INSERT INTO forge_identity_refresh_tokens (app_id,id,user_id,session_id,created_at,expires_at,revoked_at,rotated_from)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7)
       ON CONFLICT (app_id,id) DO UPDATE SET
         user_id=EXCLUDED.user_id, session_id=EXCLUDED.session_id, created_at=EXCLUDED.created_at,
         expires_at=EXCLUDED.expires_at, revoked_at=NULL, rotated_from=EXCLUDED.rotated_from, rotated_to=NULL`,
      [appId, rec.id, rec.user_id, rec.session_id, rec.created_at, rec.expires_at, input.rotatedFrom ?? null],
    );
    return rec;
  }

  async getRefreshToken(appId: string, tokenHash: string): Promise<StoredRefreshToken | null> {
    const r = await this.pool.query<RefreshRow>('SELECT * FROM forge_identity_refresh_tokens WHERE app_id=$1 AND id=$2', [appId, tokenHash]);
    return r.rows[0] ? rowToRefresh(r.rows[0]) : null;
  }

  async revokeSessionRefreshTokens(appId: string, sessionId: string): Promise<number> {
    const r = await this.pool.query(
      'UPDATE forge_identity_refresh_tokens SET revoked_at=now() WHERE app_id=$1 AND session_id=$2 AND revoked_at IS NULL', [appId, sessionId],
    );
    return r.rowCount ?? 0;
  }

  async revokeAllUserRefreshTokens(appId: string, userId: string): Promise<number> {
    const r = await this.pool.query(
      'UPDATE forge_identity_refresh_tokens SET revoked_at=now() WHERE app_id=$1 AND user_id=$2 AND revoked_at IS NULL', [appId, userId],
    );
    return r.rowCount ?? 0;
  }

  async activeRefreshTokenCount(appId: string): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM forge_identity_refresh_tokens WHERE app_id=$1 AND revoked_at IS NULL AND expires_at > now()', [appId],
    );
    return Number(r.rows[0]!.n);
  }

  // The full rotation decision, ported verbatim from the FS logic but run in ONE transaction with the
  // presented token + its session row LOCKED (FOR UPDATE) — so concurrent redeems of the same token
  // serialize (the classic refresh-rotation race) with no app-level lock: P27 fixed by the DB.
  async redeemRefreshToken(appId: string, presentedHash: string, successorHash: string, opts: RedeemOpts): Promise<RefreshRedeem> {
    const grace = opts.graceSeconds ?? 0;
    const nowMs = opts.now ?? Date.now();
    const isoNow = new Date(nowMs).toISOString();
    return this.withTx(async (c) => {
      const cur = await c.query<RefreshRow>('SELECT * FROM forge_identity_refresh_tokens WHERE app_id=$1 AND id=$2 FOR UPDATE', [appId, presentedHash]);
      const rec = cur.rows[0];
      if (!rec) return { outcome: 'invalid' };
      if (new Date(rec.expires_at).getTime() <= nowMs) return { outcome: 'invalid' };

      const sessionLive = async (): Promise<boolean> => {
        const s = await c.query<SessionRow>('SELECT * FROM forge_identity_sessions WHERE app_id=$1 AND id=$2', [appId, rec.session_id]);
        const row = s.rows[0];
        return Boolean(row && !row.revoked && new Date(row.expires_at).getTime() > nowMs);
      };
      const mintSuccessor = async (): Promise<void> => {
        // Upsert (replace) — mirrors the FS backend's `doc.refresh_tokens[successor] = {…}`, which
        // unconditionally overwrites. Minting a successor hash that was used before (tests reuse hashes
        // across seeds) is a fresh, live token, not a PK violation.
        await c.query(
          `INSERT INTO forge_identity_refresh_tokens (app_id,id,user_id,session_id,created_at,expires_at,revoked_at,rotated_from,rotated_to)
           VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,NULL)
           ON CONFLICT (app_id,id) DO UPDATE SET
             user_id=EXCLUDED.user_id, session_id=EXCLUDED.session_id, created_at=EXCLUDED.created_at,
             expires_at=EXCLUDED.expires_at, revoked_at=NULL, rotated_from=EXCLUDED.rotated_from, rotated_to=NULL`,
          [appId, successorHash, rec.user_id, rec.session_id, isoNow, new Date(nowMs + opts.refreshTtlSeconds * 1000).toISOString(), rec.id],
        );
        await c.query(
          'UPDATE forge_identity_sessions SET last_seen_at=$3, expires_at=$4 WHERE app_id=$1 AND id=$2',
          [appId, rec.session_id, isoNow, new Date(nowMs + opts.sessionTtlSeconds * 1000).toISOString()],
        );
      };

      if (rec.revoked_at) {
        if (rec.rotated_to) {
          const withinGrace = nowMs - new Date(rec.revoked_at).getTime() < grace * 1000;
          if (withinGrace && (await sessionLive())) {
            await mintSuccessor();
            return { outcome: 'rotated', userId: rec.user_id, sessionId: rec.session_id };
          }
          // Breach (or dead session): revoke the whole chain + the session.
          await c.query('UPDATE forge_identity_refresh_tokens SET revoked_at=$3 WHERE app_id=$1 AND session_id=$2 AND revoked_at IS NULL', [appId, rec.session_id, isoNow]);
          await c.query('UPDATE forge_identity_sessions SET revoked=true WHERE app_id=$1 AND id=$2', [appId, rec.session_id]);
          return { outcome: 'reuse', userId: rec.user_id, sessionId: rec.session_id };
        }
        return { outcome: 'invalid' };
      }

      if (!(await sessionLive())) return { outcome: 'invalid' };
      await c.query('UPDATE forge_identity_refresh_tokens SET revoked_at=$3, rotated_to=$4 WHERE app_id=$1 AND id=$2', [appId, rec.id, isoNow, successorHash]);
      await mintSuccessor();
      return { outcome: 'rotated', userId: rec.user_id, sessionId: rec.session_id };
    });
  }

  // --- verify / reset tokens (single-use, hashed at rest) ------------------
  async putVerifyToken(appId: string, tokenHash: string, userId: string, ttlSeconds: number): Promise<void> {
    await this.putToken('forge_identity_verify_tokens', appId, tokenHash, userId, ttlSeconds);
  }
  async putResetToken(appId: string, tokenHash: string, userId: string, ttlSeconds: number): Promise<void> {
    await this.putToken('forge_identity_reset_tokens', appId, tokenHash, userId, ttlSeconds);
  }
  private async putToken(table: string, appId: string, tokenHash: string, userId: string, ttlSeconds: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${table} (app_id,id,user_id,expires_at,used_at) VALUES ($1,$2,$3,$4,NULL)
       ON CONFLICT (app_id,id) DO UPDATE SET user_id=EXCLUDED.user_id, expires_at=EXCLUDED.expires_at, used_at=NULL`,
      [appId, tokenHash, userId, new Date(Date.now() + ttlSeconds * 1000).toISOString()],
    );
  }
  async consumeVerifyToken(appId: string, tokenHash: string): Promise<string | null> {
    return this.consumeToken('forge_identity_verify_tokens', appId, tokenHash);
  }
  async consumeResetToken(appId: string, tokenHash: string): Promise<string | null> {
    return this.consumeToken('forge_identity_reset_tokens', appId, tokenHash);
  }
  // Single-use + unexpired, atomically: mark used only if currently unused AND unexpired, RETURNING
  // the user id — one statement, so a double-redeem race can't both win.
  private async consumeToken(table: string, appId: string, tokenHash: string): Promise<string | null> {
    const r = await this.pool.query<{ user_id: string }>(
      `UPDATE ${table} SET used_at=now()
       WHERE app_id=$1 AND id=$2 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [appId, tokenHash],
    );
    return r.rows[0] ? r.rows[0].user_id : null;
  }

  // --- migration surface (backfill source / dual-write target) -------------
  async exportApp(appId: string): Promise<IdentitySnapshot> {
    const [users, groups, members, sessions, refresh, verify, reset] = await Promise.all([
      this.pool.query<UserRow>('SELECT * FROM forge_identity_users WHERE app_id=$1', [appId]),
      this.pool.query<{ id: string; kind: string; name: string; created_at: Date }>('SELECT * FROM forge_identity_groups WHERE app_id=$1', [appId]),
      this.pool.query<{ group_id: string; user_id: string; role: GroupRole; created_at: Date }>('SELECT * FROM forge_identity_group_members WHERE app_id=$1', [appId]),
      this.pool.query<SessionRow>('SELECT * FROM forge_identity_sessions WHERE app_id=$1', [appId]),
      this.pool.query<RefreshRow>('SELECT * FROM forge_identity_refresh_tokens WHERE app_id=$1', [appId]),
      this.pool.query<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>('SELECT * FROM forge_identity_verify_tokens WHERE app_id=$1', [appId]),
      this.pool.query<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>('SELECT * FROM forge_identity_reset_tokens WHERE app_id=$1', [appId]),
    ]);
    const tok = (r: { id: string; user_id: string; expires_at: Date; used_at: Date | null }) => ({ hash: r.id, user_id: r.user_id, expires_at: iso(r.expires_at), ...(r.used_at ? { used_at: iso(r.used_at) } : {}) });
    return {
      users: users.rows.map(rowToUser),
      groups: groups.rows.map((g): StoredGroup => ({ id: g.id, kind: g.kind as StoredGroup['kind'], name: g.name, created_at: iso(g.created_at) })),
      memberships: members.rows.map((m) => ({ group_id: m.group_id, user_id: m.user_id, role: m.role, created_at: iso(m.created_at) })),
      sessions: sessions.rows.map(rowToSession),
      refresh_tokens: refresh.rows.map(rowToRefresh),
      verify_tokens: verify.rows.map(tok),
      reset_tokens: reset.rows.map(tok),
    };
  }

  async importApp(appId: string, snap: IdentitySnapshot): Promise<void> {
    await this.withTx(async (c) => {
      for (const t of ['forge_identity_users', 'forge_identity_groups', 'forge_identity_group_members', 'forge_identity_sessions', 'forge_identity_refresh_tokens', 'forge_identity_verify_tokens', 'forge_identity_reset_tokens']) {
        await c.query(`DELETE FROM ${t} WHERE app_id=$1`, [appId]);
      }
      for (const u of snap.users) {
        await c.query(
          `INSERT INTO forge_identity_users (app_id,id,email,email_verified,password_hash,provider,provider_user_id,name,is_owner,personal_group_id,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [appId, u.id, u.email, u.email_verified, u.password_hash ?? null, u.provider ?? null, u.provider_user_id ?? null, u.name ?? null, u.is_owner, u.personal_group_id ?? null, u.created_at, u.updated_at],
        );
      }
      for (const g of snap.groups) {
        await c.query('INSERT INTO forge_identity_groups (app_id,id,kind,name,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (app_id,id) DO NOTHING', [appId, g.id, g.kind, g.name, g.created_at]);
      }
      for (const m of snap.memberships) {
        await c.query('INSERT INTO forge_identity_group_members (app_id,group_id,user_id,role,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (app_id,group_id,user_id) DO NOTHING', [appId, m.group_id, m.user_id, m.role, m.created_at]);
      }
      for (const s of snap.sessions) {
        await c.query('INSERT INTO forge_identity_sessions (app_id,id,user_id,created_at,expires_at,last_seen_at,revoked) VALUES ($1,$2,$3,$4,$5,$6,$7)', [appId, s.id, s.user_id, s.created_at, s.expires_at, s.last_seen_at, s.revoked]);
      }
      for (const r of snap.refresh_tokens) {
        await c.query('INSERT INTO forge_identity_refresh_tokens (app_id,id,user_id,session_id,created_at,expires_at,revoked_at,rotated_from,rotated_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [appId, r.id, r.user_id, r.session_id, r.created_at, r.expires_at, r.revoked_at, r.rotated_from ?? null, r.rotated_to ?? null]);
      }
      for (const t of snap.verify_tokens) {
        await c.query('INSERT INTO forge_identity_verify_tokens (app_id,id,user_id,expires_at,used_at) VALUES ($1,$2,$3,$4,$5)', [appId, t.hash, t.user_id, t.expires_at, t.used_at ?? null]);
      }
      for (const t of snap.reset_tokens) {
        await c.query('INSERT INTO forge_identity_reset_tokens (app_id,id,user_id,expires_at,used_at) VALUES ($1,$2,$3,$4,$5)', [appId, t.hash, t.user_id, t.expires_at, t.used_at ?? null]);
      }
    });
  }

  // --- test isolation ------------------------------------------------------
  async __truncateAllForTests(): Promise<void> {
    await this.pool.query(`TRUNCATE
      forge_identity_users, forge_identity_groups, forge_identity_group_members,
      forge_identity_sessions, forge_identity_refresh_tokens,
      forge_identity_verify_tokens, forge_identity_reset_tokens`);
  }
}
