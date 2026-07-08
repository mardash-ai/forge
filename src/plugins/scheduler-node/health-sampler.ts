import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../../storage/store';
import type { Application } from '../../resources/types';
import { resolveAppBase, resolveReadinessPath, probeHealth } from '../../shared/health-probe';
import { computeStatus } from '../../shared/status';
import { uptimeStore } from '../../storage/uptime-store';
import type { HealthSnapshot } from '../../shared/uptime';
import { parseDuration } from './schedule';

// C15 Phase 2 — the health SAMPLER: a platform-internal periodic probe run by the
// C2 scheduler-node Implementation (the same always-on, non-overlapping, unref'd
// ticker as the job scheduler). Each tick it does a CHEAP, read-only GET to every
// app's C6 health — reusing the SAME `probeHealth` + `computeStatus` core the live
// `/status` page uses (no second health definition, no write to the app) — and
// records a HealthSnapshot into the durable uptime store, which the status route
// renders as a per-component uptime timeline.
//
// It is NOT a ScheduledJob Resource (those call BACK into an app's cron endpoint);
// it is platform-internal periodic work, so it emits no per-tick fact — the bounded
// uptime store IS its durable record (a JobRan event every few minutes would flood
// the shared event log).
//
// OPT-IN + SAFE BY DEFAULT: sampling runs only when `FORGE_STATUS_SAMPLE` is set on
// the plane. When it is off, `startHealthSampler` is a no-op and every app still gets
// the Phase-1 live page with an empty history ("collecting…").

const DEFAULT_INTERVAL = '5m';
const MIN_INTERVAL_MS = 30_000; // never sample more often than every 30s (cheap + safe)

function envFlag(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

// Whether this plane should sample (FORGE_STATUS_SAMPLE truthy).
export function isSamplingEnabled(): boolean {
  return envFlag(process.env.FORGE_STATUS_SAMPLE);
}

// The sample cadence in ms: FORGE_STATUS_SAMPLE_INTERVAL (e.g. "1m", "5m"), default
// 5m, floored at MIN_INTERVAL_MS. Invalid values fall back to the default.
export function sampleIntervalMs(): number {
  const raw = process.env.FORGE_STATUS_SAMPLE_INTERVAL?.trim();
  let ms: number;
  try {
    ms = parseDuration(raw && raw.length ? raw : DEFAULT_INTERVAL);
  } catch {
    ms = parseDuration(DEFAULT_INTERVAL);
  }
  return Math.max(ms, MIN_INTERVAL_MS);
}

// Best-effort manifest read (dev has the app repo; the prod sidecar relies on env and
// simply gets `{}`). Only used to resolve the health base/path — exactly as the route.
async function loadManifest(repoPath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path.join(repoPath, 'forge.app.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Sample ONE app: probe its C6 health, compute the status, record a snapshot. Never
// throws (an unreachable app records a snapshot with the web component down — that IS
// the outage the timeline should show). Exported for tests.
export async function sampleApp(
  store: Store,
  app: Application,
  opts: { planeLabel: string; now?: Date },
): Promise<HealthSnapshot> {
  const now = opts.now ?? new Date();
  const manifest = await loadManifest(app.repo_path);
  const url = `${resolveAppBase(manifest)}${resolveReadinessPath(manifest)}`;
  const probe = await probeHealth(url);
  const report = computeStatus(probe, { appName: app.name, planeLabel: opts.planeLabel, now });
  const snapshot: HealthSnapshot = {
    at: now.toISOString(),
    overall: report.overall,
    components: report.components.map((c) => ({ name: c.name, state: c.state })),
  };
  await uptimeStore.record(app.id, snapshot);
  return snapshot;
}

// One sampler pass: sample every known Application. A single bad app never aborts the
// pass. Exported for tests.
export async function sampleAll(store: Store, opts: { planeLabel: string; now?: Date }): Promise<void> {
  const apps = (await store.listResources({ type: 'Application' })) as Application[];
  for (const app of apps) {
    try {
      await sampleApp(store, app, opts);
    } catch {
      // a wedged app must never crash the sampler
    }
  }
}

// Start the background sampler (opt-in). Returns a stop function. Ticks don't overlap;
// the timer is unref'd so it never keeps the process alive. A no-op (returns a no-op
// stop fn) when FORGE_STATUS_SAMPLE is not set.
export function startHealthSampler(
  store: Store,
  opts: { planeLabel: string; intervalMs?: number } = { planeLabel: 'Forge platform' },
): () => void {
  if (!isSamplingEnabled()) return () => {};
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await sampleAll(store, { planeLabel: opts.planeLabel });
    } catch {
      /* a bad pass must never crash the plane */
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, opts.intervalMs ?? sampleIntervalMs());
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
