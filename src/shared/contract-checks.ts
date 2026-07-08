// C14 — platform-contract smoke checks. The read-only HTTP assertions that verify
// a DEPLOYED forge app actually honors the platform contracts it adopted:
//   1. C6 health   — GET /api/health is 200, PUBLIC, and matches the standard schema
//   2. C10 page gate    — an unauthenticated page 302-redirects to /auth/login?next=…
//   3. C10 API gate     — an unauthenticated protected API path is 401
//   4. C10 service gate  — a cron/service path with NO service token is 403 (not 401)
//   5. C10 /auth/config — 200 + the {methods,configured} shape (+ expected methods)
//   6. C10 /auth/refresh — a cookie-less refresh is 401 (optional)
//
// Pure of any capability/store coupling: given a base URL + parameters it does fresh
// read-only requests (a new request per assertion, redirects NOT followed) and returns
// a structured report that NEVER throws. This is the ONE definition of the contract
// assertions — `forge verify` (the one-shot CLI, C14) drives it, and it reuses the
// SAME C6 probe + schema recognizer the C15 status page uses (shared/health-probe.ts +
// shared/health.ts), so "what a healthy contract looks like" is defined in one place.

import { z } from 'zod';
import { httpProbe, probeHealth, HEALTH_TIMEOUT_MS } from './health-probe';

export type AssertionStatus = 'pass' | 'fail' | 'skip';

export interface Assertion {
  // Stable machine id (e.g. 'health', 'page-gate', 'api-gate:/api/habits').
  name: string;
  // Human label.
  title: string;
  status: AssertionStatus;
  // What was probed, e.g. "GET /api/health".
  target: string;
  // The contract expectation, human-readable.
  expected: string;
  // What actually came back.
  actual: string;
  // Optional extra context (a hint, a non-fatal warning, why it was skipped).
  detail?: string;
}

// Which /auth/config methods the caller asserts are ENABLED (C10). Any omitted flag
// is not asserted (the shape is still checked). `email` maps to configured.email.
export interface ExpectMethods {
  google?: boolean;
  email?: boolean;
  passwordSignup?: boolean;
}

export interface ContractCheckOptions {
  // Base URL of the deployed app, e.g. "https://app.example.com" (no trailing slash).
  baseUrl: string;
  // Unauthenticated page to probe for the C10 page gate (default '/').
  pagePath?: string;
  // Health/readiness path (default '/api/health').
  healthPath?: string;
  // Protected API paths to probe for the C10 API gate (each expected 401).
  apiPaths?: string[];
  // A cron/service-scoped path to probe with NO service token (expected 403).
  cronPath?: string;
  // Expected enabled auth methods to assert against /auth/config.
  expect?: ExpectMethods;
  // Also probe POST /auth/refresh with no cookies (expected 401).
  checkRefresh?: boolean;
  timeoutMs?: number;
}

export interface ContractReport {
  passed: boolean;
  total: number;
  failed: number;
  skipped: number;
  assertions: Assertion[];
  checked_at: string;
}

// Recognize the C10 /auth/config shape (permissive on unknown extra keys).
const authConfigSchema = z.object({
  methods: z.object({
    password: z.boolean(),
    password_signup: z.boolean(),
    google: z.boolean(),
  }),
  configured: z.object({
    session_key: z.boolean(),
    google: z.boolean(),
    email: z.boolean(),
    service_token: z.boolean(),
  }),
});
type AuthConfigShape = z.infer<typeof authConfigSchema>;

function isRedirect(status?: number): boolean {
  return status !== undefined && status >= 300 && status < 400;
}

// ---- individual assertions ---------------------------------------------------

// 1. C6 health: PUBLIC (no auth redirect / 401), 200, and conforms to the standard
//    schema. Reuses probeHealth (the SAME C6 probe the C15 status page uses) with
//    redirect:'manual' so a health path wrongly behind the auth gate is caught.
export async function checkHealth(baseUrl: string, healthPath: string, timeoutMs: number): Promise<Assertion> {
  const target = `GET ${healthPath}`;
  const expected = '200 + public + C6 schema {status,service,time,checks[]}';
  const probe = await probeHealth(`${baseUrl}${healthPath}`, timeoutMs, { redirect: 'manual' });
  if (!probe.reachable) {
    return { name: 'health', title: 'C6 health endpoint', status: 'fail', target, expected, actual: `unreachable (${probe.error})` };
  }
  if (isRedirect(probe.httpStatus)) {
    return { name: 'health', title: 'C6 health endpoint', status: 'fail', target, expected, actual: `HTTP ${probe.httpStatus} redirect to ${probe.redirectLocation ?? '?'}`, detail: 'health must be PUBLIC — it is behind an auth redirect' };
  }
  if (probe.httpStatus === 401 || probe.httpStatus === 403) {
    return { name: 'health', title: 'C6 health endpoint', status: 'fail', target, expected, actual: `HTTP ${probe.httpStatus}`, detail: 'health must be PUBLIC — it is auth-gated' };
  }
  if (probe.httpStatus !== 200) {
    return { name: 'health', title: 'C6 health endpoint', status: 'fail', target, expected, actual: `HTTP ${probe.httpStatus}` };
  }
  if (!probe.conforms || !probe.health) {
    return { name: 'health', title: 'C6 health endpoint', status: 'fail', target, expected, actual: `HTTP 200 but body is not the C6 schema`, detail: probe.parseError };
  }
  const h = probe.health;
  const down = h.checks.filter((c) => c.status === 'unavailable').map((c) => c.name);
  return {
    name: 'health',
    title: 'C6 health endpoint',
    status: 'pass',
    target,
    expected,
    actual: `HTTP 200, status='${h.status}', ${h.checks.length} check(s)${down.length ? `, down: ${down.join(', ')}` : ''}`,
  };
}

// 2. C10 page gate: an unauthenticated page 302-redirects to /auth/login?next=…
export async function checkPageGate(baseUrl: string, pagePath: string, timeoutMs: number): Promise<Assertion> {
  const target = `GET ${pagePath}`;
  const expected = '302 → /auth/login?next=…';
  const r = await httpProbe(`${baseUrl}${pagePath}`, { redirect: 'manual', timeoutMs });
  if (!r.reachable) {
    return { name: 'page-gate', title: 'C10 page gate', status: 'fail', target, expected, actual: `unreachable (${r.error})` };
  }
  const loc = r.location ?? '';
  const toLogin = isRedirect(r.status) && /\/auth\/login\b/.test(loc);
  if (!toLogin) {
    return { name: 'page-gate', title: 'C10 page gate', status: 'fail', target, expected, actual: isRedirect(r.status) ? `HTTP ${r.status} → ${loc || '(no Location)'}` : `HTTP ${r.status} (no redirect to login)` };
  }
  const hasNext = /[?&]next=/.test(loc);
  const notes: string[] = [];
  if (r.status !== 302) notes.push(`redirect status ${r.status}, expected 302`);
  if (!hasNext) notes.push('no `next=` param on the redirect');
  return {
    name: 'page-gate',
    title: 'C10 page gate',
    status: 'pass',
    target,
    expected,
    actual: `HTTP ${r.status} → ${loc}`,
    ...(notes.length ? { detail: notes.join('; ') } : {}),
  };
}

// 3. C10 API gate: an unauthenticated protected API path is 401 (JSON, not a redirect).
export async function checkApiGate(baseUrl: string, apiPath: string, timeoutMs: number): Promise<Assertion> {
  const target = `GET ${apiPath}`;
  const expected = '401';
  const r = await httpProbe(`${baseUrl}${apiPath}`, { redirect: 'manual', timeoutMs });
  if (!r.reachable) {
    return { name: `api-gate:${apiPath}`, title: `C10 API gate (${apiPath})`, status: 'fail', target, expected, actual: `unreachable (${r.error})` };
  }
  if (r.status === 401) {
    return { name: `api-gate:${apiPath}`, title: `C10 API gate (${apiPath})`, status: 'pass', target, expected, actual: 'HTTP 401' };
  }
  const detail = isRedirect(r.status)
    ? 'a protected API should 401, not redirect (that is the PAGE gate)'
    : r.status === 200
      ? 'not gated — returned 200 unauthenticated'
      : undefined;
  return { name: `api-gate:${apiPath}`, title: `C10 API gate (${apiPath})`, status: 'fail', target, expected, actual: isRedirect(r.status) ? `HTTP ${r.status} → ${r.location ?? '?'}` : `HTTP ${r.status}`, ...(detail ? { detail } : {}) };
}

// 4. C10 service gate: a cron/service path with NO service token is 403 (NOT 401 —
//    a missing/invalid service token is forbidden, distinct from an unauthenticated user).
export async function checkServiceGate(baseUrl: string, cronPath: string, timeoutMs: number): Promise<Assertion> {
  const target = `GET ${cronPath}`;
  const expected = '403 (no service token)';
  const r = await httpProbe(`${baseUrl}${cronPath}`, { redirect: 'manual', timeoutMs });
  if (!r.reachable) {
    return { name: 'service-gate', title: 'C10 service gate', status: 'fail', target, expected, actual: `unreachable (${r.error})` };
  }
  if (r.status === 403) {
    return { name: 'service-gate', title: 'C10 service gate', status: 'pass', target, expected, actual: 'HTTP 403' };
  }
  const detail = r.status === 401
    ? 'got 401 — the service gate must be 403 (service-scoped), distinct from the 401 user-API gate'
    : r.status === 200
      ? 'not gated — returned 200 with no service token'
      : undefined;
  return { name: 'service-gate', title: 'C10 service gate', status: 'fail', target, expected, actual: isRedirect(r.status) ? `HTTP ${r.status} → ${r.location ?? '?'}` : `HTTP ${r.status}`, ...(detail ? { detail } : {}) };
}

// 5. C10 /auth/config: 200 + the {methods,configured} shape; assert any expected methods.
export async function checkAuthConfig(baseUrl: string, expect: ExpectMethods | undefined, timeoutMs: number): Promise<Assertion> {
  const target = 'GET /auth/config';
  const wants: string[] = [];
  if (expect?.google) wants.push('google');
  if (expect?.email) wants.push('email');
  if (expect?.passwordSignup) wants.push('password_signup');
  const expected = `200 + {methods,configured} shape${wants.length ? ` + enabled: ${wants.join(', ')}` : ''}`;
  const r = await httpProbe(`${baseUrl}/auth/config`, { redirect: 'manual', timeoutMs, headers: { accept: 'application/json' } });
  if (!r.reachable) {
    return { name: 'auth-config', title: 'C10 /auth/config', status: 'fail', target, expected, actual: `unreachable (${r.error})` };
  }
  if (r.status !== 200) {
    return { name: 'auth-config', title: 'C10 /auth/config', status: 'fail', target, expected, actual: isRedirect(r.status) ? `HTTP ${r.status} → ${r.location ?? '?'}` : `HTTP ${r.status}` };
  }
  let parsed: AuthConfigShape;
  try {
    parsed = authConfigSchema.parse(JSON.parse(r.body ?? ''));
  } catch (e) {
    const issue = e instanceof z.ZodError ? (e.issues[0] ? `${e.issues[0].path.join('.') || '(root)'}: ${e.issues[0].message}` : 'shape mismatch') : 'not JSON';
    return { name: 'auth-config', title: 'C10 /auth/config', status: 'fail', target, expected, actual: `HTTP 200 but not the {methods,configured} shape`, detail: issue };
  }
  const missing: string[] = [];
  if (expect?.google && !parsed.methods.google) missing.push('google not enabled');
  if (expect?.passwordSignup && !parsed.methods.password_signup) missing.push('password_signup not enabled');
  if (expect?.email && !parsed.configured.email) missing.push('email not configured');
  const enabled = [
    parsed.methods.password ? 'password' : null,
    parsed.methods.password_signup ? 'password_signup' : null,
    parsed.methods.google ? 'google' : null,
  ].filter(Boolean);
  if (missing.length) {
    return { name: 'auth-config', title: 'C10 /auth/config', status: 'fail', target, expected, actual: `enabled: ${enabled.join(', ') || 'none'}`, detail: missing.join('; ') };
  }
  return { name: 'auth-config', title: 'C10 /auth/config', status: 'pass', target, expected, actual: `HTTP 200, enabled: ${enabled.join(', ') || 'none'}` };
}

// 6. C10 /auth/refresh (optional): a cookie-less refresh is 401.
export async function checkRefresh(baseUrl: string, timeoutMs: number): Promise<Assertion> {
  const target = 'POST /auth/refresh';
  const expected = '401 (no cookies)';
  const r = await httpProbe(`${baseUrl}/auth/refresh`, { method: 'POST', redirect: 'manual', timeoutMs });
  if (!r.reachable) {
    return { name: 'refresh', title: 'C10 /auth/refresh', status: 'fail', target, expected, actual: `unreachable (${r.error})` };
  }
  if (r.status === 401) {
    return { name: 'refresh', title: 'C10 /auth/refresh', status: 'pass', target, expected, actual: 'HTTP 401' };
  }
  return { name: 'refresh', title: 'C10 /auth/refresh', status: 'fail', target, expected, actual: `HTTP ${r.status}`, ...(r.status === 200 ? { detail: 'a cookie-less refresh must not mint a session' } : {}) };
}

// ---- runner ------------------------------------------------------------------

// Run every applicable contract check against the base URL. Deterministic order.
// A check with no input to probe (e.g. no --api-path) records a SKIP with a note
// rather than guessing app routes. `passed` is true iff no assertion FAILED
// (skips don't fail the run).
export async function runContractChecks(opts: ContractCheckOptions): Promise<ContractReport> {
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const pagePath = opts.pagePath ?? '/';
  const healthPath = opts.healthPath ?? '/api/health';
  const assertions: Assertion[] = [];

  assertions.push(await checkHealth(baseUrl, healthPath, timeoutMs));
  assertions.push(await checkPageGate(baseUrl, pagePath, timeoutMs));

  const apiPaths = opts.apiPaths ?? [];
  if (apiPaths.length === 0) {
    assertions.push({
      name: 'api-gate',
      title: 'C10 API gate',
      status: 'skip',
      target: 'GET <api-path>',
      expected: '401',
      actual: 'skipped',
      detail: 'no --api-path given (not guessing app routes); pass one or more protected API paths to probe',
    });
  } else {
    for (const p of apiPaths) assertions.push(await checkApiGate(baseUrl, p, timeoutMs));
  }

  if (opts.cronPath) {
    assertions.push(await checkServiceGate(baseUrl, opts.cronPath, timeoutMs));
  } else {
    assertions.push({
      name: 'service-gate',
      title: 'C10 service gate',
      status: 'skip',
      target: 'GET <cron-path>',
      expected: '403 (no service token)',
      actual: 'skipped',
      detail: 'no --cron-path given (app may have no scheduled/cron routes)',
    });
  }

  assertions.push(await checkAuthConfig(baseUrl, opts.expect, timeoutMs));

  if (opts.checkRefresh) {
    assertions.push(await checkRefresh(baseUrl, timeoutMs));
  }

  const failed = assertions.filter((a) => a.status === 'fail').length;
  const skipped = assertions.filter((a) => a.status === 'skip').length;
  return {
    passed: failed === 0,
    total: assertions.length,
    failed,
    skipped,
    assertions,
    checked_at: new Date().toISOString(),
  };
}
