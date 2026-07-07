import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isProductionNextDir, resetStaleProductionNext } from '../src/plugins/build-npm/next-artifacts';

// P4 regression — `forge build` (production `.next`) then `forge dev` (dev-mode `.next`) over the
// same bind-mounted `.next` leaves the dev server serving stale production chunks (every route
// 500s). RunDevServer resets a leftover production `.next` before starting; these tests cover the
// detect-and-reset helper: a production `.next` is detected and wiped; a dev `.next` is preserved.
let dir: string;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// A production `.next` — as written by `next build` (has BUILD_ID + production-only manifests).
async function makeProductionNext(appDir: string): Promise<void> {
  const n = path.join(appDir, '.next');
  await mkdir(path.join(n, 'server'), { recursive: true });
  await writeFile(path.join(n, 'BUILD_ID'), 'abc123\n');
  await writeFile(path.join(n, 'required-server-files.json'), '{"version":1}');
  await writeFile(path.join(n, 'prerender-manifest.json'), '{"version":4}');
}

// A dev-mode `.next` — as written by `next dev` (no BUILD_ID, no production manifests).
async function makeDevNext(appDir: string): Promise<void> {
  const n = path.join(appDir, '.next');
  await mkdir(path.join(n, 'cache'), { recursive: true });
  await writeFile(path.join(n, 'package.json'), '{"type":"commonjs"}');
  await writeFile(path.join(n, 'build-manifest.json'), '{}');
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'forge-next-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('next-artifacts: production `.next` detection + reset (P4)', () => {
  it('detects a production `.next`', async () => {
    await makeProductionNext(dir);
    expect(await isProductionNextDir(dir)).toBe(true);
  });

  it('does not flag a dev-mode `.next`', async () => {
    await makeDevNext(dir);
    expect(await isProductionNextDir(dir)).toBe(false);
  });

  it('resets a production `.next` (so dev starts clean) and reports it', async () => {
    await makeProductionNext(dir);
    const { reset } = await resetStaleProductionNext(dir);
    expect(reset).toBe(true);
    expect(await exists(path.join(dir, '.next'))).toBe(false); // wiped
  });

  it('preserves a dev-mode `.next` (keeps the dev cache warm)', async () => {
    await makeDevNext(dir);
    const { reset } = await resetStaleProductionNext(dir);
    expect(reset).toBe(false);
    expect(await exists(path.join(dir, '.next'))).toBe(true); // untouched
  });

  it('is a no-op when there is no `.next` at all', async () => {
    const { reset } = await resetStaleProductionNext(dir);
    expect(reset).toBe(false);
  });
});
