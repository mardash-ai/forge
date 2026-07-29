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

describe('bootstrap role curation', () => {
  it('deployer roles are a curated list and never roles/editor or owner', () => {
    expect(DEPLOYER_ROLES.length).toBeGreaterThan(5);
    for (const r of DEPLOYER_ROLES) {
      expect(r).not.toMatch(/roles\/(editor|owner)$/);
    }
  });
});

describe('§3.6 guard — apply is CI-only (subprocess, the real thing)', () => {
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
