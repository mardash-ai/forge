import { run } from '../../shared/exec';

// Plugin: deploy-compose-rollout.
//
// The zero-downtime deploy Implementation used by the Deploy Capability. It rolls
// a reverse-proxy-fronted (Traefik) production stack START-FIRST: bring up a new
// replica of the public service alongside the old, wait until it is healthy, drain
// the old out of the proxy, then remove it — so there is never a moment with zero
// healthy backends (no 502 window). If the new replica never becomes healthy it is
// discarded and the old one keeps serving (a safe, automatic rollback).
//
// Ported from the hand-authored forge-os `deploy/rollout.sh` (proven live: a probe
// across the roll showed the 1–3s of 502s from a plain `compose up -d` eliminated).
// Non-public services (postgres, sidecars) reconcile in place with `up -d --no-deps`.

export const IMPLEMENTATION = 'deploy-compose-rollout';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested — no Docker required).
// ---------------------------------------------------------------------------

// Prefix docker args with `--context <ctx>` to target a remote daemon; empty = local.
export function dockerArgs(context: string | undefined, args: string[]): string[] {
  return context ? ['--context', context, ...args] : [...args];
}

// The container ids present after scale-up that weren't there before = the new replica(s).
export function newContainers(before: string[], after: string[]): string[] {
  const had = new Set(before);
  return after.filter((id) => !had.has(id));
}

// Every service except the one rolled start-first (the rest reconcile in place).
export function nonTargetServices(all: string[], target: string): string[] {
  return all.filter((s) => s !== target);
}

// Health status from `docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'`.
// "none" = the container declares no healthcheck (treat as ready).
export function healthOf(raw: string): string {
  return raw.trim() || 'unknown';
}

// Split `compose ps -q` / `config --services` output into a clean list.
export function lines(s: string): string[] {
  return s.split('\n').map((l) => l.trim()).filter(Boolean);
}

const short = (id: string): string => id.slice(0, 12);
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The roll (executes Docker; logs each step into the caller-owned `log` array so
// a partial log survives a thrown failure).
// ---------------------------------------------------------------------------

export interface RolloutOptions {
  cwd: string; // project root where the compose file + relative bind-mounts live
  composeFile: string; // e.g. "compose.prod.yaml"
  service: string; // the public service to roll start-first (e.g. "web")
  context?: string; // docker context of the target daemon; undefined = local
  proxyNet: string; // reverse-proxy network to drain the old replica out of (e.g. "proxy")
  pull: boolean; // pull images first (non-fatal)
  timeoutMs: number; // how long to wait for the new replica to become healthy
  drainMs: number; // how long to let in-flight requests settle before removing the old
}

export interface RolloutResult {
  strategy: 'first-deploy' | 'rolled';
  reconciled_services: string[];
  old_container_ids: string[];
  new_container_ids: string[];
  pulled: boolean;
  log: string[];
}

export async function rollout(opts: RolloutOptions, log: string[] = []): Promise<RolloutResult> {
  const { cwd, composeFile, service, context, proxyNet, pull, timeoutMs, drainMs } = opts;
  const step = (m: string): void => {
    log.push(m);
  };
  const compose = (...args: string[]): string[] => dockerArgs(context, ['compose', '-f', composeFile, ...args]);
  const docker = (...args: string[]): string[] => dockerArgs(context, args);
  const sh = (args: string[], timeout = 5 * 60_000): ReturnType<typeof run> =>
    run('docker', args, { cwd, timeoutMs: timeout });
  const ids = async (): Promise<string[]> => lines((await sh(compose('ps', '-q', service))).combined);

  // 0. Discover services from the prod compose file (also validates it exists/parses).
  const cfg = await sh(compose('config', '--services'));
  if (cfg.code !== 0) {
    throw new Error(`compose file "${composeFile}" not usable: ${cfg.tail.join(' ') || 'config failed'}`);
  }
  const services = lines(cfg.combined);
  if (!services.includes(service)) {
    throw new Error(`service "${service}" not in ${composeFile} (has: ${services.join(', ') || 'none'})`);
  }
  step(`services: ${services.join(', ')}`);

  // 1. Pull images — NON-FATAL (a Docker-Desktop keychain over SSH can block it; cached images still deploy).
  let pulled = false;
  if (pull) {
    pulled = (await sh(compose('pull'), 10 * 60_000)).code === 0;
    step(pulled ? '✓ pulled images' : '⚠ image pull skipped (non-fatal) — deploying cached images');
  }

  // 2. Reconcile the non-public services in place (postgres / sidecars).
  const others = nonTargetServices(services, service);
  if (others.length) {
    const up = await sh(compose('up', '-d', '--no-deps', ...others));
    if (up.code !== 0) throw new Error(`reconcile of [${others.join(', ')}] failed: ${up.tail.join(' ')}`);
    step(`✓ reconciled ${others.join(', ')}`);
  }

  // 3. Roll the public service START-FIRST.
  const before = await ids();

  if (before.length === 0) {
    const up = await sh(compose('up', '-d', service));
    if (up.code !== 0) throw new Error(`initial start of ${service} failed: ${up.tail.join(' ')}`);
    step(`✓ ${service} started (first deploy — nothing to roll)`);
    return { strategy: 'first-deploy', reconciled_services: others, old_container_ids: [], new_container_ids: await ids(), pulled, log };
  }

  // 3a. Scale up: a new replica alongside the old(s), on the new image/config.
  const scaled = await sh(compose('up', '-d', '--no-deps', '--no-recreate', '--scale', `${service}=${before.length + 1}`, service));
  if (scaled.code !== 0) throw new Error(`scale-up of ${service} failed: ${scaled.tail.join(' ')}`);
  const fresh = newContainers(before, await ids());
  if (fresh.length === 0) throw new Error(`could not identify the new ${service} replica after scale-up`);
  step(`→ started new replica: ${fresh.map(short).join(', ')}`);

  // 3b. Wait for the new replica(s) to become healthy; else discard + roll back.
  const deadline = Date.now() + timeoutMs;
  for (const id of fresh) {
    for (;;) {
      const insp = await sh(docker('inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', id), 30_000);
      const st = healthOf(insp.combined);
      if (st === 'healthy' || st === 'none') {
        step(`✓ ${short(id)} ${st === 'none' ? 'ready (no healthcheck)' : 'healthy'}`);
        break;
      }
      if (Date.now() >= deadline || insp.code !== 0) {
        await sh(docker('rm', '-f', ...fresh), 60_000);
        throw new Error(`new ${service} replica never became healthy (last: ${st}) — discarded it; the old replica keeps serving`);
      }
      await delay(2000);
    }
  }

  // 3c. Drain the old replica(s) out of the proxy, let in-flight settle, then remove.
  for (const id of before) {
    await sh(docker('network', 'disconnect', proxyNet, id), 30_000); // non-fatal if not on that network
  }
  step(`→ drained ${before.map(short).join(', ')} out of ${proxyNet}`);
  if (drainMs > 0) await delay(drainMs);
  for (const id of before) {
    await sh(docker('stop', id), 60_000);
    await sh(docker('rm', id), 30_000);
  }
  step(`✓ removed old replica(s) — ${service} now serving on the new image`);

  return { strategy: 'rolled', reconciled_services: others, old_container_ids: before, new_container_ids: fresh, pulled, log };
}
