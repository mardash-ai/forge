import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { getBackends } from '../src/storage/backends';
import { loadStoreConfig } from '../src/storage/backends/config';
import { S3Client } from '../src/storage/backends/blobs/s3-client';
import { S3BlobBackend, ensureBlobSchema } from '../src/storage/backends/blobs/s3';
import { blobStore } from '../src/storage/blob-store';
import { backfillBlobs } from '../src/storage/backends/blobs/migrate';
import { nowIso } from '../src/shared/time';
import type { BlobMetadata } from '../src/blobs/types';

// P26 (increment 5) — object-store + Postgres blob backend-SPECIFIC coverage: bytes really land in the
// S3/MinIO bucket, metadata + O4 columns land in Postgres, the metadata-write-failure ROLLS BACK the
// object (no orphan), ranged reads stream from S3, and backfill moves bytes+metadata with the blob_id
// preserved. Runs ONLY when the s3 blob backend is selected (`test:pg` with MinIO); skipped otherwise.
const HAS_S3 = process.env.FORGE_BLOBS_BACKEND === 's3' && Boolean(process.env.FORGE_DB_URL) && Boolean(process.env.FORGE_S3_ENDPOINT);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (payload: string): Buffer => Buffer.concat([PNG_SIG, Buffer.from(payload)]);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function streamToBuffer(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

describe.skipIf(!HAS_S3)('P26 S3+Postgres blob backend — object store bytes, PG metadata, rollback, backfill', () => {
  const APP = 'app_pg_blobs';
  let pool: Pool;
  let s3: S3Client;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
    s3 = new S3Client(loadStoreConfig().s3!);
    await s3.ensureBucket();
  });
  afterAll(async () => {
    await pool.end();
  });

  // Commit a blob through the configured (s3+postgres) backend.
  const commit = async (owner: string, data: Buffer, blobId: string): Promise<BlobMetadata> => {
    const backend = (await getBackends()).blobs;
    const tmp = await backend.prepareTemp();
    await writeFile(tmp, data);
    const meta: BlobMetadata = { blob_id: blobId, owner, content_type: 'image/png', size: data.length, checksum: sha256(data), created_at: nowIso() };
    const res = await backend.commit(APP, tmp, meta, { maxBytes: 1e9, quotaBytes: 1e9, quotaObjects: 1000, allowedTypes: new Set(['image/png']) });
    if (!res.ok) throw new Error(`commit rejected: ${res.reason}`);
    return res.meta;
  };

  it('stores bytes in the object store and metadata (with O4 columns) in Postgres', async () => {
    const data = png('object-store-body');
    const m = await commit('A', data, `blob_${Math.random().toString(36).slice(2)}`);

    // Bytes really in the bucket, at key `<app>/<blob_id>`.
    const fromS3 = await streamToBuffer(await s3.getObject(`${APP}/${m.blob_id}`));
    expect(Buffer.compare(fromS3, data)).toBe(0);

    // Metadata row in Postgres with the O4 scope columns defaulted.
    const row = await pool.query<{ size: string; checksum: string; owner: string; visibility: string; group_id: string | null }>(
      'SELECT size, checksum, owner, visibility, group_id FROM forge_blobs WHERE app_id=$1 AND blob_id=$2',
      [APP, m.blob_id],
    );
    expect(row.rows[0]).toMatchObject({ owner: 'A', checksum: sha256(data), visibility: 'private', group_id: null });
    expect(Number(row.rows[0]!.size)).toBe(data.length);
  });

  it('a metadata-write failure ROLLS BACK the object (no orphan in the bucket)', async () => {
    const backend = new S3BlobBackend(pool, s3);
    const data = png('will-roll-back');
    const blobId = `blob_${Math.random().toString(36).slice(2)}`;
    // Pre-insert a row with the SAME (app, blob_id) so the commit's INSERT hits a PK conflict and throws
    // AFTER the object has been PUT — exercising the rollback that deletes the just-written object.
    await ensureBlobSchema(pool);
    await pool.query(
      "INSERT INTO forge_blobs (app_id, blob_id, owner, content_type, size, checksum, created_at, visibility) VALUES ($1,$2,'A','image/png',1,'x',$3,'private')",
      [APP, blobId, nowIso()],
    );
    const tmp = await backend.prepareTemp();
    await writeFile(tmp, data);
    const meta: BlobMetadata = { blob_id: blobId, owner: 'A', content_type: 'image/png', size: data.length, checksum: sha256(data), created_at: nowIso() };
    await expect(backend.commit(APP, tmp, meta, { maxBytes: 1e9, quotaBytes: 1e9, quotaObjects: 1000, allowedTypes: new Set(['image/png']) })).rejects.toBeTruthy();
    // The object that was PUT before the failed INSERT must have been deleted — nothing orphaned.
    await expect(s3.getObject(`${APP}/${blobId}`)).rejects.toBeTruthy();
  });

  it('serves a byte range from the object store', async () => {
    const data = png('0123456789abcdef');
    const m = await commit('A', data, `blob_${Math.random().toString(36).slice(2)}`);
    const backend = (await getBackends()).blobs;
    const partial = await streamToBuffer(await backend.openRange(APP, m.blob_id, { start: PNG_SIG.length, end: PNG_SIG.length + 3 }));
    expect(partial.toString()).toBe('0123');
  });

  it('backfill (filesystem → object store + Postgres) preserves the blob_id, bytes, and metadata', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forge-blob-bf-'));
    const prev = process.env.FORGE_STATE_DIR;
    process.env.FORGE_STATE_DIR = dir;
    try {
      const APP2 = 'app_blob_backfill';
      const data = png('backfill-me');
      // Seed an FS blob (bytes on the volume + metadata in the JSON map).
      const tmp = await blobStore.prepareTemp();
      await writeFile(tmp, data);
      const blobId = `blob_bf_${Math.random().toString(36).slice(2)}`;
      const fsRes = await blobStore.commit(APP2, tmp, { blob_id: blobId, owner: 'A', content_type: 'image/png', size: data.length, checksum: sha256(data), created_at: nowIso() },
        { maxBytes: 1e9, quotaBytes: 1e9, quotaObjects: 1000, allowedTypes: new Set(['image/png']) });
      expect(fsRes.ok).toBe(true);

      await ensureBlobSchema(pool);
      await pool.query('DELETE FROM forge_blobs WHERE app_id=$1', [APP2]);
      const target = new S3BlobBackend(pool, s3);
      const results = await backfillBlobs(blobStore, target, [APP2]);
      expect(results).toEqual([{ app: APP2, blobs: 1 }]);

      // blob_id preserved; metadata resolvable in PG (owner-scoped); bytes fetch from S3 intact.
      const got = await target.get(APP2, 'A', blobId);
      expect(got).toMatchObject({ blob_id: blobId, owner: 'A', checksum: sha256(data) });
      const bytes = await streamToBuffer(await target.openBytes(APP2, blobId));
      expect(Buffer.compare(bytes, data)).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.FORGE_STATE_DIR;
      else process.env.FORGE_STATE_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
