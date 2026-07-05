import { describe, it, expect } from 'vitest';
import { analyzeLines } from '../src/core/log-analyzer';

describe('log-analyzer', () => {
  it('detects a missing next dependency', () => {
    const d = analyzeLines([
      '$ docker compose run --rm web npm run build',
      "Error: Cannot find module 'next'",
      'at Function._load (node:internal)',
    ]);
    expect(d.likely_cause).toMatch(/not installed/i);
    expect(d.suggested_actions.join(' ')).toMatch(/forge install/);
  });

  it('detects a TypeScript error and extracts a file ref', () => {
    const d = analyzeLines([
      './app/projects/page.tsx:12:5',
      "Type error: Module '\"./list\"' has no exported member 'ProjectList'.",
    ]);
    expect(d.likely_cause).toMatch(/type error/i);
    expect(d.file_refs).toContain('app/projects/page.tsx:12');
  });

  it('falls back to a tail when nothing matches', () => {
    const d = analyzeLines(['some', 'unremarkable', 'output', 'lines']);
    expect(d.likely_cause).toMatch(/no known error signature/i);
    expect(d.evidence.length).toBeGreaterThan(0);
  });
});
