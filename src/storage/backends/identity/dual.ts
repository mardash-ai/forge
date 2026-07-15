import type { FsIdentityBackend } from './fs';
import type { PgIdentityBackend } from './pg';
import type {
  IdentityBackend,
  StoredUser,
  StoredSession,
  StoredRefreshToken,
  StoredTwofaCode,
  NewUser,
  UpdateUserPatch,
  PutRefreshTokenInput,
  PutTwofaCodeInput,
  RedeemOpts,
  RedeemTwofaOpts,
  RefreshRedeem,
  TwofaRedeem,
  UserScope,
  Provider,
} from './types';

// P26 — the DUAL-WRITE identity backend: the safe migration window. Postgres is the source of truth
// (all READS come from it); every WRITE goes to Postgres first, then the whole app's identity state is
// mirrored back to the filesystem doc. That mirror means an operator can flip reads back to the FS
// backend at ANY time with no data loss (roll back a bad cutover), and it keeps the on-disk file a
// faithful copy until the FS write is retired. Selected with FORGE_IDENTITY_BACKEND=postgres +
// FORGE_IDENTITY_DUAL_WRITE=1. (Steady state, post-cutover, is plain FORGE_IDENTITY_BACKEND=postgres.)
export class DualWriteIdentityBackend implements IdentityBackend {
  constructor(private readonly primary: PgIdentityBackend, private readonly secondary: FsIdentityBackend) {}

  // Rebuild the FS doc for one app from the Postgres source of truth (faithful — exact ids preserved).
  private async mirror(appId: string): Promise<void> {
    await this.secondary.importApp(appId, await this.primary.exportApp(appId));
  }

  // reads → primary (Postgres)
  getUser(appId: string, userId: string): Promise<StoredUser | null> { return this.primary.getUser(appId, userId); }
  findByEmail(appId: string, email: string): Promise<StoredUser | null> { return this.primary.findByEmail(appId, email); }
  findByProvider(appId: string, p: Provider, id: string): Promise<StoredUser | null> { return this.primary.findByProvider(appId, p, id); }
  countUsers(appId: string): Promise<number> { return this.primary.countUsers(appId); }
  listUsers(appId: string): Promise<StoredUser[]> { return this.primary.listUsers(appId); }
  getUserScope(appId: string, userId: string): Promise<UserScope | null> { return this.primary.getUserScope(appId, userId); }
  getSession(appId: string, id: string): Promise<StoredSession | null> { return this.primary.getSession(appId, id); }
  activeSessionCount(appId: string): Promise<number> { return this.primary.activeSessionCount(appId); }
  getRefreshToken(appId: string, h: string): Promise<StoredRefreshToken | null> { return this.primary.getRefreshToken(appId, h); }
  activeRefreshTokenCount(appId: string): Promise<number> { return this.primary.activeRefreshTokenCount(appId); }

  // writes → primary, then mirror the app to the filesystem
  async createUser(appId: string, input: NewUser): Promise<StoredUser> {
    const u = await this.primary.createUser(appId, input);
    await this.mirror(appId);
    return u;
  }
  async updateUser(appId: string, userId: string, patch: UpdateUserPatch): Promise<StoredUser | null> {
    const u = await this.primary.updateUser(appId, userId, patch);
    await this.mirror(appId);
    return u;
  }
  async deleteUser(appId: string, userId: string): Promise<{ deleted: boolean; email: string | null }> {
    const r = await this.primary.deleteUser(appId, userId);
    await this.mirror(appId);
    return r;
  }
  async createSession(appId: string, userId: string, ttl: number): Promise<StoredSession> {
    const s = await this.primary.createSession(appId, userId, ttl);
    await this.mirror(appId);
    return s;
  }
  async touchSession(appId: string, id: string, ttl: number): Promise<StoredSession | null> {
    const s = await this.primary.touchSession(appId, id, ttl);
    await this.mirror(appId);
    return s;
  }
  async revokeSession(appId: string, id: string): Promise<boolean> {
    const r = await this.primary.revokeSession(appId, id);
    await this.mirror(appId);
    return r;
  }
  async revokeAllUserSessions(appId: string, userId: string): Promise<number> {
    const n = await this.primary.revokeAllUserSessions(appId, userId);
    await this.mirror(appId);
    return n;
  }
  async putRefreshToken(appId: string, input: PutRefreshTokenInput): Promise<StoredRefreshToken> {
    const r = await this.primary.putRefreshToken(appId, input);
    await this.mirror(appId);
    return r;
  }
  async revokeSessionRefreshTokens(appId: string, sessionId: string): Promise<number> {
    const n = await this.primary.revokeSessionRefreshTokens(appId, sessionId);
    await this.mirror(appId);
    return n;
  }
  async revokeAllUserRefreshTokens(appId: string, userId: string): Promise<number> {
    const n = await this.primary.revokeAllUserRefreshTokens(appId, userId);
    await this.mirror(appId);
    return n;
  }
  async redeemRefreshToken(appId: string, presented: string, successor: string, opts: RedeemOpts): Promise<RefreshRedeem> {
    const out = await this.primary.redeemRefreshToken(appId, presented, successor, opts);
    await this.mirror(appId);
    return out;
  }
  async putVerifyToken(appId: string, h: string, userId: string, ttl: number): Promise<void> {
    await this.primary.putVerifyToken(appId, h, userId, ttl);
    await this.mirror(appId);
  }
  async putResetToken(appId: string, h: string, userId: string, ttl: number): Promise<void> {
    await this.primary.putResetToken(appId, h, userId, ttl);
    await this.mirror(appId);
  }
  async consumeVerifyToken(appId: string, h: string): Promise<string | null> {
    const r = await this.primary.consumeVerifyToken(appId, h);
    await this.mirror(appId);
    return r;
  }
  async consumeResetToken(appId: string, h: string): Promise<string | null> {
    const r = await this.primary.consumeResetToken(appId, h);
    await this.mirror(appId);
    return r;
  }

  // 2FA codes are transient + excluded from the mirror snapshot; in dual mode the read path is always
  // Postgres (the primary), so these delegate straight through with no filesystem mirror.
  putTwofaCode(appId: string, input: PutTwofaCodeInput): Promise<void> { return this.primary.putTwofaCode(appId, input); }
  getTwofaCode(appId: string, id: string): Promise<StoredTwofaCode | null> { return this.primary.getTwofaCode(appId, id); }
  redeemTwofaCode(appId: string, id: string, presentedCodeHash: string, opts: RedeemTwofaOpts): Promise<TwofaRedeem> {
    return this.primary.redeemTwofaCode(appId, id, presentedCodeHash, opts);
  }
  deleteTwofaCode(appId: string, id: string): Promise<void> { return this.primary.deleteTwofaCode(appId, id); }
}
