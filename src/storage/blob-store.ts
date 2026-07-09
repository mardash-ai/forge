import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { blobsDir, blobsMetaFile, blobsBytesDir, blobBytesFile } from '../shared/paths';
import type { BlobConfig, BlobMetadata } from '../blobs/types';

// C20 — the durable, per-app FILE / BLOB store.
//
// TWO durable parts, BOTH on the same state volume the data-plane already uses (FORGE_STATE_DIR, e.g.
// /forge-state on the `forge_state` named volume) — no new external dependency:
//   - METADATA: one JSON doc per app, a keyed map `{ [owner<NUL>blob_id]: BlobMetadata }`. Low-volume,
//     mutable durable STATE (put/delete in place), so this mirrors the C4 notification / C19 search
//     store shape rather than an append-only log.
//   - BYTES: one opaque file per blob at `bytes/<appId>/<blob_id>`. Content-addressed by the
//     server-minted `blob_id`; the app never sees the path, so an object-store (S3/MinIO) swap behind
//     this same class is invisible to it.
//
// OWNER-SCOPING is STRUCTURAL: the metadata key includes `owner`, so `get`/`delete`/`list` for one
// owner can only ever build keys in that owner's slice — a cross-owner read can't even name the record,
// so it is a 404 (absent, never forbidden). The bytes file is keyed by the unguessable `blob_id`, and
// the only path from `blob_id` → bytes is through the owner-scoped metadata lookup.
//
// CONCURRENCY: a per-app async mutex serialises each app's metadata read-modify-write, and every file is
// replaced atomically (temp + rename), so a concurrent reader never sees a half-written map and two
// concurrent commits never lose an update (nor let two uploads both slip past the same quota). Byte
// streaming happens OUTSIDE the lock (it is slow); only the fast quota-check + rename + metadata write
// runs under it. Same discipline as the C4/C15/C19 stores.

// A NUL separates the key parts; it never appears in a normal owner/blob_id, so keys can't collide even
// if an owner id contains spaces. This is an in-memory/JSON map key (not a filename) — NUL is safe there
// and JSON escapes it. Built via fromCharCode so the source stays pure ASCII.
const SEP = String.fromCharCode(0);

function storageKey(owner: string, blobId: string): string {
  return `${owner}${SEP}${blobId}`;
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch {
    // already gone / never created — nothing to clean up.
  }
}

export interface OwnerUsage {
  bytes: number;
  count: number;
}

export type CommitResult =
  | { ok: true; meta: BlobMetadata }
  | { ok: false; reason: 'quota_bytes' | 'quota_objects'; usage: OwnerUsage };

export class BlobStore {
  private locks = new Map<string, Promise<unknown>>();

  private withLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(appId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // The lock tail must never reject, or a failed op would wedge the next waiter.
    this.locks.set(
      appId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async readMap(appId: string): Promise<Record<string, BlobMetadata>> {
    try {
      const parsed = JSON.parse(await readFile(blobsMetaFile(appId), 'utf8')) as Record<string, BlobMetadata>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  // Atomic replace: write a sibling temp file, then rename over the target.
  private async writeMap(appId: string, map: Record<string, BlobMetadata>): Promise<void> {
    await mkdir(blobsDir(), { recursive: true });
    const file = blobsMetaFile(appId);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(map, null, 2));
    await rename(tmp, file);
  }

  private ownerUsage(map: Record<string, BlobMetadata>, owner: string): OwnerUsage {
    let bytes = 0;
    let count = 0;
    for (const m of Object.values(map)) {
      if (m.owner === owner) {
        bytes += m.size;
        count += 1;
      }
    }
    return { bytes, count };
  }

  // Allocate a temp path for the route to stream an upload into, BEFORE the app is resolved (the `app`
  // field is only known once the multipart body is parsed). It lives in a staging dir under blobsDir(),
  // i.e. the SAME filesystem/volume as every app's final byte dir, so the commit rename is atomic (never
  // a cross-device copy) regardless of which app it lands in.
  async prepareTemp(): Promise<string> {
    const dir = path.join(blobsDir(), 'uploads');
    await mkdir(dir, { recursive: true });
    return path.join(dir, `.upload.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  }

  // The final byte-file path for a stored blob — the route streams the response from here on GET.
  bytesFile(appId: string, blobId: string): string {
    return blobBytesFile(appId, blobId);
  }

  // Current per-owner usage (bytes + object count), for the list endpoint's quota readout.
  async usage(appId: string, owner: string): Promise<OwnerUsage> {
    return this.ownerUsage(await this.readMap(appId), owner);
  }

  // Commit a fully-streamed temp file as a durable blob. Runs under the per-app lock: re-checks the
  // owner's quota against the CURRENT map (so two concurrent uploads can't both slip past), then
  // atomically moves the bytes into place and writes the metadata. ATOMIC + no orphans:
  //   - quota fail  → the temp file is removed, nothing persists.
  //   - metadata write fail → the just-moved byte file is removed, then the error propagates (507/503).
  // The caller MUST have already validated size/allowlist/magic BEFORE calling — commit only owns quota
  // + the atomic move. `tmpPath` must be from prepareTemp(appId) (same dir as the final file).
  async commit(appId: string, tmpPath: string, meta: BlobMetadata, config: BlobConfig): Promise<CommitResult> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      const usage = this.ownerUsage(map, meta.owner);
      if (usage.count + 1 > config.quotaObjects) {
        await safeUnlink(tmpPath);
        return { ok: false, reason: 'quota_objects', usage };
      }
      if (usage.bytes + meta.size > config.quotaBytes) {
        await safeUnlink(tmpPath);
        return { ok: false, reason: 'quota_bytes', usage };
      }
      const finalPath = this.bytesFile(appId, meta.blob_id);
      await mkdir(blobsBytesDir(appId), { recursive: true });
      await rename(tmpPath, finalPath);
      try {
        map[storageKey(meta.owner, meta.blob_id)] = meta;
        await this.writeMap(appId, map);
      } catch (err) {
        // Metadata could not be persisted → roll the bytes back so nothing is orphaned.
        await safeUnlink(finalPath);
        throw err;
      }
      return { ok: true, meta };
    });
  }

  // Owner-scoped metadata lookup. Returns null when the (owner, blobId) pair names no record — which is
  // ALSO the answer when the blob belongs to a DIFFERENT owner (the key simply isn't in this owner's
  // slice), so a cross-owner read is a 404, never a 403.
  async get(appId: string, owner: string, blobId: string): Promise<BlobMetadata | null> {
    const map = await this.readMap(appId);
    return map[storageKey(owner, blobId)] ?? null;
  }

  // Owner-scoped delete — removes metadata then bytes. Idempotent-by-effect: false when the (owner,
  // blobId) names nothing (absent or owned by someone else), so the route answers 404 either way.
  // Metadata is removed first so the blob is instantly unreachable; the byte unlink follows (a crash
  // between them leaves an orphan byte file with NO dangling metadata — the safe direction).
  async delete(appId: string, owner: string, blobId: string): Promise<boolean> {
    return this.withLock(appId, async () => {
      const map = await this.readMap(appId);
      const key = storageKey(owner, blobId);
      if (!(key in map)) return false;
      delete map[key];
      await this.writeMap(appId, map);
      await safeUnlink(this.bytesFile(appId, blobId));
      return true;
    });
  }

  // The owner's blobs, newest-first. Owner-filtered before it returns, so it can never surface another
  // owner's record.
  async list(appId: string, owner: string): Promise<BlobMetadata[]> {
    const map = await this.readMap(appId);
    return Object.values(map)
      .filter((m) => m.owner === owner)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }
}

export const blobStore = new BlobStore();
