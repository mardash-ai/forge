import type { Pool } from 'pg';
import { readFile, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { BlobConfig, BlobMetadata } from '../../../blobs/types';
import type { S3Client } from './s3-client';
import type { BlobBackend, MigratableBlobBackend, OwnerUsage, CommitResult } from './types';

// P26 (increment 5) — the OBJECT-STORE + POSTGRES blob backend: bytes in an S3-compatible object store
// (MinIO/S3), metadata in Postgres. Contract-identical to the filesystem backend — the route stages the
// upload to a local temp file (hash/validate), then commit() quota-checks against the metadata table,
// PUTs the bytes, and INSERTs the row (rolling the object back if the metadata write fails). Owner
// scoping + quota are driven off `forge_blobs`. Ranged reads stream a Range GetObject. The O4 (owner,
// group_id, visibility) columns are baked in + defaulted.

export async function ensureBlobSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS forge_blobs (
      app_id       text   NOT NULL,
      blob_id      text   NOT NULL,
      owner        text   NOT NULL,
      content_type text   NOT NULL,
      size         bigint NOT NULL,
      checksum     text   NOT NULL,
      filename     text,
      attrs        jsonb,
      created_at   text   NOT NULL,   -- ISO-8601, verbatim
      -- O4 ownership scope (baked in; households/C31 light up with no migration).
      group_id     text,
      visibility   text   NOT NULL DEFAULT 'private',
      PRIMARY KEY (app_id, blob_id)
    );
    CREATE INDEX IF NOT EXISTS forge_blobs_owner ON forge_blobs (app_id, owner, created_at DESC);
  `);
}

interface BlobRow {
  blob_id: string; owner: string; content_type: string; size: string; checksum: string;
  filename: string | null; attrs: unknown; created_at: string;
}
function rowToMeta(r: BlobRow): BlobMetadata {
  return {
    blob_id: r.blob_id,
    owner: r.owner,
    content_type: r.content_type,
    size: Number(r.size),
    checksum: r.checksum,
    ...(r.filename != null ? { filename: r.filename } : {}),
    ...(r.attrs != null ? { attrs: r.attrs as Record<string, unknown> } : {}),
    created_at: r.created_at,
  };
}

// Stream a Readable fully into a Buffer (upload commit / migration import — a blob is bounded by the
// per-file max, so buffering is safe).
async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export class S3BlobBackend implements BlobBackend, MigratableBlobBackend {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly pool: Pool, private readonly s3: S3Client) {}

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

  // The object key: `<appId>/<blobId>`. blob_id is a server-minted opaque id, so this never collides.
  private key(appId: string, blobId: string): string {
    return `${appId}/${blobId}`;
  }

  async prepareTemp(): Promise<string> {
    const dir = path.join(tmpdir(), 'forge-blob-uploads');
    await mkdir(dir, { recursive: true });
    return path.join(dir, `.upload.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  }

  private async ownerUsage(appId: string, owner: string): Promise<OwnerUsage> {
    const r = await this.pool.query<{ bytes: string; count: string }>(
      'SELECT COALESCE(SUM(size),0)::text AS bytes, COUNT(*)::text AS count FROM forge_blobs WHERE app_id=$1 AND owner=$2',
      [appId, owner],
    );
    return { bytes: Number(r.rows[0]!.bytes), count: Number(r.rows[0]!.count) };
  }

  async usage(appId: string, owner: string): Promise<OwnerUsage> {
    return this.ownerUsage(appId, owner);
  }

  async commit(appId: string, tmpPath: string, meta: BlobMetadata, config: BlobConfig): Promise<CommitResult> {
    return this.withLock(appId, async () => {
      const usage = await this.ownerUsage(appId, meta.owner);
      if (usage.count + 1 > config.quotaObjects) {
        await this.safeUnlink(tmpPath);
        return { ok: false, reason: 'quota_objects', usage };
      }
      if (usage.bytes + meta.size > config.quotaBytes) {
        await this.safeUnlink(tmpPath);
        return { ok: false, reason: 'quota_bytes', usage };
      }
      const key = this.key(appId, meta.blob_id);
      const body = await readFile(tmpPath);
      await this.s3.putObject(key, body, meta.content_type, meta.checksum);
      try {
        await this.pool.query(
          `INSERT INTO forge_blobs (app_id, blob_id, owner, content_type, size, checksum, filename, attrs, created_at, group_id, visibility)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, NULL, 'private')`,
          [appId, meta.blob_id, meta.owner, meta.content_type, meta.size, meta.checksum, meta.filename ?? null, meta.attrs != null ? JSON.stringify(meta.attrs) : null, meta.created_at],
        );
      } catch (err) {
        // Metadata could not be persisted → remove the just-PUT object so nothing is orphaned.
        await this.s3.deleteObject(key).catch(() => undefined);
        await this.safeUnlink(tmpPath);
        throw err;
      }
      await this.safeUnlink(tmpPath);
      return { ok: true, meta };
    });
  }

  async get(appId: string, owner: string, blobId: string): Promise<BlobMetadata | null> {
    const r = await this.pool.query<BlobRow>(
      'SELECT blob_id, owner, content_type, size, checksum, filename, attrs, created_at FROM forge_blobs WHERE app_id=$1 AND owner=$2 AND blob_id=$3',
      [appId, owner, blobId],
    );
    return r.rows[0] ? rowToMeta(r.rows[0]) : null;
  }

  async delete(appId: string, owner: string, blobId: string): Promise<boolean> {
    return this.withLock(appId, async () => {
      // Metadata first (instantly unreachable), then the object — a crash between leaves an orphan object
      // with no dangling metadata, the safe direction (same as the FS backend).
      const r = await this.pool.query(
        'DELETE FROM forge_blobs WHERE app_id=$1 AND owner=$2 AND blob_id=$3',
        [appId, owner, blobId],
      );
      if ((r.rowCount ?? 0) === 0) return false;
      await this.s3.deleteObject(this.key(appId, blobId)).catch(() => undefined);
      return true;
    });
  }

  async list(appId: string, owner: string): Promise<BlobMetadata[]> {
    const r = await this.pool.query<BlobRow>(
      'SELECT blob_id, owner, content_type, size, checksum, filename, attrs, created_at FROM forge_blobs WHERE app_id=$1 AND owner=$2 ORDER BY created_at DESC, blob_id ASC',
      [appId, owner],
    );
    return r.rows.map(rowToMeta);
  }

  async openRange(appId: string, blobId: string, range?: { start: number; end: number }): Promise<Readable> {
    return this.s3.getObject(this.key(appId, blobId), range);
  }

  private async safeUnlink(p: string): Promise<void> {
    try {
      await unlink(p);
    } catch {
      // already gone / never created.
    }
  }

  // --- migration surface ---------------------------------------------------
  async exportMeta(appId: string): Promise<BlobMetadata[]> {
    const r = await this.pool.query<BlobRow>(
      'SELECT blob_id, owner, content_type, size, checksum, filename, attrs, created_at FROM forge_blobs WHERE app_id=$1',
      [appId],
    );
    return r.rows.map(rowToMeta);
  }

  async openBytes(appId: string, blobId: string): Promise<Readable> {
    return this.s3.getObject(this.key(appId, blobId));
  }

  async importOne(appId: string, meta: BlobMetadata, bytes: Readable): Promise<void> {
    const key = this.key(appId, meta.blob_id);
    await this.s3.putObject(key, await toBuffer(bytes), meta.content_type, meta.checksum);
    await this.pool.query(
      `INSERT INTO forge_blobs (app_id, blob_id, owner, content_type, size, checksum, filename, attrs, created_at, group_id, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9, NULL, 'private')
       ON CONFLICT (app_id, blob_id) DO UPDATE SET
         owner=EXCLUDED.owner, content_type=EXCLUDED.content_type, size=EXCLUDED.size, checksum=EXCLUDED.checksum,
         filename=EXCLUDED.filename, attrs=EXCLUDED.attrs, created_at=EXCLUDED.created_at`,
      [appId, meta.blob_id, meta.owner, meta.content_type, meta.size, meta.checksum, meta.filename ?? null, meta.attrs != null ? JSON.stringify(meta.attrs) : null, meta.created_at],
    );
  }

  async __truncateAllForTests(): Promise<void> {
    // Only the metadata is truncated here (fast + all the tests observe through it). Object bytes in the
    // test bucket are overwritten by blob_id and are harmless leftovers between tests.
    await this.pool.query('TRUNCATE forge_blobs');
  }
}
