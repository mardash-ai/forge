import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { resolveAppLenient } from '../src/capabilities/_shared';
import { ForgeError } from '../src/shared/errors';
import type { Application } from '../src/resources/types';
import { nowIso } from '../src/shared/time';

// P19 — `forge release` (and the `productionize`/`verify` phases it composes) must resolve the
// target app the SAME lenient way `forge deploy` does: a store-registered Application is OPTIONAL
// on a production host, inferred from the single-app layout + the committed `app/forge.app.json`.
// Before the fix, release/productionize/verify used the STRICT `resolveApp`, which threw
//   not_found: No Application named "forge-os". Run: forge init app --name forge-os
// on a deploy host that only ever ran `forge deploy` / `forge productionize` (never `forge init
// app`), so its control-plane store had no `forge-os` record — even though the SAME app deployed
// fine via `forge deploy`. These lock the store-optional resolution `resolveAppLenient` gives.

let dir: string; // stands in for FORGE_WORKSPACE — the app repo root (single-app layout ⇒ ./app)
let prevWorkspace: string | undefined;
let prevState: string | undefined;
let prevLayout: string | undefined;

const WEB_PIN = 'ghcr.io/mardash-ai/forge-os-app@sha256:' + 'a'.repeat(64);

beforeEach(async () => {
  prevWorkspace = process.env.FORGE_WORKSPACE;
  prevState = process.env.FORGE_STATE_DIR;
  prevLayout = process.env.FORGE_APP_LAYOUT;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-p19-'));
  process.env.FORGE_WORKSPACE = dir;
  process.env.FORGE_STATE_DIR = path.join(dir, '.forge');
  process.env.FORGE_APP_LAYOUT = 'single'; // ⇒ appDir(name) === <workspace>/app, name is metadata
  await store.init();
});

afterEach(async () => {
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('FORGE_WORKSPACE', prevWorkspace);
  restore('FORGE_STATE_DIR', prevState);
  restore('FORGE_APP_LAYOUT', prevLayout);
  await rm(dir, { recursive: true, force: true });
});

// Write the committed app manifest exactly as it exists on the deploy box: name + persisted
// production block (host + current web-image pin), the file `forge deploy` already resolves from.
async function writeManifest(name: string): Promise<string> {
  const appRepo = path.join(dir, 'app');
  await mkdir(appRepo, { recursive: true });
  await writeFile(
    path.join(appRepo, 'forge.app.json'),
    JSON.stringify({ name, production: { host: `${name}.mardash.ai`, web_image: WEB_PIN } }, null, 2) + '\n',
  );
  return appRepo;
}

describe('P19 · resolveAppLenient — deploy-time app resolution (store record OPTIONAL)', () => {
  it('THE CRUX: resolves from app/forge.app.json with NO store-registered Application (was not_found)', async () => {
    const appRepo = await writeManifest('forge-os'); // committed manifest present…
    // …and the store is empty (no `forge init app` on this box).
    expect(await store.findAppByName('forge-os')).toBeNull();

    const target = await resolveAppLenient(store, 'forge-os');

    // Resolved purely from the manifest + single-app layout — no store id, repo is <workspace>/app.
    expect(target.id).toBeUndefined();
    expect(target.name).toBe('forge-os');
    expect(target.repo_path).toBe(appRepo);
  });

  it('a store-registered Application still WINS (its id links resources/events; its repo_path is used)', async () => {
    await writeManifest('forge-os');
    const now = nowIso();
    const app: Application = {
      id: 'app_forgeos', type: 'Application', app_id: 'app_forgeos', created_at: now, updated_at: now,
      name: 'forge-os', repo_path: '/srv/forge-os', platform: 'web', framework: 'nextjs',
      template: 'nextjs-web', language: 'typescript', package_manager: 'npm',
    };
    await store.saveResource(app);

    const target = await resolveAppLenient(store, 'forge-os');
    expect(target.id).toBe('app_forgeos'); // store record present ⇒ id carried through
    expect(target.repo_path).toBe('/srv/forge-os'); // and its persisted repo_path wins over the layout default
  });

  it('still FAILS CLEARLY when NEITHER a store record NOR a usable app/forge.app.json resolves it', async () => {
    // No manifest written, empty store.
    await expect(resolveAppLenient(store, 'ghost')).rejects.toBeInstanceOf(ForgeError);
    await expect(resolveAppLenient(store, 'ghost')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    // The message still points the operator at the fix.
    await resolveAppLenient(store, 'ghost').catch((e: ForgeError) => {
      expect(e.message).toContain('forge init app --name ghost');
    });
  });

  it('prefers the manifest name over the passed arg (single-app layout self-corrects a mismatched --app)', async () => {
    await writeManifest('forge-os'); // the real app is forge-os…
    // …an operator passes a stale name; single-app layout has exactly one app, so the manifest wins.
    const target = await resolveAppLenient(store, 'forge-os-old');
    expect(target.name).toBe('forge-os');
    expect(target.repo_path).toBe(path.join(dir, 'app'));
  });
});
