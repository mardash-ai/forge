import type { FsBillingBackend } from './fs';
import type { PgBillingBackend } from './pg';
import type { BillingBackend } from './types';
import type { BillingState } from '../../../billing/state';

// C33 / P26 — the DUAL-WRITE billing backend: Postgres is the source of truth (reads + the serialized
// mutate), and each committed state is mirrored to the filesystem, for a reversible cutover.
// FORGE_BILLING_BACKEND=postgres + FORGE_BILLING_DUAL_WRITE=1.
export class DualWriteBillingBackend implements BillingBackend {
  constructor(private readonly primary: PgBillingBackend, private readonly secondary: FsBillingBackend) {}

  read(appId: string): Promise<BillingState> {
    return this.primary.read(appId);
  }

  async mutate<T>(appId: string, fn: (state: BillingState) => { state: BillingState; result: T }): Promise<T> {
    let committed: BillingState | undefined;
    const result = await this.primary.mutate(appId, (state) => {
      const out = fn(state);
      committed = out.state;
      return out;
    });
    if (committed) await this.secondary.importApp(appId, committed);
    return result;
  }
}
