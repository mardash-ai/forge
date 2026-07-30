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
import { modulePins } from './pins';
import { bootstrap } from './bootstrap';
import { tfInit, tfValidate, tfFmtCheck, tfPlan, tfApply, tfDestroy, tfOutputs, tfUntaint, readBackConverged } from './terraform';
import { materializeContract, publishContract, publishDeclaredHash, fetchDeclaredHash } from './contract';
import { runVerify, behaviourChecks, checksNeedOutputs } from './verify';

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
    // MIXED MODULE PINS — the third axis no other guard watches. CI apply proves
    // declaration→cloud; drift proves cloud→declaration. Both stay GREEN while the DECLARATION
    // rots. Dorinda's foundation ran six releases behind on `network` (no Cloud NAT ⇒ every
    // non-Google outbound call hung) while every check was green, because a fresh module block
    // was written at the then-current ref and the older blocks were never bumped alongside it.
    const pins = await modulePins(stack);
    const distinct = [...new Set(pins.map((p) => p.ref))];
    if (distinct.length > 1) {
      const detail = pins.map((p) => `  ${p.ref}  ${p.module}  (${p.file})`).join('\n');
      fail(
        `MIXED module pins in one stack — adopt is all-or-nothing:\n${detail}\n` +
          `Bump every module in this stack to the same forge release, then re-run.`,
      );
    }
    if (distinct.length === 1) say(`module pins: all at ${distinct[0]} ✓`);
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
  .command('release-image')
  .description('CODE plane (§3.3): roll ONE Cloud Run service to a new image by digest, then PROVE IT WORKS. Infra owns the stack (and ignores image changes); THIS moves the code. Refuses before rolling unless the stack declares a behaviour check, and after the revision goes Ready runs the stack\'s verify checks — a Ready revision can still be broken (the FORGE_APP_CALLBACK_URL cutover bug). The 2a pipeline wraps it.')
  .requiredOption('--env <env>')
  .requiredOption('--service <name>', 'Cloud Run service name')
  .requiredOption('--image <ref>', 'image ref — digest-pinned (R1): repo@sha256:…')
  .option('--allow-unverified-release', 'roll WITHOUT a behaviour gate. Escape hatch only: it ships code whose only proof is that the container booted.')
  .action(async (opts) => {
    if (!/@sha256:[0-9a-f]{64}$/.test(opts.image)) {
      fail(`image must be DIGEST-pinned (R1): got "${opts.image}"`);
    }
    const stack = await stackFor(opts.env);
    const e = stack.config.envs[opts.env]!;

    // Gate BEFORE the roll, not after: refusing once the traffic has already moved is a complaint,
    // not a guard. A stack whose only checks are cloud_run_ready/dns_resolves cannot tell a working
    // release from a broken one, and must say so at declaration time.
    const behaviour = behaviourChecks(stack);
    if (behaviour.length === 0 && !opts.allowUnverifiedRelease) {
      fail(
        `stack "${stack.config.stack}" declares no BEHAVIOUR check, so a release here can only prove the ` +
          `container booted — never that it works (§3.2).\n` +
          `  Add an http / certless_discovery / command check to forge.infra.json "verify".\n` +
          `  cloud_run_ready and dns_resolves do not count: release-image already reads back revision-Ready, ` +
          `and a Ready revision serving 500s passes both.\n` +
          `  Deliberate exception: --allow-unverified-release`,
      );
    }
    const { run } = await import('../shared/exec');
    const r = await run('gcloud', ['run', 'services', 'update', opts.service,
      `--project=${e.project_id}`, `--region=${e.region}`, `--image=${opts.image}`, '--quiet'],
      { timeoutMs: 10 * 60_000, tailLines: 50 });
    if ((r.code ?? 1) !== 0) fail(`release failed:\n${r.combined.slice(-1200)}`);
    // §3.7 discipline, code-plane edition: read back the serving revision's image.
    const { capture } = await import('./exec');
    const check = await capture('gcloud', ['run', 'services', 'describe', opts.service,
      `--project=${e.project_id}`, `--region=${e.region}`,
      '--format=value(spec.template.spec.containers[0].image)'], { timeoutMs: 60_000 });
    const live = check.stdout.trim();
    if (live !== opts.image) fail(`read-back mismatch: serving "${live}", expected "${opts.image}"`);
    // The configured image is not the proof — the REVISION must go Ready (a bad manifest fails at
    // import with the config already updated; hit live: "Container import failed").
    let ready_ok = false;
    for (let i = 0; i < 30; i++) {
      const ready = await capture('gcloud', ['run', 'services', 'describe', opts.service,
        `--project=${e.project_id}`, `--region=${e.region}`,
        '--format=value(status.conditions[0].status,status.conditions[0].message)'], { timeoutMs: 60_000 });
      const line = ready.stdout.trim();
      if (line.startsWith('True')) { say(`release: ${opts.service} → ${opts.image} (revision Ready ✓)`); ready_ok = true; break; }
      if (/failed|error/i.test(line)) fail(`revision NOT ready: ${line}`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
    if (!ready_ok) fail('revision did not become Ready within 5 minutes');

    // Ready ≠ working. Now make a real request.
    if (opts.allowUnverifiedRelease) {
      say('release: behaviour gate SKIPPED (--allow-unverified-release) — this release proved only that it booted.');
      return;
    }
    // Deliberately WITHOUT terraform unless a check truly needs an output. The release runner has
    // gcloud and docker, not terraform; and post-DNS-cutover, resolving normally is the stronger
    // check anyway — it takes the path a real client takes.
    let outputs: Record<string, unknown> = {};
    if (checksNeedOutputs(stack)) {
      // run() REJECTS when the binary is absent (spawn ENOENT) rather than returning a code — the
      // exact shape that turned a missing terraform into an unexplained release failure.
      const init = await tfInit(stack, opts.env).catch((e: unknown) => ({ code: 1, output: String(e) }));
      if (init.code === 0) {
        outputs = await tfOutputs(stack).catch(() => ({}) as Record<string, unknown>);
      } else {
        say('release: terraform unavailable — resolving verify targets through public DNS instead of pinned outputs.');
      }
    }
    const results = await runVerify(stack, opts.env, outputs);
    let failed = 0;
    for (const r of results) {
      say(`  ${r.status === 'pass' ? 'PASS' : 'FAIL'}  ${r.title} — ${r.detail}`);
      if (r.status === 'fail') failed++;
    }
    if (failed > 0) {
      fail(
        `release rolled ${opts.service} to a revision that is Ready but DOES NOT WORK: ${failed}/${results.length} ` +
          `verify checks failed (above). The new revision is serving — roll back with the previous digest.`,
      );
    }
    say(`release: ${opts.service} verified — ${results.length}/${results.length} behaviour checks passed ✓`);
  });

program
  .command('untaint')
  .description('Clear the tainted flag on ONE resource address. STATE bookkeeping only — touches nothing in the cloud. Exists because a partially-failed apply (e.g. a rejected IAM member AFTER service creation) leaves a healthy resource marked for pointless replacement.')
  .requiredOption('--env <env>')
  .requiredOption('--address <address>', 'exact terraform resource address to untaint')
  .action(async (opts) => {
    const stack = await stackFor(opts.env);
    const init = await tfInit(stack, opts.env);
    if (init.code !== 0) fail(`terraform init failed:\n${init.output.slice(-1000)}`);
    const r = await tfUntaint(stack, opts.address);
    process.stdout.write(r.output);
    if (r.code !== 0) fail(`untaint failed (exit ${r.code})`);
    say(`untaint: ${opts.address} — run plan to confirm the replacement is gone.`);
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
