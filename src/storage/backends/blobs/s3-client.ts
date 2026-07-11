import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';

// P26 (increment 5) — a MINIMAL S3-compatible client (AWS Signature V4, path-style) built on native
// crypto + fetch. No SDK dependency (the platform's zero-dep discipline — like model-anthropic and
// auth-identity), so it stays multi-arch and ships clean in the slim data-plane image. Path-style +
// region-configurable so it targets MinIO (dev/test) and AWS S3 (prod) identically. Only the operations
// the C20 blob backend needs: PutObject (known body + its sha256), GetObject (with Range), DeleteObject,
// and an idempotent bucket ensure.

export interface S3Config {
  endpoint: string; // e.g. http://minio:9000 or https://s3.us-east-1.amazonaws.com
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string; // default us-east-1
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // sha256('')
const ALGO = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}
// RFC-3986 encode a single path SEGMENT (keeps unreserved chars; encodes everything else). '/' is joined
// between segments, never encoded.
function encodeSegment(seg: string): string {
  return encodeURIComponent(seg).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function canonicalUri(bucket: string, key: string): string {
  // A bucket-level op (empty key) is `/<bucket>` with NO trailing slash — it must match the request URI
  // exactly or the signature won't verify.
  if (!key) return `/${encodeSegment(bucket)}`;
  return '/' + [bucket, ...key.split('/')].map(encodeSegment).join('/');
}
function amzDate(now: Date): { amz: string; date: string } {
  const amz = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
  return { amz, date: amz.slice(0, 8) };
}

export class S3Client {
  constructor(private readonly cfg: S3Config) {}

  // Sign a request and return the headers to send. `payloadHash` is the hex sha256 of the body (or the
  // empty-payload constant for bodyless requests). Only host + x-amz-date + x-amz-content-sha256 are
  // signed; any other header (Range, Content-Type, Content-Length) is sent UNSIGNED, which S3/MinIO
  // accept — keeping the canonical request identical across every verb.
  private signedHeaders(method: string, bucket: string, key: string, payloadHash: string, extra: Record<string, string>, now = new Date()): Record<string, string> {
    const url = new URL(this.cfg.endpoint);
    const host = url.host;
    const { amz, date } = amzDate(now);
    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amz}\n`;
    const signedHeaderList = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [method, canonicalUri(bucket, key), '', canonicalHeaders, signedHeaderList, payloadHash].join('\n');
    const scope = `${date}/${this.cfg.region}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGO, amz, scope, sha256hex(canonicalRequest)].join('\n');
    const kDate = hmac(`AWS4${this.cfg.secretKey}`, date);
    const kRegion = hmac(kDate, this.cfg.region);
    const kService = hmac(kRegion, SERVICE);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
    const authorization = `${ALGO} Credential=${this.cfg.accessKey}/${scope}, SignedHeaders=${signedHeaderList}, Signature=${signature}`;
    return { host, 'x-amz-date': amz, 'x-amz-content-sha256': payloadHash, authorization, ...extra };
  }

  private objectUrl(key: string): string {
    return `${this.cfg.endpoint.replace(/\/+$/, '')}/${this.cfg.bucket}/${key.split('/').map(encodeSegment).join('/')}`;
  }

  // Create the bucket if it doesn't exist (idempotent — a 200/409/BucketAlreadyOwnedByYou is success).
  async ensureBucket(): Promise<void> {
    const bucketUrl = `${this.cfg.endpoint.replace(/\/+$/, '')}/${this.cfg.bucket}`;
    const headers = this.signedHeaders('PUT', this.cfg.bucket, '', EMPTY_SHA256, {});
    const res = await fetch(bucketUrl, { method: 'PUT', headers });
    if (res.ok) return;
    const body = await res.text();
    if (res.status === 409 || /BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(body)) return;
    throw new Error(`S3 ensureBucket failed: ${res.status} ${body.slice(0, 200)}`);
  }

  // PUT an object. `sha256` is the hex checksum of `body` (the blob backend already computed it), so the
  // payload is signed exactly — no re-hash.
  async putObject(key: string, body: Buffer, contentType: string, sha256: string): Promise<void> {
    const headers = this.signedHeaders('PUT', this.cfg.bucket, key, sha256, {
      'content-type': contentType,
      'content-length': String(body.length),
    });
    const res = await fetch(this.objectUrl(key), { method: 'PUT', headers, body });
    if (!res.ok) {
      throw new Error(`S3 putObject failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }

  // GET an object, optionally a byte range. Returns a Node Readable of the (partial) body. Range is sent
  // unsigned. Throws on a non-2xx.
  async getObject(key: string, range?: { start: number; end: number }): Promise<Readable> {
    const extra: Record<string, string> = {};
    if (range) extra['range'] = `bytes=${range.start}-${range.end}`;
    const headers = this.signedHeaders('GET', this.cfg.bucket, key, EMPTY_SHA256, extra);
    const res = await fetch(this.objectUrl(key), { method: 'GET', headers });
    if (!res.ok || !res.body) {
      throw new Error(`S3 getObject failed: ${res.status}`);
    }
    return Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  }

  async deleteObject(key: string): Promise<void> {
    const headers = this.signedHeaders('DELETE', this.cfg.bucket, key, EMPTY_SHA256, {});
    const res = await fetch(this.objectUrl(key), { method: 'DELETE', headers });
    // S3 delete is idempotent: 204 (deleted) or 404 (already gone) are both fine.
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 deleteObject failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }
}
