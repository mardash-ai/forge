import path from 'node:path';

// Workspace root: where Builder applications live and where the .forge state
// store is kept. Bind-mounted at the same absolute path host==container.
export function workspaceDir(): string {
  return process.env.FORGE_WORKSPACE ?? path.resolve(process.cwd(), 'workspace');
}

export function stateDir(): string {
  return process.env.FORGE_STATE_DIR ?? path.join(workspaceDir(), '.forge');
}

export function appsDir(): string {
  return path.join(workspaceDir(), 'apps');
}

export function appDir(name: string): string {
  return path.join(appsDir(), name);
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
