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

export function logsDir(): string {
  return path.join(stateDir(), 'logs');
}

export function logPath(resourceId: string): string {
  return path.join(logsDir(), `${resourceId}.log`);
}
