import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { executeCapability } from '../src/core/runtime';
import { SYSTEM_ACTOR } from '../src/shared/domain';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';
import {
  generateProdCompose,
  generateStarterTheme,
  type ProdComposeOptions,
} from '../src/plugins/productionize-nextjs-compose/index';

// C16 — `forge productionize` scaffolds + carries the theme into the prod sidecar, and
// wires the callback env the C15 status page needs to probe the app in production.

const WEB = 'ghcr.io/mardash-ai/acme-web:1.2.3@sha256:' + 'a'.repeat(64);
const DP = 'ghcr.io/mardash-ai/forge-data-plane:0.11.0@sha256:' + 'b'.repeat(64);

function base(): ProdComposeOptions {
  return {
    appName: 'demo', port: 3000, host: 'demo.example.com', readinessPath: '/api/health',
    webImage: WEB, dataPlaneImage: DP, withPostgres: false, withRedis: false, secrets: [], certResolver: 'letsencrypt',
  };
}

function dataPlaneBlock(yaml: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === '  data-plane:');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i] ?? '') || /^\S/.test(lines[i] ?? '')) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

describe('C16 generateProdCompose — theme mount + status callback env', () => {
  it('mounts forge.theme.json + sets FORGE_THEME_FILE when withTheme', () => {
    const dp = dataPlaneBlock(generateProdCompose({ ...base(), withTheme: true }));
    expect(dp).toContain('FORGE_THEME_FILE=/app/forge.theme.json');
    expect(dp).toContain('./forge.theme.json:/app/forge.theme.json:ro');
  });

  it('leaves the theme seam optional when no theme is declared', () => {
    const dp = dataPlaneBlock(generateProdCompose({ ...base(), withTheme: false }));
    expect(dp).toContain('FORGE_THEME_FILE=${FORGE_THEME_FILE:-}');
    expect(dp).not.toContain('./forge.theme.json:');
  });

  it('always wires the app callback + readiness path so the status page can probe in prod', () => {
    const dp = dataPlaneBlock(generateProdCompose({ ...base(), readinessPath: '/healthz', port: 4000 }));
    expect(dp).toContain('FORGE_APP_CALLBACK_HOST=web');
    expect(dp).toContain('FORGE_APP_CALLBACK_PORT=4000');
    expect(dp).toContain('FORGE_READINESS_PATH=/healthz');
  });
});

describe('C16 generateStarterTheme', () => {
  it('produces valid JSON carrying the app name + an editable palette', () => {
    const parsed = JSON.parse(generateStarterTheme('demo'));
    expect(parsed.name).toBe('demo');
    expect(parsed.mode).toBe('auto');
    expect(parsed.colors.primary).toMatch(/^#/);
  });
});

// ---- capability-level scaffold behavior -------------------------------------

let dir: string;
let repo: string;
let prevState: string | undefined;
let prevDp: string | undefined;

async function seedApp(): Promise<void> {
  const now = nowIso();
  const app: Application = {
    id: 'app_demo', type: 'Application', app_id: 'app_demo', created_at: now, updated_at: now,
    name: 'demo', repo_path: repo, platform: 'web', framework: 'nextjs', template: 'nextjs-web',
    language: 'typescript', package_manager: 'npm',
  };
  await store.saveResource(app);
}
async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  prevDp = process.env.FORGE_DATA_PLANE_IMAGE;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-pt-'));
  repo = await mkdtemp(path.join(tmpdir(), 'forge-pt-repo-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_DATA_PLANE_IMAGE = DP;
  await store.init();
  await seedApp();
});
afterEach(async () => {
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('FORGE_STATE_DIR', prevState);
  restore('FORGE_DATA_PLANE_IMAGE', prevDp);
  await rm(dir, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe('C16 forge productionize scaffolds + carries the theme', () => {
  it('scaffolds forge.theme.json when absent and mounts it in the compose', async () => {
    expect(await exists(path.join(repo, 'forge.theme.json'))).toBe(false);
    await executeCapability('productionize', { app: 'demo', host: 'demo.example.com', web_image: WEB }, SYSTEM_ACTOR);
    expect(await exists(path.join(repo, 'forge.theme.json'))).toBe(true);
    const starter = JSON.parse(await readFile(path.join(repo, 'forge.theme.json'), 'utf8'));
    expect(starter.name).toBe('demo');
    const compose = await readFile(path.join(repo, 'compose.prod.yaml'), 'utf8');
    expect(compose).toContain('FORGE_THEME_FILE=/app/forge.theme.json');
    expect(compose).toContain('./forge.theme.json:/app/forge.theme.json:ro');
  });

  it('never clobbers an app-edited theme', async () => {
    const edited = JSON.stringify({ name: 'Edited', colors: { primary: '#abcdef' } }, null, 2);
    await writeFile(path.join(repo, 'forge.theme.json'), edited);
    await executeCapability('productionize', { app: 'demo', host: 'demo.example.com', web_image: WEB }, SYSTEM_ACTOR);
    expect(await readFile(path.join(repo, 'forge.theme.json'), 'utf8')).toBe(edited);
  });
});
