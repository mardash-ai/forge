import type { Readable } from 'node:stream';
import type { BlobConfig, BlobMetadata } from '../../../blobs/types';

// P26 (increment 5) — the pluggable BlobBackend interface (C20). Blobs are the first store whose BYTES
// move off the filesystem: a filesystem implementation keeps bytes on the forge_state volume + metadata
// in a JSON map, while the object-store implementation puts bytes in an S3-compatible object store
// (MinIO/S3) + metadata in Postgres. Both satisfy the identical method set, so POST /blobs,
// GET /blobs/:id (Range/ETag), DELETE /blobs/:id, GET /blobs never know which runs — the app only ever
// holds the opaque server-minted blob_id. Owner-scoping + the size/allowlist/magic-byte/quota checks are
// unchanged; the O4 (owner, group_id, visibility) columns are baked into the metadata.
//
// UPLOAD FLOW (both backends): the route streams the multipart file into a LOCAL temp file (computing
// the sha256 + head bytes + size for the magic-byte/allowlist/size checks), THEN calls commit() — which
// enforces the per-owner quota and persists the bytes (FS: atomic rename into the bytes dir; S3: PUT the
// temp file to the object store) + the metadata, atomically with rollback on failure.

export interface OwnerUsage {
  bytes: number;
  count: number;
}

export type CommitResult =
  | { ok: true; meta: BlobMetadata }
  | { ok: false; reason: 'quota_bytes' | 'quota_objects'; usage: OwnerUsage };

export interface BlobBackend {
  // A local staging path the route streams the upload into (BOTH backends stage locally so the bytes can
  // be validated + hashed before they are committed).
  prepareTemp(): Promise<string>;
  // Persist a fully-streamed temp file as a durable blob (quota-checked, atomic, no orphans on failure).
  commit(appId: string, tmpPath: string, meta: BlobMetadata, config: BlobConfig): Promise<CommitResult>;
  // Owner-scoped metadata lookup (a different owner → null → the route answers 404, never 403).
  get(appId: string, owner: string, blobId: string): Promise<BlobMetadata | null>;
  // Owner-scoped delete of metadata + bytes; idempotent-by-effect.
  delete(appId: string, owner: string, blobId: string): Promise<boolean>;
  // The owner's blobs, newest-first.
  list(appId: string, owner: string): Promise<BlobMetadata[]>;
  // Per-owner usage (bytes + object count) for the quota readout.
  usage(appId: string, owner: string): Promise<OwnerUsage>;
  // A readable stream of the blob's bytes, optionally a byte range (Range serving). The route has already
  // resolved the blob's metadata (so the range is in-bounds) before calling this.
  openRange(appId: string, blobId: string, range?: { start: number; end: number }): Promise<Readable>;
  close?(): Promise<void>;
  __truncateAllForTests?(): Promise<void>;
}

// Migration surface. `exportMeta` lists an app's blob metadata; `openBytes` opens the full byte stream
// (source side); `importOne` writes one blob's bytes + metadata into the target with the blob_id
// preserved. Backfill copies bytes → object store + metadata → Postgres, blob_ids intact.
export interface MigratableBlobBackend {
  exportMeta(appId: string): Promise<BlobMetadata[]>;
  openBytes(appId: string, blobId: string): Promise<Readable>;
  importOne(appId: string, meta: BlobMetadata, bytes: Readable): Promise<void>;
}
