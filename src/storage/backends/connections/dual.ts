import type { FsConnectionBackend } from './fs';
import type { PgConnectionBackend } from './pg';
import type { ConnectionBackend } from './types';
import type { Connection, ConnectRequest } from '../../../connectors/types';

// C24 / P26 — the DUAL-WRITE connector-vault backend: Postgres is the source of truth (all reads), every
// write also mirrors to the filesystem doc, so an operator can flip reads back with no data loss during a
// cutover. FORGE_CONNECTIONS_BACKEND=postgres + FORGE_CONNECTIONS_DUAL_WRITE=1. The one-shot consumeRequest
// deletes from BOTH so a mirrored pending request can't be double-spent after a read flip.
export class DualWriteConnectionBackend implements ConnectionBackend {
  constructor(private readonly primary: PgConnectionBackend, private readonly secondary: FsConnectionBackend) {}

  async putConnection(appId: string, conn: Connection): Promise<Connection> {
    const out = await this.primary.putConnection(appId, conn);
    await this.secondary.putConnection(appId, conn);
    return out;
  }
  getConnection(appId: string, owner: string, provider: string): Promise<Connection | null> {
    return this.primary.getConnection(appId, owner, provider);
  }
  listConnections(appId: string, owner: string): Promise<Connection[]> {
    return this.primary.listConnections(appId, owner);
  }
  async deleteConnection(appId: string, owner: string, provider: string): Promise<boolean> {
    const removed = await this.primary.deleteConnection(appId, owner, provider);
    await this.secondary.deleteConnection(appId, owner, provider);
    return removed;
  }

  async putRequest(appId: string, req: ConnectRequest): Promise<ConnectRequest> {
    const out = await this.primary.putRequest(appId, req);
    await this.secondary.putRequest(appId, req);
    return out;
  }
  async consumeRequest(appId: string, state: string): Promise<ConnectRequest | null> {
    const consumed = await this.primary.consumeRequest(appId, state);
    await this.secondary.consumeRequest(appId, state);
    return consumed;
  }
  async pruneExpiredRequests(appId: string, nowIso: string): Promise<number> {
    const n = await this.primary.pruneExpiredRequests(appId, nowIso);
    await this.secondary.pruneExpiredRequests(appId, nowIso);
    return n;
  }
}
