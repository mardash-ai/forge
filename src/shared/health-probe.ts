// Live C6 health probing — the shared way the platform reaches a Builder app's
// health endpoint and reads the standard health schema. Used by `forge inspect
// health` (the CLI/agent view) AND the C15 status page (the public dashboard), so
// there is ONE definition of "where the app is" and "what its health says".
//
// Pure of any capability/store coupling: given a base URL + readiness path it does a
// no-cache fetch, parses the standard schema, and returns a structured result that
// NEVER throws (a wedged/unreachable app degrades to `reachable:false`).

import { parseHealthResponse, type HealthResponse } from './health';

// Default probe timeout — an inspection or status render must never hang on a wedged app.
export const HEALTH_TIMEOUT_MS = 5_000;

// Where the platform reaches a Builder app's HTTP server to probe health — the SAME
// env convention the scheduler uses to call an app back (host.docker.internal in dev;
// FORGE_APP_CALLBACK_HOST/PORT on a prod compose network, e.g. host=web port=3000).
// Port falls back to the provisioned web host port, then the manifest port, then 3000.
export function resolveAppBase(manifest: Record<string, unknown>): string {
  const host = process.env.FORGE_APP_CALLBACK_HOST ?? 'host.docker.internal';
  const envPort = process.env.FORGE_APP_CALLBACK_PORT;
  const webPort = (manifest.infra as { ports?: { web?: unknown } } | undefined)?.ports?.web;
  const manifestPort = typeof webPort === 'number' ? webPort : typeof manifest.port === 'number' ? manifest.port : 3000;
  return `http://${host}:${envPort ?? manifestPort}`;
}

// The readiness path the whole platform points at (dev/prod compose healthchecks, the
// C7 Traefik loadbalancer.healthcheck): an explicit env override (prod sidecar, which
// has no manifest), else the manifest's production.readiness_path, else /api/health.
export function resolveReadinessPath(manifest: Record<string, unknown>): string {
  const fromEnv = process.env.FORGE_READINESS_PATH;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const production = (manifest.production ?? {}) as { readiness_path?: string };
  return production.readiness_path ?? '/api/health';
}

// ---------------------------------------------------------------------------
// Generic HTTP probe — the ONE never-throws fetch primitive the platform uses to
// reach a deployed app read-only. `probeHealth` (C6/C15) and the C14 contract
// checks (`shared/contract-checks.ts`) both build on this, so there is a single
// definition of "make a safe outbound request and report what came back."
// ---------------------------------------------------------------------------

export interface HttpProbeResult {
  reachable: boolean;
  status?: number;
  // The `Location` header, when present (a redirect target). Captured so a caller
  // using `redirect:'manual'` can assert WHERE a gate redirected to.
  location?: string;
  contentType?: string;
  body?: string;
  // Present only when unreachable/timed-out.
  error?: string;
}

// Make one read-only HTTP request that NEVER throws. `redirect:'manual'` (the
// default here) surfaces a 3xx as-is (status + Location) rather than following it,
// so gate assertions can see the redirect; pass `redirect:'follow'` to chase it.
export async function httpProbe(
  url: string,
  opts: { method?: string; timeoutMs?: number; redirect?: 'follow' | 'manual'; headers?: Record<string, string> } = {},
): Promise<HttpProbeResult> {
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      redirect: opts.redirect ?? 'manual',
      headers: opts.headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? HEALTH_TIMEOUT_MS),
    });
    const body = await res.text();
    return {
      reachable: true,
      status: res.status,
      location: res.headers.get('location') ?? undefined,
      contentType: res.headers.get('content-type') ?? undefined,
      body,
    };
  } catch (e) {
    return { reachable: false, error: String((e as Error)?.message ?? e) };
  }
}

export interface HealthProbeResult {
  url: string;
  reachable: boolean;
  httpStatus?: number;
  // Present when reachable AND the body conforms to the standard schema.
  conforms?: boolean;
  health?: HealthResponse;
  // Present when reachable but the body does NOT conform.
  parseError?: string;
  bodyPreview?: string;
  // The `Location` header when the endpoint answered with a redirect (only
  // observable under `redirect:'manual'`) — lets a caller detect a health path
  // that is (wrongly) behind an auth gate instead of public.
  redirectLocation?: string;
  // Present when unreachable.
  error?: string;
}

// Probe a health URL. Never throws: an unreachable/timed-out endpoint returns
// `{ reachable:false, error }`; a reachable-but-malformed one returns
// `{ reachable:true, conforms:false, parseError }`. Follows redirects by default
// (the C6/C15 behavior); pass `redirect:'manual'` to keep a 3xx visible (C14 uses
// this to assert `/api/health` is PUBLIC, not gated behind a login redirect).
export async function probeHealth(
  url: string,
  timeoutMs = HEALTH_TIMEOUT_MS,
  opts: { redirect?: 'follow' | 'manual' } = {},
): Promise<HealthProbeResult> {
  const res = await httpProbe(url, {
    timeoutMs,
    redirect: opts.redirect ?? 'follow',
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
  });
  if (!res.reachable) return { url, reachable: false, error: res.error };
  const text = res.body ?? '';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = parseHealthResponse(json);
  if (parsed.ok) {
    return { url, reachable: true, httpStatus: res.status, conforms: true, health: parsed.value, redirectLocation: res.location };
  }
  return { url, reachable: true, httpStatus: res.status, conforms: false, parseError: parsed.error, bodyPreview: text.slice(0, 200), redirectLocation: res.location };
}

// ---------------------------------------------------------------------------
// Readiness wait — bridge the post-deploy WARM-UP window before asserting health.
//
// A start-first roll (C7) returns as soon as the NEW replica reports container-healthy,
// but the public endpoint can still be a beat behind (the reverse proxy re-pointing at the
// fresh replica, the app finishing its own warm-up). A post-deploy `forge verify` that
// probes in that instant sees a transient miss — an unreachable dial, a proxy 502, a
// half-booted non-conforming body — and reports a FALSE red, even though a manual re-run a
// few seconds later passes (the exact C19-deploy flake). This gate polls the health URL with
// a bounded, backed-off retry until it answers a clean C6 200 (reachable + conforming — the
// SAME bar `checkHealth` passes on, so a legitimately degraded-but-up app is still "ready"),
// or the budget elapses. It NEVER throws and NEVER turns a real failure green: if the app
// never warms up, the wait simply ends and the normal `checkHealth` assertion runs and fails.
// ---------------------------------------------------------------------------

export const READINESS_INTERVAL_MS = 2_000; // base poll interval between readiness attempts
const READINESS_INTERVAL_CAP_MS = 5_000; // backoff never waits longer than this between polls

export interface ReadinessWaitOptions {
  timeoutMs: number; // total budget to wait for readiness (<= 0 disables the wait entirely)
  intervalMs?: number; // base interval between polls (backs off up to a cap)
  probeTimeoutMs?: number; // per-probe timeout
  redirect?: 'follow' | 'manual';
  now?: () => number; // injectable clock (tests)
  sleep?: (ms: number) => Promise<void>; // injectable sleep (tests)
  onAttempt?: (attempt: number, result: HealthProbeResult) => void;
}

export interface ReadinessResult {
  ready: boolean; // did the endpoint reach a clean C6 200 within the budget?
  attempts: number;
  waitedMs: number;
  last: HealthProbeResult; // the final probe (what `checkHealth` will then see)
}

// A clean, warm C6 200 — the readiness bar. Matches `checkHealth`'s pass condition
// (200 + conforming schema), so this waits out exactly the transient states (unreachable,
// non-200, non-conforming boot output) and stops the instant the app is genuinely serving.
function isReady(p: HealthProbeResult): boolean {
  return p.reachable === true && p.httpStatus === 200 && p.conforms === true;
}

const readinessDelay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Poll `url` until it answers a clean C6 200 or the budget elapses. Returns the outcome +
// the last probe (never throws). A non-positive budget is a no-op (one probe, no waiting) so
// callers can leave the gate off by default and opt in with a real budget (the release path).
export async function waitForHealthReady(url: string, opts: ReadinessWaitOptions): Promise<ReadinessResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? readinessDelay;
  const base = Math.max(1, opts.intervalMs ?? READINESS_INTERVAL_MS);
  const start = now();
  const deadline = start + Math.max(0, opts.timeoutMs);
  let attempts = 0;
  let interval = base;
  for (;;) {
    attempts++;
    const probe = await probeHealth(url, opts.probeTimeoutMs ?? HEALTH_TIMEOUT_MS, { redirect: opts.redirect ?? 'manual' });
    opts.onAttempt?.(attempts, probe);
    if (isReady(probe)) return { ready: true, attempts, waitedMs: now() - start, last: probe };
    // Out of budget (or the gate is disabled with timeoutMs<=0): stop and hand the last probe back.
    if (now() >= deadline) return { ready: false, attempts, waitedMs: now() - start, last: probe };
    // Don't overrun the deadline on the final sleep.
    const remaining = deadline - now();
    await sleep(Math.min(interval, Math.max(0, remaining)));
    interval = Math.min(Math.round(interval * 1.5), READINESS_INTERVAL_CAP_MS);
  }
}
