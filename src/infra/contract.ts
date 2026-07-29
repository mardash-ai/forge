/**
 * §3.5 — the platform contract. Foundation publishes its terraform outputs (plus the declared-config
 * hash) as a small versioned JSON object at gs://<state_bucket>/contract/<env>.json after every
 * converged apply. Consumer stacks read THAT object — never foundation state (§2.5 rule 2) — and
 * `plan`/`apply` refuse immediately on a major-version mismatch, before touching the provider.
 *
 * Materialization: the contract's values are written into the consumer's tf dir as
 * `contract.auto.tfvars.json` (terraform auto-loads it; gitignored; regenerated every plan/apply).
 */
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { run } from '../shared/exec';
import type { RepoStack } from './config';

export interface PlatformContract {
  platform_contract_version: number;
  published_at: string;
  declared_config_hash: string;
  values: Record<string, unknown>;
}

export function contractObjectPath(stateBucket: string, env: string): string {
  return `gs://${stateBucket}/contract/${env}.json`;
}

export function hashObjectPath(stateBucket: string, stackName: string, env: string): string {
  return `gs://${stateBucket}/hash/${stackName}.${env}`;
}

async function gsutilCat(gsUrl: string): Promise<string | null> {
  const r = await run('gcloud', ['storage', 'cat', gsUrl], { timeoutMs: 60_000, tailLines: 50 });
  return (r.code ?? 1) === 0 ? r.combined : null;
}

async function gsutilWrite(gsUrl: string, content: string): Promise<void> {
  const tmp = join(tmpdir(), `forge-infra-${randomUUID()}.json`);
  await writeFile(tmp, content, 'utf8');
  try {
    const r = await run('gcloud', ['storage', 'cp', tmp, gsUrl], { timeoutMs: 120_000, tailLines: 50 });
    if ((r.code ?? 1) !== 0) throw new Error(`failed to write ${gsUrl}:\n${r.combined.slice(-800)}`);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export async function publishContract(
  stack: RepoStack,
  env: string,
  outputs: Record<string, unknown>,
  declaredHash: string,
): Promise<PlatformContract> {
  const version = Number(outputs.platform_contract_version ?? NaN);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(
      `foundation stack declares publishes_contract, but terraform outputs carry no integer ` +
        `"platform_contract_version" — the contract version must be an OUTPUT of the stack, so a ` +
        `version bump is a reviewed change to the config, not CLI state.`,
    );
  }
  const contract: PlatformContract = {
    platform_contract_version: version,
    published_at: new Date().toISOString(),
    declared_config_hash: declaredHash,
    values: outputs,
  };
  await gsutilWrite(contractObjectPath(stack.config.state_bucket, env), JSON.stringify(contract, null, 2));
  return contract;
}

export async function fetchContract(stack: RepoStack, env: string): Promise<PlatformContract | null> {
  const raw = await gsutilCat(contractObjectPath(stack.config.state_bucket, env));
  if (!raw) return null;
  return JSON.parse(raw) as PlatformContract;
}

/**
 * Consumer-side gate + materialization. Fails BEFORE any provider call on: contract absent (the
 * foundation has never converged in this env) or major too old. Removing/renaming an output is a
 * major bump on the foundation side (§3.5), so this is where the quiet failure becomes loud.
 */
export async function materializeContract(stack: RepoStack, env: string): Promise<PlatformContract> {
  const required = stack.config.required_platform_contract;
  if (!required) throw new Error(`stack "${stack.config.stack}" has no required_platform_contract — nothing to materialize`);
  const contract = await fetchContract(stack, env);
  if (!contract) {
    throw new Error(
      `no platform contract published at ${contractObjectPath(stack.config.state_bucket, env)} — ` +
        `apply the foundation stack for env "${env}" first.`,
    );
  }
  if (contract.platform_contract_version < required) {
    throw new Error(
      `platform contract mismatch: this stack requires v${required}, but the published contract is ` +
        `v${contract.platform_contract_version}. Apply the updated foundation first.`,
    );
  }
  await writeFile(
    join(stack.tfDir, 'contract.auto.tfvars.json'),
    JSON.stringify({ platform: contract.values }, null, 2),
    'utf8',
  );
  return contract;
}

/** Publish the declared-config hash after a converged apply; `status` compares against it. */
export async function publishDeclaredHash(stack: RepoStack, env: string, hash: string): Promise<void> {
  await gsutilWrite(hashObjectPath(stack.config.state_bucket, stack.config.stack, env), hash);
}

export async function fetchDeclaredHash(stack: RepoStack, env: string): Promise<string | null> {
  const raw = await gsutilCat(hashObjectPath(stack.config.state_bucket, stack.config.stack, env));
  return raw ? raw.trim() : null;
}

/** Best-effort read of the contract file for repos that only need values locally (e.g. verify). */
export async function readMaterializedContract(stack: RepoStack): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(stack.tfDir, 'contract.auto.tfvars.json'), 'utf8');
    return (JSON.parse(raw) as { platform: Record<string, unknown> }).platform;
  } catch {
    return null;
  }
}
