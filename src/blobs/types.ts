// C20 — File / blob storage. A generic, per-app, owner-scoped blob store: an app uploads a user's file
// (avatar, attachment, export, …), gets back an opaque `blob_id`, and later streams the bytes back —
// reached server-side exactly like the C3 app-event log / C4 notifications / C19 search (base URL via
// the app's FORGE_EVENTS_URL; optional `app` field defaulting to the sidecar's FORGE_APP_NAME).
//
// The blob is deliberately CONTENT-AGNOSTIC: the platform stores bytes + a little metadata and enforces
// owner-scoping, size, an allowlist, and per-owner quota. It never interprets the content beyond a
// magic-byte sniff that the declared type isn't a lie. `(app, owner)` partitions everything; the
// `blob_id` is a server-minted, unguessable id — the app only ever sees that id, so an object-store
// (S3/MinIO) swap behind the same API is invisible to the app.

// The durable record for one stored blob. `owner` is REQUIRED and is stamped on upload; every read and
// delete is filtered to it, so a blob can never leak across owners — the crux of the capability.
export interface BlobMetadata {
  // Server-minted opaque id (e.g. `blob_ab12…`). The ONLY handle the app holds; also the byte-file key.
  blob_id: string;
  // Owner (C11) — the opaque per-user id (C10's session `userId`). REQUIRED. Part of the storage key.
  owner: string;
  // The validated MIME type (allowlisted AND magic-byte-confirmed). What GET streams back verbatim.
  content_type: string;
  // Exact byte length of the stored content.
  size: number;
  // Lowercase hex SHA-256 of the bytes — the integrity checksum and the ETag source.
  checksum: string;
  // Original client filename (basename, sanitized), used for Content-Disposition. Optional.
  filename?: string;
  // A small denormalized bag the app may attach (e.g. { alt, purpose }) — round-tripped verbatim.
  attrs?: Record<string, unknown>;
  // ISO-8601 creation time.
  created_at: string;
}

// The public projection returned on a successful upload (201) and in a list. Never exposes the storage
// key scheme or any owner other than the caller's own.
export interface BlobDescriptor {
  blob_id: string;
  content_type: string;
  size: number;
  checksum: string;
  filename?: string;
  attrs?: Record<string, unknown>;
  created_at: string;
}

export function toDescriptor(m: BlobMetadata): BlobDescriptor {
  return {
    blob_id: m.blob_id,
    content_type: m.content_type,
    size: m.size,
    checksum: m.checksum,
    ...(m.filename !== undefined ? { filename: m.filename } : {}),
    ...(m.attrs !== undefined ? { attrs: m.attrs } : {}),
    created_at: m.created_at,
  };
}

// ============================================================================
// Config — defaults with env overrides (config, not architecture; read at call
// time so tests can pin small limits without re-registering the routes).
// ============================================================================

export const DEFAULT_MAX_BYTES = 15 * 1024 * 1024; // 15 MB per file
export const DEFAULT_QUOTA_BYTES = 500 * 1024 * 1024; // 500 MB per owner
export const DEFAULT_QUOTA_OBJECTS = 1000; // objects per owner
export const HEAD_SNIFF_BYTES = 512; // leading bytes captured for the magic-byte sniff
export const MAX_ATTRS_BYTES = 4 * 1024; // the `attrs` bag stays small (serialized cap)

// The shipped allowlist: common images + a few document types. Configurable via FORGE_BLOB_ALLOWED_TYPES.
export const DEFAULT_ALLOWED_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/markdown',
];

export interface BlobConfig {
  maxBytes: number;
  quotaBytes: number;
  quotaObjects: number;
  allowedTypes: Set<string>;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  // 0 is a valid config (e.g. quota 0 = block all); only a negative/NaN value falls back to the default.
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function blobConfig(): BlobConfig {
  const allowedRaw = process.env.FORGE_BLOB_ALLOWED_TYPES;
  const allowedTypes = new Set(
    allowedRaw && allowedRaw.trim() !== ''
      ? allowedRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : DEFAULT_ALLOWED_TYPES,
  );
  return {
    maxBytes: intEnv('FORGE_BLOB_MAX_BYTES', DEFAULT_MAX_BYTES),
    quotaBytes: intEnv('FORGE_BLOB_QUOTA_BYTES', DEFAULT_QUOTA_BYTES),
    quotaObjects: intEnv('FORGE_BLOB_QUOTA_OBJECTS', DEFAULT_QUOTA_OBJECTS),
    allowedTypes,
  };
}

// ============================================================================
// Magic-byte sniffing — SECURITY: never trust the declared `content_type`. A binary type must match
// its signature exactly; a text type must NOT match any known binary signature and must contain no NUL
// byte. So declaring `image/png` while sending a PDF (or declaring `text/plain` while sending a PNG)
// is rejected 415, even though the header claimed an allowlisted type.
// ============================================================================

interface BinarySignature {
  type: string;
  test: (b: Buffer) => boolean;
}

const BINARY_SIGNATURES: BinarySignature[] = [
  // PNG — 89 50 4E 47 0D 0A 1A 0A
  { type: 'image/png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  // JPEG — FF D8 FF
  { type: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // GIF — "GIF87a" / "GIF89a"
  { type: 'image/gif', test: (b) => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61 },
  // WEBP — "RIFF" <4-byte size> "WEBP"
  { type: 'image/webp', test: (b) => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  // PDF — "%PDF-"
  { type: 'application/pdf', test: (b) => b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d },
];

const SNIFFABLE_TEXT_TYPES = new Set(['text/plain', 'text/markdown']);

// True iff the leading bytes are consistent with the declared type. `head` is the first HEAD_SNIFF_BYTES
// (or fewer for a small file) of the content.
export function sniffMatches(declared: string, head: Buffer): boolean {
  const t = declared.toLowerCase();
  const sig = BINARY_SIGNATURES.find((s) => s.type === t);
  if (sig) return sig.test(head);
  if (SNIFFABLE_TEXT_TYPES.has(t)) {
    // A text type must not actually be a known binary payload and must look like text.
    if (BINARY_SIGNATURES.some((s) => s.test(head))) return false;
    if (head.includes(0x00)) return false;
    return true;
  }
  // A declared type with no signature we know how to sniff (only reachable if the operator widened the
  // allowlist to an unsniffable type): the allowlist is the gate; we can't affirmatively contradict it.
  return true;
}

// ============================================================================
// Error envelope — the platform's standard `{ error: { code, message, retry } }` shape.
// ============================================================================

export type Retry = 'no' | 'change-input' | 'backoff';

export function blobError(code: string, message: string, retry: Retry = 'no'): {
  error: { code: string; message: string; retry: Retry };
} {
  return { error: { code, message, retry } };
}

// Sanitize a client-supplied filename to a safe basename for Content-Disposition (never a storage path).
// Drops directory components, control characters, quotes, and backslashes; caps the length.
export function sanitizeFilename(name: string | undefined): string | undefined {
  if (!name || typeof name !== 'string') return undefined;
  const base = name.split(/[\\/]/).pop() ?? '';
  let out = '';
  for (const ch of base) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || ch === '"' || ch === '\\') continue;
    out += ch;
  }
  out = out.trim().slice(0, 200);
  return out.length > 0 ? out : undefined;
}
