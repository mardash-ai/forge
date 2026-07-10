import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { Verification } from '../../resources/types';
import { appRefInput, resolveAppLenient, baseResource } from '../_shared';
import { runContractChecks, type ExpectMethods } from '../../shared/contract-checks';

// Verify (C14) — a generic post-deploy smoke that checks the platform contracts a
// DEPLOYED forge app has adopted, against its public host. Read-only HTTP only: it
// asserts the C6 health endpoint (200 + public + standard schema), the C10 auth gates
// (page → 302 /auth/login, protected API → 401, service/cron → 403), and /auth/config
// (the {methods,configured} shape + any expected methods). Never writes, never needs
// credentials. The overall `passed` is the gate the CLI turns into an exit code.
//
// This is the platform lift of an app-local smoke suite: the app declares WHICH paths
// to probe (its own routes) and WHICH auth methods it expects enabled; the platform
// owns the contract assertions. It reuses the SAME C6 probe/schema the C15 status page
// uses (shared/health-probe.ts + shared/contract-checks.ts) — one definition of "what a
// healthy contract looks like", not a duplicate.

const inputSchema = z.object({
  ...appRefInput,
  // Public host or base URL of the deployed app. Accepts "app.example.com" (https is
  // assumed) or a full "https://app.example.com". Trailing slash is trimmed.
  host: z.string().min(1).describe('Public host or base URL of the deployed app'),
  // Unauthenticated page to probe for the C10 page gate (default '/').
  page_path: z.string().default('/'),
  // Health/readiness path (default '/api/health').
  health_path: z.string().default('/api/health'),
  // Protected API paths to probe for the C10 API gate (each expected 401). Repeatable.
  api_paths: z.array(z.string()).default([]),
  // A cron/service-scoped path to probe with NO service token (expected 403). Optional.
  cron_path: z.string().optional(),
  // Expected enabled auth methods asserted against /auth/config.
  expect_google: z.boolean().default(false),
  expect_email: z.boolean().default(false),
  expect_password_signup: z.boolean().default(false),
  // Also probe POST /auth/refresh with no cookies (expected 401).
  check_refresh: z.boolean().default(false),
  // Per-request timeout (ms).
  timeout_ms: z.number().int().positive().optional(),
  // Post-deploy WARM-UP wait (ms). When > 0, `verify` first polls the health endpoint with a
  // bounded, backed-off retry until it answers a clean C6 200 — so a start-first roll's warm-up
  // window can't produce a false-red health check (the C19-deploy flake). Defaults to 0 for a
  // standalone `forge verify` (which runs after a deploy has settled); the `release` pipeline
  // supplies a budget for its deploy→verify handoff. Never turns a real failure green.
  readiness_timeout_ms: z.number().int().nonnegative().default(0),
  readiness_interval_ms: z.number().int().positive().optional(),
});
type Input = z.infer<typeof inputSchema>;

// Normalize a host/URL into a scheme-qualified base URL (https assumed), no trailing slash.
function toBaseUrl(host: string): string {
  const h = host.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(h) ? h : `https://${h}`;
  return withScheme.replace(/\/+$/, '');
}

export const verify: Capability<Input, Verification> = {
  name: 'Verify',
  slug: 'verify',
  description:
    'Post-deploy contract smoke: read-only HTTP assertions that a deployed app honors the platform contracts it adopted (C6 health, C10 auth gates + /auth/config). Exits non-zero on any failed assertion.',
  inputSchema,
  resourceType: 'Verification',
  events: ['VerificationCompleted'],
  longRunning: false,
  requiresDocker: false,
  // An observe surface useful from the control plane (CI post-deploy) and the data plane.
  plane: 'both',
  async execute(input, ctx) {
    // Deploy-time resolution (P19): the post-deploy gate must run on a prod host whose store may
    // never have had `forge init app` — resolve the app leniently (store record optional; inferred
    // from `app/forge.app.json`), matching how `forge deploy` / the `release` pipeline resolve it.
    const app = await resolveAppLenient(ctx.store, input.app);
    const baseUrl = toBaseUrl(input.host);

    const expect: ExpectMethods = {
      google: input.expect_google,
      email: input.expect_email,
      passwordSignup: input.expect_password_signup,
    };

    const report = await runContractChecks({
      baseUrl,
      pagePath: input.page_path,
      healthPath: input.health_path,
      apiPaths: input.api_paths,
      cronPath: input.cron_path,
      expect,
      checkRefresh: input.check_refresh,
      timeoutMs: input.timeout_ms,
      readinessTimeoutMs: input.readiness_timeout_ms,
      ...(input.readiness_interval_ms ? { readinessIntervalMs: input.readiness_interval_ms } : {}),
    });

    const summary = report.passed
      ? `${app.name} @ ${baseUrl}: all ${report.total - report.skipped} contract check(s) passed${report.skipped ? ` (${report.skipped} skipped)` : ''}.`
      : `${app.name} @ ${baseUrl}: ${report.failed} of ${report.total} contract check(s) FAILED — ${report.assertions
          .filter((a) => a.status === 'fail')
          .map((a) => a.title)
          .join(', ')}.`;

    const resource: Verification = {
      ...baseResource('Verification', app.id),
      type: 'Verification',
      host: baseUrl,
      passed: report.passed,
      summary,
      total: report.total,
      failed: report.failed,
      skipped: report.skipped,
      assertions: report.assertions,
      checked_at: report.checked_at,
    };
    await ctx.store.saveResource(resource);
    await ctx.emit({
      type: 'VerificationCompleted',
      resource_type: 'Verification',
      resource_id: resource.id,
      app_id: app.id,
      data: { host: baseUrl, passed: report.passed, total: report.total, failed: report.failed, skipped: report.skipped },
    });

    return resource;
  },
};
