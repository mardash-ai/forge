import { z } from 'zod';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capability } from '../../core/types';
import type { ObservabilityStack } from '../../resources/types';
import { baseResource } from '../_shared';
import { nowIso } from '../../shared/time';
import { workspaceDir } from '../../shared/paths';
import { run } from '../../shared/exec';
import { httpProbe } from '../../shared/health-probe';
import {
  generateObservabilityCompose,
  generateObservabilitySecrets,
  renderObservabilityEnv,
  renderObservabilityEnvExample,
  OBSERVABILITY_HEALTH_PATH,
  OBSERVABILITY_OTLP_PATH,
} from '../../plugins/observability-stack/index';

const inputSchema = z.object({
  dir: z
    .string()
    .optional()
    .describe('Target directory for the stack files (default <workspace>/observability)'),
  project_name: z.string().default('dorinda-monitor').describe('Compose project name'),
  public_host: z
    .string()
    .optional()
    .describe('Front langfuse-web via a Traefik proxy at this host (e.g. monitor.dorinda.ai)'),
  ui_port: z.number().int().positive().default(3100).describe('Host port langfuse-web is published on'),
  network: z.string().default('observability').describe('Shared external network consumers attach to'),
  proxy_network: z.string().default('proxy').describe('External Traefik network (used only when public_host is set)'),
  admin_email: z.string().email().default('admin@forge.local').describe('Bootstrap admin email (first boot only)'),
  env_file: z.string().default('.env').describe('Env filename inside the stack dir (compose --env-file)'),
  preserve_volumes_from: z
    .string()
    .optional()
    .describe('Adopt existing named volumes under this prefix instead of fresh ones (data preservation)'),
  health_url: z.string().url().optional().describe('Override the health-probe URL (default derived from host/port)'),
  context: z.string().optional().describe('docker --context for a remote daemon'),
  skip_deploy: z.boolean().default(false).describe('Generate files only; do not pull/up (dry provision)'),
  regenerate_secrets: z
    .boolean()
    .default(false)
    .describe('Force NEW secrets even if an env file exists — DESTRUCTIVE: breaks existing data + wired keys'),
  health_timeout_ms: z.number().int().positive().default(240_000).describe('How long to wait for langfuse-web to serve'),
});

type Input = z.infer<typeof inputSchema>;

// Tolerant `docker network create` — succeeds if the network already exists (the common case for the
// shared observability net + the box Traefik proxy net).
async function ensureNetwork(ctxArgs: string[], name: string): Promise<void> {
  const r = await run('docker', [...ctxArgs, 'network', 'create', name], { timeoutMs: 30_000 });
  if (r.code !== 0 && !/already exists/i.test(r.combined)) {
    throw new Error(`docker network create ${name} failed: ${r.tail}`);
  }
}

// Poll langfuse-web until it serves a 200 (or the deadline). Langfuse's /api/public/health is
// unauthenticated, so a plain GET is enough — we don't assert a forge health schema here.
async function waitForLangfuse(
  url: string,
  timeoutMs: number,
): Promise<{ ready: boolean; status?: number; attempts: number }> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    attempts++;
    const p = await httpProbe(url, { method: 'GET', timeoutMs: 5_000, redirect: 'manual' });
    lastStatus = p.status;
    if (p.reachable && p.status === 200) return { ready: true, status: p.status, attempts };
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return { ready: false, status: lastStatus, attempts };
}

// Pull the LANGFUSE_PUBLIC_KEY out of an existing env file so we can register the resource without
// regenerating (and thus breaking) the stack's real secrets.
function parseEnvValue(text: string, key: string): string | undefined {
  for (const line of text.split('\n')) {
    const m = line.match(new RegExp(`^${key}=(.*)$`));
    if (m) return m[1]?.trim();
  }
  return undefined;
}

// ProvisionObservability (C37) — GENERATE the canonical self-hosted Langfuse stack + DEPLOY it, then
// register the ObservabilityStack resource. Forge owns the stack definition (the observability-stack
// plugin bakes in every fix the box needed), so a consumer host gets a green Langfuse in one command.
//
// Secrets are PRESERVED by default: if an env file already exists, its values (incl. the project key
// pair consumers wired into their OTLP auth) are reused untouched. Only a first provision — or an
// explicit --regenerate-secrets — writes fresh secrets. This makes re-provisioning an already-running
// stack a safe, diff-clean no-op (adopt-in-place), not a data-losing reset.
export const provisionObservability: Capability<Input, ObservabilityStack> = {
  name: 'ProvisionObservability',
  slug: 'provision-observability',
  description:
    'Generate the canonical self-hosted Langfuse stack, deploy it (docker compose up), wait for health, and register the ObservabilityStack resource.',
  inputSchema,
  resourceType: 'ObservabilityStack',
  events: ['ObservabilityConfigured'],
  longRunning: true,
  requiresDocker: true,
  plane: 'control',
  async execute(input, ctx) {
    const dir = input.dir ?? join(workspaceDir(), 'observability');
    const ctxArgs = input.context ? ['--context', input.context] : [];
    const nextauthUrl = input.public_host ? `https://${input.public_host}` : `http://localhost:${input.ui_port}`;

    await mkdir(dir, { recursive: true });

    // 1. Generate + write the compose (deterministic — no secrets inside) + a committable .env.example.
    const compose = generateObservabilityCompose({
      projectName: input.project_name,
      publicHost: input.public_host,
      uiPort: input.ui_port,
      network: input.network,
      proxyNetwork: input.proxy_network,
      preserveVolumesFrom: input.preserve_volumes_from,
    });
    await writeFile(join(dir, 'compose.yaml'), compose, 'utf8');
    await writeFile(join(dir, '.env.example'), renderObservabilityEnvExample(), 'utf8');

    // 2. Secrets: preserve an existing env file (default), else generate + write fresh (mode 0600).
    const envPath = join(dir, input.env_file);
    const existingEnv = await readFile(envPath, 'utf8').catch(() => null);
    let publicKey: string | undefined;
    let secretsMode: 'preserved' | 'generated';
    if (existingEnv && !input.regenerate_secrets) {
      secretsMode = 'preserved';
      publicKey = parseEnvValue(existingEnv, 'LANGFUSE_PUBLIC_KEY');
    } else {
      secretsMode = 'generated';
      const secrets = generateObservabilitySecrets();
      publicKey = secrets.LANGFUSE_PUBLIC_KEY;
      const env = renderObservabilityEnv(secrets, {
        adminEmail: input.admin_email,
        nextauthUrl,
        uiPort: input.ui_port,
      });
      await writeFile(envPath, env, { mode: 0o600 });
    }

    // 3. Deploy (unless skip_deploy): ensure networks, pull, whole-stack up -d.
    let deployed = false;
    if (!input.skip_deploy) {
      await ensureNetwork(ctxArgs, input.network);
      if (input.public_host) await ensureNetwork(ctxArgs, input.proxy_network);

      const composeArgs = [...ctxArgs, 'compose', '-f', 'compose.yaml', '--env-file', input.env_file];
      // Best-effort pull — a failed pull is not fatal (offline hosts / rate limits); `up` surfaces it.
      await run('docker', [...composeArgs, 'pull'], { cwd: dir, timeoutMs: 10 * 60_000 });
      const up = await run('docker', [...composeArgs, 'up', '-d'], { cwd: dir, timeoutMs: 10 * 60_000 });
      if (up.code !== 0) throw new Error(`docker compose up failed:\n${up.tail}`);
      deployed = true;
    }

    // 4. Wait for langfuse-web to serve.
    const healthUrl =
      input.health_url ??
      (input.public_host
        ? `https://${input.public_host}${OBSERVABILITY_HEALTH_PATH}`
        : `http://localhost:${input.ui_port}${OBSERVABILITY_HEALTH_PATH}`);
    let reachable = false;
    if (deployed) {
      const w = await waitForLangfuse(healthUrl, input.health_timeout_ms);
      reachable = w.ready;
    }

    // 5. Register the ObservabilityStack (upsert — at most one). Consumers export to the INTERNAL OTLP
    //    endpoint (langfuse-web on the shared network), NOT the public host. Never store the secret key.
    const endpoint = `http://langfuse-web:3000${OBSERVABILITY_OTLP_PATH}`;
    const status: ObservabilityStack['status'] = deployed && !reachable ? 'unreachable' : 'configured';
    const checked_at = nowIso();
    const existing = (await ctx.store.listResources({ type: 'ObservabilityStack' }))[0] as
      | ObservabilityStack
      | undefined;

    const fields = {
      endpoint,
      public_key: publicKey ?? existing?.public_key ?? '',
      status,
      checked_at,
      public_host: input.public_host,
      stack_dir: dir,
    };
    const resource: ObservabilityStack = existing
      ? { ...existing, ...fields, updated_at: nowIso() }
      : { ...baseResource('ObservabilityStack'), type: 'ObservabilityStack', ...fields };
    await ctx.store.saveResource(resource);

    await ctx.emit({
      type: 'ObservabilityConfigured',
      resource_type: 'ObservabilityStack',
      resource_id: resource.id,
      data: {
        endpoint,
        public_key: fields.public_key, // public key only — the secret key is never emitted or stored
        status,
        deployed,
        secrets_mode: secretsMode,
        stack_dir: dir,
        public_host: input.public_host ?? null,
        health_url: healthUrl,
      },
    });

    return resource;
  },
};
