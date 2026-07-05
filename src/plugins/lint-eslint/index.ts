import { composeRun } from '../runtime-docker-compose/index';
import type { RunResult } from '../../shared/exec';

// Plugin: lint-eslint — Implementation of Lint for npm/ESLint (`next lint`).
export const IMPLEMENTATION = 'lint-eslint';

export interface LintOutput {
  ok: boolean;
  run: RunResult;
  problems: number;
  errors: number;
  warnings: number;
  summary: string;
  top_problems: string[];
}

export async function lint(appDir: string, logFile: string): Promise<LintOutput> {
  const r = await composeRun(appDir, 'web', ['npm', 'run', 'lint'], { logFile });
  const ok = r.code === 0;

  // ESLint summary: "✖ 3 problems (2 errors, 1 warning)"
  const m = r.combined.match(/(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/);
  const errors = m ? Number(m[2]) : ok ? 0 : 1;
  const warnings = m ? Number(m[3]) : 0;
  const problems = m ? Number(m[1]) : errors + warnings;

  const top_problems = ok
    ? []
    : r.combined
        .split('\n')
        .filter((l) => /\s+(error|warning)\s+/.test(l) || /^\.?\/?[\w./-]+\.(tsx?|jsx?)/.test(l.trim()))
        .map((l) => l.trim())
        .slice(0, 8);

  const summary = ok
    ? 'No ESLint errors.'
    : `Lint found ${problems} problem(s) (${errors} error(s), ${warnings} warning(s)).`;

  return { ok, run: r, problems, errors, warnings, summary, top_problems };
}
