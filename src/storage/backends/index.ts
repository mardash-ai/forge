import { Pool } from 'pg';
import { loadStoreConfig, needsDatabase, type StoreConfig } from './config';
import type { IdentityBackend } from './identity/types';
import { FsIdentityBackend } from './identity/fs';
import { PgIdentityBackend, ensureIdentitySchema } from './identity/pg';
import { DualWriteIdentityBackend } from './identity/dual';
import type { SearchBackend } from './search/types';
import { FsSearchBackend } from './search/fs';
import { PgSearchBackend, ensureSearchSchema } from './search/pg';
import { DualWriteSearchBackend } from './search/dual';
import type { EventBackend } from './events/types';
import { FsEventBackend } from './events/fs';
import { PgEventBackend, ensureEventSchema } from './events/pg';
import { DualWriteEventBackend } from './events/dual';

export { loadStoreConfig, needsDatabase } from './config';
export type { StoreConfig, BackendKind } from './config';

// P26 — the composition root for pluggable store backends. `makeBackends` reads the config once,
// opens the Postgres pool ONLY when a Postgres backend is selected (fail-fast if FORGE_DB_URL is
// missing), ensures the schema, and wires each store domain's front to the chosen implementation.
// Capabilities/routes keep calling the same store methods; only this file knows which backend runs.

export interface Backends {
  identity: IdentityBackend;
  search: SearchBackend;
  events: EventBackend;
  // The Postgres pool, when one was opened (shared across domains as more migrate).
  pool?: Pool;
  describe(): string;
  close(): Promise<void>;
}

export async function makeBackends(cfg: StoreConfig = loadStoreConfig()): Promise<Backends> {
  let pool: Pool | undefined;
  if (needsDatabase(cfg)) {
    if (!cfg.dbUrl) {
      throw new Error(
        'FORGE_DB_URL is required when a Postgres store backend is selected ' +
          '(FORGE_STORE_BACKEND=postgres, FORGE_IDENTITY_BACKEND=postgres, or FORGE_SEARCH_BACKEND=postgres). ' +
          'Point it at the platform database, e.g. postgres://forge_platform:***@postgres:5432/forge_platform.',
      );
    }
    pool = new Pool({ connectionString: cfg.dbUrl, max: cfg.poolMax });
    // Fail fast at boot: a bad URL / unreachable DB surfaces here, not on the first request. Ensure the
    // schema of every domain that is on Postgres.
    if (cfg.identity === 'postgres') await ensureIdentitySchema(pool);
    if (cfg.search === 'postgres') await ensureSearchSchema(pool);
    if (cfg.events === 'postgres') await ensureEventSchema(pool);
  }

  // identity
  const fsIdentity = new FsIdentityBackend();
  let identity: IdentityBackend;
  let identityLabel: string;
  if (cfg.identity === 'postgres') {
    const pg = new PgIdentityBackend(pool!);
    identity = cfg.identityDualWrite ? new DualWriteIdentityBackend(pg, fsIdentity) : pg;
    identityLabel = cfg.identityDualWrite ? 'postgres+dualwrite' : 'postgres';
  } else {
    identity = fsIdentity;
    identityLabel = 'filesystem';
  }

  // search
  const fsSearch = new FsSearchBackend();
  let search: SearchBackend;
  let searchLabel: string;
  if (cfg.search === 'postgres') {
    const pg = new PgSearchBackend(pool!);
    search = cfg.searchDualWrite ? new DualWriteSearchBackend(pg, fsSearch) : pg;
    searchLabel = cfg.searchDualWrite ? 'postgres+dualwrite' : 'postgres';
  } else {
    search = fsSearch;
    searchLabel = 'filesystem';
  }

  // events (C3 timeline)
  const fsEvents = new FsEventBackend();
  let events: EventBackend;
  let eventsLabel: string;
  if (cfg.events === 'postgres') {
    const pg = new PgEventBackend(pool!);
    events = cfg.eventsDualWrite ? new DualWriteEventBackend(pg, fsEvents) : pg;
    eventsLabel = cfg.eventsDualWrite ? 'postgres+dualwrite' : 'postgres';
  } else {
    events = fsEvents;
    eventsLabel = 'filesystem';
  }

  return {
    identity,
    search,
    events,
    pool,
    describe: () => `identity=${identityLabel} search=${searchLabel} events=${eventsLabel}`,
    async close() {
      await identity.close?.();
      await search.close?.();
      await events.close?.();
      if (pool) await pool.end();
    },
  };
}

// Lazy process-wide singleton — the store fronts (plugins/auth-identity/store.ts forwarders) call
// getBackends() on each op; it initializes once from env. Servers eagerly await it at boot so a bad
// Postgres config fails the boot (see data-plane/api servers).
let backendsPromise: Promise<Backends> | null = null;

export function getBackends(): Promise<Backends> {
  if (!backendsPromise) backendsPromise = makeBackends();
  return backendsPromise;
}

// Reset the singleton (tests that change backend env, and clean shutdown). Closes any open pool.
export async function resetBackends(): Promise<void> {
  const prev = backendsPromise;
  backendsPromise = null;
  if (prev) {
    const b = await prev.catch(() => null);
    if (b) await b.close().catch(() => undefined);
  }
}
