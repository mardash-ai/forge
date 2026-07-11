// P26 — store-backend selection config. A global default plus per-domain overrides, read from env
// ONCE at the composition root. Filesystem is the default so nothing regresses; Postgres is opt-in
// per store domain. (Increment 1 wires the `identity` domain; later increments add search, events, …
// with the same shape.)

export type BackendKind = 'filesystem' | 'postgres';
// Blobs are special: 'filesystem' (bytes on the volume + metadata in a JSON map) or 's3' (bytes in an
// S3-compatible object store + metadata in Postgres).
export type BlobBackendKind = 'filesystem' | 's3';

export interface S3Settings {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export interface StoreConfig {
  identity: BackendKind;
  search: BackendKind;
  events: BackendKind;
  notifications: BackendKind;
  secrets: BackendKind;
  resources: BackendKind;
  policy: BackendKind;
  mcp: BackendKind;
  blobs: BlobBackendKind;
  s3?: S3Settings;
  // Migration window: when a Postgres backend is selected, ALSO write-through to the filesystem
  // (read from Postgres). Lets a deploy de-risk the cutover — flip reads back to FS with no data
  // loss — and retire the FS write once Postgres is proven. See docs/architecture/08-storage-strategy.md.
  identityDualWrite: boolean;
  searchDualWrite: boolean;
  eventsDualWrite: boolean;
  notificationsDualWrite: boolean;
  secretsDualWrite: boolean;
  resourcesDualWrite: boolean;
  policyDualWrite: boolean;
  mcpDualWrite: boolean;
  blobsDualWrite: boolean;
  dbUrl?: string;
  poolMax: number;
}

function pick(value: string | undefined, def: BackendKind): BackendKind {
  return value === 'postgres' ? 'postgres' : value === 'filesystem' ? 'filesystem' : def;
}

function flag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

// Blobs default to the object store when FORGE_STORE_BACKEND=postgres (bytes → S3, metadata → Postgres),
// else filesystem; overridable with FORGE_BLOBS_BACKEND=filesystem|s3.
function pickBlob(value: string | undefined, storeDefault: BackendKind): BlobBackendKind {
  if (value === 's3') return 's3';
  if (value === 'filesystem') return 'filesystem';
  return storeDefault === 'postgres' ? 's3' : 'filesystem';
}

function loadS3(env: NodeJS.ProcessEnv): S3Settings | undefined {
  const endpoint = env.FORGE_S3_ENDPOINT;
  const bucket = env.FORGE_S3_BUCKET;
  if (!endpoint || !bucket) return undefined;
  return {
    endpoint,
    bucket,
    accessKey: env.FORGE_S3_ACCESS_KEY ?? '',
    secretKey: env.FORGE_S3_SECRET_KEY ?? '',
    region: env.FORGE_S3_REGION ?? 'us-east-1',
  };
}

export function loadStoreConfig(env: NodeJS.ProcessEnv = process.env): StoreConfig {
  const def: BackendKind = env.FORGE_STORE_BACKEND === 'postgres' ? 'postgres' : 'filesystem';
  return {
    identity: pick(env.FORGE_IDENTITY_BACKEND, def),
    search: pick(env.FORGE_SEARCH_BACKEND, def),
    events: pick(env.FORGE_EVENTS_BACKEND, def),
    notifications: pick(env.FORGE_NOTIFICATIONS_BACKEND, def),
    secrets: pick(env.FORGE_SECRETS_BACKEND, def),
    resources: pick(env.FORGE_RESOURCES_BACKEND, def),
    policy: pick(env.FORGE_POLICY_BACKEND, def),
    mcp: pick(env.FORGE_MCP_BACKEND, def),
    blobs: pickBlob(env.FORGE_BLOBS_BACKEND, def),
    s3: loadS3(env),
    identityDualWrite: flag(env.FORGE_IDENTITY_DUAL_WRITE),
    searchDualWrite: flag(env.FORGE_SEARCH_DUAL_WRITE),
    eventsDualWrite: flag(env.FORGE_EVENTS_DUAL_WRITE),
    notificationsDualWrite: flag(env.FORGE_NOTIFICATIONS_DUAL_WRITE),
    secretsDualWrite: flag(env.FORGE_SECRETS_DUAL_WRITE),
    resourcesDualWrite: flag(env.FORGE_RESOURCES_DUAL_WRITE),
    policyDualWrite: flag(env.FORGE_POLICY_DUAL_WRITE),
    mcpDualWrite: flag(env.FORGE_MCP_DUAL_WRITE),
    blobsDualWrite: flag(env.FORGE_BLOBS_DUAL_WRITE),
    dbUrl: env.FORGE_DB_URL,
    poolMax: Number(env.FORGE_DB_POOL_MAX ?? 8),
  };
}

// Whether any selected domain needs the Postgres pool. The S3 blob backend keeps its METADATA in
// Postgres, so it needs the pool too.
export function needsDatabase(cfg: StoreConfig): boolean {
  return (
    cfg.identity === 'postgres' ||
    cfg.search === 'postgres' ||
    cfg.events === 'postgres' ||
    cfg.notifications === 'postgres' ||
    cfg.secrets === 'postgres' ||
    cfg.resources === 'postgres' ||
    cfg.policy === 'postgres' ||
    cfg.mcp === 'postgres' ||
    cfg.blobs === 's3'
  );
}
