import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { forgeNextConfig } from '../src/shared/next-config';
import { scaffold } from '../src/plugins/scaffold-nextjs-npm/index';
import { defaultNextConfig, applyStandaloneOutput } from '../src/plugins/productionize-nextjs-compose/index';

// P11 — the generated next.config's /auth/* rewrite must survive `next build`. Next
// evaluates rewrites() at BUILD time; a config that gates the rule on a runtime-only
// env (FORGE_DATA_PLANE_URL, set by compose but absent in CI's build) returns [] and
// compiles the rule OUT of the image → /auth/login 404s in prod. So we load the exact
// generated .mjs the way `next build` would and evaluate rewrites() with NO runtime
// data-plane env, asserting the rule is present with the in-cluster default destination.

// Write the generated config to a temp .mjs and import it like `next build` does, so
// rewrites() runs against the REAL module (not a string match).
type Rewrite = { source: string; destination: string };

async function loadConfig(source: string): Promise<{ config: { rewrites: () => Promise<Rewrite[]> }; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'forge-nextcfg-'));
  const file = path.join(dir, 'next.config.mjs');
  await writeFile(file, source);
  const mod = await import(pathToFileURL(file).href);
  return { config: mod.default, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// Destination of the /auth/:path* rewrite, or throw if it isn't present (a [] means
// the rule was compiled out — exactly the P11 failure).
function authDest(rules: Rewrite[]): string {
  const auth = rules.find((r) => r.source === '/auth/:path*');
  if (!auth) throw new Error(`no /auth/:path* rewrite present — got ${JSON.stringify(rules)}`);
  return auth.destination;
}

describe('forgeNextConfig — /auth/* rewrite survives a build-time evaluation (P11)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  for (const standalone of [false, true]) {
    it(`always emits the /auth rewrite (standalone=${standalone}) with the in-cluster default, even with no runtime data-plane env`, async () => {
      // Exactly what CI's `next build` sees: neither runtime override is set.
      delete process.env.FORGE_DATA_PLANE_URL;
      delete process.env.FORGE_EVENTS_URL;
      const { config, cleanup } = await loadConfig(forgeNextConfig({ standalone }));
      try {
        const rules = await config.rewrites();
        expect(Array.isArray(rules)).toBe(true);
        // NOT [] — the rule is baked in, pointed at the in-cluster data-plane sidecar.
        expect(authDest(rules)).toBe('http://data-plane:3718/auth/:path*');
      } finally {
        await cleanup();
      }
    });
  }

  it('a runtime FORGE_DATA_PLANE_URL overrides the destination (e.g. next dev against a local data-plane)', async () => {
    process.env.FORGE_DATA_PLANE_URL = 'http://localhost:3718';
    delete process.env.FORGE_EVENTS_URL;
    const { config, cleanup } = await loadConfig(forgeNextConfig());
    try {
      expect(authDest(await config.rewrites())).toBe('http://localhost:3718/auth/:path*');
    } finally {
      await cleanup();
    }
  });

  it('FORGE_EVENTS_URL also overrides (the load-bearing data-plane base name)', async () => {
    delete process.env.FORGE_DATA_PLANE_URL;
    process.env.FORGE_EVENTS_URL = 'http://data-plane.internal:3718';
    const { config, cleanup } = await loadConfig(forgeNextConfig());
    try {
      expect(authDest(await config.rewrites())).toBe('http://data-plane.internal:3718/auth/:path*');
    } finally {
      await cleanup();
    }
  });

  it('emits output: standalone only when Productionize asks for it', () => {
    expect(forgeNextConfig({ standalone: true })).toContain("output: 'standalone',");
    expect(forgeNextConfig()).not.toContain("output: 'standalone'");
  });
});

// The two generators that ship a next.config both carry the always-on rewrite from one
// source of truth, so neither a newly-scaffolded app nor a from-scratch productionized
// app re-discovers the build-out bug.
describe('generators carry the always-on /auth rewrite (P11)', () => {
  it('the InitializeApp scaffold config carries the rewrite (dev shape — no standalone)', () => {
    const cfg = scaffold({ name: 'acme', port: 3000 }).files['next.config.mjs'] ?? '';
    expect(cfg).toContain("source: '/auth/:path*'");
    expect(cfg).toContain("'http://data-plane:3718'");
    expect(cfg).not.toContain("output: 'standalone'"); // Productionize injects standalone later
  });

  it('Productionize\'s fallback default config carries the rewrite AND standalone output', () => {
    const cfg = defaultNextConfig();
    expect(cfg).toContain("source: '/auth/:path*'");
    expect(cfg).toContain("'http://data-plane:3718'");
    expect(cfg).toContain("output: 'standalone',");
  });

  // The normal flow: scaffold writes the config → Productionize runs applyStandaloneOutput
  // on it. That must inject `output: 'standalone'` WITHOUT disturbing the rewrite, and be
  // idempotent on a re-run.
  it('Productionize injects standalone into the scaffold config while preserving the rewrite', async () => {
    const scaffolded = scaffold({ name: 'acme', port: 3000 }).files['next.config.mjs'] ?? '';
    const patched = applyStandaloneOutput(scaffolded);
    expect(patched.changed).toBe(true);
    expect(patched.action).toBe('injected');
    expect(patched.content).toContain("output: 'standalone',");
    expect(patched.content).toContain("source: '/auth/:path*'");
    // Idempotent — a flag-less re-productionize changes nothing.
    const again = applyStandaloneOutput(patched.content);
    expect(again.changed).toBe(false);
    expect(again.content).toBe(patched.content);
    // And the injected config still evaluates the rewrite at build time.
    delete process.env.FORGE_DATA_PLANE_URL;
    delete process.env.FORGE_EVENTS_URL;
    const { config, cleanup } = await loadConfig(patched.content);
    try {
      expect(authDest(await config.rewrites())).toBe('http://data-plane:3718/auth/:path*');
    } finally {
      await cleanup();
    }
  });
});
