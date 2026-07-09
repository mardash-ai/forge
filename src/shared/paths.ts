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
