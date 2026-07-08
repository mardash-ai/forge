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
