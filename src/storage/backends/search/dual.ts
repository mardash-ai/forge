import type { FsSearchBackend } from './fs';
import type { PgSearchBackend } from './pg';
import type { SearchBackend } from './types';
import type { SearchDocument, SearchQuery, SearchResponse } from '../../../search/types';

// P26 — the DUAL-WRITE search backend: the safe migration window. Postgres is the source of truth (all
// reads come from it); every write goes to Postgres first, then the app's index is mirrored back to the
// filesystem, so an operator can flip reads back to the FS backend with no data loss. Selected with
// FORGE_SEARCH_BACKEND=postgres + FORGE_SEARCH_DUAL_WRITE=1. Search documents are content-addressed by
// (owner, type, id), so the mirror is faithful.
export class DualWriteSearchBackend implements SearchBackend {
  constructor(private readonly primary: PgSearchBackend, private readonly secondary: FsSearchBackend) {}

  private async mirror(appId: string): Promise<void> {
    await this.secondary.importApp(appId, await this.primary.exportApp(appId));
  }

  search(appId: string, query: SearchQuery): Promise<SearchResponse> {
    return this.primary.search(appId, query);
  }

  async index(appId: string, doc: SearchDocument): Promise<SearchDocument> {
    const stored = await this.primary.index(appId, doc);
    await this.mirror(appId);
    return stored;
  }

  async reindex(appId: string, docs: SearchDocument[]): Promise<number> {
    const n = await this.primary.reindex(appId, docs);
    await this.mirror(appId);
    return n;
  }

  async delete(appId: string, ref: { owner: string; type: string; id: string }): Promise<boolean> {
    const deleted = await this.primary.delete(appId, ref);
    await this.mirror(appId);
    return deleted;
  }
}
