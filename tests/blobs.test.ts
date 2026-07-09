import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { store } from '../src/storage/store';
import { blobStore } from '../src/storage/blob-store';
import { registerBlobRoutes } from '../src/api/blobs-routes';
import { sniffMatches, blobConfig } from '../src/blobs/types';
import { blobsBytesDir } from '../src/shared/paths';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';

// C20 — File / blob storage. A generic, per-app, owner-scoped blob store. The pure sniffer is unit
// tested directly; the file-backed store's owner-scoping/quota/atomicity and the four data-plane routes
// (multipart upload + owner-scoped serve/delete/list) are driven against a throwaway FORGE_STATE_DIR /
// Fastify instance, including a real round-trip of raw bytes.

// --- fixtures ---------------------------------------------------------------------------------------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (payload = 'forge-test-png-body'): Buffer => Buffer.concat([PNG_SIG, Buffer.from(payload)]);
const pdf = (payload = 'the rest of a pdf'): Buffer => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(payload)]);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// Build a raw multipart/form-data body + headers for Fastify inject.
function multipart(input: {
  fields?: Record<string, string>;
  file?: { field?: string; filename?: string; contentType?: string; data: Buffer };
}): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----forgeblob${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];
  const push = (s: string | Buffer): void => { chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8')); };
  for (const [name, value] of Object.entries(input.fields ?? {})) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    push(value);
    push('\r\n');
  }
  if (input.file) {
    const field = input.file.field ?? 'file';
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${field}"; filename="${input.file.filename ?? 'upload.bin'}"\r\n`);
    push(`Content-Type: ${input.file.contentType ?? 'application/octet-stream'}\r\n\r\n`);
    push(input.file.data);
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

// ============================================================================
// PURE — magic-byte sniffing
// ============================================================================

describe('C20 — magic-byte sniff (pure)', () => {
  it('a binary type must match its signature exactly', () => {
    expect(sniffMatches('image/png', png())).toBe(true);
    expect(sniffMatches('image/png', pdf())).toBe(false); // PNG declared, PDF bytes
    expect(sniffMatches('application/pdf', pdf())).toBe(true);
    expect(sniffMatches('application/pdf', png())).toBe(false);
    expect(sniffMatches('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe(true);
    expect(sniffMatches('image/gif', Buffer.from('GIF89a....'))).toBe(true);
    expect(sniffMatches('image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP')]))).toBe(true);
  });

  it('a text type must NOT look like a known binary payload and must have no NUL byte', () => {
    expect(sniffMatches('text/plain', Buffer.from('just some text'))).toBe(true);
    expect(sniffMatches('text/markdown', Buffer.from('# heading\n'))).toBe(true);
    expect(sniffMatches('text/plain', png())).toBe(false); // PNG bytes declared as text → rejected
    expect(sniffMatches('text/plain', Buffer.from([0x68, 0x69, 0x00, 0x69]))).toBe(false); // NUL byte
  });
});

// ============================================================================
// STORE — owner-scoping / quota / atomicity (file-backed)
// ============================================================================

describe('C20 — blob store (file-backed)', () => {
  let dir: string;
  let prev: string | undefined;
  const APP = 'app_x';
  const cfg = () => blobConfig();

  const commitBytes = async (owner: string, data: Buffer, contentType = 'image/png') => {
    const tmp = await blobStore.prepareTemp();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tmp, data);
    return blobStore.commit(APP, tmp, {
      blob_id: `blob_${owner}_${Math.random().toString(36).slice(2, 8)}`,
      owner, content_type: contentType, size: data.length, checksum: sha256(data), created_at: nowIso(),
    }, cfg());
  };

  beforeEach(async () => {
    prev = process.env.FORGE_STATE_DIR;
    dir = await mkdtemp(path.join(tmpdir(), 'forge-blob-'));
    process.env.FORGE_STATE_DIR = dir;
    await store.init();
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prev;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('commit persists bytes + metadata; get returns them; usage reflects them', async () => {
    const data = png('hello');
    const res = await commitBytes('A', data);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const got = await blobStore.get(APP, 'A', res.meta.blob_id);
    expect(got).not.toBeNull();
    expect(got!.size).toBe(data.length);
    expect(got!.checksum).toBe(sha256(data));
    const bytes = await stat(blobStore.bytesFile(APP, res.meta.blob_id));
    expect(bytes.size).toBe(data.length);
    expect(await blobStore.usage(APP, 'A')).toEqual({ bytes: data.length, count: 1 });
  });

  it('OWNER-SCOPING CRUX: owner B can never get/delete owner A’s blob (404, not another’s bytes)', async () => {
    const res = await commitBytes('A', png('A-secret'));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // B names the same blob_id but is not the owner → the key isn't in B's slice → null.
    expect(await blobStore.get(APP, 'B', res.meta.blob_id)).toBeNull();
    expect(await blobStore.delete(APP, 'B', res.meta.blob_id)).toBe(false); // B's delete is a no-op
    // A is untouched.
    expect(await blobStore.get(APP, 'A', res.meta.blob_id)).not.toBeNull();
    expect(await blobStore.list(APP, 'B')).toEqual([]);
  });

  it('enforces the per-owner OBJECT-count quota (409-shaped) and BYTE quota (413-shaped)', async () => {
    process.env.FORGE_BLOB_QUOTA_OBJECTS = '1';
    expect((await commitBytes('A', png('one'))).ok).toBe(true);
    const second = await commitBytes('A', png('two'));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('quota_objects');
    delete process.env.FORGE_BLOB_QUOTA_OBJECTS;

    process.env.FORGE_BLOB_QUOTA_BYTES = '20';
    const big = await commitBytes('B', Buffer.concat([PNG_SIG, Buffer.alloc(40)]));
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.reason).toBe('quota_bytes');
    delete process.env.FORGE_BLOB_QUOTA_BYTES;
  });

  it('a rejected-by-quota commit ORPHANS NOTHING (temp removed, no final byte file)', async () => {
    process.env.FORGE_BLOB_QUOTA_OBJECTS = '0'; // reject every upload
    const before = await bytesEntries(APP);
    const res = await commitBytes('A', png());
    expect(res.ok).toBe(false);
    const after = await bytesEntries(APP);
    expect(after).toEqual(before); // no leftover bytes on the volume
    delete process.env.FORGE_BLOB_QUOTA_OBJECTS;
  });

  it('ATOMICITY: a metadata-write failure ROLLS BACK the moved bytes (no orphan)', async () => {
    // Force the metadata persist to fail AFTER the bytes have been renamed into place.
    const spy = vi.spyOn(blobStore as unknown as { writeMap: (a: string, m: unknown) => Promise<void> }, 'writeMap')
      .mockRejectedValueOnce(new Error('disk gone'));
    await expect(commitBytes('A', png('will-roll-back'))).rejects.toThrow('disk gone');
    expect(spy).toHaveBeenCalled();
    // The just-moved byte file must have been unlinked — nothing orphaned, nothing retrievable.
    expect(await bytesEntries(APP)).toEqual([]);
    expect(await blobStore.list(APP, 'A')).toEqual([]);
  });

  it('delete removes bytes + metadata and is idempotent-by-effect', async () => {
    const res = await commitBytes('A', png());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await blobStore.delete(APP, 'A', res.meta.blob_id)).toBe(true);
    expect(await blobStore.get(APP, 'A', res.meta.blob_id)).toBeNull();
    await expect(stat(blobStore.bytesFile(APP, res.meta.blob_id))).rejects.toBeTruthy(); // bytes gone
    expect(await blobStore.delete(APP, 'A', res.meta.blob_id)).toBe(false); // already gone
  });

  // List every non-temp file in the app's bytes dir (helper for the orphan checks).
  async function bytesEntries(appId: string): Promise<string[]> {
    try {
      return (await readdir(blobsBytesDir(appId))).filter((f) => !f.startsWith('.upload.')).sort();
    } catch {
      return [];
    }
  }
});

// ============================================================================
// ROUTES — the multipart upload + owner-scoped serve/delete/list
// ============================================================================

describe('C20 — blob routes', () => {
  const APP = 'demo';
  const APP_ID = 'app_demo';
  let dir: string;
  let prev: string | undefined;
  let server: FastifyInstance;

  const seedApp = async (): Promise<void> => {
    const now = nowIso();
    const application: Application = {
      id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
      name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web',
      language: 'typescript', package_manager: 'npm',
    };
    await store.saveResource(application);
  };

  beforeEach(async () => {
    prev = process.env.FORGE_STATE_DIR;
    dir = await mkdtemp(path.join(tmpdir(), 'forge-blob-routes-'));
    process.env.FORGE_STATE_DIR = dir;
    await store.init();
    await seedApp();
    server = Fastify({ logger: false });
    registerBlobRoutes(server, { defaultApp: () => APP });
    await server.ready();
  });
  afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
    for (const k of ['FORGE_BLOB_MAX_BYTES', 'FORGE_BLOB_QUOTA_BYTES', 'FORGE_BLOB_QUOTA_OBJECTS', 'FORGE_BLOB_ALLOWED_TYPES']) delete process.env[k];
    if (prev === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });

  const upload = (input: Parameters<typeof multipart>[0]) => {
    const { payload, headers } = multipart(input);
    return server.inject({ method: 'POST', url: '/blobs', payload, headers });
  };

  it('upload → 201 { blob_id, checksum, size }; GET round-trips the EXACT bytes', async () => {
    const data = png('round-trip-me');
    const r = await upload({ fields: { owner: 'A', content_type: 'image/png', filename: 'pic.png' }, file: { data, contentType: 'image/png', filename: 'pic.png' } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body).toMatchObject({ content_type: 'image/png', size: data.length, checksum: sha256(data), filename: 'pic.png' });
    expect(typeof body.blob_id).toBe('string');

    const g = await server.inject({ method: 'GET', url: `/blobs/${body.blob_id}?owner=A` });
    expect(g.statusCode).toBe(200);
    expect(g.headers['content-type']).toBe('image/png');
    expect(g.headers['content-length']).toBe(String(data.length));
    expect(g.headers.etag).toBe(`"${sha256(data)}"`);
    expect(Buffer.compare(g.rawPayload, data)).toBe(0); // identical bytes
  });

  it('OWNER-SCOPING via the routes: B’s GET/DELETE of A’s blob is 404 (absent, not 403)', async () => {
    const r = await upload({ fields: { owner: 'A', content_type: 'image/png' }, file: { data: png('A-only'), contentType: 'image/png' } });
    const id = r.json().blob_id;
    expect((await server.inject({ method: 'GET', url: `/blobs/${id}?owner=B` })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url: `/blobs/${id}?owner=B` })).statusCode).toBe(404);
    // A still owns it.
    expect((await server.inject({ method: 'GET', url: `/blobs/${id}?owner=A` })).statusCode).toBe(200);
  });

  it('content-type ALLOWLIST rejects a disallowed type (415)', async () => {
    const r = await upload({ fields: { owner: 'A', content_type: 'application/zip' }, file: { data: Buffer.from('not-a-real-zip'), contentType: 'application/zip' } });
    expect(r.statusCode).toBe(415);
    expect(r.json().error.code).toBe('unsupported_media_type');
  });

  it('MAGIC-BYTE mismatch is rejected (415) even when the declared type is allowlisted', async () => {
    // Declare image/png (allowed) but send PDF bytes → content_mismatch.
    const r = await upload({ fields: { owner: 'A', content_type: 'image/png' }, file: { data: pdf(), contentType: 'image/png' } });
    expect(r.statusCode).toBe(415);
    expect(r.json().error.code).toBe('content_mismatch');
  });

  it('MAX-SIZE over the configured limit → 413, nothing stored', async () => {
    process.env.FORGE_BLOB_MAX_BYTES = '16'; // tiny
    const r = await upload({ fields: { owner: 'A', content_type: 'image/png' }, file: { data: png('this is definitely more than sixteen bytes'), contentType: 'image/png' } });
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('file_too_large');
    // nothing landed for A
    expect((await server.inject({ method: 'GET', url: '/blobs?owner=A' })).json().blobs).toEqual([]);
  });

  it('per-owner QUOTA: bytes → 413, object count → 409', async () => {
    process.env.FORGE_BLOB_QUOTA_BYTES = '10';
    const rb = await upload({ fields: { owner: 'A', content_type: 'image/png' }, file: { data: png('way over ten bytes total'), contentType: 'image/png' } });
    expect(rb.statusCode).toBe(413);
    expect(rb.json().error.code).toBe('quota_bytes_exceeded');
    delete process.env.FORGE_BLOB_QUOTA_BYTES;

    process.env.FORGE_BLOB_QUOTA_OBJECTS = '1';
    expect((await upload({ fields: { owner: 'C', content_type: 'image/png' }, file: { data: png('1'), contentType: 'image/png' } })).statusCode).toBe(201);
    const ro = await upload({ fields: { owner: 'C', content_type: 'image/png' }, file: { data: png('2'), contentType: 'image/png' } });
    expect(ro.statusCode).toBe(409);
    expect(ro.json().error.code).toBe('quota_objects_exceeded');
  });

  it('DELETE removes the blob (204) and is idempotent (second → 404)', async () => {
    const id = (await upload({ fields: { owner: 'A', content_type: 'image/png' }, file: { data: png(), contentType: 'image/png' } })).json().blob_id;
    expect((await server.inject({ method: 'DELETE', url: `/blobs/${id}?owner=A` })).statusCode).toBe(204);
    expect((await server.inject({ method: 'GET', url: `/blobs/${id}?owner=A` })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url: `/blobs/${id}?owner=A` })).statusCode).toBe(404);
  });

  it('Range request → 206 with a partial body + Content-Range', async () => {
    const data = png('0123456789abcdef');
    const id = (await upload({ fields: { owner: 'A', content_type: 'image/png' }, file: { data, contentType: 'image/png' } })).json().blob_id;
    const g = await server.inject({ method: 'GET', url: `/blobs/${id}?owner=A`, headers: { range: 'bytes=0-3' } });
    expect(g.statusCode).toBe(206);
    expect(g.headers['content-range']).toBe(`bytes 0-3/${data.length}`);
    expect(g.headers['content-length']).toBe('4');
    expect(Buffer.compare(g.rawPayload, data.subarray(0, 4))).toBe(0);
    // out-of-bounds range → 416
    const bad = await server.inject({ method: 'GET', url: `/blobs/${id}?owner=A`, headers: { range: `bytes=${data.length + 5}-` } });
    expect(bad.statusCode).toBe(416);
  });

  it('conditional GET: matching If-None-Match → 304', async () => {
    const data = png('etag-me');
    const id = (await upload({ fields: { owner: 'A', content_type: 'image/png' }, file: { data, contentType: 'image/png' } })).json().blob_id;
    const g = await server.inject({ method: 'GET', url: `/blobs/${id}?owner=A`, headers: { 'if-none-match': `"${sha256(data)}"` } });
    expect(g.statusCode).toBe(304);
  });

  it('list returns the owner’s blobs + usage/quota, owner-scoped', async () => {
    await upload({ fields: { owner: 'A', content_type: 'text/plain', filename: 'a.txt' }, file: { data: Buffer.from('hello text'), contentType: 'text/plain' } });
    await upload({ fields: { owner: 'B', content_type: 'image/png' }, file: { data: png('b'), contentType: 'image/png' } });
    const la = (await server.inject({ method: 'GET', url: '/blobs?owner=A' })).json();
    expect(la.blobs).toHaveLength(1);
    expect(la.blobs[0]).toMatchObject({ content_type: 'text/plain', filename: 'a.txt' });
    expect(la.usage).toMatchObject({ count: 1, bytes: 'hello text'.length, quota_bytes: expect.any(Number), quota_objects: expect.any(Number) });
    // B never sees A's
    expect((await server.inject({ method: 'GET', url: '/blobs?owner=B' })).json().blobs).toHaveLength(1);
  });

  it('validates input: missing owner → 422; missing file → 400; empty file → 400; GET without owner → 400', async () => {
    expect((await upload({ fields: { content_type: 'image/png' }, file: { data: png(), contentType: 'image/png' } })).statusCode).toBe(422);
    expect((await upload({ fields: { owner: 'A', content_type: 'image/png' } })).statusCode).toBe(400); // no file part
    expect((await upload({ fields: { owner: 'A', content_type: 'text/plain' }, file: { data: Buffer.alloc(0), contentType: 'text/plain' } })).statusCode).toBe(400); // empty
    expect((await server.inject({ method: 'GET', url: '/blobs/blob_whatever' })).statusCode).toBe(400); // no owner
  });

  it('ATOMIC on a write failure mid-upload: a broken temp target → 400, nothing persisted (no orphan)', async () => {
    // Force the streamed write to fail by handing the route a temp path under a non-existent directory.
    vi.spyOn(blobStore, 'prepareTemp').mockResolvedValueOnce(path.join(dir, 'no', 'such', 'dir', 'x.tmp'));
    const r = await upload({ fields: { owner: 'A', content_type: 'image/png' }, file: { data: png('interrupted'), contentType: 'image/png' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('upload_aborted');
    // nothing was stored for A
    expect((await server.inject({ method: 'GET', url: '/blobs?owner=A' })).json().blobs).toEqual([]);
  });

  it('unknown app → 404 when no default + no app field', async () => {
    const s2 = Fastify({ logger: false });
    registerBlobRoutes(s2); // no defaultApp
    await s2.ready();
    const { payload, headers } = multipart({ fields: { owner: 'A', content_type: 'image/png' }, file: { data: png(), contentType: 'image/png' } });
    expect((await s2.inject({ method: 'POST', url: '/blobs', payload, headers })).statusCode).toBe(404);
    expect((await s2.inject({ method: 'GET', url: '/blobs/blob_x?owner=A' })).statusCode).toBe(404);
    await s2.close();
  });

  it('rejects a non-multipart POST (415)', async () => {
    const r = await server.inject({ method: 'POST', url: '/blobs', payload: { owner: 'A' } });
    expect(r.statusCode).toBe(415);
  });
});
