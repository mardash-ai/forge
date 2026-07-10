import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { getBackends } from '../src/storage/backends';
import { hashPassword, newToken } from '../src/plugins/auth-identity/index';
import { FsIdentityBackend } from '../src/storage/backends/identity/fs';
import { PgIdentityBackend, ensureIdentitySchema } from '../src/storage/backends/identity/pg';
import { backfillIdentity } from '../src/storage/backends/identity/migrate';

// P26 — Postgres-backend-SPECIFIC coverage: the security invariants the filesystem tests assert against
// the on-disk file (raw secrets never persisted), asserted here against the DATABASE, plus the O4
// group-of-one. Runs ONLY when the Postgres identity backend is actually selected (the `test:pg` run);
// skipped in the default filesystem `npm test`.
const HAS_PG = process.env.FORGE_IDENTITY_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

describe.skipIf(!HAS_PG)('P26 Postgres identity backend — security + O4 group-of-one (in the DB)', () => {
  const APP = 'app_pg_sec';
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('stores a scrypt hash in the users table, never the plaintext password', async () => {
    const id = (await getBackends()).identity;
    const PW = 'Sup3rSecretPlaintext-pg!';
    const u = await id.createUser(APP, { email: 'sec@example.com', password_hash: await hashPassword(PW) });
    const r = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM forge_identity_users WHERE app_id=$1 AND id=$2',
      [APP, u.id],
    );
    expect(r.rows[0]!.password_hash.startsWith('scrypt$')).toBe(true);
    expect(r.rows[0]!.password_hash).not.toContain(PW);
  });

  it('creates a personal group-of-one + owner membership at signup (O4 ownership foundation)', async () => {
    const id = (await getBackends()).identity;
    const u = await id.createUser(APP, { email: 'grp@example.com', password_hash: 'h' });
    expect(u.personal_group_id).toBeTruthy();

    const groups = await pool.query('SELECT id, kind FROM forge_identity_groups WHERE app_id=$1 AND id=$2', [APP, u.personal_group_id]);
    expect(groups.rows[0]).toMatchObject({ id: u.personal_group_id, kind: 'personal' });

    const scope = await id.getUserScope(APP, u.id);
    expect(scope?.owner).toBe(u.id);
    expect(scope?.personal_group_id).toBe(u.personal_group_id);
    expect(scope?.memberships).toEqual([{ group_id: u.personal_group_id, role: 'owner' }]);
  });

  it('stores verify tokens only as a hash — the raw token is never in the DB', async () => {
    const id = (await getBackends()).identity;
    const u = await id.createUser(APP, { email: 'tok@example.com', password_hash: 'h' });
    const { token, hash } = newToken();
    await id.putVerifyToken(APP, hash, u.id, 3600);
    const r = await pool.query<{ id: string }>('SELECT id FROM forge_identity_verify_tokens WHERE app_id=$1', [APP]);
    const ids = r.rows.map((x) => x.id);
    expect(ids).toContain(hash);
    expect(ids).not.toContain(token);
  });

  it('backfill (filesystem → Postgres) relocates users/sessions/tokens with ids preserved', async () => {
    // Seed identity state on a FILESYSTEM backend in an isolated temp state dir.
    const dir = await mkdtemp(path.join(tmpdir(), 'forge-backfill-'));
    const prev = process.env.FORGE_STATE_DIR;
    process.env.FORGE_STATE_DIR = dir;
    try {
      const fs = new FsIdentityBackend();
      const APP2 = 'app_backfill';
      const u = await fs.createUser(APP2, { email: 'bf@example.com', password_hash: await hashPassword('pw') });
      const s = await fs.createSession(APP2, u.id, 3600);
      await fs.putRefreshToken(APP2, { tokenHash: 'rt_bf', userId: u.id, sessionId: s.id, ttlSeconds: 3600 });

      // Backfill into Postgres (a fresh schema; the target app has no rows yet).
      await ensureIdentitySchema(pool);
      await pool.query('DELETE FROM forge_identity_users WHERE app_id=$1', [APP2]);
      const pg = new PgIdentityBackend(pool);
      const results = await backfillIdentity(fs, pg, [APP2]);
      expect(results).toEqual([{ app: APP2, users: 1, sessions: 1, refresh_tokens: 1 }]);

      // Ids preserved → the same user/session/token resolve on Postgres (a live cookie stays valid).
      const migrated = await pg.getUser(APP2, u.id);
      expect(migrated?.email).toBe('bf@example.com');
      expect((await pg.getSession(APP2, s.id))?.user_id).toBe(u.id);
      expect((await pg.getRefreshToken(APP2, 'rt_bf'))?.session_id).toBe(s.id);
    } finally {
      if (prev === undefined) delete process.env.FORGE_STATE_DIR;
      else process.env.FORGE_STATE_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refresh rotation runs in a single transaction (P27): concurrent redeem of one token yields exactly one success', async () => {
    const id = (await getBackends()).identity;
    const u = await id.createUser(APP, { email: 'rot@example.com', password_hash: 'h', email_verified: true });
    const s = await id.createSession(APP, u.id, 3600);
    await id.putRefreshToken(APP, { tokenHash: 'rt_a', userId: u.id, sessionId: s.id, ttlSeconds: 3600 });
    const OPTS = { refreshTtlSeconds: 3600, sessionTtlSeconds: 3600, graceSeconds: 0 };
    // Fire two redeems of the SAME token concurrently. The DB serializes them (FOR UPDATE): exactly one
    // rotates; the other sees an already-rotated token → reuse/invalid, never a second rotation.
    const [r1, r2] = await Promise.all([
      id.redeemRefreshToken(APP, 'rt_a', 'rt_b', OPTS),
      id.redeemRefreshToken(APP, 'rt_a', 'rt_c', OPTS),
    ]);
    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes.filter((o) => o === 'rotated')).toHaveLength(1);
    expect(outcomes).not.toEqual(['rotated', 'rotated']);
  });
});
