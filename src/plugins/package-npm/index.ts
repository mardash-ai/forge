import { composeRun } from '../runtime-docker-compose/index';
import type { RunResult } from '../../shared/exec';

// Plugin: package-npm — Implementation of InstallDependencies for npm.
export const IMPLEMENTATION = 'package-npm';

export interface InstallResult {
  ok: boolean;
  run: RunResult;
  summary: string;
}

export async function install(appDir: string, logFile: string): Promise<InstallResult> {
  const r = await composeRun(appDir, 'web', ['npm', 'install'], { logFile });
  const ok = r.code === 0;
  const added = r.combined.match(/added (\d+) packages?/);
  const summary = ok
    ? added
      ? `Installed dependencies (${added[1]} packages) in ${(r.durationMs / 1000).toFixed(1)}s.`
      : `Dependencies installed in ${(r.durationMs / 1000).toFixed(1)}s.`
    : 'npm install failed.';
  return { ok, run: r, summary };
}
