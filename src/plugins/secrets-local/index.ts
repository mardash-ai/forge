import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { secretsDir } from '../../shared/paths';
import { getBackends } from '../../storage/backends';
import type { Sealed } from '../../storage/backends/secrets/types';

// Plugin: secrets-local.
//
// Forge's secret storage. Secrets are encrypted at rest (AES-256-GCM) under a master key and only ever
// decrypted in memory to be injected into an app's runtime by a Capability — the plaintext never lands
// in source, a compose file, or an image layer.
//
// P26 (increment 6): this module now SEALS/OPENS under the master key and forwards the SEALED bytes to
// the configured SecretsBackend (filesystem default, or Postgres via FORGE_SECRETS_BACKEND=postgres).
// The backend stores only ciphertext; the P27 unguarded read-modify-write is gone — the FS backend
// serializes + writes atomically, and the Postgres backend upserts one sealed row. The exported function
// signatures are unchanged, so `forge secrets set/unset/list` and the C1/C10/C12 runtime injection are
// contract-stable.

export const IMPLEMENTATION = 'secrets-local';
export const ALGO = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

// The 32-byte master key. Prefer an externally-provided key (FORGE_SECRETS_KEY) so a real deployment
// never persists key material; otherwise fall back to a locally generated 0600 key file under the
// (gitignored) state dir for dev.
async function masterKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.FORGE_SECRETS_KEY;
  if (fromEnv && fromEnv.trim()) {
    cachedKey = createHash('sha256').update(fromEnv.trim()).digest();
    return cachedKey;
  }
  const keyFile = path.join(secretsDir(), 'master.key');
  try {
    const existing = Buffer.from((await readFile(keyFile, 'utf8')).trim(), 'base64');
    if (existing.length === 32) {
      cachedKey = existing;
      return cachedKey;
    }
  } catch {
    /* generate below */
  }
  const key = randomBytes(32);
  await mkdir(secretsDir(), { recursive: true });
  await writeFile(keyFile, key.toString('base64'), { mode: 0o600 });
  cachedKey = key;
  return key;
}

function seal(key: Buffer, plaintext: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function open(key: Buffer, s: Sealed): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(s.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(s.data, 'base64')), decipher.final()]).toString('utf8');
}

const backend = () => getBackends().then((b) => b.secrets);

// Store (or replace) one secret for an app, encrypted at rest. A single upsert — no whole-vault RMW.
export async function setSecret(appId: string, name: string, value: string): Promise<void> {
  const key = await masterKey();
  await (await backend()).setSecret(appId, name, seal(key, value));
}

// Remove one secret's encrypted entry from an app's vault. Idempotent (false when absent). Never reads,
// decrypts, logs, or returns the value.
export async function unsetSecret(appId: string, name: string): Promise<boolean> {
  return (await backend()).unsetSecret(appId, name);
}

// Decrypt every secret for an app, for injection into its runtime. An entry that can't be decrypted
// (e.g. the key rotated) is skipped, never fatal — the app then simply sees the value as absent.
export async function readSecrets(appId: string): Promise<Record<string, string>> {
  const vault = await (await backend()).readVault(appId);
  const names = Object.keys(vault);
  if (names.length === 0) return {};
  const key = await masterKey();
  const out: Record<string, string> = {};
  for (const name of names) {
    const sealed = vault[name];
    if (!sealed) continue;
    try {
      out[name] = open(key, sealed);
    } catch {
      /* skip an entry we can't open */
    }
  }
  return out;
}

// The names of the secrets set for an app — never the values.
export async function listSecretNames(appId: string): Promise<string[]> {
  return (await backend()).listNames(appId);
}

// --- reusable envelope encryption under the C5 master key -----------------------
// C24 reuses the SAME AES-256-GCM master key (FORGE_SECRETS_KEY) to encrypt third-party connector tokens
// at rest — one key mechanism for all platform secret material, no second key to provision. These wrap the
// module-private seal/open so the connector vault never re-implements key handling. The value is opaque to
// the caller (a `Sealed` triple of base64 iv/tag/data) and is only ever the ciphertext.
export async function sealValue(plaintext: string): Promise<Sealed> {
  return seal(await masterKey(), plaintext);
}

export async function openValue(sealed: Sealed): Promise<string> {
  return open(await masterKey(), sealed);
}
