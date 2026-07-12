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
import type { NotificationBackend } from './notifications/types';
import { FsNotificationBackend } from './notifications/fs';
import { PgNotificationBackend, ensureNotificationSchema } from './notifications/pg';
import { DualWriteNotificationBackend } from './notifications/dual';
import type { BlobBackend } from './blobs/types';
import { blobStore } from '../blob-store';
import { S3Client } from './blobs/s3-client';
import { S3BlobBackend, ensureBlobSchema } from './blobs/s3';
import { DualWriteBlobBackend } from './blobs/dual';
import type { SecretsBackend } from './secrets/types';
import { FsSecretsBackend } from './secrets/fs';
import { PgSecretsBackend, ensureSecretsSchema } from './secrets/pg';
import { DualWriteSecretsBackend } from './secrets/dual';
import type { ResourceBackend } from './resources/types';
import { FsResourceBackend } from './resources/fs';
import { PgResourceBackend, ensureResourceSchema } from './resources/pg';
import { DualWriteResourceBackend } from './resources/dual';
import type { PolicyBackend } from './policies/types';
import { FsPolicyBackend } from './policies/fs';
import { PgPolicyBackend, ensurePolicySchema } from './policies/pg';
import { DualWritePolicyBackend } from './policies/dual';
import type { McpBackend } from './mcp/types';
import { FsMcpBackend } from './mcp/fs';
import { PgMcpBackend, ensureMcpSchema } from './mcp/pg';
import { DualWriteMcpBackend } from './mcp/dual';

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
  notifications: NotificationBackend;
  secrets: SecretsBackend;
  resources: ResourceBackend;
  policy: PolicyBackend;
  mcp: McpBackend;
  blobs: BlobBackend;
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
    if (cfg.notifications === 'postgres') await ensureNotificationSchema(pool);
    if (cfg.secrets === 'postgres') await ensureSecretsSchema(pool);
    if (cfg.resources === 'postgres') await ensureResourceSchema(pool);
    if (cfg.policy === 'postgres') await ensurePolicySchema(pool);
    if (cfg.mcp === 'postgres') await ensureMcpSchema(pool);
    if (cfg.blobs === 's3') await ensureBlobSchema(pool);
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

  // notifications (C4)
  const fsNotifications = new FsNotificationBackend();
  let notifications: NotificationBackend;
  let notificationsLabel: string;
  if (cfg.notifications === 'postgres') {
    const pg = new PgNotificationBackend(pool!);
    notifications = cfg.notificationsDualWrite ? new DualWriteNotificationBackend(pg, fsNotifications) : pg;
    notificationsLabel = cfg.notificationsDualWrite ? 'postgres+dualwrite' : 'postgres';
  } else {
    notifications = fsNotifications;
    notificationsLabel = 'filesystem';
  }

  // secrets (C5) — sealed vault on the filesystem, OR sealed rows in Postgres (still AES-256-GCM at rest).
  const fsSecrets = new FsSecretsBackend();
  let secrets: SecretsBackend;
  let secretsLabel: string;
  if (cfg.secrets === 'postgres') {
    const pg = new PgSecretsBackend(pool!);
    secrets = cfg.secretsDualWrite ? new DualWriteSecretsBackend(pg, fsSecrets) : pg;
    secretsLabel = cfg.secretsDualWrite ? 'postgres+dualwrite' : 'postgres';
  } else {
    secrets = fsSecrets;
    secretsLabel = 'filesystem';
  }

  // resources (the generic Resource store) — JSON files, OR one jsonb row per resource in Postgres.
  const fsResources = new FsResourceBackend();
  let resources: ResourceBackend;
  let resourcesLabel: string;
  if (cfg.resources === 'postgres') {
    const pg = new PgResourceBackend(pool!);
    resources = cfg.resourcesDualWrite ? new DualWriteResourceBackend(pg, fsResources) : pg;
    resourcesLabel = cfg.resourcesDualWrite ? 'postgres+dualwrite' : 'postgres';
  } else {
    resources = fsResources;
    resourcesLabel = 'filesystem';
  }

  // policy (C29) — authorization policies on the filesystem, OR in Postgres.
  const fsPolicy = new FsPolicyBackend();
  let policy: PolicyBackend;
  let policyLabel: string;
  if (cfg.policy === 'postgres') {
    const pg = new PgPolicyBackend(pool!);
    policy = cfg.policyDualWrite ? new DualWritePolicyBackend(pg, fsPolicy) : pg;
    policyLabel = cfg.policyDualWrite ? 'postgres+dualwrite' : 'postgres';
  } else {
    policy = fsPolicy;
    policyLabel = 'filesystem';
  }

  // mcp (C23) — the MCP-host + OAuth store on the filesystem, OR in Postgres.
  const fsMcp = new FsMcpBackend();
  let mcp: McpBackend;
  let mcpLabel: string;
  if (cfg.mcp === 'postgres') {
    const pg = new PgMcpBackend(pool!);
    mcp = cfg.mcpDualWrite ? new DualWriteMcpBackend(pg, fsMcp) : pg;
    mcpLabel = cfg.mcpDualWrite ? 'postgres+dualwrite' : 'postgres';
  } else {
    mcp = fsMcp;
    mcpLabel = 'filesystem';
  }

  // blobs (C20) — bytes+metadata on the filesystem, OR bytes in S3/MinIO + metadata in Postgres. The FS
  // backend is the shared `blobStore` singleton (so the store's own unit tests + the route observe the
  // same instance). The S3 backend needs both the pool (metadata) and S3 settings (bytes); the bucket is
  // ensured at boot (fail-fast).
  let blobs: BlobBackend;
  let blobsLabel: string;
  if (cfg.blobs === 's3') {
    if (!cfg.s3) {
      throw new Error(
        'FORGE_S3_ENDPOINT + FORGE_S3_BUCKET are required when the S3 blob backend is selected ' +
          '(FORGE_BLOBS_BACKEND=s3). Also set FORGE_S3_ACCESS_KEY/FORGE_S3_SECRET_KEY. ' +
          'Blobs default to the filesystem (durable volume) — omit FORGE_BLOBS_BACKEND to use it (P33).',
      );
    }
    const s3 = new S3Client(cfg.s3);
    await s3.ensureBucket();
    const pg = new S3BlobBackend(pool!, s3);
    blobs = cfg.blobsDualWrite ? new DualWriteBlobBackend(pg, blobStore) : pg;
    blobsLabel = cfg.blobsDualWrite ? 's3+postgres+dualwrite' : 's3+postgres';
  } else {
    blobs = blobStore;
    blobsLabel = 'filesystem';
  }

  return {
    identity,
    search,
    events,
    notifications,
    secrets,
    resources,
    policy,
    mcp,
    blobs,
    pool,
    describe: () =>
      `identity=${identityLabel} search=${searchLabel} events=${eventsLabel} notifications=${notificationsLabel} secrets=${secretsLabel} resources=${resourcesLabel} policy=${policyLabel} mcp=${mcpLabel} blobs=${blobsLabel}`,
    async close() {
      await identity.close?.();
      await search.close?.();
      await events.close?.();
      await notifications.close?.();
      await secrets.close?.();
      await resources.close?.();
      await policy.close?.();
      await mcp.close?.();
      await blobs.close?.();
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
