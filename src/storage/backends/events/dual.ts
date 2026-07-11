import type { FsEventBackend } from './fs';
import type { PgEventBackend } from './pg';
import type { EventBackend, AppEventInput, AppEventListOpts } from './types';
import type { AppEvent } from '../../../events/app-events';

// P26 — the DUAL-WRITE event backend: the safe migration window. Postgres is the source of truth (all
// reads come from it); each append goes to Postgres first, then the EXACT event (id + at) is mirrored
// to the filesystem log — a faithful, O(1) mirror (no whole-log rewrite, important for this high-write
// store). The rare owner-migration mirrors the whole app. An operator can flip reads back to the FS
// backend with no data loss. Selected with FORGE_EVENTS_BACKEND=postgres + FORGE_EVENTS_DUAL_WRITE=1.
export class DualWriteEventBackend implements EventBackend {
  constructor(private readonly primary: PgEventBackend, private readonly secondary: FsEventBackend) {}

  list(appId: string, opts: AppEventListOpts): Promise<AppEvent[]> {
    return this.primary.list(appId, opts);
  }
  latestTimes(appId: string, owner?: string): Promise<Record<string, string>> {
    return this.primary.latestTimes(appId, owner);
  }

  async append(appId: string, input: AppEventInput): Promise<AppEvent> {
    const event = await this.primary.append(appId, input);
    await this.secondary.mirrorAppend(appId, event);
    return event;
  }

  async assignOwner(appId: string, owner: string): Promise<number> {
    const n = await this.primary.assignOwner(appId, owner);
    // The migration rewrites many rows — resync the whole app's FS log from Postgres.
    await this.secondary.importApp(appId, await this.primary.exportApp(appId));
    return n;
  }
}
