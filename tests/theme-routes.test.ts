import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { setSecret } from '../src/plugins/secrets-local/index';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';
import { registerThemeRoutes } from '../src/api/theme-routes';
import { registerAuthRoutes } from '../src/api/auth-routes';

// C16 — the /theme.css artifact + proof a declared theme restyles the C10 auth pages.
// Driven through Fastify.inject against a throwaway store + a temp app repo holding a
// sample forge.theme.json.

const APP = 'demo';
const SAMPLE_THEME = {
  name: 'Acme Corp',
  logo: '/brand/logo.svg',
  favicon: '/brand/favicon.ico',
  mode: 'auto',
  colors: { primary: '#ff2d55', accent: '#00c2a8', background: '#fffaf5' },
  custom_css: '.card{border-radius:0} </style><script>alert(1)</script>',
};

let dir: string;
let repo: string;
let server: FastifyInstance;
let prevState: string | undefined;
let prevKey: string | undefined;

async function seedApp(withTheme = true): Promise<void> {
  const now = nowIso();
  const app: Application = {
    id: `app_${APP}`, type: 'Application', app_id: `app_${APP}`, created_at: now, updated_at: now,
    name: APP, repo_path: repo, platform: 'web', framework: 'nextjs', template: 'nextjs-web',
    language: 'typescript', package_manager: 'npm',
  };
  await store.saveResource(app);
  if (withTheme) await writeFile(path.join(repo, 'forge.theme.json'), JSON.stringify(SAMPLE_THEME, null, 2));
}

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  prevKey = process.env.FORGE_SECRETS_KEY;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-theme-'));
  repo = await mkdtemp(path.join(tmpdir(), 'forge-theme-repo-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_SECRETS_KEY = 'test-master-key-not-for-production';
  await store.init();
  server = Fastify({ logger: false });
  registerThemeRoutes(server, { defaultApp: () => APP });
  registerAuthRoutes(server, { defaultApp: () => APP });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('FORGE_STATE_DIR', prevState);
  restore('FORGE_SECRETS_KEY', prevKey);
  await rm(dir, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

describe('C16 GET /theme.css', () => {
  it('serves the app token set + sandboxed custom CSS as text/css', async () => {
    await seedApp();
    const res = await server.inject({ method: 'GET', url: '/theme.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.body).toContain('--forge-color-primary:#ff2d55');
    expect(res.body).toContain('--forge-color-bg:#fffaf5');
    expect(res.body).toContain('@media(prefers-color-scheme:dark)');
    // custom CSS is present but the </style><script> breakout was stripped
    expect(res.body).toContain('.card{border-radius:0}');
    expect(res.body).not.toContain('<script>');
    expect(res.body).not.toContain('</style>');
  });

  it('falls back to the neutral default token set for an un-themed app', async () => {
    await seedApp(false);
    const res = await server.inject({ method: 'GET', url: '/theme.css' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('--forge-color-primary:#4f46e5'); // neutral default
  });
});

describe('C16 auth pages render from the theme tokens', () => {
  it('a sample theme visibly restyles /auth/login (tokens, brand, favicon, custom CSS)', async () => {
    await setSecret(`app_${APP}`, 'AUTH_SESSION_SECRET', 'the-signing-secret');
    await seedApp();
    const res = await server.inject({ method: 'GET', url: '/auth/login' });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    // the SAME token set as /theme.css is inlined into the auth page
    expect(html).toContain('--forge-color-primary:#ff2d55');
    expect(html).toContain('background:var(--forge-color-bg)');
    expect(html).toContain('background:var(--forge-color-primary)'); // themed button
    // brand: app name in the title, logo img, favicon link
    expect(html).toContain('<title>Sign in · Acme Corp</title>');
    expect(html).toContain('src="/brand/logo.svg"');
    expect(html).toContain('<link rel="icon" href="/brand/favicon.ico">');
    // custom-CSS escape hatch injected (sandboxed)
    expect(html).toContain('<style id="forge-custom">');
    expect(html).toContain('.card{border-radius:0}');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('an un-themed app gets the neutral default look (no logo, plain title)', async () => {
    await setSecret(`app_${APP}`, 'AUTH_SESSION_SECRET', 'the-signing-secret');
    await seedApp(false);
    const res = await server.inject({ method: 'GET', url: '/auth/login' });
    const html = res.body;
    expect(html).toContain('--forge-color-primary:#4f46e5');
    expect(html).toContain('<title>Sign in</title>'); // no app name
    expect(html).not.toContain('<img class="brand-logo"'); // no logo image rendered
    expect(html).not.toContain('forge-custom');
  });
});
