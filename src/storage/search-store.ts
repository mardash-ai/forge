import { getBackends } from './backends';
import type { SearchDocument, SearchQuery, SearchResponse } from '../search/types';

// C19 — the search store facade.
//
// P26 (increment 2): persistence lives behind the pluggable SearchBackend interface
// (src/storage/backends/search), selected by config — FORGE_SEARCH_BACKEND=filesystem (default; the
// per-app JSON map + the pure in-TS BM25 ranker) or =postgres (a real tsvector + GIN inverted index).
// This facade keeps the SAME method surface the C19 routes + tests use, so /index, /index/delete,
// /reindex, /search are contract-stable and don't know which backend runs. It stays a class instance so
// the route's `vi.spyOn(searchStore, 'search')` degradation test still works.
class SearchStoreFacade {
  private backend() {
    return getBackends().then((b) => b.search);
  }

  async index(appId: string, doc: SearchDocument): Promise<SearchDocument> {
    return (await this.backend()).index(appId, doc);
  }

  async reindex(appId: string, docs: SearchDocument[]): Promise<number> {
    return (await this.backend()).reindex(appId, docs);
  }

  async delete(appId: string, ref: { owner: string; type: string; id: string }): Promise<boolean> {
    return (await this.backend()).delete(appId, ref);
  }

  /**
   * Remove EVERY document an owner has; returns how many went.
   *
   * The backends have implemented this all along — it was simply not on the facade, so it was
   * reachable only through the account cascade. A consumer wanting to empty an owner's index
   * WITHOUT destroying the account had no way to ask for it.
   */
  async deleteByOwner(appId: string, owner: string): Promise<number> {
    return (await this.backend()).deleteByOwner(appId, owner);
  }

  async search(appId: string, query: SearchQuery): Promise<SearchResponse> {
    return (await this.backend()).search(appId, query);
  }
}

export const searchStore = new SearchStoreFacade();
