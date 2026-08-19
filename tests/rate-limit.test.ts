import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkLimit,
  resetRateLimitState,
  isEnforceMode,
  checkRoute,
  recordLoginFailure,
  clearLoginFailures,
  loginBackoffSeconds,
  resetLoginFailures,
  ROUTE_RATE,
} from '../src/shared/rate-limit';

// ── Sliding-window unit tests ──────────────────────────────────────────────────────────────────

describe('checkLimit — sliding-window logic', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('allows requests below the ceiling', () => {
    const key = 'ip:1.2.3.4';
    for (let i = 0; i < 5; i++) {
      const r = checkLimit(key, 60_000, 5);
      expect(r.limited).toBe(false);
    }
  });

  it('returns limited=true and a positive retryAfterSeconds when ceiling is exceeded', () => {
    const key = 'ip:test';
    for (let i = 0; i < 5; i++) checkLimit(key, 60_000, 5);
    const r = checkLimit(key, 60_000, 5); // 6th request
    expect(r.limited).toBe(true);
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('uses separate state per key — different keys do not share counts', () => {
    checkLimit('ip:A', 60_000, 2);
    checkLimit('ip:A', 60_000, 2);
    // A is at ceiling; B is still clear
    const rA = checkLimit('ip:A', 60_000, 2);
    const rB = checkLimit('ip:B', 60_000, 2);
    expect(rA.limited).toBe(true);
    expect(rB.limited).toBe(false);
  });

  it('resetRateLimitState clears all counters', () => {
    const key = 'ip:reset-test';
    for (let i = 0; i < 10; i++) checkLimit(key, 60_000, 5);
    expect(checkLimit(key, 60_000, 5).limited).toBe(true);

    resetRateLimitState();
    expect(checkLimit(key, 60_000, 5).limited).toBe(false);
  });

  it('a ceiling of 0 limits every request (the first is already over)', () => {
    const r = checkLimit('ip:zero', 60_000, 0);
    expect(r.limited).toBe(true);
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });
});

// ── Mode: log-only (default) vs enforce ───────────────────────────────────────────────────────

describe('isEnforceMode + checkRoute — both modes', () => {
  beforeEach(() => {
    resetRateLimitState();
    delete process.env.FORGE_RATE_LIMIT_MODE;
  });
  afterEach(() => {
    delete process.env.FORGE_RATE_LIMIT_MODE;
    resetRateLimitState();
  });

  it('default mode is log-only: checkRoute returns should_reject=false even when over ceiling', () => {
    expect(isEnforceMode()).toBe(false); // default is dry-run
    // Put the key 10 requests over a ceiling-of-2 limit
    for (let i = 0; i < 5; i++) {
      const r = checkRoute('1.2.3.4', 'POST /oauth/register', 'ip', 60_000, 2);
      // First 2: under ceiling, never limited; 3rd-5th: over ceiling but mode=dry-run → should_reject=false
      expect(r.should_reject).toBe(false);
    }
  });

  it('enforce mode: checkRoute returns should_reject=true when over ceiling', () => {
    process.env.FORGE_RATE_LIMIT_MODE = 'enforce';
    expect(isEnforceMode()).toBe(true);
    // First 2 requests: under ceiling
    checkRoute('2.2.2.2', 'POST /oauth/token', 'ip', 60_000, 2);
    checkRoute('2.2.2.2', 'POST /oauth/token', 'ip', 60_000, 2);
    // 3rd: over ceiling → should_reject
    const r = checkRoute('2.2.2.2', 'POST /oauth/token', 'ip', 60_000, 2);
    expect(r.should_reject).toBe(true);
    expect(r.retry_after).toBeGreaterThan(0);
  });

  it('enforce mode: retry_after is included in the rejection result', () => {
    process.env.FORGE_RATE_LIMIT_MODE = 'enforce';
    // Exhaust the limit of 1
    checkRoute('3.3.3.3', 'POST /oauth/register', 'ip', 60_000, 1);
    const r = checkRoute('3.3.3.3', 'POST /oauth/register', 'ip', 60_000, 1);
    expect(r.should_reject).toBe(true);
    expect(typeof r.retry_after).toBe('number');
    expect(r.retry_after).toBeGreaterThanOrEqual(1);
  });
});

// ── Per-account login escalation ───────────────────────────────────────────────────────────────

describe('loginBackoffSeconds — per-account escalation', () => {
  beforeEach(() => {
    resetLoginFailures();
    // Use 0ms backoff duration env vars reset
    delete process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_AFTER;
    delete process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_MS;
    delete process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_2_AFTER;
    delete process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_2_MS;
    delete process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_3_AFTER;
    delete process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_3_MS;
  });
  afterEach(() => {
    resetLoginFailures();
    delete process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_AFTER;
    delete process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_MS;
  });

  it('no backoff before any failures', () => {
    expect(loginBackoffSeconds('user@example.com')).toBe(0);
  });

  it('no backoff below the first threshold', () => {
    // Default threshold1 = 3; with 2 failures, no backoff
    recordLoginFailure('u@example.com');
    recordLoginFailure('u@example.com');
    expect(loginBackoffSeconds('u@example.com')).toBe(0);
  });

  it('clears backoff after a successful login', () => {
    // 3 failures → should trigger backoff
    process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_AFTER = '3';
    process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_MS = '9999000'; // large so it stays active
    for (let i = 0; i < 3; i++) recordLoginFailure('clear@test.com');
    expect(loginBackoffSeconds('clear@test.com')).toBeGreaterThan(0);
    clearLoginFailures('clear@test.com');
    expect(loginBackoffSeconds('clear@test.com')).toBe(0);
  });

  it('escalates: threshold1 triggers backoff1_ms duration', () => {
    // Set threshold at 3 failures, backoff = 1 hour (so it's definitely still active)
    process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_AFTER = '3';
    process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_MS = '3600000';
    for (let i = 0; i < 3; i++) recordLoginFailure('a@b.com');
    const secs = loginBackoffSeconds('a@b.com');
    // Should be close to 3600 (±5 for timing)
    expect(secs).toBeGreaterThan(3590);
    expect(secs).toBeLessThanOrEqual(3600);
  });

  it('escalates to threshold2 when failure count crosses the second threshold', () => {
    process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_AFTER = '3';
    process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_MS = '1000';
    process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_2_AFTER = '5';
    process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_2_MS = '7200000'; // 2h
    for (let i = 0; i < 5; i++) recordLoginFailure('b@c.com');
    const secs = loginBackoffSeconds('b@c.com');
    expect(secs).toBeGreaterThan(7190);
  });

  it('different accounts do not share failure state', () => {
    process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_AFTER = '2';
    process.env.FORGE_RATE_LIMIT_LOGIN_BACKOFF_1_MS = '3600000';
    recordLoginFailure('x@x.com');
    recordLoginFailure('x@x.com');
    // x is in backoff; y is not
    expect(loginBackoffSeconds('x@x.com')).toBeGreaterThan(0);
    expect(loginBackoffSeconds('y@y.com')).toBe(0);
  });
});

// ── ROUTE_RATE config — env vars are read at call time ───────────────────────────────────────

describe('ROUTE_RATE — env-configurable ceilings', () => {
  afterEach(() => {
    delete process.env.FORGE_RATE_LIMIT_DCR_PER_IP;
    delete process.env.FORGE_RATE_LIMIT_TOKEN_PER_IP;
    delete process.env.FORGE_RATE_LIMIT_MCP_PER_IP;
    delete process.env.FORGE_RATE_LIMIT_SSE_PER_CLIENT;
  });

  it('DCR ceiling defaults to 20', () => {
    expect(ROUTE_RATE.dcr().ceiling).toBe(20);
  });

  it('DCR ceiling can be overridden via env', () => {
    process.env.FORGE_RATE_LIMIT_DCR_PER_IP = '5';
    expect(ROUTE_RATE.dcr().ceiling).toBe(5);
  });

  it('token ceiling defaults to 60', () => {
    expect(ROUTE_RATE.token().ceiling).toBe(60);
  });

  it('MCP ceiling defaults to 60', () => {
    expect(ROUTE_RATE.mcp().ceiling).toBe(60);
  });

  it('SSE per-client ceiling defaults to 5', () => {
    expect(ROUTE_RATE.ssePerClient()).toBe(5);
  });

  it('SSE per-client ceiling can be overridden', () => {
    process.env.FORGE_RATE_LIMIT_SSE_PER_CLIENT = '10';
    expect(ROUTE_RATE.ssePerClient()).toBe(10);
  });
});
