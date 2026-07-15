import { describe, it, expect, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  createDecipheriv,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  generateVapidKeys,
  signVapidJwt,
  buildVapidAuthHeader,
  encryptWebPushPayload,
  sendWebPush,
  setPushTransport,
  resetPushTransport,
  DEFAULT_TTL_SECONDS,
  type WebPushSubscription,
  type VapidConfig,
} from '../src/plugins/webpush-vapid/index';

// C21 — the Web Push technology boundary (webpush-vapid). Proves the hand-rolled crypto is correct +
// interoperable WITHOUT a network: the VAPID JWT verifies under the public key, and a payload encrypted to
// a subscription DECRYPTS back to the original with the subscription's private key (RFC 8291 aes128gcm).
// The send classification (delivered / gone / transient) is exercised through a stub transport.

const b64url = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');
const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url');
const rawPublicFromJwk = (jwk: { x: string; y: string }): Buffer =>
  Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]);

// A browser-side subscription keypair: returns the subscription shape (p256dh/auth) + the UA private key
// object needed to DECRYPT what the server encrypts to it.
function makeUaSubscription(endpoint: string): { sub: WebPushSubscription; uaPrivate: KeyObject; authSecret: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const authSecret = Buffer.from(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' }).d as string, 'base64url').subarray(0, 16);
  return {
    sub: { endpoint, keys: { p256dh: b64url(rawPublicFromJwk(jwk)), auth: b64url(authSecret) } },
    uaPrivate: privateKey,
    authSecret,
  };
}

// RFC 8291 aes128gcm DECRYPT — the browser's side. Mirrors encryptWebPushPayload so the round-trip proves
// interop. Given the server body, the UA private key, and the auth secret, recover the plaintext.
function decryptWebPush(body: Buffer, uaPrivate: KeyObject, authSecret: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen); // 0x04 || X || Y
  const ciphertext = body.subarray(21 + idlen);

  const uaJwk = uaPrivate.export({ format: 'jwk' }) as { x: string; y: string };
  const uaPublic = rawPublicFromJwk(uaJwk);
  const asKey = createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64url(asPublic.subarray(1, 33)), y: b64url(asPublic.subarray(33, 65)) },
  });
  const ecdhSecret = diffieHellman({ privateKey: uaPrivate, publicKey: asKey });

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const ct = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ct), decipher.final()]);
  // Strip the trailing 0x02 last-record delimiter (RFC 8188).
  return padded.subarray(0, padded.length - 1);
}

afterEach(() => resetPushTransport());

describe('webpush-vapid — VAPID keypair + JWT (RFC 8292)', () => {
  it('generates a base64url raw public key (65-byte uncompressed point) + a private JWK', () => {
    const { publicKey, privateJwk } = generateVapidKeys();
    const raw = fromB64url(publicKey);
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04); // uncompressed point
    expect(privateJwk.kty).toBe('EC');
    expect(privateJwk.crv).toBe('P-256');
    expect(typeof privateJwk.d).toBe('string'); // the private scalar
  });

  it('signs a VAPID JWT that VERIFIES under the public key (ES256), with aud/sub/exp claims', () => {
    const { publicKey, privateJwk } = generateVapidKeys();
    const vapid: VapidConfig = { publicKey, privateJwk, subject: 'mailto:ops@acme.test' };
    const jwt = signVapidJwt('https://fcm.googleapis.com', vapid, 1_800_000_000);

    const [h, p, s] = jwt.split('.');
    const header = JSON.parse(fromB64url(h!).toString('utf8'));
    const payload = JSON.parse(fromB64url(p!).toString('utf8'));
    expect(header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(payload.aud).toBe('https://fcm.googleapis.com');
    expect(payload.sub).toBe('mailto:ops@acme.test');
    expect(payload.exp).toBe(1_800_000_000 + 12 * 3600);

    // The signature verifies under the application-server public key (raw R||S / ieee-p1363).
    const rawPub = fromB64url(publicKey);
    const pubKey = createPublicKey({
      format: 'jwk',
      key: { kty: 'EC', crv: 'P-256', x: b64url(rawPub.subarray(1, 33)), y: b64url(rawPub.subarray(33, 65)) },
    });
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, fromB64url(s!));
    expect(ok).toBe(true);
  });

  it('buildVapidAuthHeader is `vapid t=<jwt>, k=<public key>`', () => {
    const { publicKey, privateJwk } = generateVapidKeys();
    const header = buildVapidAuthHeader('https://push.example', { publicKey, privateJwk, subject: 'mailto:a@b.test' });
    const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
    expect(m).toBeTruthy();
    expect(m![2]).toBe(publicKey);
    expect(m![1]!.split('.').length).toBe(3); // a JWT
  });
});

describe('webpush-vapid — payload encryption (RFC 8291 aes128gcm)', () => {
  it('encrypts a payload that DECRYPTS back to the original with the subscription private key', () => {
    const { sub, uaPrivate, authSecret } = makeUaSubscription('https://push.example/abc');
    const plaintext = JSON.stringify({ title: 'Goal is cold', body: 'g1 has been quiet', data: { url: '/goals/g1' } });
    const body = encryptWebPushPayload(sub, Buffer.from(plaintext, 'utf8'));

    // Header shape: salt(16) | rs(4) | idlen(1)=65 | keyid(65) | ciphertext(+16 tag).
    expect(body.readUInt8(20)).toBe(65);
    expect(body.length).toBeGreaterThan(21 + 65 + 16);

    const recovered = decryptWebPush(body, uaPrivate, authSecret).toString('utf8');
    expect(recovered).toBe(plaintext);
  });

  it('two encryptions of the same payload differ (fresh ephemeral key + salt each time)', () => {
    const { sub } = makeUaSubscription('https://push.example/abc');
    const a = encryptWebPushPayload(sub, Buffer.from('x'));
    const b = encryptWebPushPayload(sub, Buffer.from('x'));
    expect(a.equals(b)).toBe(false);
  });
});

describe('webpush-vapid — send classification (swappable transport, no socket)', () => {
  it('201 → delivered (ok, not expired); posts aes128gcm + a VAPID Authorization header', async () => {
    const { sub } = makeUaSubscription('https://push.example/xyz');
    const captured: { endpoint?: string; headers?: Record<string, string>; body?: Buffer } = {};
    setPushTransport(async (endpoint, headers, bodyBuf) => {
      captured.endpoint = endpoint;
      captured.headers = headers;
      captured.body = bodyBuf;
      return { statusCode: 201 };
    });
    const { publicKey, privateJwk } = generateVapidKeys();
    const res = await sendWebPush(sub, 'hello', { publicKey, privateJwk, subject: 'mailto:a@b.test' });
    expect(res).toMatchObject({ ok: true, statusCode: 201, expired: false });
    expect(captured.endpoint).toBe('https://push.example/xyz');
    expect(captured.headers!['content-encoding']).toBe('aes128gcm');
    expect(captured.headers!['authorization']).toMatch(/^vapid t=.+, k=.+$/);
    expect(captured.headers!['ttl']).toBe(String(DEFAULT_TTL_SECONDS));
    expect(Buffer.isBuffer(captured.body)).toBe(true);
  });

  it('404/410 → expired (prune signal); a network throw → transient failure; both are best-effort (no throw)', async () => {
    const { sub } = makeUaSubscription('https://push.example/gone');
    const { publicKey, privateJwk } = generateVapidKeys();
    const vapid: VapidConfig = { publicKey, privateJwk, subject: 'mailto:a@b.test' };

    setPushTransport(async () => ({ statusCode: 410 }));
    expect(await sendWebPush(sub, 'x', vapid)).toMatchObject({ ok: false, expired: true, statusCode: 410 });

    setPushTransport(async () => ({ statusCode: 404 }));
    expect(await sendWebPush(sub, 'x', vapid)).toMatchObject({ ok: false, expired: true, statusCode: 404 });

    setPushTransport(async () => ({ statusCode: 500 }));
    expect(await sendWebPush(sub, 'x', vapid)).toMatchObject({ ok: false, expired: false, statusCode: 500 });

    setPushTransport(async () => { throw new Error('ECONNRESET'); });
    const res = await sendWebPush(sub, 'x', vapid);
    expect(res.ok).toBe(false);
    expect(res.expired).toBe(false);
    expect(res.error).toContain('push request failed');
  });
});
