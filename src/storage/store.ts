import { mkdir, readFile, writeFile, readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import {
  resourcesDir,
  eventsFile,
  logsDir,
  stateDir,
} from '../shared/paths';
import type { AnyResource, ResourceType, BaseResource } from '../resources/types';
import type { ForgeEvent, EventType } from '../events/catalog';
import { newEventId } from '../shared/ids';
import type { Actor } from '../shared/domain';
import { nowIso } from '../shared/time';

// Filesystem-backed Resource + Event store. Intentionally simple for v1 local
// mode (JSON documents + append-only JSONL). Postgres comes later in service
// mode; the interface here is what Capabilities depend on.
export class Store {
  async init(): Promise<void> {
    await mkdir(resourcesDir(), { recursive: true });
    await mkdir(logsDir(), { recursive: true });
    await mkdir(path.dirname(eventsFile()), { recursive: true });
  }

  private resourceTypeDir(type: ResourceType): string {
    return path.join(resourcesDir(), type);
  }

  private resourcePath(type: ResourceType, id: string): string {
    return path.join(this.resourceTypeDir(type), `${id}.json`);
  }

  async saveResource<T extends BaseResource>(resource: T): Promise<T> {
    await mkdir(this.resourceTypeDir(resource.type), { recursive: true });
    await writeFile(this.resourcePath(resource.type, resource.id), JSON.stringify(resource, null, 2));
    return resource;
  }

  async getResource<T extends AnyResource = AnyResource>(
    type: ResourceType,
    id: string,
  ): Promise<T | null> {
    try {
      const raw = await readFile(this.resourcePath(type, id), 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  // Find a resource by id across all types (used when the caller only has an id).
  async findResourceById(id: string): Promise<AnyResource | null> {
    for (const type of await this.listTypes()) {
      const r = await this.getResource(type, id);
      if (r) return r;
    }
    return null;
  }

  private async listTypes(): Promise<ResourceType[]> {
    try {
      const entries = await readdir(resourcesDir(), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name as ResourceType);
    } catch {
      return [];
    }
  }

  async listResources(filter: { type?: ResourceType; app_id?: string } = {}): Promise<AnyResource[]> {
    const types = filter.type ? [filter.type] : await this.listTypes();
    const out: AnyResource[] = [];
    for (const type of types) {
      let files: string[] = [];
      try {
        files = await readdir(this.resourceTypeDir(type));
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await readFile(path.join(this.resourceTypeDir(type), file), 'utf8');
          const r = JSON.parse(raw) as AnyResource;
          if (filter.app_id && r.app_id !== filter.app_id) continue;
          out.push(r);
        } catch {
          // skip corrupt entries
        }
      }
    }
    out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return out;
  }

  async findAppByName(name: string): Promise<AnyResource | null> {
    const apps = await this.listResources({ type: 'Application' });
    return apps.find((a) => (a as { name?: string }).name === name) ?? null;
  }

  async appendEvent(input: {
    type: EventType;
    resource_type: string;
    resource_id: string;
    app_id?: string;
    actor: Actor;
    data?: Record<string, unknown>;
  }): Promise<ForgeEvent> {
    const event: ForgeEvent = {
      id: newEventId(),
      type: input.type,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      app_id: input.app_id,
      timestamp: nowIso(),
      actor: input.actor,
      data: input.data ?? {},
    };
    await mkdir(path.dirname(eventsFile()), { recursive: true });
    await appendFile(eventsFile(), JSON.stringify(event) + '\n');
    return event;
  }

  async listEvents(filter: { app_id?: string; resource_id?: string; limit?: number } = {}): Promise<ForgeEvent[]> {
    let raw: string;
    try {
      raw = await readFile(eventsFile(), 'utf8');
    } catch {
      return [];
    }
    let events = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as ForgeEvent);
    if (filter.app_id) events = events.filter((e) => e.app_id === filter.app_id);
    if (filter.resource_id) events = events.filter((e) => e.resource_id === filter.resource_id);
    events.reverse(); // newest first
    if (filter.limit) events = events.slice(0, filter.limit);
    return events;
  }

  stateDir(): string {
    return stateDir();
  }
}

export const store = new Store();
