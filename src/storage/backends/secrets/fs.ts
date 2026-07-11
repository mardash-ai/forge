import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { secretsDir } from '../../../shared/paths';
import type { SecretsBackend, MigratableSecretsBackend, Sealed, Vault } from './types';

// P26 — the FILESYSTEM secrets backend: one JSON vault per app (sealed entries only). Now GUARDED — a
// per-app async mutex serializes each app's read-modify-write and the vault is replaced atomically
// (temp + rename), so two concurrent `secrets set`s can't lose an update (this is the P27 fix on the FS
// path; the vault itself was already AES-256-GCM sealed). Mode 0600, like before. The DEFAULT backend.

function vaultPath(appId: string): string {
  return path.join(secretsDir(), `vault-${appId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

export class FsSecretsBackend implements SecretsBackend, MigratableSecretsBackend {
  private locks = new Map<string, Promise<unknown>>();

  private withLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(appId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(
      appId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async readVault(appId: string): Promise<Vault> {
    try {
      return JSON.parse(await readFile(vaultPath(appId), 'utf8')) as Vault;
    } catch {
      return {};
    }
  }

  private async writeVault(appId: string, vault: Vault): Promise<void> {
    await mkdir(secretsDir(), { recursive: true });
    const file = vaultPath(appId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(vault, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }

  async setSecret(appId: string, name: string, sealed: Sealed): Promise<void> {
    await this.withLock(appId, async () => {
      const vault = await this.readVault(appId);
      vault[name] = sealed;
      await this.writeVault(appId, vault);
    });
  }

  async unsetSecret(appId: string, name: string): Promise<boolean> {
    return this.withLock(appId, async () => {
      const vault = await this.readVault(appId);
      if (!(name in vault)) return false;
      delete vault[name];
      await this.writeVault(appId, vault);
      return true;
    });
  }

  async listNames(appId: string): Promise<string[]> {
    return Object.keys(await this.readVault(appId)).sort();
  }

  // --- migration surface ---------------------------------------------------
  async exportApp(appId: string): Promise<Vault> {
    return this.readVault(appId);
  }

  async importApp(appId: string, vault: Vault): Promise<void> {
    await this.withLock(appId, async () => {
      await this.writeVault(appId, vault);
    });
  }
}
