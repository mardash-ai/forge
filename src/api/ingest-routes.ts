/**
 * Ingest routes — machine-facing write surface for the cp-results store.
 *
 * The sole endpoint, POST /ingest/run-progress/:run_id, accepts a Cloud Run job's
 * self-reported progress and persists it to the cp-results Postgres store via the
 * already-open Backends pool (FORGE_CP_RESULTS_BACKEND=postgres).
 *
 * AUTH — exactly one credential is accepted: a Google-signed OIDC service-identity
 * token (Authorization: Bearer <token>) presented by the Cloud Run job using the job's
 * own Workload Identity service account. No shared secret, no forge session cookie, no
 * automation bearer token is accepted on this endpoint. Requests that cannot be verified
 * as coming from the configured runner service account are rejected with 401.
 *
 * IDEMPOTENCY — the underlying updateRun() does a partial SQL UPDATE. Repeated reports
 * for the same run_id advance the counters in-place; the terminal status settles once
 * and is not overwritten by a subsequent non-terminal report.
 *
 * REQUIRED ENV:
 *   FORGE_RUNNER_SA_EMAIL   — the service account email the runner presents (e.g.
 *                             forge-e2e-runner@dorinda-prod.iam.gserviceaccount.com).
 *                             Without this the endpoint fails closed with 501.
 *
 * OPTIONAL ENV:
 *   FORGE_INGEST_AUDIENCE   — the expected `aud` claim in the OIDC token (e.g. the
 *                             control-plane Cloud Run service URL). When set, any token
 *                             whose `aud` differs is rejected. Omit in local tests.
 */

import { createPublicKey, createVerify } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getBackends } from '../storage/backends';
import type { EvalRunUpdate } from '../storage/backends/cp-results/types';

// ── Google JWKS ──────────────────────────────────────────────────────────────

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

interface JwksCache {
  keys: unknown[];
  at: number;
}

let _jwksCache: JwksCache | null = null;

/** Exported for test injection. Replaces the module-level cache. */
export function _setJwksCacheForTests(cache: JwksCache | null): void {
  _jwksCache = cache;
}

async function fetchJwks(fetchImpl: typeof fetch = fetch): Promise<unknown[]> {
  if (_jwksCache && Date.now() - _jwksCache.at < 3_600_000) return _jwksCache.keys;
  const res = await fetchImpl(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: unknown[] };
  _jwksCache = { keys: body.keys, at: Date.now() };
  return body.keys;
}

// ── Service identity token verification ──────────────────────────────────────

export interface ServiceTokenClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  aud: string | string[];
  iss: string;
  iat: number;
  exp: number;
}

/**
 * Verify a Google-signed OIDC service-identity token.
 *
 * Checks, in order:
 *   1. Three-part JWT structure.
 *   2. alg == RS256 (reject algorithm confusion / symmetric attacks).
 *   3. iss == https://accounts.google.com (or the legacy bare form).
 *   4. exp not past (token not expired).
 *   5. aud matches `audience` when `audience` is non-empty.
 *   6. email == `serviceAccountEmail` (the only accepted principal).
 *   7. email_verified == true.
 *   8. RSA-SHA256 signature against Google's published JWKS.
 *
 * Returns the validated claims on success; null for any failure.
 *
 * `fetchImpl` is injectable for unit tests that must not hit the real JWKS URL.
 */
export async function verifyGoogleServiceToken(
  token: string,
  opts: { audience: string; serviceAccountEmail: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header: { kid?: string; alg?: string };
  let payload: ServiceTokenClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as {
      kid?: string;
      alg?: string;
    };
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as ServiceTokenClaims;
  } catch {
    return null;
  }

  // 1. alg must be RS256 — reject HS256 / alg-confusion attacks
  if (header.alg !== 'RS256') return null;

  // 2. issuer must be Google
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    return null;
  }

  // 3. expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return null;

  // 4. audience — only enforced when the operator has configured an audience
  if (opts.audience) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(opts.audience)) return null;
  }

  // 5. principal must match the configured runner service account
  if (payload.email !== opts.serviceAccountEmail) return null;

  // 6. email_verified must be true (service accounts always report true; explicit check guards
  //    against a malformed token crafted without the claim)
  if (!payload.email_verified) return null;

  // 7. Signature verification against Google's live JWKS
  try {
    const keys = await fetchJwks(fetchImpl);
    const jwk = keys.find(
      (k): k is Record<string, unknown> =>
        typeof k === 'object' && k !== null && (k as Record<string, unknown>)['kid'] === header.kid,
    );
    if (!jwk) return null;
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

// ── Payload types ─────────────────────────────────────────────────────────────

/**
 * What the Cloud Run runner POSTs to this endpoint.
 *
 * run_id             — the run whose row to update (must already exist; created by the console trigger)
 * workflows_intended — how many workflows the runner was asked to execute (stored in meta)
 * outcomes           — per-verdict counters for the workflows that completed
 * spend_cents        — total token spend in integer cents (additive on repeated calls)
 * status             — current run lifecycle state; terminal values settle the row
 */
export interface RunProgressPayload {
  run_id: string;
  workflows_intended?: number;
  outcomes?: {
    pass?: number;
    fail?: number;
    error?: number;
    skip?: number;
  };
  spend_cents?: number;
  status?: 'running' | 'completed' | 'failed' | 'aborted';
}

// ── Route registration ────────────────────────────────────────────────────────

export interface RegisterIngestRoutesOpts {
  /**
   * Token verifier — injectable for unit tests.
   * Defaults to `verifyGoogleServiceToken` (live Google JWKS verification).
   * Tests substitute a stub that bypasses network I/O.
   */
  verifyToken?: typeof verifyGoogleServiceToken;
}

/**
 * Register the ingest routes on the given Fastify instance.
 *
 * Called from src/api/server.ts once, at boot, alongside every other route family.
 * The endpoint is deliberately NOT behind any forge session gate — it has its own
 * Google service-identity check performed inline.
 */
export function registerIngestRoutes(app: FastifyInstance, opts?: RegisterIngestRoutesOpts): void {
  const verifyToken = opts?.verifyToken ?? verifyGoogleServiceToken;
  /**
   * POST /ingest/run-progress
   *
   * Body: RunProgressPayload (JSON).
   *
   * Returns:
   *   200 { updated: true, run_id }  — row was found and updated
   *   401  — missing or invalid service-identity token
   *   404  — run_id not found in the store (pre-create must have run first)
   *   422  — payload validation failure
   *   501  — FORGE_RUNNER_SA_EMAIL not configured, or cpResults backend not enabled
   */
  app.post('/ingest/run-progress', async (req: FastifyRequest, reply: FastifyReply) => {
    // ── Configuration ────────────────────────────────────────────────────────
    const runnerSaEmail = process.env.FORGE_RUNNER_SA_EMAIL ?? '';
    const audience = process.env.FORGE_INGEST_AUDIENCE ?? '';

    if (!runnerSaEmail) {
      return reply.code(501).send({
        error: {
          code: 'not_configured',
          message: 'FORGE_RUNNER_SA_EMAIL is not set — ingest endpoint is disabled',
          retry: 'no' as const,
        },
      });
    }

    // ── Authentication ───────────────────────────────────────────────────────
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
      return reply.code(401).send({
        error: {
          code: 'unauthorized',
          message: 'A Google service-identity Bearer token is required',
          retry: 'no' as const,
        },
      });
    }

    const claims = await verifyToken(token, { audience, serviceAccountEmail: runnerSaEmail });
    if (!claims) {
      return reply.code(401).send({
        error: {
          code: 'unauthorized',
          message: 'Service-identity token is invalid, expired, or not from the configured runner account',
          retry: 'no' as const,
        },
      });
    }

    // ── Payload validation ───────────────────────────────────────────────────
    const body = req.body as RunProgressPayload | null | undefined;
    if (!body || typeof body.run_id !== 'string' || !body.run_id.trim()) {
      return reply.code(422).send({
        error: {
          code: 'invalid_payload',
          message: 'run_id (string) is required in the request body',
          retry: 'change-input' as const,
        },
      });
    }

    const VALID_STATUSES = new Set(['running', 'completed', 'failed', 'aborted']);
    if (body.status !== undefined && !VALID_STATUSES.has(body.status)) {
      return reply.code(422).send({
        error: {
          code: 'invalid_payload',
          message: `status must be one of: ${[...VALID_STATUSES].join(', ')}`,
          retry: 'change-input' as const,
        },
      });
    }

    // ── Backend ──────────────────────────────────────────────────────────────
    const backends = await getBackends();
    if (!backends.cpResults) {
      return reply.code(501).send({
        error: {
          code: 'not_configured',
          message: 'cp-results store is not enabled — set FORGE_CP_RESULTS_BACKEND=postgres',
          retry: 'no' as const,
        },
      });
    }

    // ── Build the update ─────────────────────────────────────────────────────
    const pass = Number(body.outcomes?.pass ?? 0);
    const fail = Number(body.outcomes?.fail ?? 0);
    const error = Number(body.outcomes?.error ?? 0);
    const skip = Number(body.outcomes?.skip ?? 0);

    // "attempted" = workflows that actually ran (pass + fail + error); skipped/withheld are excluded.
    const attempted = pass + fail + error;

    const update: EvalRunUpdate = {
      workflows_attempted: attempted,
      workflows_passed: pass,
      workflows_failed: fail + error, // both fail and error verdicts are non-passing outcomes
      withheld_count: skip,
      spend_cents: Number(body.spend_cents ?? 0),
    };

    if (attempted > 0) {
      update.pass_rate = pass / attempted;
    }

    const isTerminal = body.status === 'completed' || body.status === 'failed' || body.status === 'aborted';
    if (body.status) {
      update.status = body.status;
    }
    if (isTerminal) {
      update.completed_at = new Date().toISOString();
    }

    // Carry the intended count and runner email into meta so the console can show "X of Y ran".
    const metaUpdate: Record<string, unknown> = {
      runner_sa: claims.email,
    };
    if (typeof body.workflows_intended === 'number') {
      metaUpdate['workflows_intended'] = body.workflows_intended;
    }
    update.meta = metaUpdate;

    // ── Persist ──────────────────────────────────────────────────────────────
    const updated = await backends.cpResults.updateRun(body.run_id, update);
    if (!updated) {
      return reply.code(404).send({
        error: {
          code: 'not_found',
          message: `Run "${body.run_id}" not found — the console trigger must pre-create the row`,
          retry: 'no' as const,
        },
      });
    }

    return reply.code(200).send({ updated: true, run_id: body.run_id });
  });
}
