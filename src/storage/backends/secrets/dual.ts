import type { FsSecretsBackend } from './fs';
import type { PgSecretsBackend } from './pg';
import type { SecretsBackend, Sealed, Vault } from './types';

// P26 — the DUAL-WRITE secrets backend: Postgres is the source of truth (reads), every write also
// mirrors to the filesystem vault, so an operator can flip reads back with no data loss. The sealed
// entries are content-addressed by (app, name), so the mirror is faithful. FORGE_SECRETS_BACKEND=postgres
// + FORGE_SECRETS_DUAL_WRITE=1.
export class DualWriteSecretsBackend implements SecretsBackend {
  constructor(private readonly primary: PgSecretsBackend, private readonly secondary: FsSecretsBackend) {}

  readVault(appId: string): Promise<Vault> {
    return this.primary.readVault(appId);
  }
  listNames(appId: string): Promise<string[]> {
    return this.primary.listNames(appId);
  }

  async setSecret(appId: string, name: string, sealed: Sealed): Promise<void> {
    await this.primary.setSecret(appId, name, sealed);
    await this.secondary.setSecret(appId, name, sealed);
  }

  async unsetSecret(appId: string, name: string): Promise<boolean> {
    const removed = await this.primary.unsetSecret(appId, name);
    await this.secondary.unsetSecret(appId, name);
    return removed;
  }
}
