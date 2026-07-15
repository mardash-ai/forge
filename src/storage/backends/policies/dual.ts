import type { FsPolicyBackend } from './fs';
import type { PgPolicyBackend } from './pg';
import type { PolicyBackend } from './types';
import type { PolicyRule } from '../../../authz/types';

// C29 / P26 — the DUAL-WRITE policy backend: Postgres is the source of truth (reads); every write also
// mirrors to the filesystem, for a reversible cutover. FORGE_POLICY_BACKEND=postgres + FORGE_POLICY_DUAL_WRITE=1.
export class DualWritePolicyBackend implements PolicyBackend {
  constructor(private readonly primary: PgPolicyBackend, private readonly secondary: FsPolicyBackend) {}

  get(appId: string, id: string): Promise<PolicyRule | null> {
    return this.primary.get(appId, id);
  }
  list(appId: string, opts: { owner?: string }): Promise<PolicyRule[]> {
    return this.primary.list(appId, opts);
  }

  async put(appId: string, policy: PolicyRule): Promise<PolicyRule> {
    const p = await this.primary.put(appId, policy);
    await this.secondary.put(appId, policy);
    return p;
  }

  async delete(appId: string, id: string, opts: { owner?: string } = {}): Promise<boolean> {
    const deleted = await this.primary.delete(appId, id, opts);
    await this.secondary.delete(appId, id, opts);
    return deleted;
  }
}
