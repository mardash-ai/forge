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
  /** Size of the FULL catalogue, independent of this run's scope — the run modal prices against it. */
  catalogue_size?: number;
  /**
   * Per-workflow rows for the run's drilldown table.
   *
   * Without these the console shows a run with `attempted 1 · passed 1` above an EMPTY workflow
   * table — the aggregate says work happened and the table cannot name any of it. The rows live in
   * `results.t2.jsonl` inside the job, which dies with the container, so the runner sends them here.
   * Keyed by `run_id` + `workflow_id`, so a repeated report replaces rather than duplicates.
   */
  workflows?: Array<{
    workflow_id: string;
    verdict: string;
    integrity_class?: string;
    provider?: string;
    duration_ms?: number;
    started_at?: string;
    completed_at?: string;
    input_tokens?: number;
    output_tokens?: number;
    lanes?: string[];
    trials_total?: number;
    trials_passed?: number;
    failing_bar?: string;
    prompt?: string;
    name?: string;
    /** The conversation — prompt in, visible reply out. Mirrors forge-hat's ProgressReport. */
    turns?: Array<{
      turn_index: number;
      attempt?: number;
      scene?: string;
      prompt?: string;
      reply?: string;
      tool_calls?: Array<{ tool: string; ok?: boolean; summary?: string }>;
      tool_trace_unreadable?: boolean;
    }>;
    mcp_calls?: Array<{
      call_index: number;
      tool_name: string;
      request: Record<string, unknown>;
      response?: Record<string, unknown>;
      error?: string;
    }>;
    claims?: Array<{
      claim_index: number;
      claim_type?: string;
      claim_text?: string;
      verdict?: string;
      evidence?: Record<string, unknown>;
    }>;
    scenes?: Array<{
      trial?: number;
      scene_index: number;
      scene_name?: string;
      passed?: boolean;
      assertions?: Array<{ name: string; expected: unknown; operator: string }>;
      observed_values?: Array<{ name: string; value: unknown }>;
    }>;
  }>;
  outcomes?: {
    pass?: number;
    fail?: number;
    error?: number;
    skip?: number;
  };
  spend_cents?: number;
  withheld_count?: number;
  rejected_count?: number;
  p50_duration_ms?: number;
  p99_duration_ms?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
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
  app.post(
    '/ingest/run-progress',
    {
      // ⛔ THIS ROUTE ONLY. The server-wide bodyLimit is 1 MB, and this endpoint legitimately
      // carries the whole run's evidence: the runner re-sends every workflow it knows about on each
      // push, deliberately, so a repeat heals a report that was dropped earlier.
      //
      // Measured 2026-08-14: one workflow's evidence was 164 KB raw and 35 KB after the runner's
      // clipping. Across the 76-workflow catalogue that is ~2.7 MB — so under a 1 MB cap every push
      // from roughly workflow 7 onward would have 413'd, INCLUDING the terminal one. The operator
      // would watch the counters freeze around 6 while the job quietly finished, and the row would
      // stay `running` forever: the exact symptom this evidence pipe exists to prevent, caused by
      // the pipe itself, and triggered by SUCCESS — more passing workflows, bigger payload.
      //
      // 32 MB is Cloud Run's own request ceiling and leaves ~12x headroom on today's catalogue, so
      // the suite can grow substantially before this needs revisiting. Raised HERE rather than
      // globally: no other route has any business accepting a multi-megabyte body.
      bodyLimit: 32 * 1024 * 1024,
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
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
        // The runner counts withheld verdicts itself (INFRA-FAIL / UNARMED). Falling back to `skip`
        // is a poor proxy — a rig failure is not a skipped workflow.
        withheld_count: typeof body.withheld_count === 'number' ? body.withheld_count : skip,
        spend_cents: Number(body.spend_cents ?? 0),
      };

      // ⛔ EVERY metric the sender provides must be persisted here. Extending the runner to report
      // p50/p99 and token totals without extending THIS mapping left them null in the console while
      // the payload carried them correctly — the sender and the receiver are two halves of one
      // contract, and changing one alone is the defect this file keeps producing.
      if (typeof body.rejected_count === 'number') update.rejected_count = body.rejected_count;
      if (typeof body.p50_duration_ms === 'number') update.p50_duration_ms = body.p50_duration_ms;
      if (typeof body.p99_duration_ms === 'number') update.p99_duration_ms = body.p99_duration_ms;
      if (typeof body.total_input_tokens === 'number') update.total_input_tokens = body.total_input_tokens;
      if (typeof body.total_output_tokens === 'number') update.total_output_tokens = body.total_output_tokens;

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
      if (typeof body.catalogue_size === 'number' && body.catalogue_size > 0) {
        // Deliberately separate from workflows_intended. The modal must price "Full catalogue" from
        // the CATALOGUE; pricing it from the last run's scope offered "2 workflows · $0.16" for a
        // 76-workflow run on 2026-08-14 — wrong toward zero, above a confirmation checkbox.
        metaUpdate['catalogue_size'] = body.catalogue_size;
      }
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

      // ── Per-workflow rows ────────────────────────────────────────────────────
      // Best-effort and idempotent: a run reports repeatedly as it progresses, so the same workflow
      // arrives more than once. A row that fails to persist must not fail the whole report — the
      // aggregate counters are the more important signal and are already committed above.
      /**
       * HAT's verdict vocabulary is not the store's.
       *
       * The runner speaks ACCEPTED / REJECTED / UNARMED / INFRA-FAIL; the column accepts
       * pass | fail | error | skip. Sending HAT's words made every row fail its insert — and because
       * a row failure is deliberately non-fatal, the run reported `attempted 2 · passed 2` above an
       * empty table with nothing in the response to say why. Translate at the boundary, and treat an
       * unknown word as `error` rather than dropping the row: a workflow the table cannot classify
       * still happened, and losing it silently is what this whole endpoint exists to stop.
       *
       * ⛔ UNARMED and INFRA-FAIL are RIG failures — `error`, never `fail`. Counting a rig failure as
       * a product rejection is the misreport that withheld verdicts exist to prevent.
       */
      const toStoreVerdict = (v: string): 'pass' | 'fail' | 'error' | 'skip' => {
        switch (v.toUpperCase()) {
          case 'ACCEPTED':
          case 'PASS':
            return 'pass';
          case 'REJECTED':
          case 'FAIL':
            return 'fail';
          case 'SKIP':
          case 'SKIPPED':
            return 'skip';
          default:
            return 'error'; // UNARMED, INFRA-FAIL, and anything unrecognised
        }
      };

      let workflowsWritten = 0;
      let workflowsRejected = 0;
      let scenesWritten = 0;
      let childrenWritten = 0;
      let childrenRejected = 0;
      let scenesRejected = 0;
      let lastWorkflowError: string | null = null;
      if (Array.isArray(body.workflows) && body.workflows.length > 0) {
        for (const wf of body.workflows) {
          if (!wf?.workflow_id || !wf?.verdict) continue;
          try {
            await backends.cpResults.insertWorkflow({
              // Deterministic id: the same workflow in the same run is the SAME row, however many
              // times it is reported. A random id here would fill the table with duplicates.
              id: `${body.run_id}:${wf.workflow_id}`,
              run_id: body.run_id,
              workflow_id: wf.workflow_id,
              tenant_id: updated.tenant_id,
              verdict: toStoreVerdict(wf.verdict),
              ...(wf.integrity_class ? { integrity_class: wf.integrity_class as never } : {}),
              ...(wf.provider ? { provider: wf.provider } : {}),
              ...(typeof wf.duration_ms === 'number' ? { duration_ms: wf.duration_ms } : {}),
              ...(wf.started_at ? { started_at: wf.started_at } : {}),
              ...(wf.completed_at ? { completed_at: wf.completed_at } : {}),
              ...(typeof wf.input_tokens === 'number' ? { input_tokens: wf.input_tokens } : {}),
              ...(typeof wf.output_tokens === 'number' ? { output_tokens: wf.output_tokens } : {}),
              ...(wf.lanes ? { lanes: wf.lanes } : {}),
              ...(typeof wf.trials_total === 'number' ? { trials_total: wf.trials_total } : {}),
              ...(typeof wf.trials_passed === 'number' ? { trials_passed: wf.trials_passed } : {}),
              ...(wf.failing_bar ? { failing_bar: wf.failing_bar } : {}),
              ...(wf.prompt ? { prompt: wf.prompt } : {}),
              // The human-readable title, on meta because the row has no `name` column. A code like
              // `W-001:openai` tells an operator nothing about what was tested (Mark, 2026-08-14:
              // "workflow codes by themselves are useless").
              ...(wf.name ? { meta: { name: wf.name } } : {}),
            });
            workflowsWritten += 1;

            // MCP calls — what the assistant actually DID. Deterministic ids keep repeated reports
            // idempotent, exactly as for the workflow row itself.
            for (const call of wf.mcp_calls ?? []) {
              try {
                await backends.cpResults.insertMcpCall({
                  id: `${body.run_id}:${wf.workflow_id}:call:${call.call_index}`,
                  workflow_id: `${body.run_id}:${wf.workflow_id}`,
                  run_id: body.run_id,
                  call_index: call.call_index,
                  tool_name: call.tool_name,
                  request: call.request ?? {},
                  ...(call.response ? { response: call.response } : {}),
                  ...(call.error ? { error: call.error } : {}),
                });
                childrenWritten += 1;
              } catch (e) {
                childrenRejected += 1;
                lastWorkflowError = e instanceof Error ? e.message.slice(0, 200) : String(e);
              }
            }

            // The conversation itself — prompt in, visible reply out. This is the cassette the
            // console renders. Before it was persisted the panel had nothing to show and displayed a
            // hardcoded "Use Dorinda." with no reply beneath it, on every run.
            for (const turn of wf.turns ?? []) {
              try {
                await backends.cpResults.insertTurn({
                  id: `${body.run_id}:${wf.workflow_id}:turn:${turn.turn_index}`,
                  workflow_id: `${body.run_id}:${wf.workflow_id}`,
                  run_id: body.run_id,
                  turn_index: turn.turn_index,
                  ...(typeof turn.attempt === 'number' ? { attempt: turn.attempt } : {}),
                  ...(turn.scene ? { scene: turn.scene } : {}),
                  prompt: turn.prompt ?? '',
                  reply: turn.reply ?? '',
                  ...(turn.tool_calls ? { tool_calls: turn.tool_calls } : {}),
                  ...(turn.tool_trace_unreadable ? { tool_trace_unreadable: true } : {}),
                });
                childrenWritten += 1;
              } catch (e) {
                childrenRejected += 1;
                lastWorkflowError = e instanceof Error ? e.message.slice(0, 200) : String(e);
              }
            }

            // Claims — what the assistant SAID, and whether it held up.
            for (const claim of wf.claims ?? []) {
              try {
                await backends.cpResults.insertClaim({
                  id: `${body.run_id}:${wf.workflow_id}:claim:${claim.claim_index}`,
                  workflow_id: `${body.run_id}:${wf.workflow_id}`,
                  run_id: body.run_id,
                  claim_index: claim.claim_index,
                  ...(claim.claim_type ? { claim_type: claim.claim_type } : {}),
                  ...(claim.claim_text ? { claim_text: claim.claim_text } : {}),
                  ...(claim.verdict ? { verdict: claim.verdict as never } : {}),
                  ...(claim.evidence ? { evidence: claim.evidence } : {}),
                });
                childrenWritten += 1;
              } catch (e) {
                childrenRejected += 1;
                lastWorkflowError = e instanceof Error ? e.message.slice(0, 200) : String(e);
              }
            }

            // Scene evidence for the trial drilldown. Same idempotence rule as the workflow row: a
            // deterministic id per (run, workflow, trial, scene) so repeated reports replace rather
            // than multiply. Without these the console shows a verdict with no evidence behind it.
            for (const sc of wf.scenes ?? []) {
              try {
                await backends.cpResults.insertScene({
                  id: `${body.run_id}:${wf.workflow_id}:${sc.trial ?? 1}:${sc.scene_index}`,
                  workflow_id: `${body.run_id}:${wf.workflow_id}`,
                  run_id: body.run_id,
                  scene_index: sc.scene_index,
                  ...(sc.scene_name ? { scene_name: sc.scene_name } : {}),
                  ...(typeof sc.passed === 'boolean' ? { passed: sc.passed } : {}),
                  ...(sc.assertions ? { assertions: sc.assertions } : {}),
                  ...(sc.observed_values ? { observed_values: sc.observed_values } : {}),
                });
                scenesWritten += 1;
              } catch (e) {
                scenesRejected += 1;
                lastWorkflowError = e instanceof Error ? e.message.slice(0, 200) : String(e);
              }
            }
          } catch (e) {
            // ⛔ Count AND report it. This was silent, so a verdict-vocabulary mismatch rejected every
            // row while the response said `updated: true` — the caller had no way to know the table
            // stayed empty. A partial success that reports as a success is the failure mode this
            // whole night has been about.
            workflowsRejected += 1;
            lastWorkflowError = e instanceof Error ? e.message.slice(0, 200) : String(e);
            req.log?.warn?.({ err: e, workflow_id: wf.workflow_id }, 'ingest: workflow row failed');
          }
        }
      }

      // ⛔ A REJECTION MUST NAME ITS CAUSE AND REACH A LOG, not merely increment a counter.
      //
      // On 2026-08-14 every workflow inserted perfectly and every TURN failed on a missing column.
      // `lastWorkflowError` was attached only when WORKFLOWS were rejected, so the response carried
      // a bare `children_rejected` number, nothing was written to the service log, and the endpoint
      // answered 200/updated. Every cassette in a live full-catalogue run read "No transcript was
      // recorded" and Mark found it before I did — while the exact Postgres error sat in this
      // function's local variable and was discarded.
      //
      // The response alone is not enough: it is read by a Cloud Run job that treats reporting as
      // best-effort and moves on, so a rejection that rides only in the body is one nobody sees.
      if (workflowsRejected > 0 || childrenRejected > 0 || scenesRejected > 0) {
        console.error(
          `⛔ ingest ${body.run_id}: rejected ${workflowsRejected} workflow(s), ` +
            `${childrenRejected} child row(s), ${scenesRejected} scene(s) — ` +
            `${lastWorkflowError ?? 'no cause recorded'}`,
        );
      }

      return reply.code(200).send({
        updated: true,
        run_id: body.run_id,
        workflows: workflowsWritten,
        scenes: scenesWritten,
        children: childrenWritten,
        ...(childrenRejected > 0
          ? { children_rejected: childrenRejected, children_error: lastWorkflowError }
          : {}),
        ...(scenesRejected > 0 ? { scenes_rejected: scenesRejected, scenes_error: lastWorkflowError } : {}),
        ...(workflowsRejected > 0
          ? { workflows_rejected: workflowsRejected, workflow_error: lastWorkflowError }
          : {}),
      });
    },
  );
}
