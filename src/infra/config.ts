/**
 * `forge infra` — repo declaration (`forge.infra.json`).
 *
 * THE SELECTOR RULE (dorinda-orchestrator PRODUCTIONALIZATION_PLAN.md §3.0): the repo you are
 * standing in IS the stack selector. There is no `--stack` flag and no way to provision another
 * repo's infrastructure. This file is what a repo declares about ITS stack; `forge infra` walks up
 * from the invoking cwd to find it.
 *
 * ⚠️ EXECUTION MODEL — a deliberate divergence from every other forge capability. Capabilities run
 * in the control plane behind `/capabilities/<slug>`. `forge infra` CANNOT: its inputs (the repo
 * checkout, the cwd) and its credentials (operator ADC locally, Workload Identity in CI) exist only
 * on the invoking machine, and §2.5 rule 3 forbids minting a service-account key to give the control
 * plane. So `forge infra` executes LOCALLY, like git. The `forge` wrapper intercepts the `infra`
 * noun before the docker-exec path.
 */
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const CONFIG_FILENAME = 'forge.infra.json';

/** One deployable environment of this repo's stack (e.g. prod-a). */
const envSchema = z.object({
  project_id: z.string().min(6).describe('GCP project this env lives in'),
  region: z.string().min(3).describe('primary region, e.g. us-east1'),
  /** Optional per-env terraform variables, passed as -var key=value. */
  vars: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});

/** A verify check — §3.2: every stack declares what "working" MEANS for it. */
const verifyCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('dns_resolves'),
    host: z.string(),
    /** Optional terraform output name whose value the A record must equal (e.g. the LB IP). */
    expect_output: z.string().optional(),
  }),
  z.object({
    kind: z.literal('http'),
    url: z.string().url(),
    expect_status: z.number().int().default(200),
    /** Substring that must appear in the body (optional). */
    expect_body: z.string().optional(),
    /** For pre-DNS checks: connect to this IP (or the named tf output) while sending the URL's Host/SNI. */
    resolve_to_output: z.string().optional(),
    /**
     * Seconds to keep retrying before calling it a failure. Cold-start tolerance, NOT leniency: a
     * deep-health endpoint that touches the database, the data plane and external egress legitimately
     * 503s for a few seconds after a revision reports Ready, and a single-shot probe turns that into
     * a red deploy of a perfectly good build. An endpoint that is genuinely broken still fails —
     * just after the deadline instead of before the app has opened its pool.
     */
    warmup_seconds: z.number().int().min(0).max(300).default(60),
  }),
  z.object({
    /** The mcp.dorinda.ai contract: discovery must be reachable WITHOUT a client cert (ACCEPTANCE §5f MTLS-2). */
    kind: z.literal('certless_discovery'),
    url: z.string().url(),
    resolve_to_output: z.string().optional(),
  }),
  z.object({
    kind: z.literal('cloud_run_ready'),
    service: z.string(),
  }),
  z.object({
    /** Escape hatch that keeps existing proof scripts first-class (e.g. verify-mcp-edge.sh). */
    kind: z.literal('command'),
    run: z.string(),
    /** Working directory relative to the repo root. */
    cwd: z.string().default('.'),
  }),
]);

export const infraConfigSchema = z
  .object({
    /** Stack name — used for the state prefix and display. Convention: the repo name. */
    stack: z.string().regex(/^[a-z][a-z0-9-]{2,40}$/),
    kind: z.enum(['foundation', 'service', 'runner', 'telemetry']),

    /** GCS bucket holding terraform state for the whole product. Created by bootstrap. */
    state_bucket: z.string().min(6),

    /** Foundation-only: identifiers bootstrap needs. */
    org_id: z.string().regex(/^\d+$/).optional(),
    billing_account: z
      .string()
      .regex(/^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/)
      .optional(),
    /** Display name of the folder projects live under (created by bootstrap if missing). */
    folder: z.string().optional(),

    /**
     * Foundation-only: publish `terraform output` values as the platform contract after a green
     * apply (§3.5) — a versioned JSON object at gs://<state_bucket>/contract/<env>.json. Services
     * read THAT object, never foundation state (§2.5 rule 2).
     */
    publishes_contract: z.boolean().default(false),
    /** Consumers: the contract major this stack requires. plan/apply refuse on mismatch (§3.5). */
    required_platform_contract: z.number().int().positive().optional(),

    /** Foundation-only: GitHub org/repos allowed to assume the CI deployer via WIF. */
    github: z
      .object({
        owner: z.string(),
        repos: z.array(z.string()).min(1),
      })
      .optional(),

    envs: z.record(envSchema),
    verify: z.array(verifyCheckSchema).default([]),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.kind === 'foundation') {
      for (const k of ['org_id', 'billing_account'] as const) {
        if (!cfg[k]) ctx.addIssue({ code: 'custom', message: `foundation stack requires "${k}"`, path: [k] });
      }
    } else if (!cfg.required_platform_contract) {
      ctx.addIssue({
        code: 'custom',
        message: `non-foundation stacks must declare "required_platform_contract" (§3.5)`,
        path: ['required_platform_contract'],
      });
    }
  });

export type InfraConfig = z.infer<typeof infraConfigSchema>;
export type VerifyCheck = z.infer<typeof verifyCheckSchema>;

export interface RepoStack {
  /** Directory containing forge.infra.json (the repo root). */
  root: string;
  /** The terraform root-config directory: <root>/infra. */
  tfDir: string;
  config: InfraConfig;
}

/** Walk up from `startDir` to locate the repo's forge.infra.json. The cwd IS the selector (§3.0). */
export function findRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadRepoStack(startDir: string): Promise<RepoStack> {
  const root = findRepoRoot(startDir);
  if (!root) {
    throw new Error(
      `${CONFIG_FILENAME} not found from ${startDir} upward — stand in a repo that declares a stack. ` +
        `(The repo you are standing in is the selector; there is no --stack flag.)`,
    );
  }
  const raw = await readFile(join(root, CONFIG_FILENAME), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${(e as Error).message}`);
  }
  const config = infraConfigSchema.parse(parsed);
  return { root, tfDir: join(root, 'infra'), config };
}

/** Resolve one env or fail with the list of declared ones. */
export function requireEnv(config: InfraConfig, env: string) {
  const e = config.envs[env];
  if (!e) {
    throw new Error(
      `env "${env}" is not declared in ${CONFIG_FILENAME} — declared: ${Object.keys(config.envs).join(', ')}`,
    );
  }
  return e;
}
