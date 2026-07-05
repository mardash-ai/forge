import { composeRun } from '../runtime-docker-compose/index';
import type { RunResult } from '../../shared/exec';

// Plugin: build-npm — Implementation of Build for npm/Next.js (`next build`).
export const IMPLEMENTATION = 'build-npm';

export interface BuildOutput {
  ok: boolean;
  run: RunResult;
  artifact_refs: string[];
  error_summary?: string;
  top_errors: Array<{ file?: string; line?: number; message: string }>;
}

export async function build(appDir: string, logFile: string): Promise<BuildOutput> {
  const r = await composeRun(appDir, 'web', ['npm', 'run', 'build'], { logFile });
  const ok = r.code === 0;

  const artifact_refs = ok ? ['.next'] : [];
  const top_errors = ok ? [] : extractErrors(r.combined);
  const error_summary = ok
    ? undefined
    : top_errors[0]?.message ?? 'Build failed. Run: forge explain --resource <build-id>';

  return { ok, run: r, artifact_refs, error_summary, top_errors };
}

function extractErrors(output: string): Array<{ file?: string; line?: number; message: string }> {
  const lines = output.split('\n').map((l) => l.trim());
  const errors: Array<{ file?: string; line?: number; message: string }> = [];
  const meaningful =
    /(^Error:|Failed to compile|Type error:|has no exported member|Cannot find module|Module not found|is not assignable|should not be imported|Error occurred prerendering)/;
  for (const line of lines) {
    if (/^at\s/.test(line) || line.includes('node_modules')) continue; // skip stack frames
    // Prefer references to the app's own source, not compiled deps.
    const m = line.match(/\.?\/?((?:app|lib|src|pages|components)[\w./-]*\.(?:tsx?|jsx?)):(\d+):\d+/);
    if (m || meaningful.test(line)) {
      errors.push({ file: m?.[1], line: m ? Number(m[2]) : undefined, message: line.slice(0, 200) });
    }
    if (errors.length >= 5) break;
  }
  if (errors.length === 0) {
    const fail = lines.find((l) => /Failed to compile/i.test(l));
    if (fail) errors.push({ message: fail.slice(0, 200) });
  }
  return errors.slice(0, 5);
}
