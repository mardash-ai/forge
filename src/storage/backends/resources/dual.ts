import type { FsResourceBackend } from './fs';
import type { PgResourceBackend } from './pg';
import type { ResourceBackend } from './types';
import type { AnyResource, ResourceType, BaseResource } from '../../../resources/types';

// P26 — the DUAL-WRITE resource backend: Postgres is the source of truth (reads); every write also
// mirrors to the filesystem, so an operator can flip reads back with no data loss. Resources are keyed
// by (type, id), so the mirror is faithful. FORGE_RESOURCES_BACKEND=postgres + FORGE_RESOURCES_DUAL_WRITE=1.
export class DualWriteResourceBackend implements ResourceBackend {
  constructor(private readonly primary: PgResourceBackend, private readonly secondary: FsResourceBackend) {}

  get<T extends AnyResource = AnyResource>(type: ResourceType, id: string): Promise<T | null> {
    return this.primary.get<T>(type, id);
  }
  findById(id: string): Promise<AnyResource | null> {
    return this.primary.findById(id);
  }
  list(filter: { type?: ResourceType; app_id?: string; owner?: string }): Promise<AnyResource[]> {
    return this.primary.list(filter);
  }
  findAppByName(name: string): Promise<AnyResource | null> {
    return this.primary.findAppByName(name);
  }

  async save<T extends BaseResource>(resource: T): Promise<T> {
    const r = await this.primary.save(resource);
    await this.secondary.save(resource);
    return r;
  }

  async delete(type: ResourceType, id: string): Promise<boolean> {
    const deleted = await this.primary.delete(type, id);
    await this.secondary.delete(type, id);
    return deleted;
  }

  async assignOwner(type: ResourceType, app_id: string, owner: string): Promise<number> {
    const n = await this.primary.assignOwner(type, app_id, owner);
    await this.secondary.assignOwner(type, app_id, owner);
    return n;
  }
}
