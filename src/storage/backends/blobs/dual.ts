import type { Readable } from 'node:stream';
import type { BlobConfig, BlobMetadata } from '../../../blobs/types';
import type { BlobStore } from '../../blob-store';
import type { S3BlobBackend } from './s3';
import type { BlobBackend, CommitResult, OwnerUsage } from './types';

// P26 — the DUAL-WRITE blob backend: the safe migration window. The object store + Postgres is the
// source of truth (all reads come from it); each commit writes there first, then the bytes + metadata
// are mirrored to the filesystem, so an operator can flip reads back to the FS backend with no data loss.
// Byte doubling is inherent to a bytes migration and temporary. Selected with FORGE_BLOBS_BACKEND=s3 +
// FORGE_BLOBS_DUAL_WRITE=1.
export class DualWriteBlobBackend implements BlobBackend {
  constructor(private readonly primary: S3BlobBackend, private readonly secondary: BlobStore) {}

  prepareTemp(): Promise<string> {
    return this.primary.prepareTemp();
  }
  get(appId: string, owner: string, blobId: string): Promise<BlobMetadata | null> {
    return this.primary.get(appId, owner, blobId);
  }
  list(appId: string, owner: string): Promise<BlobMetadata[]> {
    return this.primary.list(appId, owner);
  }
  usage(appId: string, owner: string): Promise<OwnerUsage> {
    return this.primary.usage(appId, owner);
  }
  openRange(appId: string, blobId: string, range?: { start: number; end: number }): Promise<Readable> {
    return this.primary.openRange(appId, blobId, range);
  }

  async commit(appId: string, tmpPath: string, meta: BlobMetadata, config: BlobConfig): Promise<CommitResult> {
    const res = await this.primary.commit(appId, tmpPath, meta, config);
    if (res.ok) {
      // Mirror to the filesystem — the primary consumed the temp file, so re-read the bytes from it.
      await this.secondary.importOne(appId, res.meta, await this.primary.openBytes(appId, res.meta.blob_id));
    }
    return res;
  }

  async delete(appId: string, owner: string, blobId: string): Promise<boolean> {
    const deleted = await this.primary.delete(appId, owner, blobId);
    await this.secondary.delete(appId, owner, blobId).catch(() => undefined);
    return deleted;
  }
}
