import type { FsPushBackend } from './fs';
import type { PgPushBackend } from './pg';
import type { PushBackend, PushSubscriptionRecord, PushSubscriptionInput } from './types';

// C21 / P26 — the DUAL-WRITE notification-delivery backend: the safe migration window. Postgres is the
// source of truth (all reads come from it); every mutation goes to Postgres first, then the app's set is
// mirrored back to the filesystem. Push state is low-volume per app, so a whole-app mirror per mutation is
// cheap and keeps the FS copy faithful — an operator can flip reads back to the FS backend with no data
// loss. Selected with FORGE_PUSH_BACKEND=postgres + FORGE_PUSH_DUAL_WRITE=1.
export class DualWritePushBackend implements PushBackend {
  constructor(private readonly primary: PgPushBackend, private readonly secondary: FsPushBackend) {}

  private async mirror(appId: string): Promise<void> {
    await this.secondary.importApp(appId, await this.primary.exportApp(appId));
  }

  listSubscriptions(appId: string, owner: string): Promise<PushSubscriptionRecord[]> {
    return this.primary.listSubscriptions(appId, owner);
  }

  async registerSubscription(appId: string, input: PushSubscriptionInput): Promise<PushSubscriptionRecord> {
    const rec = await this.primary.registerSubscription(appId, input);
    await this.mirror(appId);
    return rec;
  }

  async unregisterSubscription(appId: string, endpoint: string, owner?: string): Promise<boolean> {
    const r = await this.primary.unregisterSubscription(appId, endpoint, owner);
    await this.mirror(appId);
    return r;
  }

  async pruneSubscription(appId: string, endpoint: string): Promise<boolean> {
    const r = await this.primary.pruneSubscription(appId, endpoint);
    await this.mirror(appId);
    return r;
  }

  async claimDelivery(appId: string, owner: string, idemKey: string, when: string): Promise<boolean> {
    const r = await this.primary.claimDelivery(appId, owner, idemKey, when);
    await this.mirror(appId);
    return r;
  }

  async pruneDeliveriesBefore(appId: string, cutoffIso: string): Promise<number> {
    const n = await this.primary.pruneDeliveriesBefore(appId, cutoffIso);
    await this.mirror(appId);
    return n;
  }
}
