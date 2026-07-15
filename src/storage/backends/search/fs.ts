import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { searchDir, searchFile } from '../../../shared/paths';
import { nowIso } from '../../../shared/time';
import { rankDocuments } from '../../../search/rank';
import { docVisibleTo } from '../../../search/acl';
import { clampLimit, clampOffset, type SearchDocument, type SearchQuery, type SearchResponse } from '../../../search/types';
import type { SearchBackend, MigratableSearchBackend } from './types';

// P26 — the FILESYSTEM search backend: the legacy C19 behavior, unchanged, moved behind the
// SearchBackend interface. One JSON doc per app — a keyed map `{ [owner\0type\0id]: SearchDocument }`.
// Per-app async mutex + atomic temp+rename; owner-filter-then-rank via the pure in-TS BM25(F)-lite
// ranker. This is the DEFAULT backend — nothing regresses when Postgres is not selected.

const SEP = ' ';
function storageKey(owner: string, type: string, id: string): string {
  return `${owner}${SEP}${type}${SEP}${id}`;
}

export class FsSearchBackend implements SearchBackend, MigratableSearchBackend {
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

  private async readMap(appId: string): Promise<Record<string, SearchDocument>> {
    try {
      const parsed = JSON.parse(await readFile(searchFile(appId), 'utf8')) as Record<string, SearchDocument>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private async writeMap(appId: string, map: Record<string, SearchDocument>): Promise<void> {
    await mkdir(searchDir(), { recursive: true });
    const file = searchFile(appId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(map, null, 2));
    await rename(tmp, file);
  }

  private normalize(input: SearchDocument, prev: SearchDocument | undefined, now: string): SearchDocument {
    return {
      owner: input.owner,
      type: input.type,
      id: input.id,
      title: input.title,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(Array.isArray(input.tags) ? { tags: input.tags } : {}),
      ...(input.attrs !== undefined ? { attrs: input.attrs } : {}),
      // C19 ACL metadata — persisted verbatim; absent ⇒ owner-only (private).
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(Array.isArray(input.sharedWith) ? { sharedWith: input.sharedWith } : {}),
      ...(Array.isArray(input.sharedWriters) ? { sharedWriters: input.sharedWriters } : {}),
      created_at: input.created_at ?? prev?.created_at ?? now,
      updated_at: input.updated_at ?? now,
    };
  }

  async index(appId: string, doc: SearchDocument): Promise<SearchDocument> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      const key = storageKey(doc.owner, doc.type, doc.id);
      const normalized = this.normalize(doc, map[key], nowIso());
      map[key] = normalized;
      await this.writeMap(appId, map);
      return normalized;
    });
  }

  async reindex(appId: string, docs: SearchDocument[]): Promise<number> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      const now = nowIso();
      let n = 0;
      for (const doc of docs) {
        const key = storageKey(doc.owner, doc.type, doc.id);
        map[key] = this.normalize(doc, map[key], now);
        n++;
      }
      if (n > 0) await this.writeMap(appId, map);
      return n;
    });
  }

  async delete(appId: string, ref: { owner: string; type: string; id: string }): Promise<boolean> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      const key = storageKey(ref.owner, ref.type, ref.id);
      if (!(key in map)) return false;
      delete map[key];
      await this.writeMap(appId, map);
      return true;
    });
  }

  async search(appId: string, query: SearchQuery): Promise<SearchResponse> {
    const started = Date.now();
    const map = await this.readMap(appId);
    // ACL-scope the candidate set BEFORE ranking/paging: the caller's own docs PLUS the group/shared docs
    // their scope authorizes. No scope ⇒ owner-only (docVisibleTo reduces to `d.owner === query.owner`).
    const visible = Object.values(map).filter((d) => docVisibleTo(d, query.owner, query.scope));
    const result = rankDocuments(visible, {
      q: query.q,
      ...(query.types ? { types: query.types } : {}),
      ...(query.date_from ? { date_from: query.date_from } : {}),
      ...(query.date_to ? { date_to: query.date_to } : {}),
      limit: clampLimit(query.limit),
      offset: clampOffset(query.offset),
    });
    return { ...result, took_ms: Date.now() - started };
  }

  // --- migration surface ---------------------------------------------------
  async exportApp(appId: string): Promise<SearchDocument[]> {
    return Object.values(await this.readMap(appId));
  }

  async importApp(appId: string, docs: SearchDocument[]): Promise<void> {
    await this.withLock(appId, async () => {
      const map: Record<string, SearchDocument> = {};
      for (const d of docs) map[storageKey(d.owner, d.type, d.id)] = d;
      await this.writeMap(appId, map);
    });
  }
}
