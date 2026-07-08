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
  // Present when unreachable.
  error?: string;
}

// Probe a health URL. Never throws: an unreachable/timed-out endpoint returns
// `{ reachable:false, error }`; a reachable-but-malformed one returns
// `{ reachable:true, conforms:false, parseError }`.
export async function probeHealth(url: string, timeoutMs = HEALTH_TIMEOUT_MS): Promise<HealthProbeResult> {
  try {
    const res = await fetch(url, {
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const parsed = parseHealthResponse(json);
    if (parsed.ok) {
      return { url, reachable: true, httpStatus: res.status, conforms: true, health: parsed.value };
    }
    return { url, reachable: true, httpStatus: res.status, conforms: false, parseError: parsed.error, bodyPreview: text.slice(0, 200) };
  } catch (e) {
    return { url, reachable: false, error: String((e as Error)?.message ?? e) };
  }
}
