// The standard health / telemetry contract (C6). The platform OWNS the shape, the
// check-aggregation rollup, and the readiness → HTTP-code convention; the APP owns
// its route (framework-native) and supplies its service name + which checks mean
// "ready". This module is what `forge inspect health` uses to recognize and render
// an app's health payload, and it is the canonical definition the reference handler
// (scaffolded into new apps) mirrors. Pure + framework-agnostic — no I/O here.

import { z } from 'zod';

// Overall health status. `ok` = ready; `degraded` = live but a NON-required check is
// down (still 200, flagged); `unavailable` = a REQUIRED check is down (not ready).
export type HealthStatus = 'ok' | 'degraded' | 'unavailable';

// A single check is binary: it passed (`ok`) or it did not (`unavailable`).
export type CheckStatus = 'ok' | 'unavailable';

export interface HealthCheck {
  name: string;
  status: CheckStatus;
  detail?: string;
}

// The standard health response body. `checks: []` is valid — a liveness-only probe.
export interface HealthResponse {
  status: HealthStatus;
  service: string;
  // ISO-8601 timestamp the probe was evaluated.
  time: string;
  checks: HealthCheck[];
}

// A resolved check result the app feeds the aggregator (the app runs its own opaque
// thunks — e.g. a DB `SELECT 1` — and reports each one's outcome here). `required`
// defaults to true: a required check that is `unavailable` makes the app not-ready
// (503); a non-required one that fails only degrades it (200, flagged).
export interface CheckResult {
  name: string;
  status: CheckStatus;
  required?: boolean;
  detail?: string;
}

// Zod schema recognizing the standard response. Kept permissive on `time` (any
// string) so a conforming app is never rejected for a clock-format nicety.
export const healthCheckSchema = z.object({
  name: z.string(),
  status: z.enum(['ok', 'unavailable']),
  detail: z.string().optional(),
});

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'unavailable']),
  service: z.string(),
  time: z.string(),
  checks: z.array(healthCheckSchema),
});

// The readiness → HTTP-code convention. 503 ONLY when the overall status is
// `unavailable` (a required check failed); `ok` and `degraded` are both 200. Every
// prober (dev/prod compose healthchecks, the C7 Traefik loadbalancer.healthcheck)
// already treats non-2xx as unhealthy, so 503-on-not-ready needs no prober change.
export function httpStatusFor(status: HealthStatus): 200 | 503 {
  return status === 'unavailable' ? 503 : 200;
}

// The platform-owned rollup: reduce a list of resolved check results to the standard
// response body + the HTTP code the convention prescribes.
//   - any REQUIRED check unavailable      -> 'unavailable' (503)
//   - else any (non-required) unavailable -> 'degraded'    (200, flagged)
//   - else (all pass, or no checks)       -> 'ok'          (200)
export function aggregateHealth(
  service: string,
  results: CheckResult[],
  now: Date = new Date(),
): { body: HealthResponse; httpStatus: 200 | 503 } {
  const checks: HealthCheck[] = results.map((r) => ({
    name: r.name,
    status: r.status,
    ...(r.detail ? { detail: r.detail } : {}),
  }));
  const requiredFailed = results.some((r) => r.status === 'unavailable' && (r.required ?? true));
  const anyFailed = results.some((r) => r.status === 'unavailable');
  const status: HealthStatus = requiredFailed ? 'unavailable' : anyFailed ? 'degraded' : 'ok';
  return { body: { status, service, time: now.toISOString(), checks }, httpStatus: httpStatusFor(status) };
}

// Recognize/validate an arbitrary fetched payload as the standard schema. Returns the
// parsed value or a one-line reason it does not conform (for `forge inspect health` to
// surface a non-conforming endpoint without guessing).
export function parseHealthResponse(
  input: unknown,
): { ok: true; value: HealthResponse } | { ok: false; error: string } {
  const parsed = healthResponseSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.join('.') || '(root)';
  return { ok: false, error: issue ? `${where}: ${issue.message}` : 'not a standard health response' };
}
