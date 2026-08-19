// src/shared/rate-limit.ts
//
// Per-IP and per-account sliding-window rate limiter for the OAuth/auth/MCP public surface.
//
// DEFAULT MODE — log-only / dry-run: over-ceiling requests are COUNTED + LOGGED (route,
// key-class, would-have-throttled) but NOT rejected. Set FORGE_RATE_LIMIT_MODE=enforce to
// actively 429. Both modes are observable; NEVER flip to enforce without observing the dry-run
// logs first to calibrate ceilings against real traffic.
//
// All ceilings are env-configurable with generous defaults safe for production. State is
// in-process (Map), which is correct for the current single-instance deployment.

import type { FastifyRequest } from 'fastify';

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/** Whether rate limiting actively rejects over-ceiling requests (vs. log-only). */
export function isEnforceMode(): boolean {
  return process.env.FORGE_RATE_LIMIT_MODE === 'enforce';
}

// ---------------------------------------------------------------------------
// Sliding-window state
// ---------------------------------------------------------------------------

interface WindowEntry {
  timestamps: number[];
}

const windows = new Map<string, WindowEntry>();

/** Reset ALL sliding-window state. Call in test beforeEach to start clean. */
export function resetRateLimitState(): void {
  windows.clear();
}

export interface RateLimitResult {
  limited: boolean;
  retryAfterSeconds: number;
}

/**
 * Sliding-window rate check for `key` (e.g. `ip:1.2.3.4` or `account:user@example.com`).
 * Records the current moment and returns whether the count in the last `windowMs` exceeds `ceiling`.
 */
export function checkLimit(key: string, windowMs: number, ceiling: number): RateLimitResult {
  const now = Date.now();
  const cutoff = now - windowMs;
  const entry = windows.get(key) ?? { timestamps: [] };
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
  entry.timestamps.push(now);
  windows.set(key, entry);

  const count = entry.timestamps.length;
  const limited = count > ceiling;
  let retryAfterSeconds = 0;
  if (limited) {
    // The slot that frees up earliest is the one at index (count - ceiling - 1)
    const idx = count - ceiling - 1;
    const oldest = entry.timestamps[idx];
    if (oldest !== undefined) {
      retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    } else {
      retryAfterSeconds = 1;
    }
  }
  return { limited, retryAfterSeconds };
}

/** Reset the sliding window for a specific key (e.g. on successful login to clear per-account tracking). */
export function resetLimitKey(key: string): void {
  windows.delete(key);
}

// ---------------------------------------------------------------------------
// Login escalation (per-account failed attempts)
// ---------------------------------------------------------------------------
// Separate from the sliding-window because escalation counts FAILURES ONLY, not all
// login attempts. The backoff grows with the failure count so rotating IPs cannot
// avoid the escalation (it's keyed on the target account email, not the source IP).

interface FailureEntry {
  timestamps: number[];
}

const loginFailures = new Map<string, FailureEntry>();

/** Reset all login failure state. Call in test beforeEach. */
export function resetLoginFailures(): void {
  loginFailures.clear();
}

/** Record a FAILED login attempt for `email`. Only call this on an actual wrong-password result. */
export function recordLoginFailure(email: string): void {
  const now = Date.now();
  const windowMs = _envInt('FORGE_RATE_LIMIT_LOGIN_FAIL_WINDOW_MS', 1_800_000); // 30 min default
  const entry = loginFailures.get(email) ?? { timestamps: [] };
  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);
  entry.timestamps.push(now);
  loginFailures.set(email, entry);
}

/** Clear the login failure record for `email` (call on successful login to remove any backoff). */
export function clearLoginFailures(email: string): void {
  loginFailures.delete(email);
}

/**
 * Returns the seconds until the account can be tried again (0 = no backoff active).
 * Escalates with the failure count:
 *   ≥ 3  failures →  5s   (FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_AFTER / _MS)
 *   ≥ 5  failures → 30s   (FORGE_RATE_LIMIT_LOGIN_BACKOFF_2_AFTER / _MS)
 *   ≥ 10 failures →  5m   (FORGE_RATE_LIMIT_LOGIN_BACKOFF_3_AFTER / _MS)
 * All thresholds and durations are env-overridable (useful in tests to avoid real sleeps).
 */
export function loginBackoffSeconds(email: string): number {
  const entry = loginFailures.get(email);
  if (!entry || entry.timestamps.length === 0) return 0;
  const now = Date.now();
  const windowMs = _envInt('FORGE_RATE_LIMIT_LOGIN_FAIL_WINDOW_MS', 1_800_000);
  const recent = entry.timestamps.filter((t) => now - t < windowMs);
  const count = recent.length;
  if (count === 0) return 0;

  const lastFailed = recent[recent.length - 1] ?? 0;
  const timeSinceLastMs = now - lastFailed;

  const t1 = _envInt('FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_AFTER', 3);
  const d1 = _envInt('FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_MS', 5_000);
  const t2 = _envInt('FORGE_RATE_LIMIT_LOGIN_BACKOFF_2_AFTER', 5);
  const d2 = _envInt('FORGE_RATE_LIMIT_LOGIN_BACKOFF_2_MS', 30_000);
  const t3 = _envInt('FORGE_RATE_LIMIT_LOGIN_BACKOFF_3_AFTER', 10);
  const d3 = _envInt('FORGE_RATE_LIMIT_LOGIN_BACKOFF_3_MS', 300_000);

  let backoffMs = 0;
  if (count >= t3) backoffMs = d3;
  else if (count >= t2) backoffMs = d2;
  else if (count >= t1) backoffMs = d1;

  if (backoffMs > 0 && timeSinceLastMs < backoffMs) {
    return Math.max(1, Math.ceil((backoffMs - timeSinceLastMs) / 1000));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Route-level rate check helper
// ---------------------------------------------------------------------------

export interface RouteRateResult {
  /** true = should reject (enforce mode + over ceiling). false = proceed. */
  should_reject: boolean;
  retry_after: number;
}

/**
 * Check and log a rate limit for a public route endpoint.
 * In log-only mode: logs the event and returns { should_reject: false }.
 * In enforce mode: logs the event and returns { should_reject: true, retry_after }.
 *
 * Usage in a route:
 *   const rl = checkRoute(clientIp(req), 'POST /oauth/register', 'ip', 60_000, 20);
 *   if (rl.should_reject) return reply.status(429).header('Retry-After', String(rl.retry_after)).send(...);
 */
export function checkRoute(
  ipOrAccount: string,
  route: string,
  keyClass: string,
  windowMs: number,
  ceiling: number,
): RouteRateResult {
  const key = `${keyClass}:${ipOrAccount}:${route}`;
  const result = checkLimit(key, windowMs, ceiling);
  if (!result.limited) return { should_reject: false, retry_after: 0 };

  const mode = isEnforceMode() ? 'enforce' : 'dry-run';
  _logRateLimit({
    route,
    keyClass,
    key: ipOrAccount,
    mode,
    retryAfterSeconds: result.retryAfterSeconds,
  });
  return { should_reject: isEnforceMode(), retry_after: result.retryAfterSeconds };
}

// ---------------------------------------------------------------------------
// Per-route config (env-configurable ceilings)
// ---------------------------------------------------------------------------

export const ROUTE_RATE = {
  dcr: (): { windowMs: number; ceiling: number } => ({
    windowMs: 60_000,
    ceiling: _envInt('FORGE_RATE_LIMIT_DCR_PER_IP', 20),
  }),
  token: (): { windowMs: number; ceiling: number } => ({
    windowMs: 60_000,
    ceiling: _envInt('FORGE_RATE_LIMIT_TOKEN_PER_IP', 60),
  }),
  authorize: (): { windowMs: number; ceiling: number } => ({
    windowMs: 60_000,
    ceiling: _envInt('FORGE_RATE_LIMIT_AUTHORIZE_PER_IP', 30),
  }),
  login: (): { windowMs: number; ceiling: number } => ({
    windowMs: 60_000,
    ceiling: _envInt('FORGE_RATE_LIMIT_LOGIN_PER_IP', 20),
  }),
  signup: (): { windowMs: number; ceiling: number } => ({
    windowMs: 60_000,
    ceiling: _envInt('FORGE_RATE_LIMIT_SIGNUP_PER_IP', 10),
  }),
  forgot: (): { windowMs: number; ceiling: number } => ({
    windowMs: 60_000,
    ceiling: _envInt('FORGE_RATE_LIMIT_FORGOT_PER_IP', 5),
  }),
  mcp: (): { windowMs: number; ceiling: number } => ({
    windowMs: 60_000,
    ceiling: _envInt('FORGE_RATE_LIMIT_MCP_PER_IP', 60),
  }),
  ssePerClient: (): number => _envInt('FORGE_RATE_LIMIT_SSE_PER_CLIENT', 5),
} as const;

// ---------------------------------------------------------------------------
// IP extraction
// ---------------------------------------------------------------------------

/**
 * Client IP from Fastify request. Prefers X-Forwarded-For (set by the load balancer in
 * production) then Fastify's req.ip (socket remote address). In tests (inject), req.ip is
 * '127.0.0.1'; set x-forwarded-for: 'A.B.C.D' in the inject headers to override.
 */
export function clientIp(req: FastifyRequest): string {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const raw = Array.isArray(xff) ? (xff[0] ?? '') : xff;
    const first = raw.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _envInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function _logRateLimit(opts: {
  route: string;
  keyClass: string;
  key: string;
  mode: 'dry-run' | 'enforce';
  retryAfterSeconds: number;
}): void {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: 'rate_limit',
      route: opts.route,
      key_class: opts.keyClass,
      key: opts.key,
      would_throttle: true,
      mode: opts.mode,
      retry_after_seconds: opts.retryAfterSeconds,
    }),
  );
}
