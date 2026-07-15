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
import type { ConnectionBackend } from './connections/types';
import { FsConnectionBackend } from './connections/fs';
import { PgConnectionBackend, ensureConnectionsSchema } from './connections/pg';
import { DualWriteConnectionBackend } from './connections/dual';
import type { MembershipBackend } from './membership/types';
import { FsMembershipBackend } from './membership/fs';
import { PgMembershipBackend, ensureMembershipSchema } from './membership/pg';
import { DualWriteMembershipBackend } from './membership/dual';
import type { BillingBackend } from './billing/types';
import { FsBillingBackend } from './billing/fs';
import { PgBillingBackend, ensureBillingSchema } from './billing/pg';
import { DualWriteBillingBackend } from './billing/dual';
import type { PushBackend } from './push/types';
import { FsPushBackend } from './push/fs';
import { PgPushBackend, ensurePushSchema } from './push/pg';
import { DualWritePushBackend } from './push/dual';

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
  connections: ConnectionBackend;
  membership: MembershipBackend;
  billing: BillingBackend;
  push: PushBackend;
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
    if (cfg.connections === 'postgres') await ensureConnectionsSchema(pool);
    if (cfg.membership === 'postgres') await ensureMembershipSchema(pool);
    if (cfg.billing === 'postgres') await ensureBillingSchema(pool);
    if (cfg.push === 'postgres') await ensurePushSchema(pool);
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

  // connections (C24) — the third-party connector vault (SEALED OAuth tokens) on the filesystem, OR in
  // Postgres. Encryption-at-rest (AES-256-GCM under the C5 master key) is identical on both — the backend
  // only ever stores ciphertext.
  const fsConnections = new FsConnectionBackend();
  let connections: ConnectionBackend;
  let connectionsLabel: string;
  if (cfg.connections === 'postgres') {
    const pg = new PgConnectionBackend(pool!);
    connections = cfg.connectionsDualWrite ? new DualWriteConnectionBackend(pg, fsConnections) : pg;
    connectionsLabel = cfg.connectionsDualWrite ? 'postgres+dualwrite' : 'postgres';
  } else {
    connections = fsConnections;
    connectionsLabel = 'filesystem';
  }

  // membership (C31) — the platform-owned membership graph (roles + groups + members + invitations) as one
  // per-app document, on the filesystem, OR one jsonb row per app in Postgres. Multi-record invariants are
  // serialized by the FS per-app lock / a PG SELECT … FOR UPDATE inside mutate — identical on both.
  const fsMembership = new FsMembershipBackend();
  let membership: MembershipBackend;
  let membershipLabel: string;
  if (cfg.membership === 'postgres') {
    const pg = new PgMembershipBackend(pool!);
    membership = cfg.membershipDualWrite ? new DualWriteMembershipBackend(pg, fsMembership) : pg;
    membershipLabel = cfg.membershipDualWrite ? 'postgres+dualwrite' : 'postgres';
  } else {
    membership = fsMembership;
    membershipLabel = 'filesystem';
  }

  // billing (C33) — the payment-source-agnostic billing store (catalog + subscription-of-record +
  // webhook-event dedupe) as one per-app document, on the filesystem, OR one jsonb row per app in Postgres.
  // The monotonic-version subscription upsert + one-shot webhook dedupe are serialized by the FS per-app
  // lock / a PG SELECT … FOR UPDATE inside mutate — identical on both.
  const fsBilling = new FsBillingBackend();
  let billing: BillingBackend;
  let billingLabel: string;
  if (cfg.billing === 'postgres') {
    const pg = new PgBillingBackend(pool!);
    billing = cfg.billingDualWrite ? new DualWriteBillingBackend(pg, fsBilling) : pg;
    billingLabel = cfg.billingDualWrite ? 'postgres+dualwrite' : 'postgres';
  } else {
    billing = fsBilling;
    billingLabel = 'filesystem';
  }

  // push (C21) — the notification-delivery store (browser Web Push subscriptions + the cross-channel
  // delivery-idempotency ledger) as one per-app document on the filesystem, OR two tables in Postgres. The
  // dedupe-by-endpoint subscription upsert + the atomic first-writer delivery claim are serialized by the
  // FS per-app lock / a PG ON CONFLICT — identical semantics on both. Holds NO secret material.
  const fsPush = new FsPushBackend();
  let push: PushBackend;
  let pushLabel: string;
  if (cfg.push === 'postgres') {
    const pg = new PgPushBackend(pool!);
    push = cfg.pushDualWrite ? new DualWritePushBackend(pg, fsPush) : pg;
    pushLabel = cfg.pushDualWrite ? 'postgres+dualwrite' : 'postgres';
  } else {
    push = fsPush;
    pushLabel = 'filesystem';
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
    connections,
    membership,
    billing,
    push,
    blobs,
    pool,
    describe: () =>
      `identity=${identityLabel} search=${searchLabel} events=${eventsLabel} notifications=${notificationsLabel} secrets=${secretsLabel} resources=${resourcesLabel} policy=${policyLabel} mcp=${mcpLabel} connections=${connectionsLabel} membership=${membershipLabel} billing=${billingLabel} push=${pushLabel} blobs=${blobsLabel}`,
    async close() {
      await identity.close?.();
      await search.close?.();
      await events.close?.();
      await notifications.close?.();
      await secrets.close?.();
      await resources.close?.();
      await policy.close?.();
      await mcp.close?.();
      await connections.close?.();
      await membership.close?.();
      await billing.close?.();
      await push.close?.();
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
