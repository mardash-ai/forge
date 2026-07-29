/**
 * Terraform execution for `forge infra` — the single place the CLI shells out to terraform.
 *
 * Design points, all load-bearing:
 *  - One state per stack per env (§2.5 rule 1): backend prefix `stacks/<stack>/<env>` in the
 *    product's state bucket. The backend block in the repo is an EMPTY `backend "gcs" {}`; the
 *    bucket/prefix arrive via -backend-config at init, so the repo never hard-codes them.
 *  - §3.7: apply is not believed — after `terraform apply`, we re-run `terraform plan
 *    -detailed-exitcode` and require an EMPTY diff. Exit 2 (changes remain) means the apply did not
 *    converge, and we fail loudly naming the changed resources.
 *  - Vars flow as `-var`: env-declared vars, plus the materialized platform contract for consumer
 *    stacks (written to contract.auto.tfvars.json, which terraform auto-loads).
 */
import { run } from '../shared/exec';
import { requireEnv, type RepoStack } from './config';

export interface TfResult {
  code: number;
  output: string;
}

async function tf(stack: RepoStack, args: string[], opts: { timeoutMs?: number } = {}): Promise<TfResult> {
  const r = await run('terraform', [`-chdir=${stack.tfDir}`, ...args], {
    timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000,
    tailLines: 400,
  });
  return { code: r.code ?? 1, output: r.combined };
}

export function statePrefix(stack: RepoStack, env: string): string {
  return `stacks/${stack.config.stack}/${env}`;
}

export async function tfInit(stack: RepoStack, env: string): Promise<TfResult> {
  return tf(stack, [
    'init',
    '-input=false',
    '-reconfigure',
    `-backend-config=bucket=${stack.config.state_bucket}`,
    `-backend-config=prefix=${statePrefix(stack, env)}`,
  ]);
}

export async function tfValidate(stack: RepoStack): Promise<TfResult> {
  // validate needs providers but not the backend
  const init = await tf(stack, ['init', '-input=false', '-backend=false']);
  if (init.code !== 0) return init;
  return tf(stack, ['validate', '-no-color']);
}

export async function tfFmtCheck(stack: RepoStack): Promise<TfResult> {
  return tf(stack, ['fmt', '-check', '-recursive']);
}

function varArgs(stack: RepoStack, env: string): string[] {
  const e = requireEnv(stack.config, env);
  const base: Record<string, string | number | boolean> = {
    project_id: e.project_id,
    region: e.region,
    env_name: env,
    ...e.vars,
  };
  return Object.entries(base).flatMap(([k, v]) => ['-var', `${k}=${v}`]);
}

/** Exit 0 = no changes · 2 = changes present · anything else = error. */
export async function tfPlan(stack: RepoStack, env: string, planFile?: string): Promise<TfResult> {
  return tf(stack, [
    'plan',
    '-input=false',
    '-no-color',
    '-detailed-exitcode',
    ...varArgs(stack, env),
    ...(planFile ? [`-out=${planFile}`] : []),
  ]);
}

export async function tfApply(stack: RepoStack, env: string): Promise<TfResult> {
  return tf(stack, ['apply', '-input=false', '-no-color', '-auto-approve', ...varArgs(stack, env)]);
}

export async function tfDestroy(stack: RepoStack, env: string): Promise<TfResult> {
  return tf(stack, ['destroy', '-input=false', '-no-color', '-auto-approve', ...varArgs(stack, env)]);
}

export async function tfOutputs(stack: RepoStack): Promise<Record<string, unknown>> {
  const r = await tf(stack, ['output', '-json', '-no-color']);
  if (r.code !== 0) throw new Error(`terraform output failed:\n${r.output}`);
  const parsed = JSON.parse(r.output) as Record<string, { value: unknown }>;
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v.value]));
}

/**
 * §3.7 read-back: after apply, the plan must be EMPTY. Returns null when converged, else a
 * human-readable description of what still differs (the resources that did not converge).
 */
export async function readBackConverged(stack: RepoStack, env: string): Promise<string | null> {
  const r = await tfPlan(stack, env);
  if (r.code === 0) return null;
  if (r.code === 2) {
    const changed = r.output
      .split('\n')
      .filter((l) => /^\s*[#~+-]/.test(l) && /resource|module/.test(l))
      .slice(0, 20)
      .join('\n');
    return `apply completed but the stack did NOT converge — a re-plan still shows changes:\n${changed || r.output.slice(-2000)}`;
  }
  return `apply completed but the read-back plan errored (exit ${r.code}):\n${r.output.slice(-2000)}`;
}
