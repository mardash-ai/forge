import { setSecret, readSecrets } from '../plugins/secrets-local/index';
import { generateVapidKeys, type PrivateJwkEC, type VapidConfig } from '../plugins/webpush-vapid/index';

// C21 — VAPID key lifecycle (ZERO operator config). The platform auto-generates a per-app VAPID keypair
// on first need and PERSISTS it in the C5 secret vault (sealed AES-256-GCM at rest, on the durable state
// volume / Postgres) under a reserved name — so it survives redeploys and every browser subscription
// stays valid. The PRIVATE key never leaves the platform: only the raw public key (the
// `applicationServerKey`) is ever exposed, via GET /notifications/vapid-public-key. No operator step, no
// secret to provision (VAPID is derived, not configured).

// The reserved C5 secret name the keypair is stored under (JSON: { publicKey, privateJwk }).
export const VAPID_SECRET_NAME = 'FORGE_VAPID_KEYS';

interface StoredVapid {
  publicKey: string; // base64url raw uncompressed (the applicationServerKey)
  privateJwk: PrivateJwkEC; // the EC private JWK (signs the VAPID JWT + does ECDH); never leaves the platform
}

// Serialize generation per app so two concurrent first-subscribes don't persist DIVERGENT keypairs (a
// browser that subscribed with the losing public key would then be rejected by the push service).
const inflight = new Map<string, Promise<StoredVapid>>();

async function readStored(appId: string): Promise<StoredVapid | null> {
  try {
    const secrets = await readSecrets(appId);
    const raw = secrets[VAPID_SECRET_NAME];
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredVapid;
    if (parsed?.publicKey && parsed?.privateJwk?.d) return parsed;
    return null;
  } catch {
    return null;
  }
}

// The app's VAPID keypair — read from the vault, or generated + persisted on first need. Idempotent.
export async function getOrCreateVapid(appId: string): Promise<StoredVapid> {
  const existing = await readStored(appId);
  if (existing) return existing;
  const pending = inflight.get(appId);
  if (pending) return pending;
  const p = (async () => {
    // Double-check under the guard: another awaiter may have persisted between the read and here.
    const again = await readStored(appId);
    if (again) return again;
    const { publicKey, privateJwk } = generateVapidKeys();
    const rec: StoredVapid = { publicKey, privateJwk };
    await setSecret(appId, VAPID_SECRET_NAME, JSON.stringify(rec));
    return rec;
  })();
  inflight.set(appId, p);
  try {
    return await p;
  } finally {
    inflight.delete(appId);
  }
}

// The public key clients pass to `pushManager.subscribe({ applicationServerKey })`.
export async function getVapidPublicKey(appId: string): Promise<string> {
  return (await getOrCreateVapid(appId)).publicKey;
}

// The VAPID contact `sub` (a mailto:/https: URI). Push services require it present + well-formed but do
// not verify it. Operator-overridable via FORGE_VAPID_SUBJECT; otherwise derived from the app's configured
// EMAIL_FROM address (C5/C12), else a generic placeholder — still zero required config.
export async function resolveVapidSubject(appId: string): Promise<string> {
  const fromEnv = process.env.FORGE_VAPID_SUBJECT;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const secrets = await readSecrets(appId);
    const from = secrets['EMAIL_FROM'] ?? process.env.EMAIL_FROM;
    if (from) {
      const m = from.match(/<([^>]+)>/);
      const addr = (m && m[1] ? m[1] : from).trim();
      if (addr.includes('@')) return `mailto:${addr}`;
    }
  } catch {
    /* fall through to the placeholder */
  }
  return 'mailto:push@forge.local';
}

// The full VAPID identity for a send (public key + private JWK + subject).
export async function vapidConfig(appId: string): Promise<VapidConfig> {
  const { publicKey, privateJwk } = await getOrCreateVapid(appId);
  const subject = await resolveVapidSubject(appId);
  return { publicKey, privateJwk, subject };
}
