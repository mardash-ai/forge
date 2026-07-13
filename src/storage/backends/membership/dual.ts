import type { FsMembershipBackend } from './fs';
import type { PgMembershipBackend } from './pg';
import type { MembershipBackend } from './types';
import type { MembershipState } from '../../../membership/types';

// C31 / P26 — the DUAL-WRITE membership backend: Postgres is the source of truth (reads + the serialized
// mutate), and each committed state is mirrored to the filesystem, for a reversible cutover.
// FORGE_MEMBERSHIP_BACKEND=postgres + FORGE_MEMBERSHIP_DUAL_WRITE=1.
export class DualWriteMembershipBackend implements MembershipBackend {
  constructor(private readonly primary: PgMembershipBackend, private readonly secondary: FsMembershipBackend) {}

  read(appId: string): Promise<MembershipState> {
    return this.primary.read(appId);
  }

  async mutate<T>(appId: string, fn: (state: MembershipState) => { state: MembershipState; result: T }): Promise<T> {
    let committed: MembershipState | undefined;
    const result = await this.primary.mutate(appId, (state) => {
      const out = fn(state);
      committed = out.state;
      return out;
    });
    if (committed) await this.secondary.importApp(appId, committed);
    return result;
  }
}
