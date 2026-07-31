import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * `forge infra` (I1) — offline unit + guard tests.
 *
 * What is provable without a cloud: the declaration schema (the §3.0/§3.5 rules encoded in it), the
 * §3.7 content-hash (stable, change-sensitive, generated-file-blind), the repo-root selector walk,
 * the §3.5 contract-version gate, and — via a real subprocess — the §3.6 GUARD that `apply` refuses
 * to run outside CI without both escape-hatch flags. The guard test is the load-bearing one: it is
 * what makes "apply is CI-only" a property of the tool rather than a sentence in a plan.
 */
import { infraConfigSchema, findRepoRoot } from '../src/infra/config';
import { declaredConfigHash } from '../src/infra/hash';
import { publishContract } from '../src/infra/contract';
import { DEPLOYER_ROLES } from '../src/infra/bootstrap';

const FOUNDATION = {
  stack: 'dorinda-shared-infra',
  kind: 'foundation',
  state_bucket: 'dorinda-tf-state',
  org_id: '326717963308',
  billing_account: '01DC01-E21BD0-B8F812',
  folder: 'Dorinda',
  publishes_contract: true,
  github: { owner: 'mardash-ai', repos: ['dorinda-api'] },
  envs: { 'prod-a': { project_id: 'dorinda-prod', region: 'us-east1' } },
  verify: [{ kind: 'dns_resolves', host: 'api.dorinda.ai' }],
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'forge-infra-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('forge.infra.json schema — the rules are in the schema, not in memory', () => {
  it('accepts a full foundation declaration', () => {
    expect(() => infraConfigSchema.parse(FOUNDATION)).not.toThrow();
  });

  it('rejects a foundation without org_id/billing_account', () => {
    const bad = { ...FOUNDATION, org_id: undefined };
    expect(() => infraConfigSchema.parse(bad)).toThrow(/org_id/);
  });

  it('rejects a NON-foundation stack without required_platform_contract (§3.5)', () => {
    const bad = { ...FOUNDATION, kind: 'service', org_id: undefined, billing_account: undefined, folder: undefined };
    expect(() => infraConfigSchema.parse(bad)).toThrow(/required_platform_contract/);
  });

  it('accepts a service stack that declares its contract requirement', () => {
    const svc = {
      stack: 'dorinda-api',
      kind: 'service',
      state_bucket: 'dorinda-tf-state',
      required_platform_contract: 1,
      envs: { 'prod-a': { project_id: 'dorinda-prod', region: 'us-east1' } },
    };
    expect(() => infraConfigSchema.parse(svc)).not.toThrow();
  });
});

describe('repo-root selector (§3.0 — the cwd IS the selector)', () => {
  it('walks UP from a nested dir to the declaring repo root, and null when absent', async () => {
    const repo = join(dir, 'repo');
    await mkdir(join(repo, 'infra', 'deep'), { recursive: true });
    await writeFile(join(repo, 'forge.infra.json'), JSON.stringify(FOUNDATION));
    expect(findRepoRoot(join(repo, 'infra', 'deep'))).toBe(repo);
    expect(findRepoRoot(tmpdir())).toBeNull();
  });
});

describe('§3.7 declared-config hash', () => {
  it('is stable, changes when a declaration changes, and IGNORES generated files', async () => {
    const repo = join(dir, 'hash-repo');
    await mkdir(join(repo, 'infra'), { recursive: true });
    await writeFile(join(repo, 'forge.infra.json'), JSON.stringify(FOUNDATION));
    await writeFile(join(repo, 'infra', 'main.tf'), 'resource "null_resource" "a" {}');

    const h1 = await declaredConfigHash(repo, join(repo, 'infra'));
    const h2 = await declaredConfigHash(repo, join(repo, 'infra'));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);

    // the materialized contract is per-run output, not declaration — it must NOT move the hash
    await writeFile(join(repo, 'infra', 'contract.auto.tfvars.json'), '{"platform":{}}');
    expect(await declaredConfigHash(repo, join(repo, 'infra'))).toBe(h1);

    await writeFile(join(repo, 'infra', 'main.tf'), 'resource "null_resource" "b" {}');
    expect(await declaredConfigHash(repo, join(repo, 'infra'))).not.toBe(h1);
  });
});

describe('§3.5 contract publication', () => {
  it('REFUSES to publish when the stack outputs no platform_contract_version', async () => {
    const stack = {
      root: dir,
      tfDir: join(dir, 'infra'),
      config: infraConfigSchema.parse(FOUNDATION),
    };
    // no version in outputs → must throw BEFORE any write is attempted
    await expect(publishContract(stack, 'prod-a', { vpc_network: 'x' }, 'sha256:0')).rejects.toThrow(
      /platform_contract_version/,
    );
  });
});

  async function runInfra(args: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawn('npx', ['tsx', join(__dirname, '..', 'src', 'infra', 'cli.ts'), ...args], {
      cwd,
      env: { ...process.env, GITHUB_ACTIONS: '', CI: '', FORGE_INFRA_INVOKE_DIR: cwd, ...env },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

describe('bootstrap scoping — --component / --repo (0.82.0)', () => {
  it('exposes exactly the components the CLI advertises', async () => {
    const { BOOTSTRAP_COMPONENTS } = await import('../src/infra/bootstrap');
    expect([...BOOTSTRAP_COMPONENTS]).toEqual(['project', 'state', 'identity', 'all']);
  });

  it('refuses to register a repo that is not DECLARED — scoping narrows work, never trust', async () => {
    // The load-bearing guard. `--repo` must be a convenience over the declaration, never a way to
    // grant deploy access to a repository nobody put in forge.infra.json.
    const repo = join(dir, 'scope-repo');
    await mkdir(join(repo, 'infra'), { recursive: true });
    await writeFile(join(repo, 'forge.infra.json'), JSON.stringify(FOUNDATION));

    const r = await runInfra(
      ['bootstrap', '--env', 'prod-a', '--component', 'identity', '--repo', 'some-other-org-repo'],
      repo,
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/not in github\.repos|never widens the trust boundary/);
  }, 60_000);

  it('rejects an unknown --component instead of silently doing everything', async () => {
    const repo = join(dir, 'scope-repo');
    const r = await runInfra(['bootstrap', '--env', 'prod-a', '--component', 'everything'], repo);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/unknown --component/);
  }, 60_000);
});

describe('bootstrap role curation', () => {
  it('deployer roles are a curated list and never roles/editor or owner', () => {
    expect(DEPLOYER_ROLES.length).toBeGreaterThan(5);
    for (const r of DEPLOYER_ROLES) {
      expect(r).not.toMatch(/roles\/(editor|owner)$/);
    }
  });
});

describe('§3.6 guard — apply is CI-only (subprocess, the real thing)', () => {

  it('refuses `apply` locally without BOTH --local and --allow-local-apply, and never half of it', async () => {
    const repo = join(dir, 'guard-repo');
    await mkdir(join(repo, 'infra'), { recursive: true });
    await writeFile(join(repo, 'forge.infra.json'), JSON.stringify(FOUNDATION));

    const bare = await runInfra(['apply', '--env', 'prod-a'], repo);
    expect(bare.code).not.toBe(0);
    expect(bare.out).toMatch(/CI-only/);

    const half = await runInfra(['apply', '--env', 'prod-a', '--local'], repo);
    expect(half.code).not.toBe(0);
    expect(half.out).toMatch(/CI-only/);
  }, 60_000);

  it('refuses `release-image` BEFORE rolling when the stack declares no behaviour check', async () => {
    const repo = join(dir, 'gate-repo');
    await mkdir(join(repo, 'infra'), { recursive: true });
    // FOUNDATION declares only dns_resolves — existence, not behaviour
    await writeFile(join(repo, 'forge.infra.json'), JSON.stringify(FOUNDATION));

    const img = 'us-east1-docker.pkg.dev/p/r/app@sha256:' + 'a'.repeat(64);
    const r = await runInfra(['release-image', '--env', 'prod-a', '--service', 'x', '--image', img], repo);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/no BEHAVIOUR check/);
    // and it must refuse BEFORE touching the cloud — no roll attempted
    expect(r.out).not.toMatch(/services update|revision Ready/);
  }, 60_000);

  it('refuses `destroy` on a prod-named env without the explicit override', async () => {
    const repo = join(dir, 'guard-repo'); // reuse
    const r = await runInfra(['destroy', '--env', 'prod-a'], repo);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/i-know-this-is-prod/);
  }, 60_000);

  it('refuses `destroy` in CI entirely (§3.6: never)', async () => {
    const repo = join(dir, 'guard-repo');
    const r = await runInfra(['destroy', '--env', 'staging'], repo, { GITHUB_ACTIONS: 'true' });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/never runs in CI/);
  }, 60_000);
});

describe('serverless app-callback (I1 cutover fix)', () => {
  const KEYS = ['FORGE_APP_CALLBACK_URL', 'FORGE_APP_CALLBACK_HOST', 'FORGE_APP_CALLBACK_PORT'];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => KEYS.forEach((k) => (saved[k] = process.env[k])));
  afterAll(() => KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]!))));

  it('prefers a full FORGE_APP_CALLBACK_URL over the compose host+port form', async () => {
    const { appCallbackBase } = await import('../src/shared/app-callback');
    process.env.FORGE_APP_CALLBACK_URL = 'https://dorinda-api-123.us-east1.run.app/';
    process.env.FORGE_APP_CALLBACK_HOST = 'web';
    process.env.FORGE_APP_CALLBACK_PORT = '3000';
    expect(await appCallbackBase({} as never)).toBe('https://dorinda-api-123.us-east1.run.app');
  });

  it('falls back to http host:port when no URL is set (compose deploys unchanged)', async () => {
    const { appCallbackBase } = await import('../src/shared/app-callback');
    delete process.env.FORGE_APP_CALLBACK_URL;
    process.env.FORGE_APP_CALLBACK_HOST = 'web';
    process.env.FORGE_APP_CALLBACK_PORT = '3000';
    expect(await appCallbackBase({} as never)).toBe('http://web:3000');
  });
});

describe('release hygiene', () => {
  it('CHANGELOG has an entry for the version in package.json', async () => {
    const { readFile } = await import('node:fs/promises');
    const root = join(__dirname, '..');
    const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
    const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');

    // 0.79.21–0.79.23 all shipped with no entry: the edits targeted "## <version>" while the file
    // uses "## [<version>] - <date>", so every replace silently matched nothing and rewrote the
    // file unchanged. Nothing failed, so nothing was noticed. Assert the real format.
    expect(changelog).toMatch(new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm'));
  });
});

describe('§3.3 code-plane behaviour gate — Ready is not working', () => {
  it('classifies only request-making checks as behaviour, and treats a no-op command as absent', async () => {
    const { isBehaviourCheck } = await import('../src/infra/verify');
    const parse = (c: unknown) => infraConfigSchema.parse({ ...FOUNDATION, verify: [c] }).verify[0]!;

    // these prove the container exists / booted — release-image already reads back revision-Ready
    expect(isBehaviourCheck(parse({ kind: 'cloud_run_ready', service: 'dorinda-api' }))).toBe(false);
    expect(isBehaviourCheck(parse({ kind: 'dns_resolves', host: 'api.dorinda.ai' }))).toBe(false);

    // these make a real request
    expect(isBehaviourCheck(parse({ kind: 'http', url: 'https://api.dorinda.ai/api/health' }))).toBe(true);
    expect(isBehaviourCheck(parse({ kind: 'certless_discovery', url: 'https://mcp.dorinda.ai/.well-known/x' }))).toBe(true);
    expect(isBehaviourCheck(parse({ kind: 'command', run: './scripts/verify-mcp-edge.sh' }))).toBe(true);

    // a placeholder must not satisfy the gate it stands in for — this exact stub was live in dorinda-api
    expect(isBehaviourCheck(parse({ kind: 'command', run: 'true # TODO at cutover: promote verify-mcp-edge.sh' }))).toBe(false);
    expect(isBehaviourCheck(parse({ kind: 'command', run: ':' }))).toBe(false);
  });

  it('needs terraform outputs ONLY for the pre-DNS-cutover check forms', async () => {
    const { checksNeedOutputs } = await import('../src/infra/verify');
    const mk = (verify: unknown[]) => ({
      root: dir, tfDir: dir, config: infraConfigSchema.parse({ ...FOUNDATION, verify }),
    });
    // the shape the code plane ships with: plain public-DNS checks, no terraform required
    expect(checksNeedOutputs(mk([
      { kind: 'http', url: 'https://api.dorinda.ai/api/health/deep' },
      { kind: 'command', run: './scripts/verify-mcp-edge.sh' },
      { kind: 'cloud_run_ready', service: 'dorinda-api' },
    ]))).toBe(false);
    // pinned-IP forms genuinely need an output
    expect(checksNeedOutputs(mk([
      { kind: 'http', url: 'https://api.dorinda.ai/api/health', resolve_to_output: 'main_ip_from_contract' },
    ]))).toBe(true);
    expect(checksNeedOutputs(mk([
      { kind: 'certless_discovery', url: 'https://mcp.dorinda.ai/.well-known/x', resolve_to_output: 'mcp_ip' },
    ]))).toBe(true);
  });

  it('runs a command check from the REPO ROOT, not the process cwd', async () => {
    const { runVerify } = await import('../src/infra/verify');
    const repo = join(dir, 'cwd-repo');
    await mkdir(join(repo, 'scripts'), { recursive: true });
    await writeFile(join(repo, 'scripts', 'probe.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const cfg = infraConfigSchema.parse({
      ...FOUNDATION,
      verify: [{ kind: 'command', run: './scripts/probe.sh', cwd: '.' }],
    });
    const stack = { root: repo, tfDir: join(repo, 'infra'), config: cfg };

    // process.cwd() is the forge repo — the script only resolves if cwd is the DECLARING repo,
    // which is exactly the CI layout (the CLI runs from a sibling .forge checkout).
    const [r] = await runVerify(stack, 'prod-a', {});
    expect(r!.status).toBe('pass');
  }, 30_000);
});

describe('mixed module pins — the guard for the axis nothing else watches', () => {
  it('reports one ref when a stack is consistent, and ALL refs when it is not', async () => {
    const { modulePins } = await import('../src/infra/pins');
    const repo = join(dir, 'pins-repo');
    await mkdir(join(repo, 'infra'), { recursive: true });
    await writeFile(join(repo, 'forge.infra.json'), JSON.stringify(FOUNDATION));
    const stack = { root: repo, tfDir: join(repo, 'infra'), config: infraConfigSchema.parse(FOUNDATION) };

    await writeFile(
      join(repo, 'infra', 'main.tf'),
      `module "network" { source = "github.com/mardash-ai/forge//terraform/modules/network?ref=v0.79.19" }
       module "edge"    { source = "github.com/mardash-ai/forge//terraform/modules/edge?ref=v0.79.19" }`,
    );
    let pins = await modulePins(stack);
    expect(pins).toHaveLength(2);
    expect(new Set(pins.map((p) => p.ref)).size).toBe(1);

    // the real Dorinda shape: a fresh block at the current release beside a stale one
    await writeFile(
      join(repo, 'infra', 'main.tf'),
      `module "network"   { source = "github.com/mardash-ai/forge//terraform/modules/network?ref=v0.79.3" }
       module "collector" { source = "github.com/mardash-ai/forge//terraform/modules/service?ref=v0.79.17" }`,
    );
    pins = await modulePins(stack);
    const refs = new Set(pins.map((p) => p.ref));
    expect(refs.size).toBe(2);
    expect(refs).toContain('v0.79.3');
    expect(refs).toContain('v0.79.17');
  });
});
