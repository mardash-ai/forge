import { z } from 'zod';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Capability } from '../../core/types';
import type { MonitoringStack } from '../../resources/types';
import { baseResource } from '../_shared';
import { nowIso } from '../../shared/time';
import { workspaceDir } from '../../shared/paths';
import { run } from '../../shared/exec';
import { httpProbe } from '../../shared/health-probe';
import {
  generateMonitoringCompose,
  generateMonitoringSecrets,
  renderMonitoringEnv,
  renderMonitoringEnvExample,
  MONITORING_HEALTH_PATH,
  MONITORING_OTLP_ENDPOINT,
  DEFAULT_LOG_SCOPE_REGEX,
} from '../../plugins/monitoring-stack/index';

const inputSchema = z.object({
  dir: z
    .string()
    .optional()
    .describe('Target directory for the stack files — set this to the canonical host path (prod: ~/projects/dorinda-grafana). Default <workspace>/monitoring.'),
  project_name: z.string().default('dorinda-grafana').describe('Compose project name (convention: maps to the public domain, e.g. grafana.dorinda.ai)'),
  public_host: z
    .string()
    .optional()
    .describe('Front grafana via a Traefik proxy at this host (e.g. grafana.dorinda.ai)'),
  ui_port: z.number().int().positive().default(3200).describe('Host port grafana is published on'),
  network: z
    .string()
    .default('observability')
    .describe('Shared external network (apps + langfuse-web) the collector joins'),
  proxy_network: z.string().default('proxy').describe('External Traefik network'),
  alert_email: z.string().email().default('ops@forge.local').describe('Alert contact-point email'),
  log_scope_regex: z
    .string()
    .default(DEFAULT_LOG_SCOPE_REGEX)
    .describe('promtail keep-regex over container names (forge stacks + edge by default)'),
  langfuse_otlp_b64: z
    .string()
    .optional()
    .describe('base64("pk:sk") of the C37 Langfuse key pair — the collector trace auth. Preserved if already in the env file.'),
  smtp_host: z.string().optional().describe('SMTP host:port for Grafana alert email (optional)'),
  smtp_user: z.string().optional(),
  smtp_password: z.string().optional(),
  smtp_from: z.string().optional(),
  env_file: z.string().default('.env').describe('Env filename inside the stack dir (compose --env-file)'),
  health_url: z.string().url().optional().describe('Override the health-probe URL (default derived from host/port)'),
  context: z.string().optional().describe('docker --context for a remote daemon'),
  skip_deploy: z.boolean().default(false).describe('Generate files only; do not pull/up (dry provision)'),
  regenerate_secrets: z
    .boolean()
    .default(false)
    .describe('Force NEW secrets even if an env file exists — rotates the Grafana admin password'),
  health_timeout_ms: z.number().int().positive().default(240_000).describe('How long to wait for grafana to serve'),
});

type Input = z.infer<typeof inputSchema>;

// Tolerant `docker network create` — succeeds if the network already exists.
async function ensureNetwork(ctxArgs: string[], name: string): Promise<void> {
  const r = await run('docker', [...ctxArgs, 'network', 'create', name], { timeoutMs: 30_000 });
  if (r.code !== 0 && !/already exists/i.test(r.combined)) {
    throw new Error(`docker network create ${name} failed: ${r.tail}`);
  }
}

async function waitForGrafana(
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

function parseEnvValue(text: string, key: string): string | undefined {
  for (const line of text.split('\n')) {
    const m = line.match(new RegExp(`^${key}=(.*)$`));
    if (m) return m[1]?.trim();
  }
  return undefined;
}

// ProvisionMonitoring — GENERATE the canonical metrics+logging environment (otel-collector fan-out,
// Loki, promtail, Prometheus, Grafana) + DEPLOY it, then register the MonitoringStack resource.
// The exact sibling of ProvisionObservability (C37): forge owns the stack definition; a consumer
// host gets a green Grafana pane in one command. Every fix discovered standing the box stack up is
// baked into the plugin (Loki 3.x delete_request_store, memory caps, scoped promtail, collector
// fan-out so producers never export straight to Langfuse).
//
// Secrets are PRESERVED by default (same contract as C37): an existing env file is reused
// untouched — incl. LANGFUSE_OTLP_B64 — so re-provisioning is a safe, diff-clean no-op.
export const provisionMonitoring: Capability<Input, MonitoringStack> = {
  name: 'ProvisionMonitoring',
  slug: 'provision-monitoring',
  description:
    'Generate the canonical metrics+logging stack (collector, Loki, promtail, Prometheus, Grafana), deploy it, wait for health, and register the MonitoringStack resource.',
  inputSchema,
  resourceType: 'MonitoringStack',
  events: ['MonitoringConfigured'],
  longRunning: true,
  requiresDocker: true,
  plane: 'control',
  async execute(input, ctx) {
    const dir = input.dir ?? join(workspaceDir(), 'monitoring');
    const ctxArgs = input.context ? ['--context', input.context] : [];

    await mkdir(dir, { recursive: true });

    // 1. Compose (deterministic, secret-free, self-contained) + committable .env.example.
    const compose = generateMonitoringCompose({
      projectName: input.project_name,
      publicHost: input.public_host,
      uiPort: input.ui_port,
      network: input.network,
      proxyNetwork: input.proxy_network,
      alertEmail: input.alert_email,
      logScopeRegex: input.log_scope_regex,
    });
    await writeFile(join(dir, 'compose.yaml'), compose, 'utf8');
    await writeFile(join(dir, '.env.example'), renderMonitoringEnvExample(), 'utf8');

    // 2. Secrets: preserve an existing env file (default), else generate + write fresh (mode 0600).
    const envPath = join(dir, input.env_file);
    const existingEnv = await readFile(envPath, 'utf8').catch(() => null);
    let secretsMode: 'preserved' | 'generated';
    if (existingEnv && !input.regenerate_secrets) {
      secretsMode = 'preserved';
      if (input.langfuse_otlp_b64 && !parseEnvValue(existingEnv, 'LANGFUSE_OTLP_B64')) {
        await writeFile(envPath, `${existingEnv}\nLANGFUSE_OTLP_B64=${input.langfuse_otlp_b64}\n`, { mode: 0o600 });
      }
    } else {
      secretsMode = 'generated';
      const env = renderMonitoringEnv(generateMonitoringSecrets(), {
        uiPort: input.ui_port,
        langfuseOtlpB64: input.langfuse_otlp_b64,
        smtp: {
          host: input.smtp_host,
          user: input.smtp_user,
          password: input.smtp_password,
          from: input.smtp_from,
        },
      });
      await writeFile(envPath, env, { mode: 0o600 });
    }

    // 3. Deploy (unless skip_deploy): ensure external networks, pull, whole-stack up -d.
    let deployed = false;
    if (!input.skip_deploy) {
      await ensureNetwork(ctxArgs, input.network);
      await ensureNetwork(ctxArgs, input.proxy_network);

      const composeArgs = [...ctxArgs, 'compose', '-f', 'compose.yaml', '--env-file', input.env_file];
      await run('docker', [...composeArgs, 'pull'], { cwd: dir, timeoutMs: 10 * 60_000 });
      // --force-recreate: compose does NOT hash inline `configs.content` into the service
      // fingerprint, so a re-provision with changed dashboards/rules would silently keep the
      // old containers serving stale configs (observed live 2026-07-26). Volumes persist.
      const up = await run('docker', [...composeArgs, 'up', '-d', '--force-recreate'], { cwd: dir, timeoutMs: 10 * 60_000 });
      if (up.code !== 0) throw new Error(`docker compose up failed:\n${up.tail}`);
      deployed = true;
    }

    // 4. Wait for grafana to serve.
    const healthUrl =
      input.health_url ??
      (input.public_host
        ? `https://${input.public_host}${MONITORING_HEALTH_PATH}`
        : `http://localhost:${input.ui_port}${MONITORING_HEALTH_PATH}`);
    let reachable = false;
    if (deployed) {
      const w = await waitForGrafana(healthUrl, input.health_timeout_ms);
      reachable = w.ready;
    }

    // 5. Register the MonitoringStack (upsert — at most one). Producers export to the INTERNAL
    //    OTLP endpoint on the shared networks. Never store secrets on the resource.
    const grafanaUrl = input.public_host ? `https://${input.public_host}` : `http://localhost:${input.ui_port}`;
    const status: MonitoringStack['status'] = deployed && !reachable ? 'unreachable' : 'configured';
    const checked_at = nowIso();
    const existing = (await ctx.store.listResources({ type: 'MonitoringStack' }))[0] as
      | MonitoringStack
      | undefined;

    const fields = {
      otlp_endpoint: MONITORING_OTLP_ENDPOINT,
      grafana_url: grafanaUrl,
      status,
      checked_at,
      public_host: input.public_host,
      stack_dir: dir,
    };
    const resource: MonitoringStack = existing
      ? { ...existing, ...fields, updated_at: nowIso() }
      : { ...baseResource('MonitoringStack'), type: 'MonitoringStack', ...fields };
    await ctx.store.saveResource(resource);

    await ctx.emit({
      type: 'MonitoringConfigured',
      resource_type: 'MonitoringStack',
      resource_id: resource.id,
      data: {
        otlp_endpoint: MONITORING_OTLP_ENDPOINT,
        grafana_url: grafanaUrl,
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
