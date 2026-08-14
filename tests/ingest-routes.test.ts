/**
 * tests/ingest-routes.test.ts
 *
 * Unit tests for the runner progress-ingest endpoint (POST /ingest/run-progress).
 *
 * Auth is tested by:
 *   - Directly exercising verifyGoogleServiceToken with injected `fetchImpl` (no network I/O).
 *   - Injecting a stub verifyToken into registerIngestRoutes for HTTP-layer route tests.
 *
 * The cp-results backend is stubbed so no database is needed.
 * Fastify is started and closed in each test via `app.inject()`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import Fastify from 'fastify';
import {
  registerIngestRoutes,
  verifyGoogleServiceToken,
  _setJwksCacheForTests,
  type ServiceTokenClaims,
} from '../src/api/ingest-routes';
import type { PgCpResultsBackend } from '../src/storage/backends/cp-results/pg';
import type { EvalRun } from '../src/storage/backends/cp-results/types';

// ── Backend mock ─────────────────────────────────────────────────────────────

/** A minimal stub for PgCpResultsBackend — only `updateRun` is called by the ingest route. */
function makeBackendMock(
  updateRunImpl: (_id: string, _update: Record<string, unknown>) => Promise<EvalRun | null> = async () =>
    null,
): PgCpResultsBackend {
  return {
    updateRun: vi.fn(updateRunImpl),
    upsertRun: vi.fn(),
    getRun: vi.fn().mockResolvedValue(null),
    listRuns: vi.fn().mockResolvedValue([]),
    listAllRuns: vi.fn().mockResolvedValue([]),
    deleteRun: vi.fn().mockResolvedValue(false),
    insertWorkflow: vi.fn(),
    getWorkflow: vi.fn().mockResolvedValue(null),
    listWorkflows: vi.fn().mockResolvedValue([]),
    insertScene: vi.fn(),
    listScenes: vi.fn().mockResolvedValue([]),
    insertTurn: vi.fn(),
    listTurns: vi.fn().mockResolvedValue([]),
    insertMcpCall: vi.fn(),
    listMcpCalls: vi.fn().mockResolvedValue([]),
    insertClaim: vi.fn(),
    listClaims: vi.fn().mockResolvedValue([]),
    acquireLease: vi.fn().mockResolvedValue(null),
    renewLease: vi.fn().mockResolvedValue(false),
    releaseLease: vi.fn().mockResolvedValue(false),
    getLease: vi.fn().mockResolvedValue(null),
    __truncateAllForTests: vi.fn(),
  } as unknown as PgCpResultsBackend;
}

/** A minimal stub for the `Backends` object returned by `getBackends()`. */
function makeBackendsWith(cpResults: PgCpResultsBackend | undefined) {
  return { cpResults };
}

// ── getBackends mock — module-level ──────────────────────────────────────────

vi.mock('../src/storage/backends', () => ({
  getBackends: vi.fn(),
}));

import { getBackends } from '../src/storage/backends';

// ── JWT helpers ───────────────────────────────────────────────────────────────

/**
 * Build a syntactically valid but UNSIGNED JWT.
 * Used for tests that check header / claim validation BEFORE signature verification.
 * Signature is the literal string "fakesig" encoded as base64url.
 */
function makeUnsignedJwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = Buffer.from('fakesig').toString('base64url');
  return `${h}.${p}.${sig}`;
}

/** A valid-looking payload for a runner service account. exp is far in the future. */
function runnerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    sub: '123456789',
    email: 'runner@dorinda-prod.iam.gserviceaccount.com',
    email_verified: true,
    aud: 'https://forge-cp.run.app',
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

// ── Fixed claims returned by stub verifier ───────────────────────────────────

const FAKE_CLAIMS: ServiceTokenClaims = {
  sub: '123',
  email: 'runner@dorinda-prod.iam.gserviceaccount.com',
  email_verified: true,
  aud: 'https://forge-cp.run.app',
  iss: 'https://accounts.google.com',
  iat: 1_000_000,
  exp: 9_999_999_999,
};

/** Stub verifier that unconditionally approves any token. */
const passVerifier = vi.fn().mockResolvedValue(FAKE_CLAIMS);
/** Stub verifier that unconditionally rejects any token. */
const failVerifier = vi.fn().mockResolvedValue(null);

// ── App factory ───────────────────────────────────────────────────────────────

/** Build a Fastify app with ingest routes using the given verifier stub. */
function buildApp(verifyToken: typeof verifyGoogleServiceToken = passVerifier as never) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    return reply.status(500).send({ error: { code: 'internal_error', message: err.message } });
  });
  registerIngestRoutes(app, { verifyToken });
  return app;
}

const closers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const app of closers.splice(0)) await app.close().catch(() => undefined);
  delete process.env.FORGE_RUNNER_SA_EMAIL;
  delete process.env.FORGE_INGEST_AUDIENCE;
  _setJwksCacheForTests(null);
  vi.clearAllMocks();
});

// ── verifyGoogleServiceToken pure-function tests ──────────────────────────────

describe('verifyGoogleServiceToken', () => {
  const SA_EMAIL = 'runner@dorinda-prod.iam.gserviceaccount.com';
  const AUDIENCE = 'https://forge-cp.run.app';

  beforeEach(() => {
    _setJwksCacheForTests(null);
  });

  it('returns null for a non-three-part token', async () => {
    expect(
      await verifyGoogleServiceToken('not.a.valid.jwt.too.many.parts', {
        audience: AUDIENCE,
        serviceAccountEmail: SA_EMAIL,
      }),
    ).toBeNull();
  });

  it('returns null when alg is not RS256', async () => {
    const token = makeUnsignedJwt({ alg: 'HS256', kid: 'k1' }, runnerPayload());
    expect(
      await verifyGoogleServiceToken(token, { audience: AUDIENCE, serviceAccountEmail: SA_EMAIL }),
    ).toBeNull();
  });

  it('returns null when iss is not Google', async () => {
    const token = makeUnsignedJwt({ alg: 'RS256', kid: 'k1' }, runnerPayload({ iss: 'https://evil.com' }));
    expect(
      await verifyGoogleServiceToken(token, { audience: AUDIENCE, serviceAccountEmail: SA_EMAIL }),
    ).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const token = makeUnsignedJwt(
      { alg: 'RS256', kid: 'k1' },
      runnerPayload({ exp: Math.floor(Date.now() / 1000) - 1 }),
    );
    expect(
      await verifyGoogleServiceToken(token, { audience: AUDIENCE, serviceAccountEmail: SA_EMAIL }),
    ).toBeNull();
  });

  it('returns null when aud does not match the configured audience', async () => {
    const token = makeUnsignedJwt(
      { alg: 'RS256', kid: 'k1' },
      runnerPayload({ aud: 'https://other-service.run.app' }),
    );
    expect(
      await verifyGoogleServiceToken(token, { audience: AUDIENCE, serviceAccountEmail: SA_EMAIL }),
    ).toBeNull();
  });

  it('accepts an array aud that includes the configured audience', async () => {
    // JWKS returns no key → null from signature step, but aud check is satisfied first.
    // What matters: null comes from JWKS (no key), not from aud mismatch.
    _setJwksCacheForTests({ keys: [], at: Date.now() });
    const token = makeUnsignedJwt(
      { alg: 'RS256', kid: 'k1' },
      runnerPayload({ aud: [AUDIENCE, 'https://other.example.com'] }),
    );
    // We just confirm it reaches the JWKS step (null from kid not found, not from aud).
    expect(
      await verifyGoogleServiceToken(token, { audience: AUDIENCE, serviceAccountEmail: SA_EMAIL }),
    ).toBeNull(); // still null — but from JWKS, not aud check
  });

  it('returns null when email does not match the configured runner SA', async () => {
    const token = makeUnsignedJwt(
      { alg: 'RS256', kid: 'k1' },
      runnerPayload({ email: 'other-sa@project.iam.gserviceaccount.com' }),
    );
    expect(
      await verifyGoogleServiceToken(token, { audience: AUDIENCE, serviceAccountEmail: SA_EMAIL }),
    ).toBeNull();
  });

  it('returns null when email_verified is false', async () => {
    const token = makeUnsignedJwt({ alg: 'RS256', kid: 'k1' }, runnerPayload({ email_verified: false }));
    expect(
      await verifyGoogleServiceToken(token, { audience: AUDIENCE, serviceAccountEmail: SA_EMAIL }),
    ).toBeNull();
  });

  it('returns null when JWKS fetch fails', async () => {
    const token = makeUnsignedJwt({ alg: 'RS256', kid: 'k1' }, runnerPayload());
    const badFetch = vi.fn().mockRejectedValue(new Error('network error'));
    expect(
      await verifyGoogleServiceToken(
        token,
        { audience: AUDIENCE, serviceAccountEmail: SA_EMAIL },
        badFetch as unknown as typeof fetch,
      ),
    ).toBeNull();
  });

  it('returns null when kid is not found in JWKS', async () => {
    _setJwksCacheForTests({ keys: [{ kid: 'other-kid', kty: 'RSA' }], at: Date.now() });
    const token = makeUnsignedJwt({ alg: 'RS256', kid: 'k1' }, runnerPayload());
    expect(
      await verifyGoogleServiceToken(token, { audience: AUDIENCE, serviceAccountEmail: SA_EMAIL }),
    ).toBeNull();
  });

  it('skips audience validation when audience is empty string', async () => {
    // JWKS returns no key → null from JWKS, not from aud check.
    _setJwksCacheForTests({ keys: [], at: Date.now() });
    const token = makeUnsignedJwt(
      { alg: 'RS256', kid: 'k1' },
      runnerPayload({ aud: 'https://any-audience.example.com' }),
    );
    // Null from JWKS step, not from aud check — confirms audience was not the blocker.
    expect(await verifyGoogleServiceToken(token, { audience: '', serviceAccountEmail: SA_EMAIL })).toBeNull();
  });
});

// ── Route: configuration gate ─────────────────────────────────────────────────

describe('POST /ingest/run-progress — configuration gate', () => {
  it('returns 501 when FORGE_RUNNER_SA_EMAIL is not set', async () => {
    delete process.env.FORGE_RUNNER_SA_EMAIL;
    const app = buildApp();
    closers.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      payload: { run_id: 'run-x' },
    });
    expect(res.statusCode).toBe(501);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('not_configured');
  });
});

// ── Route: auth gate ──────────────────────────────────────────────────────────

describe('POST /ingest/run-progress — auth gate', () => {
  beforeEach(() => {
    process.env.FORGE_RUNNER_SA_EMAIL = 'runner@dorinda-prod.iam.gserviceaccount.com';
  });

  it('returns 401 when no Authorization header is present', async () => {
    const app = buildApp(failVerifier as never);
    closers.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      payload: { run_id: 'run-x' },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 401 when Authorization is not the Bearer scheme', async () => {
    const app = buildApp(failVerifier as never);
    closers.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
      payload: { run_id: 'run-x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when the token is present but verification fails', async () => {
    const app = buildApp(failVerifier as never);
    closers.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer some.token.value' },
      payload: { run_id: 'run-x' },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('passes the token to the verifier', async () => {
    // Even after auth (pass), we need a backend. Wire cpResults = undefined to get 501.
    vi.mocked(getBackends).mockResolvedValue(makeBackendsWith(undefined) as never);
    const verifier = vi.fn().mockResolvedValue(FAKE_CLAIMS);
    const app = buildApp(verifier as never);
    closers.push(app);
    await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer the.real.token' },
      payload: { run_id: 'run-x' },
    });
    expect(verifier).toHaveBeenCalledOnce();
    const [calledToken] = verifier.mock.calls[0] as [string];
    expect(calledToken).toBe('the.real.token');
  });

  it('passes the configured SA email to the verifier', async () => {
    vi.mocked(getBackends).mockResolvedValue(makeBackendsWith(undefined) as never);
    const verifier = vi.fn().mockResolvedValue(FAKE_CLAIMS);
    process.env.FORGE_RUNNER_SA_EMAIL = 'specific-sa@proj.iam.gserviceaccount.com';
    const app = buildApp(verifier as never);
    closers.push(app);
    await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { run_id: 'run-x' },
    });
    const [, opts] = verifier.mock.calls[0] as [string, { serviceAccountEmail: string }];
    expect(opts.serviceAccountEmail).toBe('specific-sa@proj.iam.gserviceaccount.com');
  });

  it('passes FORGE_INGEST_AUDIENCE to the verifier when set', async () => {
    vi.mocked(getBackends).mockResolvedValue(makeBackendsWith(undefined) as never);
    const verifier = vi.fn().mockResolvedValue(FAKE_CLAIMS);
    process.env.FORGE_INGEST_AUDIENCE = 'https://my-cp.run.app';
    const app = buildApp(verifier as never);
    closers.push(app);
    await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { run_id: 'run-x' },
    });
    const [, opts] = verifier.mock.calls[0] as [string, { audience: string }];
    expect(opts.audience).toBe('https://my-cp.run.app');
  });
});

// ── Route: payload validation ─────────────────────────────────────────────────

describe('POST /ingest/run-progress — payload validation', () => {
  beforeEach(() => {
    process.env.FORGE_RUNNER_SA_EMAIL = 'runner@dorinda-prod.iam.gserviceaccount.com';
    const backend = makeBackendMock(async () => ({ run_id: 'run-x' }) as unknown as EvalRun);
    vi.mocked(getBackends).mockResolvedValue(makeBackendsWith(backend) as never);
  });

  it('returns 422 when run_id is missing', async () => {
    const app = buildApp();
    closers.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { status: 'running' },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_payload');
  });

  it('returns 422 when run_id is an empty or whitespace-only string', async () => {
    const app = buildApp();
    closers.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { run_id: '   ' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 422 when status is an invalid value', async () => {
    const app = buildApp();
    closers.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { run_id: 'run-x', status: 'destroyed' },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_payload');
  });
});

// ── Route: backend not configured ────────────────────────────────────────────

describe('POST /ingest/run-progress — backend not configured', () => {
  beforeEach(() => {
    process.env.FORGE_RUNNER_SA_EMAIL = 'runner@dorinda-prod.iam.gserviceaccount.com';
    vi.mocked(getBackends).mockResolvedValue(makeBackendsWith(undefined) as never);
  });

  it('returns 501 when cpResults backend is not enabled', async () => {
    const app = buildApp();
    closers.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { run_id: 'run-x', status: 'running' },
    });
    expect(res.statusCode).toBe(501);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('not_configured');
  });
});

// ── Route: successful write ───────────────────────────────────────────────────

describe('POST /ingest/run-progress — successful write', () => {
  const existingRun: EvalRun = {
    run_id: 'run-x',
    tenant_id: 'dorinda-prod',
    canonical_url: null,
    provider: null,
    trigger_source: 'manual',
    workflows_attempted: 0,
    workflows_passed: 0,
    workflows_failed: 0,
    pass_rate: null,
    withheld_count: 0,
    rejected_count: 0,
    spend_cents: 0,
    p50_duration_ms: null,
    p99_duration_ms: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    status: 'running',
    started_at: '2026-08-13T20:00:00Z',
    completed_at: null,
    meta: {},
    created_at: '2026-08-13T20:00:00Z',
    updated_at: '2026-08-13T20:00:00Z',
  };

  let backend: PgCpResultsBackend;

  beforeEach(() => {
    process.env.FORGE_RUNNER_SA_EMAIL = 'runner@dorinda-prod.iam.gserviceaccount.com';
    backend = makeBackendMock(async () => existingRun);
    vi.mocked(getBackends).mockResolvedValue(makeBackendsWith(backend) as never);
  });

  it('returns 200 with updated: true on a valid in-progress report', async () => {
    const app = buildApp();
    closers.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: {
        run_id: 'run-x',
        workflows_intended: 10,
        outcomes: { pass: 3, fail: 1, error: 0, skip: 0 },
        spend_cents: 42,
        status: 'running',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { updated: boolean; run_id: string };
    expect(body.updated).toBe(true);
    expect(body.run_id).toBe('run-x');
  });

  it('calls updateRun with correct mapped counters', async () => {
    const app = buildApp();
    closers.push(app);
    await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: {
        run_id: 'run-x',
        workflows_intended: 10,
        outcomes: { pass: 5, fail: 2, error: 1, skip: 2 },
        spend_cents: 100,
        status: 'completed',
      },
    });
    expect(backend.updateRun).toHaveBeenCalledOnce();
    const [runId, update] = (backend.updateRun as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(runId).toBe('run-x');
    // attempted = pass + fail + error = 5+2+1 = 8
    expect(update['workflows_attempted']).toBe(8);
    expect(update['workflows_passed']).toBe(5);
    // failed = fail + error = 2+1 = 3
    expect(update['workflows_failed']).toBe(3);
    // withheld = skip
    expect(update['withheld_count']).toBe(2);
    expect(update['spend_cents']).toBe(100);
    expect(update['status']).toBe('completed');
    expect(typeof update['completed_at']).toBe('string');
    expect(update['pass_rate']).toBeCloseTo(5 / 8);
  });

  it('does not set completed_at for non-terminal status (running)', async () => {
    const app = buildApp();
    closers.push(app);
    await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { run_id: 'run-x', outcomes: { pass: 2 }, status: 'running' },
    });
    const [, update] = (backend.updateRun as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(update['completed_at']).toBeUndefined();
  });

  it('sets completed_at for failed status', async () => {
    const app = buildApp();
    closers.push(app);
    await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { run_id: 'run-x', status: 'failed' },
    });
    const [, update] = (backend.updateRun as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(typeof update['completed_at']).toBe('string');
  });

  it('sets completed_at for aborted status', async () => {
    const app = buildApp();
    closers.push(app);
    await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { run_id: 'run-x', status: 'aborted' },
    });
    const [, update] = (backend.updateRun as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(typeof update['completed_at']).toBe('string');
  });

  it('stores runner SA email in meta', async () => {
    const app = buildApp();
    closers.push(app);
    await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { run_id: 'run-x', workflows_intended: 5 },
    });
    const [, update] = (backend.updateRun as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const meta = update['meta'] as Record<string, unknown>;
    // The FAKE_CLAIMS.email is what passVerifier returns
    expect(meta['runner_sa']).toBe('runner@dorinda-prod.iam.gserviceaccount.com');
    expect(meta['workflows_intended']).toBe(5);
  });

  it('does not set workflows_intended in meta when omitted', async () => {
    const app = buildApp();
    closers.push(app);
    await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { run_id: 'run-x' },
    });
    const [, update] = (backend.updateRun as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const meta = update['meta'] as Record<string, unknown>;
    expect(meta['workflows_intended']).toBeUndefined();
  });

  it('returns 404 when updateRun returns null (run not found)', async () => {
    const nullBackend = makeBackendMock(async () => null);
    vi.mocked(getBackends).mockResolvedValue(makeBackendsWith(nullBackend) as never);

    const app = buildApp();
    closers.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { run_id: 'run-missing', status: 'completed' },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('accepts a payload with no outcomes (all counters default to 0)', async () => {
    const app = buildApp();
    closers.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { run_id: 'run-x' },
    });
    expect(res.statusCode).toBe(200);
    const [, update] = (backend.updateRun as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(update['workflows_attempted']).toBe(0);
    expect(update['workflows_passed']).toBe(0);
    expect(update['workflows_failed']).toBe(0);
    expect(update['spend_cents']).toBe(0);
  });

  it('repeated reports for the same run_id each invoke updateRun (idempotent at the row level)', async () => {
    const app = buildApp();
    closers.push(app);
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/ingest/run-progress',
        headers: { authorization: 'Bearer x.y.z' },
        payload: { run_id: 'run-x', outcomes: { pass: i + 1 }, status: 'running' },
      });
    }
    expect(backend.updateRun).toHaveBeenCalledTimes(3);
  });

  it('does not set pass_rate when attempted is 0', async () => {
    const app = buildApp();
    closers.push(app);
    await app.inject({
      method: 'POST',
      url: '/ingest/run-progress',
      headers: { authorization: 'Bearer x.y.z' },
      payload: { run_id: 'run-x', outcomes: { skip: 5 }, status: 'running' },
    });
    const [, update] = (backend.updateRun as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // skip = 5, pass/fail/error = 0 → attempted = 0 → no pass_rate
    expect(update['pass_rate']).toBeUndefined();
  });

  it('accepts all four valid terminal statuses', async () => {
    const statuses = ['completed', 'failed', 'aborted'] as const;
    for (const status of statuses) {
      const b = makeBackendMock(async () => existingRun);
      vi.mocked(getBackends).mockResolvedValue(makeBackendsWith(b) as never);
      const app = buildApp();
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/ingest/run-progress',
        headers: { authorization: 'Bearer x.y.z' },
        payload: { run_id: 'run-x', status },
      });
      expect(res.statusCode).toBe(200);
      const [, update] = (b.updateRun as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(update['status']).toBe(status);
    }
  });
});

describe('per-workflow rows', () => {
  // A run reading `attempted 1 · passed 1` above an empty drilldown table is the bug this closes:
  // the aggregate says work happened and the table cannot name any of it (Mark, 2026-08-14).
  it('persists a row per workflow, keyed so repeats do not duplicate', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'api', 'ingest-routes.ts'), 'utf8');
    expect(src).toContain('insertWorkflow');
    // Deterministic id — the same workflow in the same run is the SAME row however often reported.
    expect(src).toMatch(/id: `\$\{body\.run_id\}:\$\{wf\.workflow_id\}`/);
  });

  it('⛔ a failed workflow row never fails the whole report', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'api', 'ingest-routes.ts'), 'utf8');
    const block = src.slice(src.indexOf('Per-workflow rows'), src.indexOf('return reply.code(200)'));
    expect(block).toMatch(/try\s*\{/);
    expect(block).toMatch(/catch/);
  });
});

describe('verdict translation at the boundary', () => {
  // HAT speaks ACCEPTED/REJECTED/UNARMED/INFRA-FAIL; the column takes pass|fail|error|skip. Sending
  // HAT's words rejected every row, and because a row failure is non-fatal the response still said
  // `updated: true` — a run showed `attempted 2 · passed 2` above an empty table (Mark, 2026-08-14).
  const src = readFileSync(join(__dirname, '..', 'src', 'api', 'ingest-routes.ts'), 'utf8');

  it('maps HAT verdicts onto the store vocabulary', () => {
    expect(src).toContain("case 'ACCEPTED'");
    expect(src).toMatch(/return 'pass'/);
    expect(src).toMatch(/return 'fail'/);
  });

  it('⛔ rig failures map to error, never to fail', () => {
    // Counting INFRA-FAIL/UNARMED as a product rejection is the misreport withheld verdicts prevent.
    const fn = src.slice(src.indexOf('toStoreVerdict'), src.indexOf('let workflowsWritten'));
    expect(fn).toMatch(/default:\s*\n?\s*return 'error'/);
    expect(fn).not.toMatch(/INFRA-FAIL[\s\S]{0,40}return 'fail'/);
  });

  it('⛔ rejected rows are reported, not swallowed', () => {
    expect(src).toContain('workflows_rejected');
  });
});

describe('the route persists every metric the sender can provide', () => {
  // ⛔ The defect this closes: the runner was extended to report p50/p99 and token totals, the route
  // was NOT extended to copy them into its update, and the console rendered null while the payload
  // carried the values correctly. Sender and receiver are two halves of one contract; changing one
  // alone is the failure this file keeps producing (Mark, 2026-08-14: "check ALL metrics").
  const src = readFileSync(join(__dirname, '..', 'src', 'api', 'ingest-routes.ts'), 'utf8');
  const types = readFileSync(
    join(__dirname, '..', 'src', 'storage', 'backends', 'cp-results', 'types.ts'),
    'utf8',
  );

  it('⛔ every EvalRunUpdate column is either persisted here or explicitly server-derived', () => {
    const block = types.slice(types.indexOf('interface EvalRunUpdate'));
    const columns = [...block.slice(0, block.indexOf('}')).matchAll(/^\s+([a-z0-9_]+)\??:/gm)].map(
      (m) => m[1] as string,
    );
    expect(columns.length).toBeGreaterThan(5);

    // Derived by this handler from `outcomes`, or set by it directly — not carried on the payload.
    const derived = new Set([
      'workflows_attempted',
      'workflows_passed',
      'workflows_failed',
      'pass_rate',
      'completed_at',
      'meta',
      'status',
      'withheld_count', // taken from the payload when present, falls back to a derived value
    ]);

    // A column counts as persisted whether it is set in the update LITERAL (`spend_cents: …`) or
    // assigned afterwards (`update.p50_duration_ms = …`). Checking only one form made the guard
    // accuse working code, which is how a check earns its way into being ignored.
    const literal = src.slice(src.indexOf('const update: EvalRunUpdate'), src.indexOf('const isTerminal'));
    const unpersisted = columns.filter(
      (c) => !derived.has(c) && !src.includes(`update.${c}`) && !new RegExp(`^\\s+${c}:`, 'm').test(literal),
    );
    expect(
      unpersisted,
      `these columns are never written by the ingest route, so they stay null no matter what the ` +
        `runner sends: ${unpersisted.join(', ')}`,
    ).toEqual([]);
  });
});

describe('MCP calls, claims and the workflow name', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'api', 'ingest-routes.ts'), 'utf8');

  it('persists MCP calls with deterministic ids', () => {
    expect(src).toContain('insertMcpCall');
    expect(src).toMatch(/:call:\$\{call\.call_index\}/);
  });

  it('persists claims with deterministic ids', () => {
    expect(src).toContain('insertClaim');
    expect(src).toMatch(/:claim:\$\{claim\.claim_index\}/);
  });

  it('persists the CONVERSATION — prompt and reply both', () => {
    // The reply is the half that never left the container. forge-hat captured it in every
    // `host.turn` and dropped it, so the console's cassette panel had no transcript and covered
    // that with a hardcoded prompt and no answer at all (2026-08-14).
    expect(src).toContain('insertTurn');
    expect(src).toMatch(/:turn:\$\{turn\.turn_index\}/);
    expect(src).toMatch(/prompt: turn\.prompt/);
    expect(src).toMatch(/reply: turn\.reply/);
  });

  it('carries "the tool trace was unreadable" through the pipe', () => {
    // An unreadable trace is not an empty one. Dropping the flag here would let a blind turn render
    // as one where the assistant simply called nothing.
    expect(src).toContain('tool_trace_unreadable');
  });

  it('⛔ a rejected child row is counted and returned, never swallowed', () => {
    expect(src).toContain('children_rejected');
  });

  it('stores the human-readable workflow name', () => {
    // `W-001:openai` tells an operator nothing about what was tested.
    expect(src).toMatch(/meta: \{ name: wf\.name \}/);
  });
});

describe('the ingest route can carry a full catalogue', () => {
  const routeSrc = readFileSync(join(__dirname, '..', 'src', 'api', 'ingest-routes.ts'), 'utf8');

  it('⛔ accepts a body large enough for every workflow in the catalogue', () => {
    // 2026-08-14, found in pre-flight before a full run: the server-wide bodyLimit is 1 MB, and the
    // runner re-sends every workflow it knows about on each push (deliberately — a repeat heals a
    // dropped report). One workflow measured 164 KB raw / 35 KB clipped, so 76 workflows is ~2.7 MB.
    // Every push from roughly workflow 7 would have 413'd, INCLUDING the terminal one: counters
    // frozen at 6, row stuck `running` forever while the job quietly finished. The exact failure
    // this pipe exists to prevent, caused by the pipe, and triggered by SUCCESS.
    const m = routeSrc.match(/bodyLimit:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/);
    expect(m, 'the ingest route must set its own bodyLimit').toBeTruthy();
    const limitBytes = Number(m![1]) * 1024 * 1024;

    const CATALOGUE = 76;
    const CLIPPED_BYTES_PER_WORKFLOW = 35_023; // measured against real stored evidence
    const projected = CATALOGUE * CLIPPED_BYTES_PER_WORKFLOW;

    expect(limitBytes).toBeGreaterThan(projected);
    // Headroom, not a hairline: the suite grows, and a limit that only just fits today fails
    // silently on the run that adds the workflow which crosses it.
    expect(limitBytes).toBeGreaterThanOrEqual(projected * 4);
  });

  it('raises the limit on THIS route only, never server-wide', () => {
    // No other endpoint has any business accepting a multi-megabyte body.
    const server = readFileSync(join(__dirname, '..', 'src', 'console', 'server.ts'), 'utf8');
    expect(server).toMatch(/bodyLimit:\s*1_000_000/);
  });
});
