import { composeRun } from '../runtime-docker-compose/index';
import type { RunResult } from '../../shared/exec';

// Plugin: test-npm — Implementation of Test for npm/Vitest (`npm test`).
export const IMPLEMENTATION = 'test-npm';

export interface TestOutput {
  ok: boolean;
  run: RunResult;
  passed: number;
  failed: number;
  skipped: number;
  top_failures: string[];
  failure_summary?: string;
}

export async function test(appDir: string, logFile: string): Promise<TestOutput> {
  const r = await composeRun(appDir, 'web', ['npm', 'test'], { logFile });
  const { passed, failed, skipped } = parseCounts(r.combined);
  const ok = r.code === 0 && failed === 0;
  const top_failures = ok ? [] : parseFailures(r.combined);
  const failure_summary = ok
    ? undefined
    : failed > 0
      ? `${failed} test(s) failed.`
      : 'Test run failed (non-zero exit).';
  return { ok, run: r, passed, failed, skipped, top_failures, failure_summary };
}

function parseCounts(output: string): { passed: number; failed: number; skipped: number } {
  // Vitest: "      Tests  1 passed (1)" / "Tests  2 failed | 1 passed (3)"
  const testsLine = output.split('\n').reverse().find((l) => /^\s*Tests\s+/.test(l)) ?? '';
  const passed = Number(testsLine.match(/(\d+)\s+passed/)?.[1] ?? 0);
  const failed = Number(testsLine.match(/(\d+)\s+failed/)?.[1] ?? 0);
  const skipped = Number(testsLine.match(/(\d+)\s+skipped/)?.[1] ?? 0);
  return { passed, failed, skipped };
}

function parseFailures(output: string): string[] {
  return output
    .split('\n')
    .filter((l) => /(FAIL|×|✗)\s/.test(l) || /AssertionError|Expected|Received/.test(l))
    .map((l) => l.trim())
    .slice(0, 6);
}
