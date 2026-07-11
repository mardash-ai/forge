import type { FsNotificationBackend } from './fs';
import type { PgNotificationBackend } from './pg';
import type { NotificationBackend, NotificationUpsertInput, NotificationListOpts } from './types';
import type { Notification } from '../../../notifications/types';

// P26 — the DUAL-WRITE notification backend: the safe migration window. Postgres is the source of truth
// (all reads come from it); every mutation goes to Postgres first, then the app's set is mirrored back to
// the filesystem. Notifications are low-volume per app, so a whole-app mirror per mutation is cheap and
// keeps the FS copy faithful — an operator can flip reads back to the FS backend with no data loss.
// Selected with FORGE_NOTIFICATIONS_BACKEND=postgres + FORGE_NOTIFICATIONS_DUAL_WRITE=1.
export class DualWriteNotificationBackend implements NotificationBackend {
  constructor(private readonly primary: PgNotificationBackend, private readonly secondary: FsNotificationBackend) {}

  private async mirror(appId: string): Promise<void> {
    await this.secondary.importApp(appId, await this.primary.exportApp(appId));
  }

  list(appId: string, opts: NotificationListOpts): Promise<Notification[]> {
    return this.primary.list(appId, opts);
  }

  async upsert(appId: string, input: NotificationUpsertInput): Promise<Notification> {
    const n = await this.primary.upsert(appId, input);
    await this.mirror(appId);
    return n;
  }

  async dismiss(appId: string, key: string, owner?: string): Promise<boolean> {
    const r = await this.primary.dismiss(appId, key, owner);
    await this.mirror(appId);
    return r;
  }

  async clear(appId: string, key: string, owner?: string): Promise<boolean> {
    const r = await this.primary.clear(appId, key, owner);
    await this.mirror(appId);
    return r;
  }

  async assignOwner(appId: string, owner: string): Promise<number> {
    const n = await this.primary.assignOwner(appId, owner);
    await this.mirror(appId);
    return n;
  }
}
