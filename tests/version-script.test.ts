import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── version lifecycle script — mechanism tests ────────────────────────────────
//
// npm version <level> runs scripts.version automatically immediately after editing
// package.json (before committing). Without a `version` script the model stamp
// drifts from the package version on every release; with it, the model is
// regenerated and staged in the same commit.
//
// These tests:
//   1. Assert the version script is present and contains the required commands.
//   2. Exercise the full mechanism end-to-end: bump a temporary package.json,
//      run generate:platform-model, assert the model stamp follows.

describe('version npm lifecycle script', () => {
  it('package.json has a version script', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.version, 'scripts.version must be defined in package.json').toBeDefined();
  });

  it('version script invokes generate:platform-model', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.version).toMatch(/generate:platform-model/);
  });

  it('version script stages platform-model.json for commit with git add', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.version).toMatch(/git add platform-model\.json/);
  });
});

// ── End-to-end mechanism: bump → generate → model stamp follows ───────────────
//
// This describe block temporarily modifies package.json and platform-model.json,
// then restores them. All tests within run serially (vitest guarantees this within
// a file), so the modification window is bounded and deterministic.

describe('version script mechanism — bump propagates to model stamp', () => {
  const pkgPath = join(ROOT, 'package.json');
  const modelPath = join(ROOT, 'platform-model.json');

  let savedPkg: string;
  let savedModel: string;
  const BUMPED_VERSION = '99.0.0-version-script-test';

  beforeAll(() => {
    savedPkg = readFileSync(pkgPath, 'utf8');
    savedModel = existsSync(modelPath) ? readFileSync(modelPath, 'utf8') : '';
  });

  afterAll(() => {
    // Always restore regardless of test outcome.
    writeFileSync(pkgPath, savedPkg);
    if (savedModel) writeFileSync(modelPath, savedModel);
  });

  it('running generate:platform-model after a version bump updates the model stamp', () => {
    // Step 1: write a bumped package.json (simulates what npm version does to the file).
    const pkg = JSON.parse(savedPkg) as { version: string };
    pkg.version = BUMPED_VERSION;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

    // Step 2: run the same generate command the version script invokes.
    // (We skip the `git add` part — git staging is not meaningful inside a test run.)
    execSync('npm run generate:platform-model', { cwd: ROOT, stdio: 'pipe' });

    // Step 3: the model stamp must now equal the bumped version.
    const model = JSON.parse(readFileSync(modelPath, 'utf8')) as { version: string };
    expect(model.version).toBe(BUMPED_VERSION);
  });
});
