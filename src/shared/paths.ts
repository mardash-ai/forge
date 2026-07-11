import path from 'node:path';

// Workspace root: where Builder applications live and where the .forge state
// store is kept. Bind-mounted at the same absolute path host==container.
export function workspaceDir(): string {
  return process.env.FORGE_WORKSPACE ?? path.resolve(process.cwd(), 'workspace');
}

export function stateDir(): string {
  return process.env.FORGE_STATE_DIR ?? path.join(workspaceDir(), '.forge');
}

// App layout for this workspace:
//   'single' → every repo is exactly one app, living at ./app.
//   'multi'  → many apps under ./apps/<name> (default; legacy/backward-compatible).
// Selected by FORGE_APP_LAYOUT (set in the workspace's compose.yaml). Anything
// other than 'single' resolves to 'multi', so existing projects are unaffected.
export function appLayout(): 'single' | 'multi' {
  return process.env.FORGE_APP_LAYOUT === 'single' ? 'single' : 'multi';
}

export function appsDir(): string {
  return path.join(workspaceDir(), 'apps');
}

// Directory for an app. In single-app mode the name is metadata only — the app
// always lives at ./app. In multi-app mode it lives at ./apps/<name>.
export function appDir(name: string): string {
  return appLayout() === 'single'
    ? path.join(workspaceDir(), 'app')
    : path.join(appsDir(), name);
}

export function resourcesDir(): string {
  return path.join(stateDir(), 'resources');
}

export function eventsFile(): string {
  return path.join(stateDir(), 'events', 'events.jsonl');
}

// Application DOMAIN event log (C3) — one append-only JSONL PER APP, separate from the
// platform's single ForgeEvent log above. Keeps the app's own facts (goal.created, …) out
// of the closed platform fact catalog.
export function appEventsDir(): string {
  return path.join(stateDir(), 'app-events');
}

export function appEventsFile(appId: string): string {
  return path.join(appEventsDir(), `${appId}.jsonl`);
}

// Per-app notification store (C4) — a single JSON doc per app (keyed map), since notifications
// are low-volume durable STATE (upsert/dismiss/clear), unlike the append-only app-event log.
export function notificationsDir(): string {
  return path.join(stateDir(), 'notifications');
}

export function notificationsFile(appId: string): string {
  return path.join(notificationsDir(), `${appId}.json`);
}

// Per-app uptime history store (C15 Phase 2). Two files per app under one dir:
//   <appId>.jsonl        raw HealthSnapshots (bounded to the raw retention window)
//   <appId>.rollup.json  the durable per-day rollup (bounded to the rollup window)
// High-volume, timestamped, per-app durable data — kept out of the generic Resource
// store (like the C3 app-event log + C4 notifications), so it never bloats /resources.
export function uptimeDir(): string {
  return path.join(stateDir(), 'uptime');
}

export function uptimeRawFile(appId: string): string {
  return path.join(uptimeDir(), `${appId}.jsonl`);
}

export function uptimeRollupFile(appId: string): string {
  return path.join(uptimeDir(), `${appId}.rollup.json`);
}

// Per-app incident store (C15 Phase 3) — one JSON doc per app (a keyed map of
// operator-declared incidents), since incidents are low-volume durable STATE
// (create/update/resolve + a bounded resolved-history), like the C4 notification
// store. Kept OUT of the generic Resource store (like uptime/notifications/auth), so
// operator incidents never surface through the inspectable `/resources` API.
export function incidentsDir(): string {
  return path.join(stateDir(), 'incidents');
}

export function incidentsFile(appId: string): string {
  return path.join(incidentsDir(), `${appId}.json`);
}

export function logsDir(): string {
  return path.join(stateDir(), 'logs');
}

// Where encrypted secrets (and the local master key, in dev) are kept. Under the
// gitignored state dir, so material never lands in a tracked file or image layer.
export function secretsDir(): string {
  return path.join(stateDir(), 'secrets');
}

// Per-app identity store (C10) — one JSON doc per app holding users, sessions, and
// short-lived verify/reset tokens. Lives under the gitignored state dir (like the
// secrets vault), NEVER surfaced through the generic `/resources` read API, so
// password hashes and session material stay out of any inspectable resource.
export function authDir(): string {
  return path.join(stateDir(), 'auth');
}

export function authFile(appId: string): string {
  return path.join(authDir(), `${appId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

export function logPath(resourceId: string): string {
  return path.join(logsDir(), `${resourceId}.log`);
}

// Per-app search index store (C19) — one JSON doc per app: a keyed map `{ [owner\0type\0id]: doc }`
// of the app's indexable documents (owner-stamped). Mutable, durable STATE (upsert/delete in place),
// so it mirrors the C4 notification store's shape rather than an append-only log. Kept OUT of the
// generic Resource store (like notifications/auth/incidents), so indexed app rows never surface
// through the inspectable `/resources` API.
export function searchDir(): string {
  return path.join(stateDir(), 'search');
}

export function searchFile(appId: string): string {
  return path.join(searchDir(), `${appId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

// Per-app policy store (C29) — one JSON doc per app: a keyed map `{ [id]: PolicyRule }` of the app's
// authorization policies (owner-scoped or app-wide). Mutable durable STATE (put/delete in place). Kept
// OUT of the generic Resource store, so policies never surface through the inspectable `/resources` API.
export function policiesDir(): string {
  return path.join(stateDir(), 'policies');
}

export function policiesFile(appId: string): string {
  return path.join(policiesDir(), `${appId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

// Per-app blob / file store (C20). Two parts, both under the SAME durable state volume the data-plane
// already uses (FORGE_STATE_DIR, e.g. /forge-state on the `forge_state` named volume) — NO new external
// dependency:
//   - METADATA: one JSON doc per app, a keyed map `{ [owner\0blob_id]: BlobMetadata }` (owner-stamped,
//     mutable durable STATE, upsert/delete in place — the C4/C19 store shape). Keyed by owner so a
//     cross-owner lookup can't build the right key (owner-scoping is structural).
//   - BYTES: one opaque file per blob under `bytes/<appId>/<blob_id>` — content-addressed by the
//     server-minted `blob_id`. Never surfaces through the inspectable `/resources` API (like
//     search/auth/secrets). Object store (S3/MinIO) is a scale-out swap behind the same store API.
function safeSeg(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function blobsDir(): string {
  return path.join(stateDir(), 'blobs');
}

export function blobsMetaFile(appId: string): string {
  return path.join(blobsDir(), `${safeSeg(appId)}.json`);
}

export function blobsBytesDir(appId: string): string {
  return path.join(blobsDir(), 'bytes', safeSeg(appId));
}

export function blobBytesFile(appId: string, blobId: string): string {
  return path.join(blobsBytesDir(appId), safeSeg(blobId));
}
