import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { incidentsDir, incidentsFile } from '../shared/paths';
import { newResourceId } from '../shared/ids';
import {
  type Incident,
  type CreateIncidentInput,
  type IncidentStatus,
  createIncident,
  appendUpdate,
  resolveIncident,
  pruneIncidents,
} from '../incidents/types';

// C15 Phase 3 — the durable, per-app INCIDENT store.
//
// One JSON doc per app (see paths.ts): a keyed map `{ [id]: Incident }`. Incidents are
// low-volume, mutable, durable STATE (create → append update → resolve + a bounded
// resolved-history), so this mirrors the C4 notification store's shape rather than the
// append-only C2 uptime log. All the lifecycle + retention MATH is the pure module
// `incidents/types.ts`; this class is only its file I/O.
//
// Bounded storage: every write prunes to (all active incidents + the recent, capped
// resolved history), so the doc stays small no matter how long the app runs.
//
// Concurrency: a per-app async mutex serializes each app's read-modify-write, and every
// file is replaced atomically (temp + rename), so a concurrent reader never sees a
// half-written file and two concurrent mutations never lose an update. Different apps
// never block each other. (Same discipline as the uptime + notification stores.)
export class IncidentStore {
  private locks = new Map<string, Promise<unknown>>();

  private withLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(appId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // The lock tail must never reject, or a failed op would wedge the next waiter.
    this.locks.set(
      appId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async readMap(appId: string): Promise<Record<string, Incident>> {
    try {
      const parsed = JSON.parse(await readFile(incidentsFile(appId), 'utf8')) as Record<string, Incident>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  // Atomic replace: write a sibling temp file, then rename over the target.
  private async writeMap(appId: string, map: Record<string, Incident>): Promise<void> {
    await mkdir(incidentsDir(), { recursive: true });
    const file = incidentsFile(appId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(map, null, 2));
    await rename(tmp, file);
  }

  // Prune the map to (active + recent/capped resolved) and persist.
  private async writePruned(appId: string, map: Record<string, Incident>, now: Date): Promise<void> {
    const kept = pruneIncidents(Object.values(map), { now });
    const next: Record<string, Incident> = {};
    for (const inc of kept) next[inc.id] = inc;
    await this.writeMap(appId, next);
  }

  // Create a new incident. Returns the created incident.
  async create(appId: string, input: CreateIncidentInput, now: Date = new Date()): Promise<Incident> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      const inc = createIncident(newResourceId('Incident'), input, now);
      map[inc.id] = inc;
      await this.writePruned(appId, map, now);
      return inc;
    });
  }

  // Append an update to an existing incident (moving it to `status`). Returns the
  // updated incident, or null if there is no such incident for this app.
  async update(
    appId: string,
    id: string,
    update: { status: IncidentStatus; body?: string },
    now: Date = new Date(),
  ): Promise<Incident | null> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      const prev = map[id];
      if (!prev) return null;
      const next = appendUpdate(prev, update, now);
      map[id] = next;
      await this.writePruned(appId, map, now);
      return next;
    });
  }

  // Resolve an incident (idempotent-ish: appends a final update, preserves the original
  // resolved_at). Returns the resolved incident, or null if not found.
  async resolve(
    appId: string,
    id: string,
    opts: { body?: string } = {},
    now: Date = new Date(),
  ): Promise<Incident | null> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      const prev = map[id];
      if (!prev) return null;
      const next = resolveIncident(prev, opts, now);
      map[id] = next;
      await this.writePruned(appId, map, now);
      return next;
    });
  }

  // All incidents for an app (unordered — callers order via the pure orderActive /
  // orderResolved / incidentsJson helpers). Never throws: a missing store reads empty.
  async list(appId: string): Promise<Incident[]> {
    const map = await this.readMap(appId);
    return Object.values(map);
  }

  // A single incident by id, or null.
  async get(appId: string, id: string): Promise<Incident | null> {
    const map = await this.readMap(appId);
    return map[id] ?? null;
  }
}

export const incidentStore = new IncidentStore();
