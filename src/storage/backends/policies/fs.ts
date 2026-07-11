import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { policiesDir, policiesFile } from '../../../shared/paths';
import type { PolicyRule } from '../../../authz/types';
import type { PolicyBackend, MigratablePolicyBackend } from './types';

// C29 / P26 — the FILESYSTEM policy backend: one JSON doc per app (a keyed map `{ [id]: PolicyRule }`).
// Guarded — a per-app async mutex serializes each read-modify-write and the file is replaced atomically
// (temp + rename), so concurrent policy edits never lose an update. The DEFAULT backend.
export class FsPolicyBackend implements PolicyBackend, MigratablePolicyBackend {
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

  private async readMap(appId: string): Promise<Record<string, PolicyRule>> {
    try {
      const parsed = JSON.parse(await readFile(policiesFile(appId), 'utf8')) as Record<string, PolicyRule>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private async writeMap(appId: string, map: Record<string, PolicyRule>): Promise<void> {
    await mkdir(policiesDir(), { recursive: true });
    const file = policiesFile(appId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(map, null, 2));
    await rename(tmp, file);
  }

  async put(appId: string, policy: PolicyRule): Promise<PolicyRule> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      map[policy.id] = policy;
      await this.writeMap(appId, map);
      return policy;
    });
  }

  async get(appId: string, id: string): Promise<PolicyRule | null> {
    return (await this.readMap(appId))[id] ?? null;
  }

  async delete(appId: string, id: string): Promise<boolean> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      if (!(id in map)) return false;
      delete map[id];
      await this.writeMap(appId, map);
      return true;
    });
  }

  async list(appId: string, opts: { owner?: string }): Promise<PolicyRule[]> {
    const all = Object.values(await this.readMap(appId));
    const scoped =
      opts.owner === undefined
        ? all
        : all.filter((p) => p.owner === undefined || p.owner === null || p.owner === opts.owner);
    return scoped.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // --- migration surface ---------------------------------------------------
  async exportApp(appId: string): Promise<PolicyRule[]> {
    return Object.values(await this.readMap(appId));
  }

  async importApp(appId: string, policies: PolicyRule[]): Promise<void> {
    await this.withLock(appId, async () => {
      const map: Record<string, PolicyRule> = {};
      for (const p of policies) map[p.id] = p;
      await this.writeMap(appId, map);
    });
  }
}
