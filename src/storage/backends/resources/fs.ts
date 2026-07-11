import { mkdir, readFile, writeFile, readdir, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { resourcesDir } from '../../../shared/paths';
import { nowIso } from '../../../shared/time';
import type { AnyResource, ResourceType, BaseResource } from '../../../resources/types';
import type { ResourceBackend, MigratableResourceBackend } from './types';

// P26 — the FILESYSTEM resource backend: one JSON file per resource at `resources/<Type>/<id>.json`.
// The legacy behavior, moved behind the interface, with one fix: `save` now writes ATOMICALLY (temp +
// rename) instead of a bare overwrite — closing the P27 torn-write (a crash mid-write can no longer
// leave a truncated resource). The DEFAULT backend.

export class FsResourceBackend implements ResourceBackend, MigratableResourceBackend {
  private typeDir(type: ResourceType): string {
    return path.join(resourcesDir(), type);
  }
  private resourcePath(type: ResourceType, id: string): string {
    return path.join(this.typeDir(type), `${id}.json`);
  }

  private async listTypes(): Promise<ResourceType[]> {
    try {
      const entries = await readdir(resourcesDir(), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name as ResourceType);
    } catch {
      return [];
    }
  }

  async save<T extends BaseResource>(resource: T): Promise<T> {
    const dir = this.typeDir(resource.type);
    await mkdir(dir, { recursive: true });
    const file = this.resourcePath(resource.type, resource.id);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(resource, null, 2));
    await rename(tmp, file);
    return resource;
  }

  async get<T extends AnyResource = AnyResource>(type: ResourceType, id: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.resourcePath(type, id), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  async delete(type: ResourceType, id: string): Promise<boolean> {
    try {
      await rm(this.resourcePath(type, id));
      return true;
    } catch {
      return false;
    }
  }

  async findById(id: string): Promise<AnyResource | null> {
    for (const type of await this.listTypes()) {
      const r = await this.get(type, id);
      if (r) return r;
    }
    return null;
  }

  async list(filter: { type?: ResourceType; app_id?: string; owner?: string } = {}): Promise<AnyResource[]> {
    const types = filter.type ? [filter.type] : await this.listTypes();
    const out: AnyResource[] = [];
    for (const type of types) {
      let files: string[] = [];
      try {
        files = await readdir(this.typeDir(type));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const r = JSON.parse(await readFile(path.join(this.typeDir(type), file), 'utf8')) as AnyResource;
          if (filter.app_id && r.app_id !== filter.app_id) continue;
          if (filter.owner !== undefined && r.owner !== filter.owner) continue;
          out.push(r);
        } catch {
          // skip corrupt entries
        }
      }
    }
    out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return out;
  }

  async assignOwner(type: ResourceType, app_id: string, owner: string): Promise<number> {
    const orphans = (await this.list({ type, app_id })).filter((r) => r.owner === undefined);
    let n = 0;
    for (const r of orphans) {
      await this.save({ ...r, owner, updated_at: nowIso() } as BaseResource);
      n++;
    }
    return n;
  }

  async findAppByName(name: string): Promise<AnyResource | null> {
    const apps = await this.list({ type: 'Application' });
    return apps.find((a) => (a as { name?: string }).name === name) ?? null;
  }

  // --- migration surface ---------------------------------------------------
  async exportAll(): Promise<AnyResource[]> {
    return this.list({});
  }

  async importAll(resources: AnyResource[]): Promise<void> {
    for (const r of resources) await this.save(r as BaseResource);
  }
}
