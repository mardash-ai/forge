/**
 * forge-console — the server. Fastify, serving the API and the built SPA from one process.
 *
 * Auth is Google OIDC (domain-restricted to mardash.ai). Google OIDC is the sole authenticated
 * entry; no shared-password fallback exists. The console fails closed when OIDC credentials are
 * absent — nothing is served to the internet without a valid session.
 *
 * A scoped automation credential is also supported: a bearer token seeded out-of-band in Secret
 * Manager (CONSOLE_AUTOMATION_TOKEN). It is API-only (no cookie issued), read-only by
 * construction (all audited write methods refuse it with 403), and stamps every audit row with the
 * distinct actor identity `automation@console`. When the secret is unconfigured the path fails
 * closed — no token is accepted. Google OIDC remains the ONLY interactive login path.
 *
 * Every mutating route is registered in a table with a required role, and a test asserts that no
 * mutating route exists outside it.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { timingSafeEqual, createHmac, randomBytes, createVerify, createPublicKey } from 'node:crypto';

import { envelope, type Finding, type MetricIntent, type QuotaGauge, type Revision } from './domain';
import { registerIngestRoutes } from '../api/ingest-routes';
import {
  queryListRuns,
  queryGetRun,
  queryGetWorkflow,
  queryDiffRuns,
  TRIAGE_INSTRUCTIONS,
  E2E_MCP_TOOLS,
} from './e2e-api';
import { getEvalStore } from './e2e-store';
import type { PgCpResultsBackend } from '../storage/backends/cp-results/pg';
import { aggregate, createRegistry, type ProviderContext, type ProviderRegistry } from './providers/types';
import type {
  CredentialsProvider,
  InventoryProvider,
  LogsProvider,
  MetricsProvider,
  PipelinesProvider,
  RuntimeProvider,
} from './providers/types';
import { buildServiceGraph } from './correlate/graph';
import { runFindings } from './findings';
import { buildTimeline } from './timeline';
import { computeQuotas } from './quota';
import { builtinSource, webManifestSource, indexAll, findSource, unqualify, type DocSource } from './docs';
import { createGrafanaCatalog, resolveGrafanaMacros } from './metrics-catalog';
import { createGrafanaBoards } from './grafana-boards';
import { createGcpInventoryProvider } from '../plugins/console-gcp/inventory';
import {
  createCloudMonitoringProvider,
  createManagedPrometheusProvider,
} from '../plugins/console-gcp/metrics';
import { createCloudLoggingProvider } from '../plugins/console-gcp/logs';
import { createGcpCredentialsProvider } from '../plugins/console-gcp/credentials';
import { createCloudRunRuntimeProvider } from '../plugins/console-gcp/runtime';
import {
  createGcpAlertsProvider,
  createGcpCostProvider,
  createGcsDriftProvider,
  type AlertsProvider,
  type CostProvider,
  type DriftProvider,
} from '../plugins/console-gcp/ops';
import { triggerCloudRunJob, buildExecutionConsoleUrl, getExecutionState } from '../plugins/console-gcp/jobs';
import { createGitHubPipelinesProvider } from '../plugins/console-github/pipelines';
import { createDorindaTenantProvider, TenantAppError } from '../plugins/console-dorinda/tenants';
import type { TenantProvider } from './providers/tenants';

/**
 * Reconcile `running` rows against their Cloud Run execution.
 *
 * A run row is pre-created as 'running' the moment the operator clicks, and it is the RUNNER's job
 * to finalise it. When the runner never gets that far — on 2026-08-13 the container could not exec
 * and Cloud Run failed the execution within seconds — the row says "running" forever, and the tab
 * shows a run in progress that ended long ago. Nothing in the system ever revisited it.
 *
 * So the execution is treated as the source of truth and the row follows it, on every read:
 *   - execution finished  → the row takes its outcome (failed / aborted / completed)
 *   - execution running   → left alone
 *   - state unreadable    → left alone; a lookup failure must never rewrite a record
 *   - no execution name AND older than the trigger timeout → the trigger never took; mark aborted,
 *     because a row that can never be finalised is worse than an honest failure
 *
 * Corrections are persisted, so a row heals once rather than being recomputed on every request.
 */
const RUN_STALE_WITHOUT_EXECUTION_MS = 5 * 60 * 1000;

export async function reconcileRunningRuns<
  T extends { run_id: string; status?: string; started_at?: string; meta?: Record<string, unknown> },
>(
  store: { updateRun: (id: string, patch: Record<string, unknown>) => Promise<unknown> } | null,
  runs: T[],
  // Injected so the reconciliation logic is testable without reaching Cloud Run.
  readState: (
    name: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<{
    state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    completed_at?: string;
    message?: string;
  }> = getExecutionState,
): Promise<T[]> {
  if (!store || !Array.isArray(runs) || runs.length === 0) return runs;
  // Reconciliation is an ENHANCEMENT to the read path. A store that cannot persist, or any error
  // raised while reconciling, must never turn a working list view into a 500 — the tab showing
  // slightly stale status beats the tab showing nothing. (Caught by the existing endpoint tests,
  // which hand in a read-only store: the first cut threw and took the whole list down with it.)
  if (typeof (store as { updateRun?: unknown }).updateRun !== 'function') return runs;
  const running = runs.filter((r) => r?.status === 'running');
  if (running.length === 0) return runs;

  try {
    await Promise.all(
      running.map(async (row) => {
        const executionName = (row.meta as { execution_name?: string } | undefined)?.execution_name;
        if (!executionName) {
          const startedMs = row.started_at ? Date.parse(row.started_at) : NaN;
          const stale = Number.isFinite(startedMs) && Date.now() - startedMs > RUN_STALE_WITHOUT_EXECUTION_MS;
          if (!stale) return;
          row.status = 'aborted';
          await store
            .updateRun(row.run_id, {
              status: 'aborted',
              completed_at: new Date().toISOString(),
              meta: { ...(row.meta ?? {}), reconciled: 'no execution was ever recorded for this run' },
            })
            .catch(() => {});
          return;
        }
        const state = await readState(executionName, { signal: AbortSignal.timeout(10_000) });
        if (state.state === 'running' || state.state === 'unknown') return;
        const status =
          state.state === 'succeeded' ? 'completed' : state.state === 'cancelled' ? 'aborted' : 'failed';
        row.status = status;
        await store
          .updateRun(row.run_id, {
            status,
            completed_at: state.completed_at ?? new Date().toISOString(),
            meta: {
              ...(row.meta ?? {}),
              reconciled: `execution ${state.state}${state.message ? `: ${state.message}` : ''}`,
            },
          })
          .catch(() => {});
      }),
    );
  } catch {
    // Deliberately swallowed: see the note above. The rows are returned as read.
  }
  return runs;
}

const PORT = Number(process.env.PORT ?? 3000);
const PROJECT = process.env.CONSOLE_GCP_PROJECT ?? 'dorinda-prod';
const REGION = process.env.CONSOLE_GCP_REGION ?? 'us-east1';
const ENV: string = process.env.CONSOLE_ENV ?? 'prod-a';
const GH_OWNER = process.env.CONSOLE_GITHUB_OWNER ?? 'mardash-ai';
const GH_REPOS = (process.env.CONSOLE_GITHUB_REPOS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const UI_DIR = process.env.CONSOLE_UI_DIR ?? join(process.cwd(), 'console', 'dist');
const STATE_BUCKET = process.env.CONSOLE_STATE_BUCKET ?? 'dorinda-tf-state';
const BILLING_ACCOUNT = process.env.CONSOLE_BILLING_ACCOUNT ?? '';
/** Which Cloud Run services carry the deploy axis. Discovered from inventory, capped for latency. */
const DEPLOY_SAMPLE = 8;

// ── Providers ──────────────────────────────────────────────────────────────────────────────────

export function buildRegistry(): ProviderRegistry {
  const scope = { project_id: PROJECT, region: REGION };
  const providers = [
    createGcpInventoryProvider({ id: 'gcp-inventory', envs: [ENV], scope }),
    createCloudMonitoringProvider({ id: 'cloud-monitoring', envs: [ENV], scope: { project_id: PROJECT } }),
    createManagedPrometheusProvider({
      id: 'managed-prometheus',
      envs: [ENV],
      scope: { project_id: PROJECT },
    }),
    createCloudLoggingProvider({ id: 'cloud-logging', envs: [ENV], scope: { project_id: PROJECT } }),
    createGcpCredentialsProvider({
      id: 'gcp-credentials',
      envs: [ENV],
      scope: { project_id: PROJECT },
      // Expiries no API exposes. Configured rather than coded so adding one is not a release.
      declared: (process.env.CONSOLE_DECLARED_EXPIRIES ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((entry) => {
          // "name|kind|iso8601|detail"
          const [name, kind, expires_at, detail] = entry.split('|');
          return {
            name: name ?? 'unknown',
            kind: (kind ?? 'api_token') as never,
            expires_at: expires_at ?? '',
            ...(detail ? { detail } : {}),
          };
        })
        .filter((d) => d.expires_at),
    }),
    createGitHubPipelinesProvider({
      id: 'github-actions',
      envs: [ENV],
      owner: GH_OWNER,
      repos: GH_REPOS,
      ...(process.env.CONSOLE_GITHUB_TOKEN ? { token: process.env.CONSOLE_GITHUB_TOKEN } : {}),
    }),
    createCloudRunRuntimeProvider({ id: 'cloud-run', envs: [ENV], scope }),
    createGcpAlertsProvider({ id: 'gcp-alerts', envs: [ENV], scope: { project_id: PROJECT } }),
    createGcsDriftProvider({
      id: 'gcs-drift',
      envs: [ENV],
      scope: { bucket: STATE_BUCKET },
      ...(process.env.CONSOLE_GITHUB_TOKEN ? { githubToken: process.env.CONSOLE_GITHUB_TOKEN } : {}),
      owner: GH_OWNER,
      repos: GH_REPOS,
    }),
    createGcpCostProvider({
      id: 'gcp-billing',
      envs: [ENV],
      scope: { billing_account: BILLING_ACCOUNT, project_id: PROJECT },
    }),
  ];
  return createRegistry(providers);
}

function ctx(): ProviderContext {
  return { env: ENV, signal: AbortSignal.timeout(28_000), now: new Date() };
}

// ── Auth ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The result of an auth check.
 *
 * `readonly` is `true` for token-authenticated (automation) requests. The server's `onRequest`
 * hook refuses mutating methods (POST/PUT/PATCH/DELETE) when `readonly` is set, so the
 * read-only constraint is enforced at the transport layer rather than in each write handler.
 */
export interface ConsoleAuth {
  readonly mode: 'google' | 'open';
  check(req: FastifyRequest): { ok: true; actor: string; readonly: boolean } | { ok: false };
}

/** The actor identity stamped into every audit row for automation-token requests. */
export const AUTOMATION_ACTOR = 'automation@console';

// ── Google OIDC — session cookie helpers ──────────────────────────────────────────────────────

/** Cookie names are console-specific — never collide with forge's tenant auth cookies. */
export const OIDC_SESSION_COOKIE = 'console_session';
export const OIDC_STATE_COOKIE = 'console_oidc_state';
const OIDC_SESSION_MAX_AGE_S = 8 * 3600; // 8 h
const OIDC_STATE_MAX_AGE_S = 600; // 10 min for the OAuth round-trip
const REQUIRED_HD = 'mardash.ai'; // enforced server-side; hd in the auth URL is a cosmetic hint
const GOOGLE_OAUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Very simple cookie header parser — no library needed. */
export function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (name) out[name] = val;
  }
  return out;
}

/**
 * Sign an OIDC session cookie.
 *
 * Format: `<email_base64url>.<expiry_unix>.<hmac_sha256_hex>`
 * The HMAC binds email and expiry together so neither can be altered independently.
 */
export function makeSessionCookie(email: string, secret: string): string {
  const expiry = Math.floor(Date.now() / 1000) + OIDC_SESSION_MAX_AGE_S;
  const emailB64 = Buffer.from(email, 'utf8').toString('base64url');
  const hmac = createHmac('sha256', secret).update(`${email}|${expiry}`).digest('hex');
  return `${emailB64}.${expiry}.${hmac}`;
}

/**
 * Verify and parse a session cookie. Returns the email or null if invalid/expired.
 * The HMAC comparison is constant-time to prevent timing side-channels.
 */
export function parseSessionCookie(value: string, secret: string): string | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  let email: string;
  try {
    email = Buffer.from(parts[0]!, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!email) return null;
  const expiry = Number(parts[1]);
  if (!Number.isFinite(expiry) || Math.floor(Date.now() / 1000) > expiry) return null;
  const expected = createHmac('sha256', secret).update(`${email}|${expiry}`).digest('hex');
  const eBuf = Buffer.from(expected, 'hex');
  const gBuf = Buffer.from(parts[2] ?? '', 'hex');
  if (gBuf.length !== eBuf.length) return null;
  try {
    if (!timingSafeEqual(gBuf, eBuf)) return null;
  } catch {
    return null;
  }
  return email;
}

// ── Google OIDC — ID token verification ───────────────────────────────────────────────────────

export interface GoogleIdClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  hd?: string;
  name?: string;
  iat: number;
  exp: number;
  aud: string;
  iss: string;
}

/** Module-level JWKS cache — Google keys rotate infrequently (hourly TTL is conservative). */
let _jwksCache: { keys: unknown[]; at: number } | null = null;
/** Reset the cache between tests. Never call from production code. */
export function _resetJwksCache(): void {
  _jwksCache = null;
}

async function fetchJwks(): Promise<unknown[]> {
  if (_jwksCache && Date.now() - _jwksCache.at < 3_600_000) return _jwksCache.keys;
  const res = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`JWKS fetch ${res.status}`);
  const body = (await res.json()) as { keys: unknown[] };
  _jwksCache = { keys: body.keys, at: Date.now() };
  return body.keys;
}

/**
 * Verify a Google ID token end-to-end:
 *   1. Parse header + payload.
 *   2. Check alg == RS256 and standard claims (iss, aud, exp).
 *   3. Enforce hd == mardash.ai — the hard security boundary.
 *   4. Verify the RSA-SHA256 signature against Google's published JWKS.
 *
 * Returns the verified claims or null for ANY failure. The caller must treat null
 * as "access denied" and must NOT fall back to Basic auth or an unauthenticated state.
 */
export async function verifyGoogleIdToken(token: string, clientId: string): Promise<GoogleIdClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header: { kid?: string; alg?: string };
  let payload: GoogleIdClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as {
      kid?: string;
      alg?: string;
    };
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as GoogleIdClaims;
  } catch {
    return null;
  }

  // alg must be RS256 — reject HS256 algorithm confusion attacks
  if (header.alg !== 'RS256') return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return null;
  if (payload.aud !== clientId) return null;
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    return null;
  }

  // hd claim is the ENFORCED boundary — a non-mardash.ai Google account is refused here,
  // not challenged, not offered an alternative path.
  if (payload.hd !== REQUIRED_HD) return null;
  if (!payload.email_verified) return null;

  // Signature verification against the live JWKS
  try {
    const keys = await fetchJwks();
    const jwk = keys.find(
      (k): k is Record<string, unknown> =>
        typeof k === 'object' && k !== null && (k as Record<string, unknown>)['kid'] === header.kid,
    );
    if (!jwk) return null;
    // Type assertion: createPublicKey validates the JWK structure at runtime; TypeScript's
    // JsonWebKey type is not globally available in all lib targets so we cast through unknown.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pubKey = createPublicKey({ key: jwk as unknown as any, format: 'jwk' });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    if (!verifier.verify(pubKey, Buffer.from(parts[2]!, 'base64url'))) return null;
  } catch {
    return null;
  }

  return payload;
}

// ── Session revocation ──────────────────────────────────────────────────────────────────────────

/**
 * In-process revocation set for signed-out sessions.
 *
 * The console uses stateless HMAC cookies (no server-side session store). Sign-out adds the raw
 * cookie value to this set so the same token is refused on subsequent requests even before its
 * 8-hour HMAC expiry. The set is cleared on process restart — acceptable for an operator console
 * where a restart is an uncommon, intentional event. Tests call _resetRevokedSessions() between
 * runs so the set never bleeds across test cases.
 */
const revokedSessions = new Set<string>();

/** Reset the revocation set — for test isolation only. Never call in production code. */
export function _resetRevokedSessions(): void {
  revokedSessions.clear();
}

// ── Auth factory ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify a bearer token from the `Authorization` header using a constant-time comparison.
 *
 * Returns `true` when the header has the form `Bearer <token>` and the token matches `expected`.
 * Returns `false` for any other value, including malformed headers. Using timingSafeEqual
 * prevents timing attacks — an attacker cannot infer partial token matches from response latency.
 *
 * `expected` must be non-empty (callers must not call this when the token is unconfigured).
 */
export function checkBearerToken(authHeader: string, expected: string): boolean {
  if (!authHeader.startsWith('Bearer ')) return false;
  const presented = authHeader.slice(7); // everything after "Bearer "
  if (!presented) return false;
  const eBuf = Buffer.from(expected, 'utf8');
  const gBuf = Buffer.from(presented, 'utf8');
  // timingSafeEqual requires equal-length buffers; mismatched lengths means they can't be equal.
  if (gBuf.length !== eBuf.length) return false;
  try {
    return timingSafeEqual(gBuf, eBuf);
  } catch {
    return false;
  }
}

/**
 * Google OIDC is the sole interactive authenticated path.
 * OIDC is active whenever CONSOLE_GOOGLE_CLIENT_ID + CONSOLE_GOOGLE_CLIENT_SECRET are present.
 * If those are absent the console fails CLOSED — every request is denied, nothing is served to
 * the internet. There is no shared-password fallback.
 *
 * The check() for OIDC verifies a signed HMAC session cookie — fast, stateless, no network call
 * per request. The expensive OIDC code-exchange happens once in /auth/callback.
 *
 * Additionally, a scoped automation bearer token is supported when CONSOLE_AUTOMATION_TOKEN is
 * set. It is checked BEFORE the session cookie. A token-authenticated request:
 *   - Is marked `readonly: true` so the server refuses all mutating methods with 403.
 *   - Returns actor `automation@console` so machine reads are distinguishable in audit logs.
 *   - Issues NO session cookie — it can never become an interactive session.
 *   - Fails closed when CONSOLE_AUTOMATION_TOKEN is absent: bearer tokens are simply not accepted.
 */
export function createAuth(): ConsoleAuth {
  // Automation token — loaded from the environment (Secret Manager injects it at startup).
  // Empty string means unconfigured; the path is disabled entirely (fail closed).
  const automationToken = process.env.CONSOLE_AUTOMATION_TOKEN ?? '';

  // OIDC mode: the sole interactive authenticated path.
  const googleClientId = process.env.CONSOLE_GOOGLE_CLIENT_ID ?? '';
  const googleClientSecret = process.env.CONSOLE_GOOGLE_CLIENT_SECRET ?? '';
  if (googleClientId && googleClientSecret) {
    const sessionSecret = process.env.CONSOLE_SESSION_SECRET || googleClientSecret;
    return {
      mode: 'google',
      check(req) {
        // 1. Automation bearer token — checked first, API-only, read-only.
        //    Only available when the secret is configured.
        if (automationToken) {
          const authHeader = (req.headers as Record<string, string>).authorization ?? '';
          if (authHeader.startsWith('Bearer ')) {
            // A bearer token is presented. Either it matches (and we authenticate as
            // automation@console) or it is wrong (and we refuse immediately — never fall
            // through to session-cookie auth, which would let a bad token silently degrade
            // to a cookie check).
            if (checkBearerToken(authHeader, automationToken)) {
              return { ok: true, actor: AUTOMATION_ACTOR, readonly: true };
            }
            return { ok: false };
          }
        }

        // 2. Session cookie — the OIDC-issued interactive credential.
        const cookieHeader = (req.headers as Record<string, string>).cookie ?? '';
        const cookies = parseCookieHeader(cookieHeader);
        const val = cookies[OIDC_SESSION_COOKIE];
        if (!val) return { ok: false };
        // Reject explicitly revoked sessions (server-side invalidation for sign-out).
        if (revokedSessions.has(val)) return { ok: false };
        const email = parseSessionCookie(val, sessionSecret);
        if (!email) return { ok: false };
        return { ok: true, actor: email, readonly: false };
      },
    };
  }

  // Fails CLOSED: with no OIDC credential configured the console serves nothing rather than
  // serving a production control plane to the internet. There is no credential back door.
  // The automation token is also refused — it is only available in authenticated deployments.
  return {
    mode: 'open',
    check: () => ({ ok: false }),
  };
}

// ── Write actions — the audited surface ────────────────────────────────────────────────────────

export const WRITE_ROUTES = [
  '/api/actions/dispatch',
  // The console MCP endpoint (POST /mcp) uses HTTP POST as the JSON-RPC 2.0 transport — it is NOT
  // a data-write route. All exposed tools are read-only by construction. Declared here so the
  // "every mutating route must be declared" guard passes; the route comment + the readonly-exemption
  // in the auth middleware distinguish it from the audited write operations below.
  '/mcp',
  // ── E2E trigger. Starts a Cloud Run job execution and creates an EvalRun record.
  // Audited with the authenticated operator's email as actor.
  '/api/e2e/runs',
  // ── E2E run delete. Removes a run + all child records (cascade). Refuses running runs.
  // Same authorization as the trigger: OIDC session only (automation token is read-only).
  // Audit row is written BEFORE the delete attempt.
  '/api/e2e/runs/:run_id',
  // ── The Data section. Every one of these changes a real account or a real tenant's data, so
  // every one of them is audited BY CONSTRUCTION: this list is what the guard test checks a
  // mutating route against, and an unlisted POST/DELETE fails the build rather than shipping.
  '/api/tenants/accounts/comp',
  '/api/tenants/accounts/lock',
  '/api/tenants/accounts/purge',
  '/api/tenants/test/create',
  '/api/tenants/test/delete',
  '/api/tenants/test/password',
  '/api/tenants/test/seed',
  '/api/tenants/test/reset',
  '/api/tenants/test/clock',
] as const;

interface AuditRow {
  at: string;
  actor: string;
  action: string;
  target: string;
  outcome: 'attempted' | 'succeeded' | 'failed';
  detail?: string;
}
const auditLog: AuditRow[] = [];

/** Reset the audit log — for test isolation only. Never call in production code. */
export function _resetAuditLog(): void {
  auditLog.length = 0;
}

/**
 * The audit row is written BEFORE the attempt and updated after.
 *
 * Auditing only on success loses exactly the interesting cases: the crash mid-write, the provider
 * timeout, the permission denial. Those are the rows you want at 3am.
 */
async function audited<T>(actor: string, action: string, target: string, fn: () => Promise<T>): Promise<T> {
  const row: AuditRow = { at: new Date().toISOString(), actor, action, target, outcome: 'attempted' };
  auditLog.unshift(row);
  if (auditLog.length > 500) auditLog.pop();
  try {
    const out = await fn();
    row.outcome = 'succeeded';
    return out;
  } catch (e) {
    row.outcome = 'failed';
    row.detail = (e as Error).message.slice(0, 300);
    throw e;
  }
}

// ── Server ─────────────────────────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Every route this server registers, as `METHOD /full/path`.
 *
 * Recorded from Fastify's own `onRoute` hook rather than parsed out of `printRoutes()`, which
 * renders a tree for humans and COLLAPSES shared prefixes: six routes under `/api/tenants/...`
 * print as `/comp`, `/lock`, `/purge`.
 *
 * That was survivable while every write route sat at the top level and printed in full — the audit
 * guard worked, and it failed loudly the moment routes nested. The reason to fix it properly rather
 * than adjust the parser is the case that would NOT fail loudly: a nested path whose collapsed
 * fragment happens to match a declared entry would pass the guard while checking a different route
 * than the one registered.
 */
export const REGISTERED_ROUTES: string[] = [];

export function buildServer(
  registry = buildRegistry(),
  auth = createAuth(),
  /** Eval-store provider — defaults to the lazy process-wide singleton. Overridden in tests. */
  evalStoreGetter: () => Promise<PgCpResultsBackend | null> = getEvalStore,
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  REGISTERED_ROUTES.length = 0;
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) REGISTERED_ROUTES.push(`${m} ${r.url}`);
  });

  // Health is public — a probe cannot hold a credential, and it reveals nothing.
  app.get('/healthz', async () => ({ status: 'ok', service: 'forge-console', env: ENV }));

  // ── OIDC config — read once and close over it for the routes below ──
  const oidcClientId = process.env.CONSOLE_GOOGLE_CLIENT_ID ?? '';
  const oidcClientSecret = process.env.CONSOLE_GOOGLE_CLIENT_SECRET ?? '';
  const oidcSessionSecret = process.env.CONSOLE_SESSION_SECRET || oidcClientSecret;
  const oidcPublicUrl =
    (process.env.CONSOLE_PUBLIC_URL ?? '').replace(/\/$/, '') || `http://localhost:${PORT}`;
  const secureCookies = !process.env.CONSOLE_INSECURE_COOKIES;
  const cookieFlags = (maxAge: number, path = '/') =>
    `HttpOnly; ${secureCookies ? 'Secure; ' : ''}SameSite=Lax; Path=${path}; Max-Age=${maxAge}`;

  // `/login` is the ONLY page an unauthenticated user can see. `/auth/*` is the OAuth round-trip
  // that page initiates (signout stays public so an expired cookie can still sign out without a
  // redirect loop); `/healthz` is the probe contract (a probe cannot hold a credential and the
  // payload reveals nothing); the favicons are what lets the login page itself carry the mark.
  // Every other path — the SPA, its assets, every API — requires a session.
  //
  // NOTE: We strip the query string before matching — /auth/callback?code=…&state=… must match
  // /auth/callback.  This is a correctness fix for any public path that could carry query params.
  const PUBLIC_PATHS = new Set([
    '/healthz',
    '/favicon.svg',
    '/favicon.ico',
    '/login',
    '/auth/login',
    '/auth/callback',
    '/auth/signout',
    // RFC 9728 MCP protected-resource discovery doc — must be public so MCP clients can
    // discover the auth server before they have a token.
    '/.well-known/oauth-protected-resource/mcp',
    // ⛔ MACHINE endpoint — exempt from the SESSION wall, NOT from authentication. The e2e-runner
    // Cloud Run job reports its progress here carrying a Google-signed OIDC identity token, and the
    // route verifies that token and the exact service-account email itself before touching the
    // store. A browser session is the wrong credential for a job that has no browser; requiring one
    // is why a run's counters could never reach this console at all. Interactive login remains
    // Google-only — this is not a login path.
    '/ingest/run-progress',
  ]);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Strip query string for the allowlist check.
    const reqPath = req.url.split('?')[0] ?? req.url;
    if (PUBLIC_PATHS.has(reqPath)) return;
    const r = auth.check(req);
    if (!r.ok) {
      // Browser navigation lands on the login page — in EVERY auth mode, including unconfigured
      // fail-closed (the page then says sign-in is unavailable instead of serving raw JSON).
      // API calls and MCP protocol paths get 401 so clients handle them programmatically.
      // The /mcp path is a machine-facing JSON-RPC endpoint, not a browsing context.
      if (!reqPath.startsWith('/api/') && !reqPath.startsWith('/mcp')) {
        void reply.code(302).header('Location', '/login').send('');
        return;
      }
      reply.code(401).send({ error: { code: 'unauthorized', message: 'authentication required' } });
      return;
    }

    // Automation token is read-only by construction: every audited write route refuses it.
    // This check is at the transport layer — not duplicated per handler — so there is no way
    // for a future write route to escape the constraint by omitting a per-handler check.
    //
    // EXCEPTION: the console MCP endpoint (POST /mcp) uses HTTP POST as the JSON-RPC 2.0
    // transport — its tools are read-only by design and the automation token is the intended
    // auth credential for agent callers. The MCP route itself enforces read-only semantics.
    if (r.readonly && /^(POST|PUT|PATCH|DELETE)$/i.test(req.method) && !reqPath.startsWith('/mcp')) {
      reply.code(403).send({
        error: {
          code: 'forbidden',
          message: 'automation token is read-only — use a human Google session to perform writes',
        },
      });
    }
  });

  // ── The login page — the one unauthenticated page ────────────────────────────────────────────
  //
  // Server-rendered, standalone HTML: the SPA and its assets stay entirely behind the session, so
  // an unauthenticated visitor sees exactly this page and nothing else. States the access policy
  // outright — Google sign-in only, mardash.ai members only — because an operator refused at the
  // door should be told the rule, not left guessing. Hex values are hardcoded from tokens.css for
  // the same reason as the favicon: no CSS cascade exists outside the SPA.
  const LOGIN_ERRORS: Record<string, string> = {
    access_denied: 'That Google account is not a member of the mardash.ai organization — access refused.',
    state_mismatch: 'The sign-in attempt could not be validated (state mismatch). Try again.',
    token_exchange_failed: 'Google did not complete the sign-in (token exchange failed). Try again.',
    no_code: 'Google returned no authorization code. Try again.',
    no_id_token: 'Google returned no identity token. Try again.',
  };

  app.get('/login', async (req, reply) => {
    // An authenticated visitor has no business on the login page — straight to the console.
    if (auth.check(req).ok) {
      return reply.code(302).header('Location', '/').send('');
    }
    const q = req.query as { error?: string; signed_out?: string };
    const errKey = q.error ?? '';
    const errMsg = errKey ? (LOGIN_ERRORS[errKey] ?? `Sign-in failed (${errKey}). Try again.`) : '';
    const signedOut = q.signed_out === '1';
    // After a sign-out, the button carries prompt=select_account so Google presents the account
    // chooser instead of silently re-using the identity that just signed out.
    const loginHref = signedOut ? '/auth/login?prompt=select_account' : '/auth/login';
    const configured = auth.mode === 'google';
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>forge console — sign in</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { min-height: 100vh; display: grid; place-items: center; background: #0A0D0C; color: #E8ECEA;
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .card { width: min(400px, calc(100vw - 32px)); background: #101514; border: 1px solid #363E3B;
          border-radius: 10px; padding: 28px; }
  .mark { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
  .mark h1 { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
  .mark h1 span { color: #8B9490; font-weight: 400; }
  p.policy { color: #8B9490; font-size: 12.5px; margin-bottom: 20px; }
  p.policy strong { color: #B8C0BC; font-weight: 500; }
  .err { border: 1px solid #C2410C; background: rgba(194, 65, 12, 0.12); color: #FFC48A;
         border-radius: 6px; padding: 10px 12px; font-size: 12.5px; margin-bottom: 16px; }
  .info { border: 1px solid #363E3B; background: rgba(54, 62, 59, 0.25); color: #B8C0BC;
          border-radius: 6px; padding: 10px 12px; font-size: 12.5px; margin-bottom: 16px; }
  a.btn { display: block; text-align: center; background: #FF8A3C; color: #0A0D0C; font-weight: 600;
          text-decoration: none; border-radius: 6px; padding: 10px 14px; font-size: 13.5px; }
  a.btn:hover { background: #FFC48A; }
  .unavail { border: 1px dashed #363E3B; color: #8B9490; border-radius: 6px; padding: 10px 12px;
             font-size: 12.5px; text-align: center; }
</style>
</head>
<body>
  <main class="card">
    <div class="mark">
      <img src="/favicon.svg" width="28" height="28" alt="">
      <h1>forge <span>console</span></h1>
    </div>
    ${errMsg ? `<div class="err" role="alert">${esc(errMsg)}</div>` : ''}
    ${signedOut && !errMsg ? `<div class="info" role="status">You have signed out.</div>` : ''}
    <p class="policy">This is the operator pane for the production estate. Sign-in is via
    <strong>Google only</strong>, and access is restricted to members of the
    <strong>mardash.ai</strong> organization. There is no other way in.</p>
    ${
      configured
        ? `<a class="btn" href="${loginHref}">Sign in with Google</a>`
        : `<div class="unavail">Sign-in is unavailable — no identity provider is configured on this deployment.</div>`
    }
  </main>
</body>
</html>`;
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  });

  // ── Google OIDC routes ───────────────────────────────────────────────────────────────────────
  //
  // Registered only when the Google credentials are present.  The routes are in PUBLIC_PATHS
  // regardless so that a mis-hit against an unconfigured server just falls through to the SPA
  // 404 handler rather than hitting the auth gate and looping.

  if (oidcClientId && oidcClientSecret) {
    const redirectUri = `${oidcPublicUrl}/auth/callback`;

    /**
     * GET /auth/login — redirect the browser to Google's authorization endpoint.
     *
     * A random state nonce is generated and stored in a short-lived HttpOnly cookie.  The nonce
     * is echoed back by Google in the callback query string; matching it against the cookie is the
     * CSRF protection for the OAuth flow.
     *
     * The `hd` parameter is a COSMETIC HINT to Google's consent screen ("prefer a mardash.ai
     * account").  It is NOT a security control.  The actual enforcement is the `hd` claim check
     * inside verifyGoogleIdToken on the callback route.
     */
    app.get('/auth/login', async (req, reply) => {
      const q = req.query as { prompt?: string };
      const state = randomBytes(16).toString('hex');
      const url = new URL(GOOGLE_OAUTH_URL);
      url.searchParams.set('client_id', oidcClientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('hd', REQUIRED_HD); // cosmetic hint only
      // prompt=select_account is requested after sign-out so Google presents the account chooser
      // rather than silently re-using the last identity. This is a deliberate UX choice, not a
      // security control — the hd enforcement in verifyGoogleIdToken is the enforced boundary.
      if (q.prompt === 'select_account') {
        url.searchParams.set('prompt', 'select_account');
      }
      reply.header(
        'Set-Cookie',
        `${OIDC_STATE_COOKIE}=${state}; ${cookieFlags(OIDC_STATE_MAX_AGE_S, '/auth')}`,
      );
      reply.code(302);
      reply.header('Location', url.toString());
      return reply.send('');
    });

    /**
     * GET /auth/callback — receive the authorization code, exchange it, verify the ID token.
     *
     * Security steps in order:
     *   1. Reject Google error responses (e.g. `error=access_denied`).
     *   2. Verify the state param matches the cookie — CSRF protection.
     *   3. Exchange the code for tokens via Google's token endpoint.
     *   4. verifyGoogleIdToken() checks alg, iss, aud, exp, hd==mardash.ai, email_verified, sig.
     *   5. Issue a signed HMAC session cookie carrying the authenticated email.
     *
     * A non-mardash.ai Google account fails step 4 and is REFUSED — not challenged, not given
     * another attempt.
     */
    app.get('/auth/callback', async (req, reply) => {
      const q = req.query as { code?: string; state?: string; error?: string };

      if (q.error) {
        return reply
          .code(302)
          .header('Location', `/login?error=${encodeURIComponent(q.error)}`)
          .send('');
      }

      // CSRF: state param must match the cookie we set in /auth/login.
      const reqCookies = parseCookieHeader((req.headers as Record<string, string>).cookie ?? '');
      const stateCookie = reqCookies[OIDC_STATE_COOKIE] ?? '';
      if (!q.state || !stateCookie || q.state !== stateCookie) {
        return reply.code(302).header('Location', '/login?error=state_mismatch').send('');
      }

      if (!q.code) {
        return reply.code(302).header('Location', '/login?error=no_code').send('');
      }

      // Exchange authorization code for tokens.
      let idToken: string | null = null;
      try {
        const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: q.code,
            client_id: oidcClientId,
            client_secret: oidcClientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }).toString(),
          signal: AbortSignal.timeout(15_000),
        });
        if (!tokenRes.ok) {
          return reply.code(302).header('Location', '/login?error=token_exchange_failed').send('');
        }
        const tokens = (await tokenRes.json()) as { id_token?: string };
        idToken = tokens.id_token ?? null;
      } catch {
        return reply.code(302).header('Location', '/login?error=token_exchange_failed').send('');
      }

      if (!idToken) {
        return reply.code(302).header('Location', '/login?error=no_id_token').send('');
      }

      // Verify ID token — aud, hd (mardash.ai enforcement), signature.
      let claims: GoogleIdClaims | null = null;
      try {
        claims = await verifyGoogleIdToken(idToken, oidcClientId);
      } catch {
        // verifyGoogleIdToken returns null on failure but could throw on unexpected input
      }

      if (!claims) {
        // Wrong domain, expired token, invalid signature, etc. Refuse and do not fall back.
        return reply.code(302).header('Location', '/login?error=access_denied').send('');
      }

      // Issue a signed session cookie. The actor is the verified email, recorded in every
      // subsequent audit log row — not a shared username.
      const sessionVal = makeSessionCookie(claims.email, oidcSessionSecret);
      reply.header('Set-Cookie', [
        `${OIDC_SESSION_COOKIE}=${sessionVal}; ${cookieFlags(OIDC_SESSION_MAX_AGE_S)}`,
        `${OIDC_STATE_COOKIE}=; ${cookieFlags(0, '/auth')}`, // clear the CSRF cookie
      ]);
      return reply.code(302).header('Location', '/').send('');
    });
  }

  const actorOf = (req: FastifyRequest): string => {
    const r = auth.check(req);
    return r.ok ? r.actor : 'anonymous';
  };

  // ── Sign-out ─────────────────────────────────────────────────────────────────────────────────
  //
  // Registered unconditionally (OIDC and open modes). In open mode there is no session to revoke,
  // but the route still clears whatever cookie might be present and redirects to /auth/login so a
  // browser that lands here always ends up in the right place.
  //
  // The route is in PUBLIC_PATHS so the auth gate does not intercept it — signing out with an
  // already-expired cookie must not loop back to /auth/login before we can clear it.
  //
  // After clearing the cookie, the redirect includes prompt=select_account so Google's next
  // authorization presents the account chooser rather than silently re-using the last identity.

  app.get('/auth/signout', async (req, reply) => {
    // Resolve the actor BEFORE revoking — afterwards the cookie no longer authenticates anyone.
    const actor = actorOf(req);
    const cookies = parseCookieHeader((req.headers as Record<string, string>).cookie ?? '');
    const sessionVal = cookies[OIDC_SESSION_COOKIE];
    // Server-side invalidation: the raw cookie value is added to the revocation set so any
    // concurrent or future request carrying the same token is rejected even before its HMAC expiry.
    if (sessionVal) revokedSessions.add(sessionVal);
    // The session's end is recorded next to everything the session did. An anonymous signout
    // (expired/absent cookie) is not an event worth a row.
    if (actor !== 'anonymous') await audited(actor, 'auth.signout', actor, async () => undefined);
    reply.header('Set-Cookie', `${OIDC_SESSION_COOKIE}=; ${cookieFlags(0)}`);
    // Land on the login page — the one unauthenticated page — which offers the account chooser
    // (prompt=select_account) for the next sign-in.
    return reply.code(302).header('Location', '/login?signed_out=1').send('');
  });

  // ── Reads ──

  app.get('/api/bootstrap', async (req) => {
    const c = ctx();
    const health = await Promise.all(
      registry.all().map(async (p) => ({
        provider_id: p.id,
        label: p.label,
        kind: p.kind,
        ...(await p.health(c)),
      })),
    );
    return envelope({
      env: ENV,
      project: PROJECT,
      region: REGION,
      auth: auth.mode,
      actor: actorOf(req),
      providers: health,
    });
  });

  // ── Identity ─────────────────────────────────────────────────────────────────────────────────
  //
  // A lightweight endpoint for the SPA to read the current operator's identity without waiting for
  // the full bootstrap (which fans out to all providers). Returns only the authenticated email so
  // the UI can display it immediately. The identity is also included in /api/bootstrap for screens
  // that render after the full load.

  app.get('/api/me', async (req) => {
    return { email: actorOf(req) };
  });

  app.get('/api/inventory', async () => {
    const c = ctx();
    const provs = registry.byKind('inventory', ENV) as InventoryProvider[];
    const { items, sources } = await aggregate(provs, (p) => p.list(c));
    return envelope(items, sources);
  });

  app.get('/api/services', async () => {
    const c = ctx();
    const inv = registry.byKind('inventory', ENV) as InventoryProvider[];
    const pipes = registry.byKind('pipelines', ENV) as PipelinesProvider[];
    const [invRes, pipeRes] = await Promise.all([
      aggregate(inv, (p) => p.list(c)),
      aggregate(pipes, (p) => (p.supports('pipelines.list') ? p.listPipelines(c) : Promise.resolve([]))),
    ]);
    const graph = buildServiceGraph({
      resources: invRes.items,
      pipelines: pipeRes.items,
      repos: GH_REPOS.map((r) => `${GH_OWNER}/${r}`),
      hostBackends: {},
    });
    return envelope(graph, [...invRes.sources, ...pipeRes.sources]);
  });

  app.get('/api/pipelines/runs', async (req) => {
    const q = req.query as { limit?: string };
    const c = ctx();
    const provs = registry.byKind('pipelines', ENV) as PipelinesProvider[];
    const { items, sources } = await aggregate(provs, (p) =>
      p.supports('pipelines.runs') ? p.listRuns({ limit: Number(q.limit ?? 20) }, c) : Promise.resolve([]),
    );
    return envelope(items, sources);
  });

  app.get('/api/pipelines', async () => {
    const c = ctx();
    const provs = registry.byKind('pipelines', ENV) as PipelinesProvider[];
    const { items, sources } = await aggregate(provs, (p) =>
      p.supports('pipelines.list') ? p.listPipelines(c) : Promise.resolve([]),
    );
    return envelope(items, sources);
  });

  /*
   * The top-line product metrics are DEFINED in a Grafana dashboard and read from it here — see
   * metrics-catalog.ts for why they are not also written down in this repo. The short answer: they
   * were, in both places, and both copies computed tool errors from a metric that is never emitted.
   */
  const catalog = createGrafanaCatalog({
    origin: process.env.CONSOLE_GRAFANA_URL,
    user: process.env.CONSOLE_GRAFANA_USER,
    pass: process.env.CONSOLE_GRAFANA_PASS,
    dashboardUid: process.env.CONSOLE_TOPLINE_DASHBOARD ?? 'dorinda-product-topline',
  });

  app.get('/api/metrics/catalog', async () => envelope(await catalog.get(AbortSignal.timeout(10_000))));

  /*
   * The Dorinda-folder boards, embedded rather than redrawn.
   *
   * Tokens are resolved live and re-published when missing — Grafana's database here is SQLite on an
   * ephemeral filesystem, so a redeploy wipes every token and any URL held as configuration would
   * rot silently.
   */
  const boards = createGrafanaBoards({
    origin: process.env.CONSOLE_GRAFANA_URL,
    user: process.env.CONSOLE_GRAFANA_USER,
    pass: process.env.CONSOLE_GRAFANA_PASS,
    folder: process.env.CONSOLE_GRAFANA_FOLDER ?? 'Dorinda',
  });

  app.get('/api/boards', async (req) => {
    // `?refresh=1` forces a re-resolve, which is the recovery path straight after a Grafana deploy.
    if ((req.query as { refresh?: string }).refresh) boards.invalidate();
    return envelope(await boards.list(AbortSignal.timeout(20_000)));
  });

  app.get('/api/metrics', async (req) => {
    const q = req.query as { intent?: string; service?: string; minutes?: string; metric?: string };
    const intent = (q.intent ?? 'request_rate') as MetricIntent;
    const end = new Date();
    const minutes = Number(q.minutes ?? 60);
    const range = {
      start: new Date(end.getTime() - minutes * 60_000),
      end,
      step_seconds: Math.max(60, Math.floor((minutes * 60) / 120)),
    };
    const c = ctx();
    const provs = registry.byKind('metrics', ENV) as MetricsProvider[];

    /*
     * A CATALOG metric runs the dashboard's own PromQL, verbatim.
     *
     * Resolved by id against the catalog rather than taking an expression from the query string:
     * accepting arbitrary PromQL from a URL would make this an open query proxy into the metrics
     * store, and the id indirection means the only expressions this can ever run are ones a human
     * put on the dashboard.
     */
    if (q.metric) {
      const cat = await catalog.get(AbortSignal.timeout(10_000));
      if (cat.error) {
        return envelope({
          series: [],
          provider_id: 'grafana-catalog',
          empty_reason: 'not_supported',
          detail: cat.error,
        });
      }
      const m = cat.metrics.find((x) => x.id === q.metric);
      if (!m) {
        return envelope({
          series: [],
          provider_id: 'grafana-catalog',
          empty_reason: 'not_supported',
          detail: `no catalog metric "${q.metric}"`,
        });
      }
      const native = provs.find((p) => p.supports('metrics.native') && p.queryNative);
      if (!native) {
        return envelope({
          series: [],
          provider_id: 'none',
          empty_reason: 'not_supported',
          detail: 'no provider can run raw PromQL',
        });
      }
      // Grafana macros are resolved against the console's OWN window, exactly as Grafana resolves
      // them against the dashboard's. Passing `[$__range]` through would be a parse error at
      // Prometheus, and the panel would fail for a reason unrelated to the metric.
      const expr = resolveGrafanaMacros(m.expr, minutes * 60);
      const r = await native.queryNative!(expr, range, c);
      return envelope(r, [{ provider_id: native.id, ok: true }]);
    }
    const target = { runtime_id: q.service ?? 'dorinda-api', env: ENV };
    const usable = provs.filter((p) => p.supportsIntent(intent, target));
    if (usable.length === 0) {
      return envelope({
        series: [],
        provider_id: 'none',
        empty_reason: 'not_supported',
        detail: `no provider answers "${intent}"`,
      });
    }
    const results = await Promise.all(usable.map((p) => p.query(intent, target, range, c)));
    // Prefer a provider that actually returned data; otherwise keep the first result SO THAT its
    // empty_reason survives — that explanation is the whole point.
    const withData = results.find((r) => r.series.length > 0);
    return envelope(
      withData ?? results[0]!,
      usable.map((p) => ({ provider_id: p.id, ok: true })),
    );
  });

  app.get('/api/logs', async (req) => {
    const q = req.query as {
      service?: string;
      text?: string;
      severity?: string;
      minutes?: string;
      limit?: string;
      trace?: string;
      owner?: string;
      data_set?: string;
    };
    const end = new Date();
    const minutes = Number(q.minutes ?? 60);
    const c = ctx();
    const provs = registry.byKind('logs', ENV) as LogsProvider[];
    const limit = Number(q.limit ?? 100);
    const { items, sources } = await aggregate(provs, (p) =>
      p.query(
        {
          ...(q.service ? { runtime_id: q.service } : {}),
          ...(q.text ? { text: q.text } : {}),
          ...(q.severity ? { severity_at_least: q.severity as never } : {}),
          /*
           * Trace correlation, which the provider always supported and the route never exposed.
           *
           * This is the question an incident actually starts from: "one request failed — show me
           * everything that request did, across every service it touched." Without it an operator
           * greps a message string and hopes, which finds the line they already had and none of the
           * ones around it.
           */
          ...(q.trace ? { trace_id: q.trace } : {}),
          /*
           * The test/production split, defaulting to PRODUCTION.
           *
           * Defaulted here rather than in the UI so the API answers the same way to any caller — a
           * curl, a future CLI, a script. A log view that silently includes fixture traffic is one an
           * operator learns to distrust, and this estate deliberately runs fixtures in production
           * because a staging environment is a cost the business has chosen not to carry.
           */
          data_set: (q.data_set as 'production' | 'test' | 'all') ?? 'production',
          /*
           * Filter by OWNER ID, never by email.
           *
           * The console shows a list of emails and resolves the chosen one to an owner before
           * asking — dorinda-api writes only the opaque id into its logs, deliberately, because
           * Cloud Logging retains entries outside the app's database and an email written there
           * would survive the account being deleted. The operator's experience is identical; the
           * durable artefact carries no personal data.
           */
          ...(q.owner ? { owner: q.owner } : {}),
        },
        { start: new Date(end.getTime() - minutes * 60_000), end, limit },
        c,
      ),
    );
    /*
     * ⛔ SAY WHEN THE ANSWER IS SHORTER THAN THE QUESTION.
     *
     * Logs come back newest-first, so hitting the row limit means the response covers a WINDOW
     * SMALLER than the one asked for — and silently so. During the 2026-07-31 acceptance run a
     * 190-minute query returned 400 rows spanning 20 minutes, and "no 5xx in the last 190 minutes"
     * was about to be recorded as a pass from data that never reached back that far. An all-clear
     * derived from an unstated truncation is exactly the false green this console exists to end.
     */
    const oldest = items.length ? items[items.length - 1]!.timestamp : null;
    const truncated = items.length >= limit;
    return envelope(items, sources, {
      ...(truncated && oldest
        ? {
            note:
              `showing the newest ${items.length} lines — they cover back to ${oldest}, ` +
              `NOT the full ${minutes}m requested. Narrow the filter or raise the limit to see further back.`,
          }
        : {}),
    });
  });

  app.get('/api/findings', async () => {
    const c = ctx();
    const inv = registry.byKind('inventory', ENV) as InventoryProvider[];
    const pipes = registry.byKind('pipelines', ENV) as PipelinesProvider[];
    const creds = registry.byKind('credentials', ENV) as CredentialsProvider[];
    const metrics = registry.byKind('metrics', ENV) as MetricsProvider[];

    const [invRes, runRes, credRes] = await Promise.all([
      aggregate(inv, (p) => p.list(c)),
      aggregate(pipes, (p) =>
        p.supports('pipelines.runs') ? p.listRuns({ limit: 30 }, c) : Promise.resolve([]),
      ),
      aggregate(creds, (p) => p.list(c)),
    ]);

    // Certificates carry their own expiry; fold them into the credential list so one rule covers both.
    const certCreds = invRes.items
      .filter((r) => r.kind === 'certificate' && r.attributes['expires_at'])
      .map((r) => ({
        id: r.external_id,
        env: r.env,
        kind: 'tls_certificate' as const,
        name: r.name,
        expires_at: String(r.attributes['expires_at']),
        auto_renews: true,
        source: 'discovered' as const,
      }));

    // Ask the STORE whether it is ingesting, never a single metric — see isIngesting().
    const gmp = metrics.find((p) => p.type === 'gcp.managed-prometheus');
    const ingesting = gmp?.isIngesting ? await gmp.isIngesting(c) : true;

    const graph = buildServiceGraph({
      resources: invRes.items,
      pipelines: [],
      repos: GH_REPOS.map((r) => `${GH_OWNER}/${r}`),
      hostBackends: {},
    });

    const findings: Finding[] = runFindings({
      resources: invRes.items,
      graph,
      credentials: [...credRes.items, ...certCreds],
      runs: runRes.items,
      metricsIngesting: ingesting,
      now: new Date(),
    });
    return envelope(findings, [...invRes.sources, ...runRes.sources]);
  });

  app.get('/api/credentials', async () => {
    const c = ctx();
    const provs = registry.byKind('credentials', ENV) as CredentialsProvider[];
    const { items, sources } = await aggregate(provs, (p) => p.list(c));
    // Soonest expiry first: the whole point of this view is "what bites me next".
    const sorted = items.slice().sort((a, b) => {
      if (a.expires_at && b.expires_at) return a.expires_at.localeCompare(b.expires_at);
      if (a.expires_at) return -1;
      if (b.expires_at) return 1;
      return a.name.localeCompare(b.name);
    });
    return envelope(sorted, sources);
  });

  app.get('/api/audit', async () => envelope(auditLog.slice(0, 100)));

  // ── Runtime: what is serving, and what you could roll back to ──

  app.get('/api/runtime/revisions', async (req) => {
    const q = req.query as { service?: string };
    if (!q.service) return envelope([] as Revision[], [], {});
    const c = ctx();
    const provs = registry.byKind('runtime', ENV) as RuntimeProvider[];
    const { items, sources } = await aggregate(provs, (p) => p.listRevisions(q.service!, c));
    return envelope(items, sources);
  });

  // ── Alerts: is anything watching, and does it reach a human? ──

  app.get('/api/alerts', async () => {
    const c = ctx();
    const provs = registry.byKind('alerts', ENV) as AlertsProvider[];
    const [pol, inc] = await Promise.all([
      aggregate(provs, (p) => p.listPolicies(c)),
      aggregate(provs, (p) => p.listFiring(c)),
    ]);
    return envelope({ policies: pol.items, firing: inc.items }, pol.sources);
  });

  // ── Drift: all three axes ──

  app.get('/api/drift', async () => {
    const c = ctx();
    const provs = registry.byKind('drift', ENV) as DriftProvider[];
    const { items, sources } = await aggregate(provs, (p) => p.listStacks(c));
    const latest = await Promise.all(provs.map((p) => p.latestRelease(c).catch(() => null)));
    // CI pin drift: the axis that let a shipped fix sit unadopted in twelve of fourteen workflows.
    const pins = (await Promise.all(provs.map((p) => p.listPinDrift(c).catch(() => [])))).flat();
    return envelope(
      { stacks: items, latest_release: latest.find(Boolean) ?? null, pin_drift: pins },
      sources,
    );
  });

  // ── Cost ──

  app.get('/api/cost', async () => {
    const c = ctx();
    const provs = registry.byKind('cost', ENV) as CostProvider[];
    const { items, sources } = await aggregate(provs, (p) => p.listBudgets(c));
    const inv = registry.byKind('inventory', ENV) as InventoryProvider[];
    const invRes = await aggregate(inv, (p) => p.list(c));
    // No BigQuery billing export exists, so there are no actuals to show. Saying that plainly beats
    // an empty chart, which reads as "you spent nothing".
    return envelope(
      {
        budgets: items,
        actuals: null as null,
        actuals_detail:
          'Actual spend needs a BigQuery billing export, which is not configured. Budgets and the ' +
          'billable-resource inventory below are what the console can prove.',
        billable: invRes.items.filter((r) => r.billable),
      },
      [...sources, ...invRes.sources],
    );
  });

  // ── Quota headroom ──

  app.get('/api/quota', async () => {
    const c = ctx();
    const inv = registry.byKind('inventory', ENV) as InventoryProvider[];
    const metrics = registry.byKind('metrics', ENV) as MetricsProvider[];
    const invRes = await aggregate(inv, (p) => p.list(c));

    const end = new Date();
    const range = { start: new Date(end.getTime() - 24 * 3600_000), end, step_seconds: 300 };
    const cm = metrics.find((p) => p.type === 'gcp.cloud-monitoring');

    const peakInstances = new Map<string, number>();
    let peakDb: number | null = null;
    if (cm) {
      const services = invRes.items.filter((r) => r.kind === 'compute.service').slice(0, DEPLOY_SAMPLE);
      await Promise.all(
        services.map(async (s) => {
          const r = await cm.query('instance_count', { runtime_id: s.name, env: ENV }, range, c);
          const peak = Math.max(0, ...r.series.flatMap((x) => x.points.map((p) => p.v ?? 0)));
          if (r.series.length > 0) peakInstances.set(s.name, peak);
        }),
      );
      const db = await cm.query('db_connections', { runtime_id: '', env: ENV }, range, c);
      if (db.series.length > 0)
        peakDb = Math.max(0, ...db.series.flatMap((x) => x.points.map((p) => p.v ?? 0)));
    }

    const providerGauges: QuotaGauge[] = (
      await Promise.all(
        registry.all().map((p) => (p.quotas ? p.quotas(c).catch(() => []) : Promise.resolve([]))),
      )
    ).flat();

    return envelope(
      computeQuotas({ resources: invRes.items, peakInstances, peakDbConnections: peakDb, providerGauges }),
      invRes.sources,
    );
  });

  // ── The unified "what changed" timeline ──

  app.get('/api/timeline', async (req) => {
    const q = req.query as { hours?: string };
    const hours = Math.min(720, Math.max(1, Number(q.hours ?? 48)));
    const since = new Date(Date.now() - hours * 3600_000);
    const c = ctx();

    const pipes = registry.byKind('pipelines', ENV) as PipelinesProvider[];
    const inv = registry.byKind('inventory', ENV) as InventoryProvider[];
    const runtime = registry.byKind('runtime', ENV) as RuntimeProvider[];

    const [runRes, invRes] = await Promise.all([
      aggregate(pipes, (p) =>
        p.supports('pipelines.runs') ? p.listRuns({ limit: 50 }, c) : Promise.resolve([]),
      ),
      aggregate(inv, (p) => p.list(c)),
    ]);

    const services = invRes.items.filter((r) => r.kind === 'compute.service').slice(0, DEPLOY_SAMPLE);
    const revisions = await Promise.all(
      services.map(async (s) => ({
        service: s.name,
        revisions: await Promise.all(runtime.map((p) => p.listRevisions(s.name, c).catch(() => []))).then(
          (all) => all.flat(),
        ),
      })),
    );

    const events = buildTimeline({
      runs: runRes.items,
      revisions,
      // Findings carry `first_seen_at = now` on every sweep (they are recomputed, not stored), so
      // including them here would stamp every finding onto this second and drown the real changes.
      findings: [],
      audit: auditLog,
      since,
    });
    return envelope(events, [...runRes.sources, ...invRes.sources]);
  });

  // ── Docs, aggregated from every source (see docs.ts for the built-in vs live rule) ──

  /*
   * Registry order is READING order in the UI: platform internals first (the architecture you need
   * to hold the system in your head), then each app's own help pages.
   *
   * `dorinda-devs` is absent on purpose — it is being decommissioned, and its durable pages are now
   * the built-in source. Its two hand-transcribed cloud snapshots were dropped rather than imported;
   * the Inventory, Cost, Credentials and Headroom screens answer those questions from the live API.
   */
  const docSources: DocSource[] = [
    builtinSource(join(process.cwd(), 'src', 'console', 'docs', 'content')),
    webManifestSource({
      id: 'app',
      label: 'Dorinda app flows',
      origin: process.env.CONSOLE_APP_DOCS_ORIGIN ?? 'https://app.dorinda.ai',
    }),
  ];

  app.get('/api/docs', async () => {
    // Never 501 as a whole: one unreachable source reports itself and the others still render.
    return envelope({ sources: await indexAll(docSources, AbortSignal.timeout(15_000)) });
  });

  app.get('/api/docs/page', async (req, reply) => {
    const q = req.query as { p?: string };
    const ref = unqualify(q.p ?? '');
    if (!ref) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_page', message: 'page id must be `source:page`' } });
    }
    const source = findSource(docSources, ref.sourceId);
    if (!source) {
      return reply
        .code(404)
        .send({ error: { code: 'unknown_source', message: `no doc source ${ref.sourceId}` } });
    }
    try {
      return envelope(await source.getPage(ref.pageId, AbortSignal.timeout(15_000)));
    } catch (e) {
      return reply.code(502).send({ error: { code: 'docs_unavailable', message: (e as Error).message } });
    }
  });

  // Assets are namespaced by source: a built-in SVG and a remote one must not collide, and a path
  // from one source must never resolve against another's origin.
  app.get('/docs/asset/*', async (req, reply) => {
    const raw = (req.params as Record<string, string>)['*'] ?? '';
    const slash = raw.indexOf('/');
    const sourceId = slash === -1 ? '' : raw.slice(0, slash);
    const path = slash === -1 ? '' : raw.slice(slash + 1);
    const source = findSource(docSources, sourceId);
    if (!source) return reply.code(404).send('unknown doc source');
    try {
      const a = await source.getAsset(path, AbortSignal.timeout(15_000));
      return reply.type(a.contentType).header('cache-control', 'private, max-age=300').send(a.body);
    } catch (e) {
      return reply.code(502).send((e as Error).message);
    }
  });

  // ── Data — accounts and test tenants ──────────────────────────────────────────────────────────

  /*
   * The console reaches an app's data through the APP's own HTTP surface, never its database.
   *
   * That is slower than a query and it is the point: the app keeps its invariants — dorinda's
   * transactional local delete, the tombstone that signs a deleted user out, the two-marker
   * test-tenant guard — and the console never becomes a second, unaudited way to mutate a
   * datastore. Forge reaching into a consumer schema would also break the boundary its own tenant
   * cascade is deliberately careful to respect.
   */
  const tenants: TenantProvider[] = [
    createDorindaTenantProvider({
      origin: process.env.CONSOLE_DORINDA_API_ORIGIN ?? 'https://api.dorinda.ai',
      adminToken: process.env.CONSOLE_DORINDA_ADMIN_TOKEN,
      testToken: process.env.CONSOLE_DORINDA_TEST_TOKEN,
    }),
  ];
  const tenantProvider = (app_?: string): TenantProvider | undefined =>
    app_ ? tenants.find((t) => t.app === app_) : tenants[0];

  /** Map the APP's own error through, so a refusal reads as a refusal and not as "upstream error". */
  function tenantFail(reply: FastifyReply, e: unknown) {
    if (e instanceof TenantAppError) {
      return reply.code(e.status).send({ error: { code: e.code, message: e.message } });
    }
    return reply.code(502).send({ error: { code: 'tenant_unavailable', message: (e as Error).message } });
  }

  /** Resolve the provider or answer 501 — an unconfigured app is a STATE, not a failure. */
  function withTenants(req: FastifyRequest, reply: FastifyReply): TenantProvider | null {
    const t = tenantProvider((req.query as { app?: string })?.app ?? (req.body as { app?: string })?.app);
    if (!t) {
      reply
        .code(501)
        .send({ error: { code: 'not_configured', message: 'no tenant provider is configured' } });
      return null;
    }
    return t;
  }

  app.get('/api/tenants/accounts', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    if (!t.supports('accounts.list')) {
      return reply.code(501).send({
        error: {
          code: 'not_configured',
          // Named precisely: "not configured" with no name sends an operator hunting.
          message: 'no CONSOLE_DORINDA_ADMIN_TOKEN configured, so accounts cannot be read',
        },
      });
    }
    try {
      return envelope(await t.listAccounts(ctx()));
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.get('/api/tenants/accounts/detail', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const owner = (req.query as { owner?: string }).owner ?? '';
    if (!owner) return reply.code(400).send({ error: { code: 'bad_request', message: 'owner is required' } });
    try {
      return envelope(await t.getAccount(ctx(), owner));
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.post('/api/tenants/accounts/comp', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { owner?: string; comped?: boolean };
    if (!body?.owner || typeof body.comped !== 'boolean') {
      return reply
        .code(400)
        .send({ error: { code: 'bad_request', message: 'owner and comped are required' } });
    }
    try {
      return envelope(
        await audited(actorOf(req), `account.comp.${body.comped ? 'grant' : 'revoke'}`, body.owner, () =>
          t.setComp(ctx(), body.owner!, body.comped!),
        ),
      );
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.post('/api/tenants/accounts/lock', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { owner?: string; locked?: boolean };
    if (!body?.owner || typeof body.locked !== 'boolean') {
      return reply
        .code(400)
        .send({ error: { code: 'bad_request', message: 'owner and locked are required' } });
    }
    try {
      return envelope(
        await audited(actorOf(req), `account.${body.locked ? 'lock' : 'unlock'}`, body.owner, () =>
          t.setLocked(ctx(), body.owner!, body.locked!),
        ),
      );
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.post('/api/tenants/accounts/purge', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { owner?: string; confirm_email?: string; reason?: string };
    if (!body?.owner || !body.confirm_email) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: 'owner and confirm_email are required' },
      });
    }
    /*
     * A REASON is required, exactly as it is for a pipeline dispatch — and more so.
     *
     * This is the one console action that destroys a person's account. The audit row is the only
     * record of WHY it happened, and "someone with the operator password did it at 03:12" is not an
     * answer anybody can act on later.
     */
    if (!body.reason || body.reason.trim().length < 3) {
      return reply.code(422).send({
        error: { code: 'reason_required', message: 'a reason is required to purge an account' },
      });
    }
    try {
      const out = await audited(actorOf(req), 'account.purge', `${body.owner} · ${body.reason.trim()}`, () =>
        t.purge(ctx(), body.owner!, body.confirm_email!),
      );
      return envelope(out);
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.get('/api/tenants/connections', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    if (!t.supports('connections.read')) {
      return reply.code(501).send({
        error: {
          code: 'not_configured',
          message: 'no CONSOLE_DORINDA_ADMIN_TOKEN configured, so connectors cannot be read',
        },
      });
    }
    const hours = Number((req.query as { hours?: string }).hours ?? 24);
    try {
      return envelope(await t.connections(ctx(), Number.isFinite(hours) && hours > 0 ? hours : 24));
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.get('/api/tenants/test', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    try {
      return envelope({ tenants: await t.listTestTenants(ctx()), canWrite: t.supports('test.reset') });
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  /*
   * CREATE a test tenant. Audited like every other write, and keyed on the EMAIL rather than an
   * owner id — there is no owner yet, and the email is the thing the operator actually chose.
   */
  app.post('/api/tenants/test/create', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { email?: string; displayName?: string; password?: string };
    if (!body?.email)
      return reply.code(400).send({ error: { code: 'bad_request', message: 'email is required' } });
    try {
      return envelope(
        await audited(actorOf(req), 'test.create', body.email, () =>
          t.createTestTenant(ctx(), {
            email: body.email!,
            displayName: body.displayName,
            password: body.password,
          }),
        ),
      );
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  /*
   * ERASE a test tenant. Audited like every write, and requires the operator to retype the EMAIL —
   * the same control the real purge uses, for the same reason: the realistic mistake is never "I
   * didn't mean to delete a tenant", it is "I didn't mean to delete THAT one".
   */
  app.post('/api/tenants/test/delete', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { owner?: string; confirmEmail?: string };
    if (!body?.owner)
      return reply.code(400).send({ error: { code: 'bad_request', message: 'owner is required' } });
    try {
      return envelope(
        await audited(actorOf(req), 'test.delete', body.owner, () => t.deleteTestTenant(ctx(), body.owner!)),
      );
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  /*
   * Generate a password for a test tenant. Audited — but the RESPONSE carries a live credential, so
   * it is returned to the caller and never written to the audit row or a log line.
   */
  app.post('/api/tenants/test/password', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { owner?: string };
    if (!body?.owner)
      return reply.code(400).send({ error: { code: 'bad_request', message: 'owner is required' } });
    try {
      return envelope(
        await audited(actorOf(req), 'test.password', body.owner, () =>
          t.setTestTenantPassword(ctx(), body.owner!),
        ),
      );
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.post('/api/tenants/test/reset', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { owner?: string };
    if (!body?.owner)
      return reply.code(400).send({ error: { code: 'bad_request', message: 'owner is required' } });
    try {
      return envelope(
        await audited(actorOf(req), 'test.reset', body.owner, () => t.reset(ctx(), body.owner!)),
      );
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.post('/api/tenants/test/seed', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as { owner?: string; fixture?: unknown };
    if (!body?.owner)
      return reply.code(400).send({ error: { code: 'bad_request', message: 'owner is required' } });
    try {
      return envelope(
        await audited(actorOf(req), 'test.seed', body.owner, () =>
          t.seed(ctx(), body.owner!, body.fixture ?? {}),
        ),
      );
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.get('/api/tenants/test/clock', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const owner = (req.query as { owner?: string }).owner ?? '';
    if (!owner) return reply.code(400).send({ error: { code: 'bad_request', message: 'owner is required' } });
    try {
      return envelope(await t.getClock(ctx(), owner));
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  app.post('/api/tenants/test/clock', async (req, reply) => {
    const t = withTenants(req, reply);
    if (!t) return;
    const body = req.body as {
      owner?: string;
      at?: string;
      advance_ms?: number;
      settle?: boolean;
      max_rounds?: number;
      clear?: boolean;
    };
    if (!body?.owner)
      return reply.code(400).send({ error: { code: 'bad_request', message: 'owner is required' } });
    try {
      if (body.clear) {
        await audited(actorOf(req), 'test.clock.clear', body.owner, () => t.clearClock(ctx(), body.owner!));
        return envelope({ owner: body.owner, cleared: true });
      }
      return envelope(
        await audited(actorOf(req), 'test.clock.set', body.owner, () =>
          t.setClock(ctx(), body.owner!, {
            at: body.at,
            advanceMs: body.advance_ms,
            settle: body.settle,
            maxRounds: body.max_rounds,
          }),
        ),
      );
    } catch (e) {
      return tenantFail(reply, e);
    }
  });

  // ── E2E read API ─────────────────────────────────────────────────────────────────────────────
  //
  // These endpoints serve the SAME data as the MCP tools below — one source, no drift.
  // Both paths call the same query functions from e2e-api.ts.
  //
  // The store is optional: when CONSOLE_CP_DB_URL / FORGE_DB_URL is absent the endpoints return
  // 501 rather than crashing. This is the graceful-degradation path for deployments that don't
  // have the cp-results database configured.

  const NOT_CONFIGURED = {
    error: {
      code: 'not_configured',
      message: 'e2e store not configured — set CONSOLE_CP_DB_URL or FORGE_DB_URL',
    },
  };

  app.get('/api/e2e/runs', async (req, reply) => {
    const store = await evalStoreGetter();
    if (!store) return reply.code(501).send(NOT_CONFIGURED);
    const q = req.query as { tenant?: string; limit?: string; status?: string };
    const runs = await queryListRuns(store, {
      tenant: q.tenant,
      limit: q.limit ? Number(q.limit) : undefined,
      status: q.status,
    });
    // A 'running' row is only ever finalised by the runner; reconcile against the execution so a
    // run that died without publishing cannot sit in the tab as in-progress forever.
    return envelope(await reconcileRunningRuns(store, runs as never[]));
  });

  app.get('/api/e2e/runs/:run_id', async (req, reply) => {
    const store = await evalStoreGetter();
    if (!store) return reply.code(501).send(NOT_CONFIGURED);
    const { run_id } = req.params as { run_id: string };
    const detail = await queryGetRun(store, run_id);
    if (!detail)
      return reply.code(404).send({ error: { code: 'not_found', message: `run ${run_id} not found` } });
    if (detail.run) await reconcileRunningRuns(store, [detail.run] as never[]);
    return envelope(detail);
  });

  // Workflow drilldown by the workflow row id (the "id" field, not the suite-level "workflow_id").
  app.get('/api/e2e/runs/:run_id/workflows/:workflow_row_id', async (req, reply) => {
    const store = await evalStoreGetter();
    if (!store) return reply.code(501).send(NOT_CONFIGURED);
    const { workflow_row_id } = req.params as { run_id: string; workflow_row_id: string };
    const result = await queryGetWorkflow(store, workflow_row_id);
    if (!result)
      return reply.code(404).send({
        error: { code: 'not_found', message: `workflow ${workflow_row_id} not found` },
      });
    return envelope(result);
  });

  // Also support /api/e2e/workflows/:id directly (without the run_id prefix) — same handler.
  app.get('/api/e2e/workflows/:workflow_row_id', async (req, reply) => {
    const store = await evalStoreGetter();
    if (!store) return reply.code(501).send(NOT_CONFIGURED);
    const { workflow_row_id } = req.params as { workflow_row_id: string };
    const result = await queryGetWorkflow(store, workflow_row_id);
    if (!result)
      return reply.code(404).send({
        error: { code: 'not_found', message: `workflow ${workflow_row_id} not found` },
      });
    return envelope(result);
  });

  app.get('/api/e2e/diff', async (req, reply) => {
    const store = await evalStoreGetter();
    if (!store) return reply.code(501).send(NOT_CONFIGURED);
    const q = req.query as { run_id?: string; baseline_run_id?: string };
    if (!q.run_id || !q.baseline_run_id) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: 'run_id and baseline_run_id are required' },
      });
    }
    const diff = await queryDiffRuns(store, q.run_id, q.baseline_run_id);
    if (!diff)
      return reply.code(404).send({
        error: { code: 'not_found', message: 'one or both run_ids not found' },
      });
    return envelope(diff);
  });

  // ── E2E trigger — POST /api/e2e/runs ─────────────────────────────────────────────────────────
  //
  // Starts a Cloud Run job execution as the console's Workload Identity and pre-creates an EvalRun
  // record in the cp-results store so the run appears immediately in the Evals tab. The endpoint
  // is authenticated exactly like every other console write path; the automation token is refused
  // (read-only by construction). A reason is required — the audit row must mean something.
  //
  // Required env: CONSOLE_E2E_JOB (Cloud Run Job short name, e.g. "forge-e2e-runner").
  //
  // Body: { reason (required), suite?, workflows? (string[]), provider? }

  // The runner's progress reports land here. The endpoint lives with the store it writes to and the
  // E2E routes that read it — it was originally registered on forge's control-plane API server,
  // which is not deployed in this project, so it existed and was unreachable.
  registerIngestRoutes(app);

  app.post('/api/e2e/runs', async (req, reply) => {
    const body = req.body as {
      suite?: string;
      workflows?: string[];
      provider?: string;
      reason?: string;
    };

    // Require a reason — the audit row must mean something.
    if (!body?.reason || body.reason.trim().length < 3) {
      return reply.code(422).send({
        error: { code: 'reason_required', message: 'a reason is required to start an eval run' },
      });
    }

    // The job name must be configured — fail closed rather than silently doing nothing.
    const jobName = process.env.CONSOLE_E2E_JOB ?? '';
    if (!jobName) {
      return reply.code(501).send({
        error: {
          code: 'not_configured',
          message: 'CONSOLE_E2E_JOB is not configured — cannot start a run',
        },
      });
    }

    const actor = actorOf(req);
    // Generate a stable, human-readable run ID that sorts chronologically.
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const suffix = randomBytes(3).toString('hex');
    const runId = `run-${ts}-${suffix}`;
    const triggerSource = `manual · ${actor}`;

    // Environment variable overrides for the job task at invocation time.
    const jobEnv: Record<string, string> = {
      E2E_RUN_ID: runId,
      E2E_TRIGGERED_BY: actor,
      E2E_REASON: body.reason.trim(),
    };
    if (body.suite) jobEnv['E2E_SUITE'] = body.suite;
    if (body.workflows?.length) jobEnv['E2E_WORKFLOWS'] = body.workflows.join(',');
    if (body.provider) jobEnv['E2E_PROVIDER'] = body.provider;

    // Pre-create the run so it appears immediately in the tab (status: 'running').
    // A store pre-create failure is not fatal — the job writes its own record on completion.
    const store = await evalStoreGetter();
    if (store) {
      await store
        .upsertRun({
          run_id: runId,
          tenant_id: process.env.CONSOLE_E2E_TENANT ?? 'dorinda-prod',
          trigger_source: triggerSource,
          meta: {
            reason: body.reason.trim(),
            ...(body.suite ? { suite: body.suite } : {}),
            ...(body.workflows?.length ? { workflows: body.workflows } : {}),
            ...(body.provider ? { provider: body.provider } : {}),
          },
        })
        .catch(() => {
          /* non-fatal — job writes its own record */
        });
    }

    // Trigger the Cloud Run Job. Audit the attempt before the call so a crash mid-request is
    // recorded, not lost.
    let execution: { operation_name: string; execution_name: string | null };
    try {
      execution = await audited(actor, 'e2e.run.trigger', runId, () =>
        triggerCloudRunJob({
          project: PROJECT,
          region: REGION,
          job: jobName,
          env: jobEnv,
          signal: AbortSignal.timeout(30_000),
        }),
      );
    } catch (e) {
      // Trigger failed: mark the pre-created run as failed so it does not hang as 'running'.
      if (store) {
        await store
          .updateRun(runId, { status: 'failed', completed_at: new Date().toISOString() })
          .catch(() => {});
      }
      return reply.code(502).send({
        error: {
          code: 'trigger_failed',
          message: `Cloud Run job trigger failed: ${(e as Error).message}`,
        },
      });
    }

    // Store the execution name and GCP Console URL in meta so the UI can link to it.
    if (store && execution.execution_name) {
      const executionUrl = buildExecutionConsoleUrl(execution.execution_name, PROJECT);
      await store
        .updateRun(runId, {
          meta: {
            execution_name: execution.execution_name,
            ...(executionUrl ? { execution_url: executionUrl } : {}),
          },
        })
        .catch(() => {});
    }

    return envelope({
      run_id: runId,
      state: 'running' as const,
      execution_name: execution.execution_name,
      trigger_source: triggerSource,
    });
  });

  // ── E2E run delete — DELETE /api/e2e/runs/:run_id ─────────────────────────────────────────────
  //
  // Permanently removes a run row and ALL child records (per-workflow drilldown, scenes, MCP calls,
  // claims) in one atomic DELETE. Child tables carry ON DELETE CASCADE FKs so no orphan rows can
  // survive to pollute aggregate metrics. The same CONSOLE_CP_DB_URL pool path as POST
  // /api/e2e/runs — no new IAM required.
  //
  // Authorization: same operator set as POST (OIDC session). The automation bearer token is
  // refused by the onRequest hook because it is read-only; that is sufficient — we do not need an
  // additional check here because the hook already returns 403 before the handler runs.
  //
  // A run whose status is 'running' is refused (409). Stop or let the run finish first.
  // An audit row is written BEFORE the delete attempt (consistent with every other audited route).

  app.delete('/api/e2e/runs/:run_id', async (req, reply) => {
    const store = await evalStoreGetter();
    if (!store) return reply.code(501).send(NOT_CONFIGURED);

    const { run_id } = req.params as { run_id: string };

    // Read the current state before touching anything.
    const existing = await store.getRun(run_id);
    if (!existing) {
      return reply.code(404).send({ error: { code: 'not_found', message: `run ${run_id} not found` } });
    }

    const actor = actorOf(req);

    // Audit BEFORE the attempt — consistent with every other audited write on this surface.
    // The 409 path throws INSIDE the audited block so the refusal is recorded with outcome='failed'.
    // A refusal IS an "attempt"; the row written here is the evidence that it happened.
    let isRunningRefusal = false;
    let deleted: boolean;
    try {
      deleted = await audited(actor, 'e2e.run.delete', run_id, async () => {
        // Refuse deletion of a live run. Throwing inside audited() marks the row 'failed'
        // so the refusal is still recorded — the interesting cases are the ones that don't succeed.
        if (existing.status === 'running') {
          isRunningRefusal = true;
          throw new Error(`run ${run_id} is currently running — stop or let it finish before deleting`);
        }
        // The delete cascades to all child tables via ON DELETE CASCADE FKs.
        return store.deleteRun(run_id);
      });
    } catch (e) {
      if (isRunningRefusal) {
        return reply.code(409).send({
          error: {
            code: 'run_is_active',
            message: `run ${run_id} is currently running — stop or let it finish before deleting`,
          },
        });
      }
      throw e;
    }

    if (!deleted) {
      // Race: another request deleted it between our getRun check and here — still a success.
      return reply.code(404).send({ error: { code: 'not_found', message: `run ${run_id} not found` } });
    }

    return reply.code(200).send({ deleted: true, run_id });
  });

  // ── Console MCP server ────────────────────────────────────────────────────────────────────────
  //
  // A lightweight Streamable-HTTP MCP server (JSON-RPC 2.0) that exposes the e2e read surface as
  // agent-callable tools. Auth: the same bearer token as the console automation API
  // (CONSOLE_AUTOMATION_TOKEN) or the OIDC session cookie. Tools are read-only by construction.
  //
  // Reachable from Claude Code:
  //   claude mcp add forge-console https://<CONSOLE_PUBLIC_URL>/mcp \
  //     --header "Authorization: Bearer <CONSOLE_AUTOMATION_TOKEN>"
  //
  // Reachable from claude.ai connector: configure the connector URL as
  //   <CONSOLE_PUBLIC_URL>/mcp and set the API key to CONSOLE_AUTOMATION_TOKEN.
  //
  //   POST /mcp             JSON-RPC 2.0: initialize | ping | tools/list | tools/call
  //   GET  /mcp             SSE server→client stream (heartbeat only; tool list is static)
  //   GET  /.well-known/oauth-protected-resource/mcp  RFC 9728 discovery doc (PUBLIC)

  const MCP_CONSOLE_VERSION = '1.0.0';
  const MCP_PROTOCOL_VERSION = '2025-06-18';
  const MCP_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

  // RFC 9728 discovery — advertises this server as the protected resource + points at the auth
  // server. The "auth server" for the console is the console itself (bearer-token or OIDC).
  app.get('/.well-known/oauth-protected-resource/mcp', async (req, reply) => {
    const proto = String(req.headers['x-forwarded-proto'] ?? 'https')
      .split(',')[0]!
      .trim();
    const host = String(req.headers['x-forwarded-host'] ?? req.headers['host'] ?? 'localhost');
    const base = (process.env.CONSOLE_PUBLIC_URL ?? `${proto}://${host}`).replace(/\/+$/, '');
    return reply
      .header('content-security-policy', MCP_CSP)
      .status(200)
      .send({ resource: `${base}/mcp`, authorization_servers: [base] });
  });

  // POST /mcp — JSON-RPC 2.0 request/response.
  // Auth is already enforced by the onRequest hook above; we only reach here with a valid session.
  app.post('/mcp', async (req, reply) => {
    reply.header('content-security-policy', MCP_CSP);

    const body = req.body as
      | { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> }
      | undefined;

    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return reply.status(200).send(mcpError(body?.id ?? null, -32600, 'Invalid Request'));
    }
    const { id, method, params } = body;
    if (id === undefined) {
      // JSON-RPC notification — no response body.
      return reply.status(202).send();
    }

    try {
      if (method === 'ping') return reply.status(200).send(mcpResult(id!, {}));

      if (method === 'initialize') {
        return reply.status(200).send(
          mcpResult(id!, {
            protocolVersion: (params?.protocolVersion as string) || MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'forge-console-e2e', version: MCP_CONSOLE_VERSION },
            instructions: TRIAGE_INSTRUCTIONS,
          }),
        );
      }

      if (method === 'tools/list') {
        return reply.status(200).send(
          mcpResult(id!, {
            tools: E2E_MCP_TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: { readOnlyHint: true },
            })),
          }),
        );
      }

      if (method === 'tools/call') {
        const toolName = params?.name as string | undefined;
        const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
        if (!toolName)
          return reply.status(200).send(mcpError(id!, -32602, 'tools/call requires a string `name`.'));

        // Validate tool name BEFORE the store check so unknown tools get -32601 (Method Not Found)
        // regardless of whether the store is configured.
        const KNOWN_TOOLS = new Set(['list_e2e_runs', 'get_e2e_run', 'get_workflow_result', 'diff_e2e_runs']);
        if (!KNOWN_TOOLS.has(toolName)) {
          return reply.status(200).send(mcpError(id!, -32601, `Unknown tool: ${toolName}`));
        }

        const store = await evalStoreGetter();
        if (!store) {
          // Store not configured — return an MCP tool error (isError: true) so the agent sees it.
          return reply.status(200).send(
            mcpResult(id!, {
              content: [{ type: 'text', text: 'e2e store not configured (no database URL).' }],
              isError: true,
            }),
          );
        }

        let result: unknown;
        try {
          if (toolName === 'list_e2e_runs') {
            result = await queryListRuns(store, {
              tenant: typeof args.tenant === 'string' ? args.tenant : undefined,
              limit: typeof args.limit === 'number' ? args.limit : undefined,
              status: typeof args.status === 'string' ? args.status : undefined,
            });
          } else if (toolName === 'get_e2e_run') {
            const runId = typeof args.run_id === 'string' ? args.run_id : '';
            if (!runId) return reply.status(200).send(mcpError(id!, -32602, 'run_id is required.'));
            const detail = await queryGetRun(store, runId);
            if (!detail)
              return reply.status(200).send(
                mcpResult(id!, {
                  content: [{ type: 'text', text: `run ${runId} not found.` }],
                  isError: true,
                }),
              );
            result = detail;
          } else if (toolName === 'get_workflow_result') {
            const wfId = typeof args.workflow_id === 'string' ? args.workflow_id : '';
            if (!wfId) return reply.status(200).send(mcpError(id!, -32602, 'workflow_id is required.'));
            const wfResult = await queryGetWorkflow(store, wfId);
            if (!wfResult)
              return reply.status(200).send(
                mcpResult(id!, {
                  content: [{ type: 'text', text: `workflow ${wfId} not found.` }],
                  isError: true,
                }),
              );
            result = wfResult;
          } else if (toolName === 'diff_e2e_runs') {
            const runId = typeof args.run_id === 'string' ? args.run_id : '';
            const baselineId = typeof args.baseline_run_id === 'string' ? args.baseline_run_id : '';
            if (!runId || !baselineId)
              return reply
                .status(200)
                .send(mcpError(id!, -32602, 'run_id and baseline_run_id are required.'));
            const diff = await queryDiffRuns(store, runId, baselineId);
            if (!diff)
              return reply.status(200).send(
                mcpResult(id!, {
                  content: [{ type: 'text', text: 'one or both run_ids not found.' }],
                  isError: true,
                }),
              );
            result = diff;
          } else {
            // This branch is unreachable — all valid tools are handled above and unknown tools
            // are caught before the store check. Kept as a type-narrowing safety net.
            return reply.status(200).send(mcpError(id!, -32601, `Unknown tool: ${toolName}`));
          }
        } catch (e) {
          return reply.status(200).send(
            mcpResult(id!, {
              content: [{ type: 'text', text: `tool error: ${(e as Error).message ?? String(e)}` }],
              isError: true,
            }),
          );
        }

        const text = JSON.stringify(result);
        return reply.status(200).send(
          mcpResult(id!, {
            content: [{ type: 'text', text }],
            structuredContent: result,
          }),
        );
      }

      return reply.status(200).send(mcpError(id!, -32601, `Method not found: ${method}`));
    } catch (e) {
      return reply
        .status(200)
        .send(mcpError(body?.id ?? null, -32603, `Internal error: ${(e as Error).message ?? e}`));
    }
  });

  // GET /mcp — SSE server→client stream. Keeps the connection alive with heartbeat pings.
  // The console MCP surface is static (tools don't change at runtime), so we don't push
  // notifications/tools/list_changed. The stream exists for spec compliance and keep-alive.
  app.get('/mcp', async (req, reply) => {
    reply.header('content-security-policy', MCP_CSP);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const hb = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* socket gone */
      }
    }, 25_000);
    hb.unref?.();
    let done = false;
    const cleanup = () => {
      if (!done) {
        done = true;
        clearInterval(hb);
      }
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  // ── The single write ──

  app.post('/api/actions/dispatch', async (req, reply) => {
    const body = req.body as {
      pipeline_id?: string;
      ref?: string;
      inputs?: Record<string, string>;
      reason?: string;
    };
    if (!body?.pipeline_id) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'pipeline_id is required' } });
    }
    // A production action must carry a stated reason — it lands in the audit row.
    if (!body.reason || body.reason.trim().length < 3) {
      return reply
        .code(422)
        .send({ error: { code: 'reason_required', message: 'a reason is required for any dispatch' } });
    }
    const provs = registry.byKind('pipelines', ENV) as PipelinesProvider[];
    const p = provs.find((x) => x.supports('pipelines.dispatch'));
    if (!p) {
      return reply.code(501).send({
        error: {
          code: 'not_supported',
          message: 'no pipeline provider can dispatch — is the GitHub token configured?',
        },
      });
    }
    const actor = actorOf(req);
    const receipt = await audited(actor, 'pipeline.dispatch', body.pipeline_id, () =>
      p.dispatch(body.pipeline_id!, { ref: body.ref ?? 'main', inputs: body.inputs ?? {} }, ctx()),
    );
    return envelope(receipt);
  });

  // ── SPA ──

  // ── JSON-RPC helpers (console MCP) ──
  function mcpResult(id: string | number | null, result: unknown) {
    return { jsonrpc: '2.0' as const, id, result };
  }
  function mcpError(id: string | number | null, code: number, message: string) {
    return { jsonrpc: '2.0' as const, id, error: { code, message } };
  }

  app.setNotFoundHandler(async (req, reply) => {
    // API 404s must stay 404s — swallowing them into the SPA shell turns a typo'd route into a
    // blank page instead of an error.
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: req.url } });
    }
    const rel = normalize(decodeURIComponent(req.url.split('?')[0] ?? '/'));
    if (rel.includes('..')) return reply.code(400).send('bad path');
    const ext = extname(rel);
    try {
      if (ext) {
        const buf = await readFile(join(UI_DIR, rel));
        return reply.type(MIME[ext] ?? 'application/octet-stream').send(buf);
      }
      const html = await readFile(join(UI_DIR, 'index.html'));
      return reply.type('text/html; charset=utf-8').send(html);
    } catch {
      return reply.code(404).type('text/html').send('<h1>forge console</h1><p>UI bundle not built.</p>');
    }
  });

  return app;
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const app = buildServer();
  app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
    process.stdout.write(`forge-console listening on :${PORT} (env=${ENV}, project=${PROJECT})\n`);
  });
}
