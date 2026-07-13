import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { membershipDir, membershipFile } from '../../../shared/paths';
import { type MembershipState, emptyMembershipState } from '../../../membership/types';
import type { MembershipBackend, MigratableMembershipBackend } from './types';

// C31 / P26 — the FILESYSTEM membership backend: one JSON doc per app holding the whole membership graph
// (roles + groups + members + invitations). Guarded — a per-app async mutex serializes each
// read-modify-write and the file is replaced atomically (temp + rename), so the ≥1-owner / singleton-flip /
// one-shot-invitation invariants never lose to a concurrent mutation. The DEFAULT backend.
export class FsMembershipBackend implements MembershipBackend, MigratableMembershipBackend {
  private locks = new Map<string, Promise<unknown>>();

  private withLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(appId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      appId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async readState(appId: string): Promise<MembershipState> {
    try {
      const parsed = JSON.parse(await readFile(membershipFile(appId), 'utf8')) as Partial<MembershipState>;
      return {
        roles: Array.isArray(parsed.roles) ? parsed.roles : [],
        groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
        members: parsed.members && typeof parsed.members === 'object' ? parsed.members : {},
        invitations: parsed.invitations && typeof parsed.invitations === 'object' ? parsed.invitations : {},
      };
    } catch {
      return emptyMembershipState();
    }
  }

  private async writeState(appId: string, state: MembershipState): Promise<void> {
    await mkdir(membershipDir(), { recursive: true });
    const file = membershipFile(appId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, file);
  }

  async read(appId: string): Promise<MembershipState> {
    return this.readState(appId);
  }

  async mutate<T>(appId: string, fn: (state: MembershipState) => { state: MembershipState; result: T }): Promise<T> {
    return this.withLock(appId, async () => {
      const state = await this.readState(appId);
      const { state: next, result } = fn(state);
      await this.writeState(appId, next);
      return result;
    });
  }

  // --- migration surface ---------------------------------------------------
  async exportApp(appId: string): Promise<MembershipState> {
    return this.readState(appId);
  }

  async importApp(appId: string, state: MembershipState): Promise<void> {
    await this.withLock(appId, async () => {
      await this.writeState(appId, state);
    });
  }
}
