import type { Connection, ConnectRequest } from '../../../connectors/types';

// C24 / P26 — the pluggable ConnectionBackend interface (the third-party connector vault). Same seam as
// every other store domain: a filesystem implementation (a per-app guarded JSON doc) and a Postgres
// implementation (two tables). It holds two record kinds per app:
//   - connections: a user's live provider connection — the SEALED access/refresh tokens keyed by
//                  (owner, provider). The store holds only ciphertext (AES-256-GCM), exactly like C5.
//   - requests:    short-lived PENDING connect requests keyed by `state`, consumed ONE-SHOT at the OAuth
//                  callback (an atomic delete-returning, like the C23 authorization-code consumeGrant).
export interface ConnectionBackend {
  // connections (durable) — upsert by (owner, provider)
  putConnection(appId: string, conn: Connection): Promise<Connection>;
  getConnection(appId: string, owner: string, provider: string): Promise<Connection | null>;
  listConnections(appId: string, owner: string): Promise<Connection[]>;
  deleteConnection(appId: string, owner: string, provider: string): Promise<boolean>;

  // pending connect requests (short-lived, one-shot)
  putRequest(appId: string, req: ConnectRequest): Promise<ConnectRequest>;
  consumeRequest(appId: string, state: string): Promise<ConnectRequest | null>; // atomic one-shot
  pruneExpiredRequests(appId: string, nowIso: string): Promise<number>; // housekeeping

  close?(): Promise<void>;
  __truncateAllForTests?(): Promise<void>;
}

// The full per-app connector state (used by the migration surface — FS → PG / dual-write mirror).
export interface ConnectionsExport {
  connections: Connection[];
  requests: ConnectRequest[];
}

export interface MigratableConnectionBackend {
  exportApp(appId: string): Promise<ConnectionsExport>;
  importApp(appId: string, data: ConnectionsExport): Promise<void>;
}
