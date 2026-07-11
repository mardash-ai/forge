import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { store } from '../storage/store';
import { getBackends } from '../storage/backends';
import { newId } from '../shared/ids';
import { nowIso } from '../shared/time';
import {
  blobConfig,
  blobError,
  sniffMatches,
  sanitizeFilename,
  toDescriptor,
  HEAD_SNIFF_BYTES,
  MAX_ATTRS_BYTES,
  type BlobConfig,
  type BlobMetadata,
} from '../blobs/types';

// C20 — the FILE / BLOB storage surface. Registered on BOTH the control-plane API (dev) and the
// data-plane server (prod sidecar), like the C3 app-event / C4 notification / C19 search routes
// (app→Forge): the running app uploads a user's file, gets an opaque `blob_id`, and streams the bytes
// back. Reached server-side the same way (base URL via the app's FORGE_EVENTS_URL; `app` defaults to
// the sidecar's FORGE_APP_NAME, so the app usually needn't pass it).
//
//   POST   /blobs            multipart/form-data: file + { app?, owner (REQUIRED), content_type,
//                            filename?, attrs? }                     -> 201 { blob_id, content_type,
//                            size, checksum, filename?, created_at }
//   GET    /blobs/:id        ?owner=&app=  (Range supported)         -> streams bytes + ETag/cache hdrs
//   DELETE /blobs/:id        ?owner=&app=                            -> 204 (404 if absent/not-owner)
//   GET    /blobs            ?owner=&app=                            -> { blobs: [...], usage }
//
// OWNER-SCOPING (mandatory): `owner` (C10's session userId) is stamped on upload and required on every
// GET/DELETE/list; the platform filters to it as defense-in-depth. A blob owned by someone else is
// therefore 404 — ABSENT, never 403 (the app fronts these with its own auth-checked route; Forge just
// enforces owner on the raw GET). Trust model is app-asserted (the private data-plane trusts the owner
// the app sends, exactly as C3/C4/C1/C19 do); there is no per-user token scheme.
//
// FAILURE MODES: upload is NOT best-effort (the app needs the `blob_id`), so it surfaces real errors:
//   file too large → 413 · disallowed type → 415 · magic-byte mismatch → 415 · per-owner byte quota →
//   413 · per-owner object quota → 409 · missing owner → 422 · client abort mid-stream → 400 with
//   NOTHING persisted · disk-full/IO → 507/503 · not-found/not-owner → 404. Writes are atomic (temp +
//   rename + metadata, or full cleanup), so a failed upload never orphans bytes.

// A high, absolute ceiling for busboy so a pathological / MISCONFIGURED request can't buffer unbounded.
// The real, configurable per-file max (default 15 MB) is what normally applies; this only bites if an
// operator sets FORGE_BLOB_MAX_BYTES absurdly high. Wired into the parts() fileSize limit below as
// min(configured, ceiling), so the upload buffer is ALWAYS bounded.
const HARD_FILE_CEILING = 2 * 1024 * 1024 * 1024; // 2 GB

interface CollectedUpload {
  found: boolean;
  size: number;
  checksum: string;
  head: Buffer;
  truncated: boolean;
  partMimetype: string;
  partFilename: string | undefined;
  fields: Record<string, string>;
  streamError: Error | null;
}

// Parse an HTTP Range header for a single byte range. Returns:
//   null              — no (or a multi-range / non-bytes) header → serve the whole object (200)
//   'unsatisfiable'   — a syntactically valid but out-of-bounds range → 416
//   { start, end }    — an inclusive, in-bounds byte range → 206
function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header || !header.startsWith('bytes=')) return null;
  const spec = header.slice('bytes='.length);
  if (spec.includes(',')) return null; // multi-range: fall back to a full 200
  const m = /^(\d*)-(\d*)$/.exec(spec.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  let start: number;
  let end: number;
  if (rawStart === '') {
    // suffix range: last N bytes
    const suffix = Number(rawEnd);
    if (suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'unsatisfiable';
  if (end >= size) end = size - 1;
  return { start, end };
}

export function registerBlobRoutes(
  app: FastifyInstance,
  opts: { defaultApp?: () => string | undefined } = {},
): void {
  // @fastify/multipart is wrapped with fastify-plugin, so its request decorators (req.parts / req.file /
  // req.isMultipart) apply to the routes below even though they're registered on the same instance.
  // throwFileSizeLimit:false → an over-limit file is TRUNCATED (we detect .truncated and return 413)
  // rather than throwing mid-parse, so we own the failure mapping.
  app.register(fastifyMultipart, { throwFileSizeLimit: false });

  const resolveAppId = async (name?: string): Promise<string | null> => {
    const n = name ?? opts.defaultApp?.();
    if (!n) return null;
    const a = await store.findAppByName(n);
    return a && a.type === 'Application' ? a.id : null;
  };
  const unknownApp = blobError('not_found', 'unknown app (pass `app` or set FORGE_APP_NAME).', 'change-input');
  const notFound = blobError('not_found', 'no such blob for this owner.', 'change-input');

  // --- Stream one multipart request to a temp file, collecting the file + all fields. ------------------
  // Streams the file part (fieldname `file`) through a hash + size counter + head capture into `tmpPath`,
  // and buffers every text field. Robust to field ORDER (validation happens after the whole body is
  // parsed), so `owner`/`content_type` may arrive before OR after the file.
  const collect = async (req: FastifyRequest, tmpPath: string, config: BlobConfig): Promise<CollectedUpload> => {
    const out: CollectedUpload = {
      found: false, size: 0, checksum: '', head: Buffer.alloc(0),
      truncated: false, partMimetype: '', partFilename: undefined, fields: {}, streamError: null,
    };
    const parts = req.parts({ limits: { fileSize: Math.min(config.maxBytes, HARD_FILE_CEILING), files: 1, fields: 25, fieldSize: 1_000_000 } });
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file' && !out.found) {
        out.found = true;
        out.partMimetype = part.mimetype;
        out.partFilename = part.filename;
        const hash = createHash('sha256');
        const headChunks: Buffer[] = [];
        let headLen = 0;
        try {
          await pipeline(
            part.file,
            async function* (source: AsyncIterable<Buffer>) {
              for await (const chunk of source) {
                out.size += chunk.length;
                hash.update(chunk);
                if (headLen < HEAD_SNIFF_BYTES) {
                  const take = chunk.subarray(0, HEAD_SNIFF_BYTES - headLen);
                  headChunks.push(take);
                  headLen += take.length;
                }
                yield chunk;
              }
            },
            createWriteStream(tmpPath),
          );
        } catch (err) {
          out.streamError = err as Error;
        }
        // busboy sets `.truncated` when the per-request fileSize limit tripped (throwFileSizeLimit:false).
        out.truncated = Boolean((part.file as { truncated?: boolean }).truncated);
        out.checksum = hash.digest('hex');
        out.head = Buffer.concat(headChunks);
      } else if (part.type === 'file') {
        // With files:1 busboy won't deliver a second file, but be defensive: drain any stray file part
        // so the parts() iterator can advance past it.
        for await (const chunk of part.file) void chunk;
      } else {
        out.fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value);
      }
    }
    return out;
  };

  // === POST /blobs — app-proxied multipart upload ======================================================
  app.post('/blobs', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.isMultipart()) {
      return reply.status(415).send(blobError('unsupported_media_type', 'POST /blobs expects multipart/form-data with a `file` field.', 'change-input'));
    }
    const config = blobConfig();
    const backend = (await getBackends()).blobs;
    const tmpPath = await backend.prepareTemp();

    let up: CollectedUpload;
    try {
      up = await collect(req, tmpPath, config);
    } catch (err) {
      await safeCleanup(tmpPath);
      return mapStreamError(reply, err as Error);
    }

    // No file part at all.
    if (!up.found) {
      await safeCleanup(tmpPath);
      return reply.status(400).send(blobError('missing_file', 'the multipart body must include a `file` part.', 'change-input'));
    }
    // Over the per-file max (busboy truncated the stream).
    if (up.truncated) {
      await safeCleanup(tmpPath);
      return reply.status(413).send(blobError('file_too_large', `file exceeds the ${config.maxBytes}-byte limit.`, 'change-input'));
    }
    // A stream error while receiving = client abort / write failure — NOTHING persisted.
    if (up.streamError) {
      await safeCleanup(tmpPath);
      return mapStreamError(reply, up.streamError);
    }
    // Empty upload — there is nothing to store.
    if (up.size === 0) {
      await safeCleanup(tmpPath);
      return reply.status(400).send(blobError('empty_file', 'the uploaded file is empty.', 'change-input'));
    }

    const owner = (up.fields.owner ?? '').trim();
    if (!owner) {
      await safeCleanup(tmpPath);
      return reply.status(422).send(blobError('invalid_input', 'an upload requires a non-empty `owner`.', 'change-input'));
    }

    const declared = (up.fields.content_type ?? up.partMimetype ?? '').trim().toLowerCase();
    if (!declared) {
      await safeCleanup(tmpPath);
      return reply.status(415).send(blobError('unsupported_media_type', 'declare a `content_type` (or send a typed file part).', 'change-input'));
    }
    if (!config.allowedTypes.has(declared)) {
      await safeCleanup(tmpPath);
      return reply.status(415).send(blobError('unsupported_media_type', `content type "${declared}" is not allowed.`, 'change-input'));
    }
    // SECURITY: the bytes must actually be what the declared type claims.
    if (!sniffMatches(declared, up.head)) {
      await safeCleanup(tmpPath);
      return reply.status(415).send(blobError('content_mismatch', `file content does not match the declared type "${declared}".`, 'change-input'));
    }

    // Optional small attrs bag (JSON string).
    let attrs: Record<string, unknown> | undefined;
    if (up.fields.attrs !== undefined && up.fields.attrs !== '') {
      if (up.fields.attrs.length > MAX_ATTRS_BYTES) {
        await safeCleanup(tmpPath);
        return reply.status(422).send(blobError('invalid_input', '`attrs` is too large.', 'change-input'));
      }
      try {
        const parsed = JSON.parse(up.fields.attrs);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          attrs = parsed as Record<string, unknown>;
        } else {
          throw new Error('not an object');
        }
      } catch {
        await safeCleanup(tmpPath);
        return reply.status(422).send(blobError('invalid_input', '`attrs` must be a JSON object.', 'change-input'));
      }
    }

    const app_id = await resolveAppId(up.fields.app);
    if (!app_id) {
      await safeCleanup(tmpPath);
      return reply.status(404).send(unknownApp);
    }

    const filename = sanitizeFilename(up.fields.filename ?? up.partFilename);
    const meta: BlobMetadata = {
      blob_id: newId('blob'),
      owner,
      content_type: declared,
      size: up.size,
      checksum: up.checksum,
      ...(filename !== undefined ? { filename } : {}),
      ...(attrs !== undefined ? { attrs } : {}),
      created_at: nowIso(),
    };

    let result;
    try {
      result = await backend.commit(app_id, tmpPath, meta, config);
    } catch (err) {
      await safeCleanup(tmpPath);
      return mapStreamError(reply, err as Error);
    }
    if (!result.ok) {
      if (result.reason === 'quota_objects') {
        return reply.status(409).send(blobError('quota_objects_exceeded', `owner object quota (${config.quotaObjects}) reached.`, 'change-input'));
      }
      return reply.status(413).send(blobError('quota_bytes_exceeded', `owner storage quota (${config.quotaBytes} bytes) would be exceeded.`, 'change-input'));
    }
    return reply.status(201).send(toDescriptor(result.meta));
  });

  // === GET /blobs/:id — owner-scoped, streamed, Range-capable ==========================================
  app.get('/blobs/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { owner?: string; app?: string };
    const owner = (q.owner ?? '').trim();
    if (!owner) return reply.status(400).send(blobError('invalid_input', 'a blob read requires an `owner` query param.', 'change-input'));
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);

    const backend = (await getBackends()).blobs;
    const meta = await backend.get(app_id, owner, id);
    if (!meta) return reply.status(404).send(notFound); // absent OR another owner's — never 403

    const etag = `"${meta.checksum}"`;
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();

    // Resolve Range BEFORE setting the body content-type, so an out-of-bounds range can still send a
    // JSON error (a 416 with the blob's content-type set would fail Fastify's payload serialization).
    const range = parseRange(req.headers.range, meta.size);
    if (range === 'unsatisfiable') {
      return reply.status(416).header('Content-Range', `bytes */${meta.size}`).send(blobError('range_not_satisfiable', 'requested range is out of bounds.', 'change-input'));
    }

    reply.header('ETag', etag);
    reply.header('Content-Type', meta.content_type);
    reply.header('Cache-Control', 'private, max-age=31536000, immutable'); // content-addressed by id → immutable
    reply.header('Accept-Ranges', 'bytes');
    if (meta.filename) reply.header('Content-Disposition', `inline; filename="${meta.filename}"`);

    if (range) {
      reply.status(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${meta.size}`);
      reply.header('Content-Length', String(range.end - range.start + 1));
      return reply.send(await backend.openRange(app_id, id, { start: range.start, end: range.end }));
    }
    reply.header('Content-Length', String(meta.size));
    return reply.send(await backend.openRange(app_id, id));
  });

  // === DELETE /blobs/:id — owner-scoped, idempotent-by-effect (204 on success, 404 otherwise) ==========
  app.delete('/blobs/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { owner?: string; app?: string };
    const body = (req.body ?? {}) as { owner?: string; app?: string };
    const owner = (q.owner ?? body.owner ?? '').trim();
    if (!owner) return reply.status(400).send(blobError('invalid_input', 'a blob delete requires an `owner`.', 'change-input'));
    const app_id = await resolveAppId(q.app ?? body.app);
    if (!app_id) return reply.status(404).send(unknownApp);

    const backend = (await getBackends()).blobs;
    const deleted = await backend.delete(app_id, owner, id);
    if (!deleted) return reply.status(404).send(notFound); // absent / already-gone / not-owner
    return reply.status(204).send();
  });

  // === GET /blobs — owner-scoped list + usage/quota readout (optional generic) =========================
  app.get('/blobs', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { owner?: string; app?: string };
    const owner = (q.owner ?? '').trim();
    if (!owner) return reply.status(400).send(blobError('invalid_input', 'a blob list requires an `owner` query param.', 'change-input'));
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const config = blobConfig();
    const backend = (await getBackends()).blobs;
    const metas = await backend.list(app_id, owner);
    const usage = await backend.usage(app_id, owner);
    return reply.status(200).send({
      blobs: metas.map(toDescriptor),
      usage: { bytes: usage.bytes, count: usage.count, quota_bytes: config.quotaBytes, quota_objects: config.quotaObjects },
    });
  });
}

// A stream/IO error is either a client abort (nothing persisted → 400) or a real storage failure
// (disk full → 507; other IO → 503).
function mapStreamError(reply: FastifyReply, err: Error): FastifyReply {
  const code = (err as { code?: string }).code;
  if (code === 'ENOSPC') {
    return reply.status(507).send(blobError('storage_full', 'insufficient storage to persist the blob.', 'backoff'));
  }
  if (code === 'EIO' || code === 'EACCES' || code === 'EROFS') {
    return reply.status(503).send(blobError('storage_unavailable', 'blob storage is temporarily unavailable.', 'backoff'));
  }
  // Default: the client went away mid-upload — the write was abandoned, nothing was stored.
  return reply.status(400).send(blobError('upload_aborted', 'the upload did not complete; nothing was stored.', 'change-input'));
}

async function safeCleanup(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch {
    // already gone.
  }
}
