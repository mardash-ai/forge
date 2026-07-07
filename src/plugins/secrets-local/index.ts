import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { secretsDir } from '../../shared/paths';

// Plugin: secrets-local.
//
// The first Implementation of Forge's secret storage — a real technology
// boundary (a secrets backend) that a future secrets-vault / cloud-KMS
// Implementation can replace WITHOUT touching the SetSecret Capability contract.
//
// Secrets are encrypted at rest (AES-256-GCM) under a master key, and are only
// ever decrypted in memory to be injected into an app's runtime by a Capability.
// The plaintext value never lands in source, a compose file, or an image layer.

export const IMPLEMENTATION = 'secrets-local';
export const ALGO = 'aes-256-gcm';

interface Sealed {
  iv: string; // base64 nonce
  tag: string; // base64 GCM auth tag
  data: string; // base64 ciphertext
}

type Vault = Record<string, Sealed>;

let cachedKey: Buffer | null = null;

// The 32-byte master key. Prefer an externally-provided key (FORGE_SECRETS_KEY)
// so a real deployment never persists key material on disk; otherwise fall back
// to a locally generated 0600 key file under the (gitignored) state dir for dev.
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

function vaultPath(appId: string): string {
  return path.join(secretsDir(), `vault-${appId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

async function readVault(appId: string): Promise<Vault> {
  try {
    return JSON.parse(await readFile(vaultPath(appId), 'utf8')) as Vault;
  } catch {
    return {};
  }
}

async function writeVault(appId: string, vault: Vault): Promise<void> {
  await mkdir(secretsDir(), { recursive: true });
  await writeFile(vaultPath(appId), JSON.stringify(vault, null, 2), { mode: 0o600 });
}

// Store (or replace) one secret for an app, encrypted at rest.
export async function setSecret(appId: string, name: string, value: string): Promise<void> {
  const key = await masterKey();
  const vault = await readVault(appId);
  vault[name] = seal(key, value);
  await writeVault(appId, vault);
}

// Remove one secret's encrypted entry from an app's vault. IDEMPOTENT: removing an absent secret
// is a no-op success (returns false). Returns whether an entry existed and was removed. Never reads,
// decrypts, logs, or returns the value — this only revokes it. An empty vault is left as `{}`.
export async function unsetSecret(appId: string, name: string): Promise<boolean> {
  const vault = await readVault(appId);
  if (!(name in vault)) return false;
  delete vault[name];
  await writeVault(appId, vault);
  return true;
}

// Decrypt every secret for an app, for injection into its runtime. An entry that
// can't be decrypted (e.g. the key rotated) is skipped, never fatal — the app
// then simply sees the value as absent and degrades gracefully.
export async function readSecrets(appId: string): Promise<Record<string, string>> {
  const vault = await readVault(appId);
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
  return Object.keys(await readVault(appId)).sort();
}
