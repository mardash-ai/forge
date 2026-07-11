// P26 (increment 6) — the pluggable SecretsBackend interface (C5). The backend stores ONLY SEALED
// entries — the AES-256-GCM ciphertext (iv/tag/data), never plaintext — so encryption-at-rest is
// identical on both implementations; sealing/opening stays in the secrets-local facade under the master
// key. The filesystem backend keeps a per-app JSON vault (now guarded by a per-app mutex + atomic
// temp+rename); the Postgres backend keeps one sealed row per (app, name), upserted in a SINGLE
// statement. Both CLOSE P27 — the previously unguarded read-modify-write of the whole vault is gone
// (FS: serialized; PG: a per-secret upsert with no whole-vault RMW). Contract-stable: forge secrets
// set/unset/list + runtime injection are unchanged.

// One AES-256-GCM sealed value (base64 fields).
export interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

export type Vault = Record<string, Sealed>;

export interface SecretsBackend {
  // All sealed entries for an app (used by readSecrets — the facade decrypts — and listNames).
  readVault(appId: string): Promise<Vault>;
  // Upsert ONE sealed secret (no whole-vault read-modify-write).
  setSecret(appId: string, name: string, sealed: Sealed): Promise<void>;
  // Remove one secret; idempotent (false when absent). Never returns/logs the value.
  unsetSecret(appId: string, name: string): Promise<boolean>;
  listNames(appId: string): Promise<string[]>;
  close?(): Promise<void>;
  __truncateAllForTests?(): Promise<void>;
}

// Migration surface (backfill FS → PG / dual-write mirror) — the SEALED vault moves verbatim.
export interface MigratableSecretsBackend {
  exportApp(appId: string): Promise<Vault>;
  importApp(appId: string, vault: Vault): Promise<void>;
}
