// P26 — store-backend selection config. A global default plus per-domain overrides, read from env
// ONCE at the composition root. Filesystem is the default so nothing regresses; Postgres is opt-in
// per store domain. (Increment 1 wires the `identity` domain; later increments add search, events, …
// with the same shape.)

export type BackendKind = 'filesystem' | 'postgres';

export interface StoreConfig {
  identity: BackendKind;
  search: BackendKind;
  // Migration window: when a Postgres backend is selected, ALSO write-through to the filesystem
  // (read from Postgres). Lets a deploy de-risk the cutover — flip reads back to FS with no data
  // loss — and retire the FS write once Postgres is proven. See docs/architecture/08-storage-strategy.md.
  identityDualWrite: boolean;
  searchDualWrite: boolean;
  dbUrl?: string;
  poolMax: number;
}

function pick(value: string | undefined, def: BackendKind): BackendKind {
  return value === 'postgres' ? 'postgres' : value === 'filesystem' ? 'filesystem' : def;
}

function flag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

export function loadStoreConfig(env: NodeJS.ProcessEnv = process.env): StoreConfig {
  const def: BackendKind = env.FORGE_STORE_BACKEND === 'postgres' ? 'postgres' : 'filesystem';
  return {
    identity: pick(env.FORGE_IDENTITY_BACKEND, def),
    search: pick(env.FORGE_SEARCH_BACKEND, def),
    identityDualWrite: flag(env.FORGE_IDENTITY_DUAL_WRITE),
    searchDualWrite: flag(env.FORGE_SEARCH_DUAL_WRITE),
    dbUrl: env.FORGE_DB_URL,
    poolMax: Number(env.FORGE_DB_POOL_MAX ?? 8),
  };
}

// Whether any selected domain needs the Postgres pool.
export function needsDatabase(cfg: StoreConfig): boolean {
  return cfg.identity === 'postgres' || cfg.search === 'postgres';
}
