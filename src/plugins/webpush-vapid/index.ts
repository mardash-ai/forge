import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  createCipheriv,
  sign,
} from 'node:crypto';

// Plugin: webpush-vapid.
//
// The first Implementation of Forge's BROWSER PUSH delivery (capability C21) — a real technology boundary
// (the Web Push protocol) that a future mobile-push (APNs/FCM) or SMS Implementation can sit ALONGSIDE
// without touching the notify() fan-out contract. It does exactly the provider-specific things Web Push
// requires and nothing else:
//   - VAPID (RFC 8292): mint the ES256-signed JWT + the `Authorization: vapid t=…, k=…` header that
//     identifies this application server to the push service. The private key is handed in; it never
//     leaves the platform (the notify() layer reads it from the C5 vault).
//   - Message encryption (RFC 8291 + RFC 8188 `aes128gcm`): ECDH against the subscription's p256dh key +
//     an HKDF ladder + AES-128-GCM, so the payload is end-to-end encrypted to the browser — the push
//     service relays ciphertext it cannot read.
//   - POST the encrypted body to the subscription endpoint and classify the result (201 = delivered;
//     404/410 = the subscription is GONE → the caller prunes it; anything else = a transient failure).
//
// Dependency-clean by design (like model-anthropic / email-smtp / message-gmail): the transport is Node's
// built-in `crypto` + `fetch`, so both the control-plane and the slim data-plane image stay free of a
// web-push SDK. The network call is swappable (getPushTransport/setPushTransport/resetPushTransport) so the
// test suite injects a deterministic capture sink and NOTHING here opens a socket — while the encryption +
// JWT are exercised for real (a test decrypts the captured body with the UA private key).

export const IMPLEMENTATION = 'webpush-vapid';

// How long a push service should retain an undelivered message for an offline device (seconds). The
// web-push default (4 weeks); a caller may shorten it per message.
export const DEFAULT_TTL_SECONDS = 2_419_200;
const WEBPUSH_TIMEOUT_MS = 20_000;

// --- key material shapes ---------------------------------------------------------------------------

export interface PrivateJwkEC {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d: string;
}
export interface PublicJwkEC {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

// A browser Web Push subscription (endpoint + the UA public key p256dh + the auth secret).
export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// The VAPID identity used to authorize a send: the raw public key (base64url uncompressed — the
// `applicationServerKey` the browser subscribed with), the private JWK (signs the JWT + does ECDH), and
// the contact `subject` (a mailto:/https: URI). The private JWK is handed in and never persisted here.
export interface VapidConfig {
  publicKey: string;
  privateJwk: PrivateJwkEC;
  subject: string;
}

export interface SendPushOptions {
  ttlSeconds?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
}

// The outcome of one push. `expired` is true for 404/410 (the subscription is gone — prune it); `ok`
// is a 2xx. A transient/other failure is `ok:false, expired:false` and carries a compact reason.
export interface WebPushResult {
  ok: boolean;
  statusCode: number;
  expired: boolean;
  error?: string;
}

// --- base64url helpers -----------------------------------------------------------------------------

function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

// The raw uncompressed EC point (0x04 || X || Y, 65 bytes) for a P-256 public JWK.
function rawPublicFromJwk(jwk: { x: string; y: string }): Buffer {
  return Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]);
}

// --- VAPID keypair ---------------------------------------------------------------------------------

// Generate a fresh VAPID keypair: the raw base64url public key (the `applicationServerKey` a browser
// passes to `pushManager.subscribe`) + the private JWK (kept in the C5 vault, used to sign + do ECDH).
export function generateVapidKeys(): { publicKey: string; privateJwk: PrivateJwkEC } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateJwk = privateKey.export({ format: 'jwk' }) as unknown as PrivateJwkEC;
  return { publicKey: b64url(rawPublicFromJwk(privateJwk)), privateJwk };
}

// --- VAPID JWT (RFC 8292) --------------------------------------------------------------------------

// Sign the ES256 VAPID JWT for one send. `aud` is the push-service ORIGIN; `exp` is bounded (12h); `sub`
// is the contact URI. The signature is raw R||S (JOSE `ieee-p1363`), not DER — what JWS ES256 requires.
export function signVapidJwt(audience: string, vapid: VapidConfig, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud: audience, exp: nowSeconds + 12 * 60 * 60, sub: vapid.subject };
  const signingInput = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const key = createPrivateKey({ format: 'jwk', key: vapid.privateJwk as unknown as Record<string, unknown> });
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${b64url(signature)}`;
}

// The `Authorization` header value: `vapid t=<jwt>, k=<application-server-public-key>`.
export function buildVapidAuthHeader(audience: string, vapid: VapidConfig): string {
  return `vapid t=${signVapidJwt(audience, vapid)}, k=${vapid.publicKey}`;
}

// --- payload encryption (RFC 8291 aes128gcm) -------------------------------------------------------

// Encrypt `payload` to a subscription, producing the RFC 8188 `aes128gcm` body:
//   header( salt(16) | rs(4) | idlen(1) | keyid(as_public,65) ) || AES-128-GCM( payload || 0x02 )
// The content encryption key + nonce come from an HKDF ladder rooted in ECDH(as_private, ua_public) and
// the subscription's auth secret (RFC 8291 §3.4), so only the subscribing browser can decrypt it.
export function encryptWebPushPayload(sub: WebPushSubscription, payload: Buffer): Buffer {
  const uaPublic = fromB64url(sub.keys.p256dh); // 65 bytes (0x04 || X || Y)
  const authSecret = fromB64url(sub.keys.auth); // 16 bytes

  // Ephemeral application-server ECDH keypair (fresh per message).
  const asPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const asJwk = asPair.publicKey.export({ format: 'jwk' }) as unknown as PublicJwkEC;
  const asPublic = rawPublicFromJwk(asJwk); // 65 bytes

  // ECDH shared secret (the X coordinate, 32 bytes).
  const uaKey = createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64url(uaPublic.subarray(1, 33)), y: b64url(uaPublic.subarray(33, 65)) },
  });
  const ecdhSecret = diffieHellman({ privateKey: asPair.privateKey, publicKey: uaKey });

  // RFC 8291 §3.4 — combine into the input keying material.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));

  // RFC 8188 — derive the CEK + nonce from a random salt.
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  // One record: plaintext || 0x02 (last-record delimiter). AES-128-GCM appends the 16-byte tag.
  const recordSize = 4096;
  const record = Buffer.concat([payload, Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20); // idlen = 65
  return Buffer.concat([header, asPublic, ciphertext]);
}

// --- send (swappable transport) --------------------------------------------------------------------

// The transport contract: POST the encrypted body to the endpoint and return the HTTP status. Swappable
// so tests inject a capture sink (no socket) and a future transport can slot in without touching the
// Capability. It NEVER sees plaintext or the VAPID private key — only the finished ciphertext + headers.
export type PushTransport = (endpoint: string, headers: Record<string, string>, body: Buffer) => Promise<{ statusCode: number }>;

const httpPushTransport: PushTransport = async (endpoint, headers, body) => {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(WEBPUSH_TIMEOUT_MS),
  });
  return { statusCode: res.status };
};

let transport: PushTransport = httpPushTransport;
export function getPushTransport(): PushTransport {
  return transport;
}
export function setPushTransport(t: PushTransport): void {
  transport = t;
}
export function resetPushTransport(): void {
  transport = httpPushTransport;
}

// Send one encrypted Web Push to a subscription with a VAPID identity. Best-effort: a network error or a
// non-2xx never throws — it returns a WebPushResult the fan-out uses to decide (deliver / prune / ignore).
export async function sendWebPush(
  sub: WebPushSubscription,
  payload: Buffer | string,
  vapid: VapidConfig,
  opts: SendPushOptions = {},
): Promise<WebPushResult> {
  let body: Buffer;
  let audience: string;
  try {
    body = encryptWebPushPayload(sub, typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload);
    audience = new URL(sub.endpoint).origin;
  } catch (e) {
    return { ok: false, statusCode: 0, expired: false, error: `encryption failed: ${String((e as Error)?.message ?? e)}` };
  }
  const headers: Record<string, string> = {
    authorization: buildVapidAuthHeader(audience, vapid),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    ...(opts.urgency ? { urgency: opts.urgency } : {}),
  };
  let statusCode: number;
  try {
    ({ statusCode } = await getPushTransport()(sub.endpoint, headers, body));
  } catch (e) {
    // A network/transport error — transient, not a gone subscription.
    return { ok: false, statusCode: 0, expired: false, error: `push request failed: ${String((e as Error)?.message ?? e)}` };
  }
  const ok = statusCode >= 200 && statusCode < 300;
  const expired = statusCode === 404 || statusCode === 410; // subscription no longer valid → prune
  return { ok, statusCode, expired, ...(ok ? {} : { error: `push service returned ${statusCode}` }) };
}
