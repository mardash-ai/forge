import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { notificationsDir, notificationsFile } from '../../../shared/paths';
import { nowIso } from '../../../shared/time';
import type { Notification } from '../../../notifications/types';
import type {
  NotificationBackend,
  MigratableNotificationBackend,
  NotificationUpsertInput,
  NotificationListOpts,
} from './types';

// P26 — the FILESYSTEM notification backend: the legacy C4 behavior, unchanged, moved behind the
// NotificationBackend interface. One JSON doc per app (a keyed map). Each mutation is a read-modify-write
// serialized by a per-app async mutex and written atomically (temp + rename), so concurrent mutations to
// distinct keys never lose an update (P5). The DEFAULT backend — nothing regresses when Postgres is off.

export class FsNotificationBackend implements NotificationBackend, MigratableNotificationBackend {
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

  private async readMap(appId: string): Promise<Record<string, Notification>> {
    try {
      return JSON.parse(await readFile(notificationsFile(appId), 'utf8')) as Record<string, Notification>;
    } catch {
      return {};
    }
  }

  // The per-app map's STORAGE key. Owner-less notifications keep the bare app key (unchanged on-disk
  // format — pre-C11 files still load); owner-scoped ones are namespaced by owner with a NUL separator
  // (which never appears in a normal key), so two users may hold the SAME app key as distinct records.
  // This MUST match the legacy separator (NUL) so existing on-disk notification docs keep loading.
  private storageKey(owner: string | undefined, key: string): string {
    return owner === undefined ? key : `${owner}${String.fromCharCode(0)}${key}`;
  }

  private async writeMap(appId: string, map: Record<string, Notification>): Promise<void> {
    await mkdir(notificationsDir(), { recursive: true });
    const file = notificationsFile(appId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(map, null, 2));
    await rename(tmp, file);
  }

  async upsert(appId: string, input: NotificationUpsertInput): Promise<Notification> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      const now = nowIso();
      const storageKey = this.storageKey(input.owner, input.key);
      const prev = map[storageKey];
      const n: Notification = {
        key: input.key,
        title: input.title,
        body: input.body,
        data: input.data ?? {},
        subject: input.subject,
        owner: input.owner,
        dismissed: prev?.dismissed ?? false,
        created_at: prev?.created_at ?? now,
        updated_at: now,
      };
      map[storageKey] = n;
      await this.writeMap(appId, map);
      return n;
    });
  }

  async dismiss(appId: string, key: string, owner?: string): Promise<boolean> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      const n = map[this.storageKey(owner, key)];
      if (!n) return false;
      n.dismissed = true;
      n.updated_at = nowIso();
      await this.writeMap(appId, map);
      return true;
    });
  }

  async clear(appId: string, key: string, owner?: string): Promise<boolean> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      const storageKey = this.storageKey(owner, key);
      if (!(storageKey in map)) return false;
      delete map[storageKey];
      await this.writeMap(appId, map);
      return true;
    });
  }

  async list(appId: string, opts: NotificationListOpts): Promise<Notification[]> {
    const map = await this.readMap(appId);
    let list = Object.values(map);
    if (opts.owner !== undefined) list = list.filter((n) => n.owner === opts.owner);
    if (!opts.includeDismissed) list = list.filter((n) => !n.dismissed);
    list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest-first
    return list;
  }

  async assignOwner(appId: string, owner: string): Promise<number> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      let n = 0;
      for (const [storageKey, note] of Object.entries(map)) {
        if (note.owner !== undefined) continue; // already owned
        const target = this.storageKey(owner, note.key);
        if (target in map) continue; // owner already has this key — don't clobber
        delete map[storageKey];
        map[target] = { ...note, owner, updated_at: nowIso() };
        n++;
      }
      if (n > 0) await this.writeMap(appId, map);
      return n;
    });
  }

  // --- migration surface ---------------------------------------------------
  async exportApp(appId: string): Promise<Notification[]> {
    return Object.values(await this.readMap(appId));
  }

  async importApp(appId: string, notifications: Notification[]): Promise<void> {
    await this.withLock(appId, async () => {
      const map: Record<string, Notification> = {};
      for (const n of notifications) map[this.storageKey(n.owner, n.key)] = n;
      await this.writeMap(appId, map);
    });
  }
}
