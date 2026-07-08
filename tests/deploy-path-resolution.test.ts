import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveWorkspacePath } from '../src/capabilities/deploy/index';

// P16 — `forge deploy` must resolve a relative `--env-file` / `--compose-file` (and the
// `app/.env.prod` / `app/compose.prod.yaml` defaults) against the app's FORGE_WORKSPACE —
// the dir `docker compose` runs from — NOT the control-plane container's process CWD
// (`/forge`), which holds no app files. The regression surfaced two ways; both are locked
// here so `make deploy` can't silently break again.

// Layer 1 — the path math inside the Deploy capability. A relative arg resolves UNDER the
// workspace; an absolute arg passes through unchanged; neither is ever tied to process.cwd().
describe('P16 · resolveWorkspacePath — relative under FORGE_WORKSPACE, absolute passes through', () => {
  const WORKSPACE = '/srv/acme-app'; // stand-in for FORGE_WORKSPACE (the app repo root)

  it('resolves the relative --env-file default under FORGE_WORKSPACE, not CWD', () => {
    expect(resolveWorkspacePath(WORKSPACE, 'app/.env.prod')).toBe('/srv/acme-app/app/.env.prod');
  });

  it('resolves the relative --compose-file default under FORGE_WORKSPACE, not CWD', () => {
    expect(resolveWorkspacePath(WORKSPACE, 'app/compose.prod.yaml')).toBe('/srv/acme-app/app/compose.prod.yaml');
  });

  it('passes an ABSOLUTE --env-file through unchanged (path.join would mis-join it under the workspace)', () => {
    // The bug path.join(ws, abs) would have produced /srv/acme-app/etc/secrets/.env.prod.
    expect(path.join(WORKSPACE, '/etc/secrets/.env.prod')).toBe('/srv/acme-app/etc/secrets/.env.prod');
    expect(resolveWorkspacePath(WORKSPACE, '/etc/secrets/.env.prod')).toBe('/etc/secrets/.env.prod');
  });

  it('is anchored to the given workspace, never the process CWD', () => {
    const viaCwd = path.resolve(process.cwd(), 'app/.env.prod');
    const viaWorkspace = resolveWorkspacePath(WORKSPACE, 'app/.env.prod');
    expect(viaWorkspace).not.toBe(viaCwd);
    expect(viaWorkspace.startsWith(WORKSPACE + path.sep)).toBe(true);
  });
});

// Layer 2 — the real root cause: how the CLI is launched. `tsx` hoists ANY node CLI flag it
// finds in argv (even after the script) into node. `forge deploy … --env-file app/.env.prod`
// therefore handed `--env-file` to NODE, which resolved it against the process CWD and aborted
// at startup (`node: app/.env.prod: not found`, exit 9) BEFORE the CLI ran. The `forge` wrapper
// now separates args with `--`; these spawn the two forms and assert the fix vs. the trap.
describe('P16 · CLI launch — a relative --env-file reaches forge, it is NOT swallowed by node', () => {
  const tsxBin = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
  const cli = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
  // Spawn from a scratch dir with NO app/.env.prod — mirrors the container CWD (/forge), so a
  // node-hoisted relative --env-file resolves to a missing file exactly as it did in prod.
  const emptyCwd = mkdtempSync(path.join(tmpdir(), 'forge-p16-'));
  const args = ['deploy', '--app', 'demo', '--env-file', 'app/.env.prod', '--compose-file', 'app/compose.prod.yaml', '--help'];

  it('FIXED (tsx -- cli …): the CLI starts and parses the flags (no node startup abort)', () => {
    const r = spawnSync(tsxBin, ['--', cli, ...args], { cwd: emptyCwd, encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out).not.toMatch(/node:.*not found/); // node did NOT hoist/abort on --env-file
    expect(r.status).toBe(0);
    expect(out).toContain('Usage: forge deploy'); // reached forge's own commander parser
  }, 30_000);

  it('TRAP (tsx cli … without --): node hoists --env-file and aborts before the CLI — this is what the `--` guards', () => {
    const r = spawnSync(tsxBin, [cli, ...args], { cwd: emptyCwd, encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out).toMatch(/not found/); // node: app/.env.prod: not found
    expect(out).not.toContain('Usage: forge deploy'); // the CLI never ran
    expect(r.status).not.toBe(0);
  }, 30_000);
});
