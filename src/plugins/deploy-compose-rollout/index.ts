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

// ---------------------------------------------------------------------------
// P14 — drift detection: a deploy must never silently run a stale image.
//
// After the reconcile + roll, the RUNNING image of every digest-pinned service MUST be
// the one the compose pin resolves to. A mismatch means either a required pull was
// skipped/failed (the pinned image isn't on the target) or a `restart: unless-stopped`
// container was left on the old image — the "requested pin X, running Y" trap that cost
// two no-op prod deploys. We compare LOCALLY-RESOLVED image IDs (config digests): exact,
// no registry round-trip, and a pin that resolves to nothing locally is itself the tell
// that a required pull failed. postgres/redis ship on moving tags (not a digest pin) and
// keep reconciling as before — the gate governs the digest-pinned services (web + the
// data-plane sidecar).
// ---------------------------------------------------------------------------

// R1 image pins are `<ref>@sha256:<64 hex>`.
const DIGEST_PIN_RE = /@sha256:[0-9a-f]{64}$/;
export function isDigestPinned(ref: string): boolean {
  return DIGEST_PIN_RE.test(ref.trim());
}

// Parse `docker compose config --format json` → { service: imageRef }. Tolerant of a
// missing/oddly-shaped payload (returns {} so the caller degrades to a loud warning
// rather than a crash).
export function parseComposeImages(configJson: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const cfg = JSON.parse(configJson) as { services?: Record<string, { image?: unknown }> };
    for (const [name, def] of Object.entries(cfg.services ?? {})) {
      if (def && typeof def.image === 'string' && def.image) out[name] = def.image;
    }
  } catch {
    /* not JSON (older compose / a config error) → empty map; the caller warns */
  }
  return out;
}

// The image identity compared per service: the local image ID the PINNED compose ref
// resolves to, vs the local image ID the RUNNING container is on.
export interface ServiceImageState {
  service: string;
  pinnedRef: string; // compose-declared image (digest-pinned)
  pinnedImageId: string; // `docker image inspect <ref> --format {{.Id}}` ('' if absent locally)
  runningImageId: string; // running container's .Image ('' if not running)
}

export interface Drift {
  service: string;
  pinnedRef: string;
  running: string; // short running image id, or 'absent'
  reason: string;
}

const shortId = (id: string): string => id.replace(/^sha256:/, '').slice(0, 12);

// Which digest-pinned services are NOT running the image their pin resolves to. An
// empty pinnedImageId means the pinned image isn't on the target at all (a required
// pull failed) — surfaced, never swallowed.
export function detectDrift(states: ServiceImageState[]): Drift[] {
  const drifts: Drift[] = [];
  for (const s of states) {
    if (!s.pinnedImageId) {
      drifts.push({
        service: s.service,
        pinnedRef: s.pinnedRef,
        running: s.runningImageId ? shortId(s.runningImageId) : 'absent',
        reason: 'pinned image not present on the target (a required pull failed — is the registry authenticated?)',
      });
    } else if (!s.runningImageId) {
      drifts.push({ service: s.service, pinnedRef: s.pinnedRef, running: 'absent', reason: 'no running container for the pinned service' });
    } else if (s.runningImageId !== s.pinnedImageId) {
      drifts.push({
        service: s.service,
        pinnedRef: s.pinnedRef,
        running: shortId(s.runningImageId),
        reason: `running ${shortId(s.runningImageId)} != pinned ${shortId(s.pinnedImageId)}`,
      });
    }
  }
  return drifts;
}

// One prominent line per drifted service for the failure/warning message.
export function driftReport(drifts: Drift[]): string {
  return drifts.map((d) => `  • ${d.service}: running ${d.running} vs pinned ${d.pinnedRef} — ${d.reason}`).join('\n');
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
  envFile?: string; // --env-file Compose interpolates vars from (e.g. "app/.env.prod"); omit = Compose's default .env auto-read
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
  // Digest-pinned services force-recreated onto their pin because they were drifted
  // (the `restart: unless-stopped` + only-image-changed trap).
  recreated_services: string[];
  log: string[];
}

export async function rollout(opts: RolloutOptions, log: string[] = []): Promise<RolloutResult> {
  const { cwd, composeFile, envFile, service, context, proxyNet, pull, timeoutMs, drainMs } = opts;
  const step = (m: string): void => {
    log.push(m);
  };
  // `--env-file` names the file Compose interpolates the compose vars from (P10). It is
  // a top-level option (before the subcommand), so every compose call — starting with
  // `config`, which fails on an unfilled `${VAR:?}` — resolves from the documented file.
  const envArgs = envFile ? ['--env-file', envFile] : [];
  const compose = (...args: string[]): string[] => dockerArgs(context, ['compose', '-f', composeFile, ...envArgs, ...args]);
  const docker = (...args: string[]): string[] => dockerArgs(context, args);
  const sh = (args: string[], timeout = 5 * 60_000): ReturnType<typeof run> =>
    run('docker', args, { cwd, timeoutMs: timeout });
  const svcIds = async (svc: string): Promise<string[]> => lines((await sh(compose('ps', '-q', svc))).combined);
  const ids = (): Promise<string[]> => svcIds(service);
  // The local image ID a ref resolves to ('' if the image isn't on the target daemon).
  const imageId = async (ref: string): Promise<string> => {
    const r = await sh(docker('image', 'inspect', ref, '--format', '{{.Id}}'), 30_000);
    return r.code === 0 ? (r.combined.trim().split('\n')[0] ?? '').trim() : '';
  };
  const containerImageId = async (id: string): Promise<string> => {
    const r = await sh(docker('inspect', id, '--format', '{{.Image}}'), 30_000);
    return r.code === 0 ? (r.combined.trim().split('\n')[0] ?? '').trim() : '';
  };

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
  step(envFile ? `env-file: ${envFile}` : 'env-file: none (Compose default .env only)');

  // 0a. The compose-declared (pinned) image per service — the source of truth the drift
  // gate compares the running stack against. The gate governs the DIGEST-pinned services
  // (web + the data-plane sidecar); postgres/redis ride moving tags and reconcile as before.
  const pinnedImages = parseComposeImages((await sh(compose('config', '--format', 'json'))).combined);
  const pinnedServices = services.filter((s) => isDigestPinned(pinnedImages[s] ?? ''));
  const stateOf = async (svc: string): Promise<ServiceImageState> => {
    const ref = pinnedImages[svc] ?? '';
    const running = (await svcIds(svc))[0] ?? '';
    return {
      service: svc,
      pinnedRef: ref,
      pinnedImageId: ref ? await imageId(ref) : '',
      runningImageId: running ? await containerImageId(running) : '',
    };
  };

  // 1. Pull images — attempted, but NO LONGER quietly non-fatal: a failed pull is tracked
  // and surfaced by the drift gate (a locked keychain over SSH used to leave the OLD image
  // running while deploy reported success — P14). Cached images still deploy IF they are the
  // pinned ones; if they aren't, the gate fails the deploy loudly.
  let pulled = false;
  if (pull) {
    pulled = (await sh(compose('pull'), 10 * 60_000)).code === 0;
    step(pulled ? '✓ pulled images' : '⚠ image pull FAILED — will verify against pinned digests before reporting success');
  }

  // 2. Reconcile the non-public services in place (postgres / sidecars).
  const others = nonTargetServices(services, service);
  if (others.length) {
    const up = await sh(compose('up', '-d', '--no-deps', ...others));
    if (up.code !== 0) throw new Error(`reconcile of [${others.join(', ')}] failed: ${up.tail.join(' ')}`);
    step(`✓ reconciled ${others.join(', ')}`);
  }

  // 2a. RECREATE-ON-PIN-CHANGE for the reconciled digest-pinned sidecars (e.g. data-plane):
  // if one is still running an image other than its pin — the `restart: unless-stopped` +
  // only-image-changed trap where `compose up` leaves the old container in place — force-
  // recreate it ONTO the pin (its pinned image is present locally). A sidecar blip is fine;
  // it is not the public tier, and this only fires when the pin actually moved.
  const recreated: string[] = [];
  for (const svc of others.filter((s) => pinnedServices.includes(s))) {
    const st = await stateOf(svc);
    if (st.pinnedImageId && st.runningImageId && st.runningImageId !== st.pinnedImageId) {
      const rec = await sh(compose('up', '-d', '--no-deps', '--force-recreate', svc));
      if (rec.code !== 0) throw new Error(`force-recreate of drifted service ${svc} onto its pin failed: ${rec.tail.join(' ')}`);
      recreated.push(svc);
      step(`↻ recreated ${svc} onto its pinned image (was running a stale image)`);
    }
  }

  // 3. Roll the public service START-FIRST.
  const before = await ids();
  let result: RolloutResult;

  if (before.length === 0) {
    const up = await sh(compose('up', '-d', service));
    if (up.code !== 0) throw new Error(`initial start of ${service} failed: ${up.tail.join(' ')}`);
    step(`✓ ${service} started (first deploy — nothing to roll)`);
    result = { strategy: 'first-deploy', reconciled_services: others, old_container_ids: [], new_container_ids: await ids(), pulled, recreated_services: recreated, log };
  } else {
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

    result = { strategy: 'rolled', reconciled_services: others, old_container_ids: before, new_container_ids: fresh, pulled, recreated_services: recreated, log };
  }

  // 4. DRIFT GATE (P14) — the running image of every digest-pinned service MUST be the
  // one its pin resolves to, or we do NOT report success. Catches a skipped/failed pull
  // (pinned image absent) or any container left on a stale image after the reconcile/roll.
  if (pinnedServices.length) {
    const drifts = detectDrift(await Promise.all(pinnedServices.map(stateOf)));
    if (drifts.length) {
      const why = pull && !pulled ? ' — the image pull failed (is the registry authenticated on the target?)' : '';
      throw new Error(`deploy drift: the running stack does NOT match the pinned images${why}:\n${driftReport(drifts)}`);
    }
    step(
      pull && !pulled
        ? `⚠ pull failed but ${pinnedServices.join(', ')} are already on their pinned images — proceeding (no drift)`
        : `✓ no drift — ${pinnedServices.join(', ')} running their pinned images`,
    );
  } else {
    step('⚠ no digest-pinned services found in compose — drift was NOT verified');
  }

  return result;
}
