#!/usr/bin/env node
/**
 * `forge infra` — the stack verbs (plan §3.1). LOCAL EXECUTION, deliberately unlike every other
 * forge command (see config.ts header): the repo you stand in is the selector, your ADC (or CI's
 * WIF token) is the credential, and the control plane is not in the loop.
 *
 * Guard rails implemented here, not left to memory:
 *   - `apply` is CI-only (§3.6). Locally it demands BOTH `--local` AND `--allow-local-apply`, the
 *     §3.8 escape hatch whose two legitimate uses (foundation, then runners) are the last local
 *     applies in the product's lifetime.
 *   - `apply` does not believe exit codes (§3.7): it re-plans after applying and FAILS unless the
 *     diff is empty, then publishes the declared-config hash + (foundation) the platform contract.
 *   - `destroy` refuses on any env containing "prod" unless `--i-know-this-is-prod`, and is never
 *     allowed in CI.
 *   - consumer stacks refuse `plan`/`apply` before the published platform contract satisfies
 *     `required_platform_contract` (§3.5) — the mismatch is named before any provider call.
 */
import { Command } from 'commander';
import { loadRepoStack, requireEnv } from './config';
import { declaredConfigHash } from './hash';
import { bootstrap } from './bootstrap';
import { tfInit, tfValidate, tfFmtCheck, tfPlan, tfApply, tfDestroy, tfOutputs, readBackConverged } from './terraform';
import { materializeContract, publishContract, publishDeclaredHash, fetchDeclaredHash } from './contract';
import { runVerify } from './verify';

const program = new Command();

const invokeDir = process.env.FORGE_INFRA_INVOKE_DIR || process.cwd();
const inCI = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true';

function fail(msg: string): never {
  process.stderr.write(`forge infra: ${msg}\n`);
  process.exit(1);
}

function say(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

async function stackFor(env?: string) {
  const stack = await loadRepoStack(invokeDir);
  if (env) requireEnv(stack.config, env);
  return stack;
}

/** plan/apply pre-flight shared by both: init + (consumers) contract gate + materialization. */
async function preflight(stack: Awaited<ReturnType<typeof stackFor>>, env: string) {
  if (stack.config.required_platform_contract) {
    const c = await materializeContract(stack, env); // throws the §3.5 mismatch BEFORE provider calls
    say(`contract: v${c.platform_contract_version} (requires v${stack.config.required_platform_contract}) ✓`);
  }
  const init = await tfInit(stack, env);
  if (init.code !== 0) fail(`terraform init failed:\n${init.output.slice(-1500)}`);
}

program
  .name('forge infra')
  .description('Provision THIS repo\'s stack. The repo you are standing in is the selector — there is no --stack flag.');

program
  .command('bootstrap')
  .description('ONCE per env: folder, project, billing, core APIs, state bucket, WIF pool (§3.8). Idempotent — the only verb allowed to create resources outside Terraform state, because the state backend cannot store itself.')
  .requiredOption('--env <env>')
  .action(async (opts) => {
    const stack = await stackFor(opts.env);
    const steps = await bootstrap(stack, opts.env);
    for (const s of steps) say(`  ${s.status.toUpperCase().padEnd(7)} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
    say(`bootstrap: ${steps.length} steps converged (re-running is safe and expected).`);
  });

program
  .command('lint')
  .description('Validate the declaration + terraform fmt/validate — before any provider call.')
  .action(async () => {
    const stack = await stackFor();
    say(`stack: ${stack.config.stack} (${stack.config.kind}) at ${stack.root}`);
    const fmt = await tfFmtCheck(stack);
    if (fmt.code !== 0) fail(`terraform fmt -check failed — run terraform fmt:\n${fmt.output.slice(-800)}`);
    const val = await tfValidate(stack);
    if (val.code !== 0) fail(`terraform validate failed:\n${val.output.slice(-1500)}`);
    say('lint: OK');
  });

program
  .command('plan')
  .description('Plan THIS repo\'s stack. Read-only; posts the §3.5 contract gate before any provider call.')
  .requiredOption('--env <env>')
  .action(async (opts) => {
    const stack = await stackFor(opts.env);
    await preflight(stack, opts.env);
    const r = await tfPlan(stack, opts.env);
    process.stdout.write(r.output);
    if (r.code === 0) say('\nplan: no changes — declared and actual match.');
    else if (r.code === 2) say('\nplan: changes present (shown above).');
    else fail(`terraform plan errored (exit ${r.code})`);
  });

program
  .command('apply')
  .description('Apply THIS repo\'s stack. CI-only; --local --allow-local-apply is the §3.8 bootstrap escape hatch.')
  .requiredOption('--env <env>')
  .option('--local', 'explicitly acknowledge this is not CI')
  .option('--allow-local-apply', 'second key for the §3.8 escape hatch — both flags are required')
  .action(async (opts) => {
    if (!inCI && !(opts.local && opts.allowLocalApply)) {
      fail(
        `apply is CI-only (§3.6). If this is the §3.8 bootstrap case (no CI exists yet), pass BOTH ` +
          `--local AND --allow-local-apply. Every other apply goes through a merge.`,
      );
    }
    const stack = await stackFor(opts.env);
    await preflight(stack, opts.env);

    const hash = await declaredConfigHash(stack.root, stack.tfDir);
    say(`declared config: ${hash}`);

    const r = await tfApply(stack, opts.env);
    process.stdout.write(r.output.slice(-4000));
    if (r.code !== 0) fail(`terraform apply errored (exit ${r.code})`);

    // §3.7 — a zero exit code is not evidence. Re-read and require convergence.
    const notConverged = await readBackConverged(stack, opts.env);
    if (notConverged) fail(notConverged);
    say('read-back: converged (re-plan is empty) ✓');

    await publishDeclaredHash(stack, opts.env, hash);

    if (stack.config.publishes_contract) {
      const outputs = await tfOutputs(stack);
      const contract = await publishContract(stack, opts.env, outputs, hash);
      say(`contract: published v${contract.platform_contract_version} → gs://${stack.config.state_bucket}/contract/${opts.env}.json`);
    }
    say('apply: converged, hash published.');
  });

program
  .command('status')
  .description('Declared vs actual: the §3.7 hash comparison + a refresh plan, on demand.')
  .requiredOption('--env <env>')
  .action(async (opts) => {
    const stack = await stackFor(opts.env);
    const local = await declaredConfigHash(stack.root, stack.tfDir);
    const published = await fetchDeclaredHash(stack, opts.env);
    say(`declared (local):    ${local}`);
    say(`published (applied): ${published ?? '(never applied)'}`);
    if (published && published !== local) say('→ local declaration has CHANGED since the last converged apply.');

    await preflight(stack, opts.env);
    const r = await tfPlan(stack, opts.env);
    if (r.code === 0) say('live state: in sync — no drift.');
    else if (r.code === 2) {
      say('live state: DRIFT — the applied stack no longer matches the declaration:');
      process.stdout.write(r.output.slice(-2500) + '\n');
      process.exit(2);
    } else fail(`terraform plan errored (exit ${r.code})`);
  });

program
  .command('outputs')
  .description('What this stack publishes to others (the §3.5 contract values, for foundation stacks).')
  .requiredOption('--env <env>')
  .action(async (opts) => {
    const stack = await stackFor(opts.env);
    const init = await tfInit(stack, opts.env);
    if (init.code !== 0) fail(`terraform init failed:\n${init.output.slice(-1000)}`);
    say(JSON.stringify(await tfOutputs(stack), null, 2));
  });

program
  .command('verify')
  .description('Prove the stack WORKS (§3.2) — the repo-declared behaviour checks, not resource existence. CI runs this as the post-deploy gate.')
  .requiredOption('--env <env>')
  .action(async (opts) => {
    const stack = await stackFor(opts.env);
    const init = await tfInit(stack, opts.env);
    if (init.code !== 0) fail(`terraform init failed:\n${init.output.slice(-1000)}`);
    const outputs = await tfOutputs(stack).catch(() => ({}) as Record<string, unknown>);
    const results = await runVerify(stack, opts.env, outputs);
    let failed = 0;
    for (const r of results) {
      say(`  ${r.status === 'pass' ? 'PASS' : 'FAIL'}  ${r.title} — ${r.detail}`);
      if (r.status === 'fail') failed++;
    }
    if (results.length === 0) say('  (no verify checks declared — declare what "working" means for this stack)');
    say(`verify: ${results.length - failed}/${results.length} passed`);
    process.exit(failed === 0 ? 0 : 1);
  });

program
  .command('destroy')
  .description('Tear the stack down. Envs containing "prod" require --i-know-this-is-prod; never runs in CI.')
  .requiredOption('--env <env>')
  .option('--i-know-this-is-prod', 'explicit override for prod-named envs')
  .action(async (opts) => {
    if (inCI) fail('destroy never runs in CI (§3.6).');
    if (/prod/i.test(opts.env) && !opts.iKnowThisIsProd) {
      fail(`env "${opts.env}" looks like production. If you truly mean it: --i-know-this-is-prod`);
    }
    const stack = await stackFor(opts.env);
    await preflight(stack, opts.env);
    const r = await tfDestroy(stack, opts.env);
    process.stdout.write(r.output.slice(-3000));
    if (r.code !== 0) fail(`terraform destroy errored (exit ${r.code})`);
    say('destroy: complete.');
  });

program.parseAsync(process.argv).catch((e) => fail((e as Error).message));
