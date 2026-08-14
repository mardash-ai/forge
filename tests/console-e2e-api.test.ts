/**
 * forge-console — e2e read API + MCP tools.
 *
 * Tests the shared query functions and the REST / MCP endpoints on the console server.
 * All tests run against in-memory mocks — no database required.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { reconcileRunningRuns } from '../src/console/server';
import type { PgCpResultsBackend } from '../src/storage/backends/cp-results/pg';
import type {
  EvalRun,
  EvalWorkflow,
  EvalScene,
  EvalMcpCall,
  EvalClaim,
} from '../src/storage/backends/cp-results/types';
import {
  queryListRuns,
  queryGetRun,
  queryGetWorkflow,
  queryDiffRuns,
  TRIAGE_INSTRUCTIONS,
  E2E_MCP_TOOLS,
} from '../src/console/e2e-api';
import { buildServer, makeSessionCookie, OIDC_SESSION_COOKIE, _resetAuditLog } from '../src/console/server';

// Mock the GCP jobs module so POST /api/e2e/runs tests never hit the real Cloud Run API.
// vi.mock is hoisted, so this runs before any import in this file.
vi.mock('../src/plugins/console-gcp/jobs', () => ({
  // Default: an execution still in flight, so reconciliation leaves rows untouched unless a test
  // says otherwise. Reconciliation reads this to decide whether a 'running' row has really ended.
  getExecutionState: vi.fn().mockResolvedValue({ state: 'running' }),
  triggerCloudRunJob: vi.fn().mockResolvedValue({
    operation_name: 'projects/test-project/locations/us-east1/operations/op-123',
    execution_name: 'projects/test-project/locations/us-east1/jobs/forge-e2e-runner/executions/exec-123',
  }),
  buildExecutionConsoleUrl: vi
    .fn()
    .mockReturnValue(
      'https://console.cloud.google.com/run/jobs/details/us-east1/forge-e2e-runner/executions/exec-123?project=test-project',
    ),
}));

// ── Auth helpers ──────────────────────────────────────────────────────────────
// SESSION_SECRET must match CONSOLE_SESSION_SECRET set in withOidcEnv below.
const SESSION_SECRET = 'test-session-secret-long-enough';
const AUTOMATION_TOKEN = 'test-automation-token-abc';

function authed(): string {
  return `${OIDC_SESSION_COOKIE}=${makeSessionCookie('mark@mardash.ai', SESSION_SECRET)}`;
}

async function withOidcEnv(fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  const envVars: Record<string, string> = {
    CONSOLE_GOOGLE_CLIENT_ID: 'test-client-id',
    CONSOLE_GOOGLE_CLIENT_SECRET: 'test-client-secret',
    CONSOLE_SESSION_SECRET: SESSION_SECRET,
    CONSOLE_INSECURE_COOKIES: '1',
  };
  for (const [k, v] of Object.entries(envVars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withAutomationEnv(fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  const envVars: Record<string, string> = {
    CONSOLE_GOOGLE_CLIENT_ID: 'test-client-id',
    CONSOLE_GOOGLE_CLIENT_SECRET: 'test-client-secret',
    CONSOLE_SESSION_SECRET: SESSION_SECRET,
    CONSOLE_INSECURE_COOKIES: '1',
    CONSOLE_AUTOMATION_TOKEN: AUTOMATION_TOKEN,
  };
  for (const [k, v] of Object.entries(envVars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Track open Fastify instances so afterEach can close them.
const closers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const app of closers.splice(0)) {
    await app.close().catch(() => undefined);
  }
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    run_id: 'run_001',
    tenant_id: 'tenant_a',
    canonical_url: 'https://cp.example.com/runs/run_001',
    provider: 'anthropic',
    trigger_source: 'schedule',
    workflows_attempted: 10,
    workflows_passed: 8,
    workflows_failed: 2,
    pass_rate: 0.8,
    withheld_count: 0,
    rejected_count: 0,
    spend_cents: 0,
    p50_duration_ms: 1200,
    p99_duration_ms: 3400,
    total_input_tokens: 50000,
    total_output_tokens: 8000,
    status: 'completed',
    started_at: '2026-08-11T01:00:00Z',
    completed_at: '2026-08-11T01:15:00Z',
    meta: {},
    created_at: '2026-08-11T01:00:00Z',
    updated_at: '2026-08-11T01:15:00Z',
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<EvalWorkflow> = {}): EvalWorkflow {
  return {
    id: 'wf_row_01',
    run_id: 'run_001',
    workflow_id: 'wf_suite_case_01',
    tenant_id: 'tenant_a',
    verdict: 'pass',
    integrity_class: 'clean',
    prompt: 'Do the thing',
    duration_ms: 1200,
    started_at: '2026-08-11T01:01:00Z',
    completed_at: '2026-08-11T01:01:02Z',
    input_tokens: 500,
    output_tokens: 80,
    provider: 'anthropic',
    lanes: [],
    trials_total: 1,
    trials_passed: 1,
    failing_bar: null,
    meta: {},
    created_at: '2026-08-11T01:01:00Z',
    updated_at: '2026-08-11T01:01:02Z',
    ...overrides,
  };
}

function makeScene(overrides: Partial<EvalScene> = {}): EvalScene {
  return {
    id: 'sc_01',
    workflow_id: 'wf_row_01',
    run_id: 'run_001',
    scene_index: 0,
    scene_name: 'check state',
    assertions: [{ name: 'count', expected: 3, operator: 'eq' }],
    observed_values: [{ name: 'count', value: 3 }],
    passed: true,
    created_at: '2026-08-11T01:01:01Z',
    ...overrides,
  };
}

function makeMcpCall(overrides: Partial<EvalMcpCall> = {}): EvalMcpCall {
  return {
    id: 'call_01',
    workflow_id: 'wf_row_01',
    run_id: 'run_001',
    call_index: 0,
    tool_name: 'search',
    request: { query: 'hello' },
    response: { results: [] },
    duration_ms: 45,
    error: null,
    called_at: '2026-08-11T01:01:00.500Z',
    created_at: '2026-08-11T01:01:00.500Z',
    ...overrides,
  };
}

function makeClaim(overrides: Partial<EvalClaim> = {}): EvalClaim {
  return {
    id: 'claim_01',
    workflow_id: 'wf_row_01',
    run_id: 'run_001',
    claim_index: 0,
    claim_type: 'assertion',
    claim_text: 'The result count is 3',
    verdict: 'verified',
    evidence: {},
    cassette: {},
    created_at: '2026-08-11T01:01:01Z',
    ...overrides,
  };
}

/** Build a minimal mock PgCpResultsBackend. Only the methods used by e2e-api are needed. */
function makeMockStore(
  overrides: Partial<Record<keyof PgCpResultsBackend, unknown>> = {},
): PgCpResultsBackend {
  return {
    listAllRuns: vi.fn().mockResolvedValue([]),
    getRun: vi.fn().mockResolvedValue(null),
    listWorkflows: vi.fn().mockResolvedValue([]),
    getWorkflow: vi.fn().mockResolvedValue(null),
    listScenes: vi.fn().mockResolvedValue([]),
    listMcpCalls: vi.fn().mockResolvedValue([]),
    listClaims: vi.fn().mockResolvedValue([]),
    // The rest are not called by e2e-api — stub them out.
    upsertRun: vi.fn(),
    updateRun: vi.fn(),
    listRuns: vi.fn(),
    insertWorkflow: vi.fn(),
    insertScene: vi.fn(),
    insertMcpCall: vi.fn(),
    insertClaim: vi.fn(),
    acquireLease: vi.fn(),
    renewLease: vi.fn(),
    releaseLease: vi.fn(),
    getLease: vi.fn(),
    // deleteRun is called by the DELETE /api/e2e/runs/:run_id handler.
    // Default: run existed and was deleted (true). Override per-test to simulate not-found or cascade.
    deleteRun: vi.fn().mockResolvedValue(true),
    __truncateAllForTests: vi.fn(),
    ...overrides,
  } as unknown as PgCpResultsBackend;
}

// ── queryListRuns ─────────────────────────────────────────────────────────────

describe('queryListRuns', () => {
  it('delegates to store.listAllRuns with the given options', async () => {
    const run = makeRun();
    const store = makeMockStore({ listAllRuns: vi.fn().mockResolvedValue([run]) });
    const result = await queryListRuns(store, { tenant: 'tenant_a', limit: 5, status: 'completed' });
    expect(result).toHaveLength(1);
    expect(result[0]!.run_id).toBe('run_001');
    expect((store.listAllRuns as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual({
      tenant: 'tenant_a',
      limit: 5,
      status: 'completed',
    });
  });

  it('returns empty array when no runs exist', async () => {
    const store = makeMockStore();
    expect(await queryListRuns(store)).toEqual([]);
  });
});

// ── queryGetRun ───────────────────────────────────────────────────────────────

describe('queryGetRun', () => {
  it('returns null when run not found', async () => {
    const store = makeMockStore();
    expect(await queryGetRun(store, 'missing')).toBeNull();
  });

  it('returns run + all failures (verdict fail or error)', async () => {
    const run = makeRun();
    const pass = makeWorkflow({ id: 'wf_pass', workflow_id: 'case_pass', verdict: 'pass' });
    const fail = makeWorkflow({ id: 'wf_fail', workflow_id: 'case_fail', verdict: 'fail' });
    const err = makeWorkflow({ id: 'wf_err', workflow_id: 'case_err', verdict: 'error' });
    const skip = makeWorkflow({ id: 'wf_skip', workflow_id: 'case_skip', verdict: 'skip' });
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(run),
      listWorkflows: vi.fn().mockResolvedValue([pass, fail, err, skip]),
    });
    const detail = await queryGetRun(store, 'run_001');
    expect(detail).not.toBeNull();
    expect(detail!.run.run_id).toBe('run_001');
    expect(detail!.failures).toHaveLength(2);
    expect(detail!.failure_count).toBe(2);
    expect(detail!.failures.map((f) => f.id).sort()).toEqual(['wf_err', 'wf_fail'].sort());
  });

  it('returns failure_count = 0 when all workflows pass', async () => {
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(makeRun()),
      listWorkflows: vi.fn().mockResolvedValue([makeWorkflow({ verdict: 'pass' })]),
    });
    const detail = await queryGetRun(store, 'run_001');
    expect(detail!.failure_count).toBe(0);
    expect(detail!.failures).toHaveLength(0);
  });
});

// ── queryGetWorkflow ──────────────────────────────────────────────────────────

describe('queryGetWorkflow', () => {
  it('returns null when workflow not found', async () => {
    const store = makeMockStore();
    expect(await queryGetWorkflow(store, 'nope')).toBeNull();
  });

  it('returns workflow + scenes + mcp_calls + claims', async () => {
    const wf = makeWorkflow();
    const sc = makeScene();
    const call = makeMcpCall();
    const claim = makeClaim();
    const store = makeMockStore({
      getWorkflow: vi.fn().mockResolvedValue(wf),
      listScenes: vi.fn().mockResolvedValue([sc]),
      listMcpCalls: vi.fn().mockResolvedValue([call]),
      listClaims: vi.fn().mockResolvedValue([claim]),
    });
    const result = await queryGetWorkflow(store, 'wf_row_01');
    expect(result!.workflow.id).toBe('wf_row_01');
    expect(result!.scenes).toHaveLength(1);
    expect(result!.mcp_calls).toHaveLength(1);
    expect(result!.claims).toHaveLength(1);
    expect(result!.mcp_calls[0]!.tool_name).toBe('search');
  });
});

// ── queryDiffRuns ─────────────────────────────────────────────────────────────

describe('queryDiffRuns', () => {
  it('returns null when either run is not found', async () => {
    const store = makeMockStore({ getRun: vi.fn().mockResolvedValue(null) });
    expect(await queryDiffRuns(store, 'a', 'b')).toBeNull();
  });

  it('identifies regressions correctly', async () => {
    const runWf = makeWorkflow({ workflow_id: 'case_1', verdict: 'fail', run_id: 'run_002', id: 'wf_r2_1' });
    const baseWf = makeWorkflow({ workflow_id: 'case_1', verdict: 'pass', run_id: 'run_001', id: 'wf_r1_1' });
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(makeRun()),
      listWorkflows: vi
        .fn()
        .mockResolvedValueOnce([runWf]) // run_002 workflows
        .mockResolvedValueOnce([baseWf]), // run_001 (baseline) workflows
    });
    const diff = await queryDiffRuns(store, 'run_002', 'run_001');
    expect(diff!.regressions).toHaveLength(1);
    expect(diff!.regressions[0]!.workflow_id).toBe('case_1');
    expect(diff!.improvements).toHaveLength(0);
    expect(diff!.new_failures).toHaveLength(0);
    expect(diff!.new_passes).toHaveLength(0);
  });

  it('identifies improvements correctly', async () => {
    const runWf = makeWorkflow({ workflow_id: 'case_2', verdict: 'pass', run_id: 'run_002', id: 'wf_r2_2' });
    const baseWf = makeWorkflow({ workflow_id: 'case_2', verdict: 'fail', run_id: 'run_001', id: 'wf_r1_2' });
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(makeRun()),
      listWorkflows: vi.fn().mockResolvedValueOnce([runWf]).mockResolvedValueOnce([baseWf]),
    });
    const diff = await queryDiffRuns(store, 'run_002', 'run_001');
    expect(diff!.improvements).toHaveLength(1);
    expect(diff!.regressions).toHaveLength(0);
  });

  it('classifies new failing workflows correctly', async () => {
    const newFail = makeWorkflow({
      workflow_id: 'case_new',
      verdict: 'fail',
      run_id: 'run_002',
      id: 'wf_r2_new',
    });
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(makeRun()),
      listWorkflows: vi
        .fn()
        .mockResolvedValueOnce([newFail]) // run
        .mockResolvedValueOnce([]), // baseline — no workflows
    });
    const diff = await queryDiffRuns(store, 'run_002', 'run_001');
    expect(diff!.new_failures).toHaveLength(1);
    expect(diff!.new_passes).toHaveLength(0);
  });

  it('classifies new passing workflows correctly', async () => {
    const newPass = makeWorkflow({
      workflow_id: 'case_new',
      verdict: 'pass',
      run_id: 'run_002',
      id: 'wf_r2_new',
    });
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(makeRun()),
      listWorkflows: vi.fn().mockResolvedValueOnce([newPass]).mockResolvedValueOnce([]),
    });
    const diff = await queryDiffRuns(store, 'run_002', 'run_001');
    expect(diff!.new_passes).toHaveLength(1);
    expect(diff!.new_failures).toHaveLength(0);
  });

  it('handles mixed regressions + improvements + new', async () => {
    const r1 = makeWorkflow({ workflow_id: 'reg', verdict: 'fail', run_id: 'run_002', id: 'r1' });
    const i1 = makeWorkflow({ workflow_id: 'imp', verdict: 'pass', run_id: 'run_002', id: 'i1' });
    const n1 = makeWorkflow({ workflow_id: 'new', verdict: 'fail', run_id: 'run_002', id: 'n1' });
    const b_reg = makeWorkflow({ workflow_id: 'reg', verdict: 'pass', run_id: 'run_001', id: 'b_r' });
    const b_imp = makeWorkflow({ workflow_id: 'imp', verdict: 'fail', run_id: 'run_001', id: 'b_i' });
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(makeRun()),
      listWorkflows: vi.fn().mockResolvedValueOnce([r1, i1, n1]).mockResolvedValueOnce([b_reg, b_imp]),
    });
    const diff = await queryDiffRuns(store, 'run_002', 'run_001');
    expect(diff!.regressions).toHaveLength(1);
    expect(diff!.improvements).toHaveLength(1);
    expect(diff!.new_failures).toHaveLength(1);
  });
});

// ── Triage instructions + tool definitions ────────────────────────────────────

describe('TRIAGE_INSTRUCTIONS', () => {
  it('contains the guardrail keyword', () => {
    expect(TRIAGE_INSTRUCTIONS).toContain('guardrail 2');
  });
  it('references all four tools', () => {
    expect(TRIAGE_INSTRUCTIONS).toContain('list_e2e_runs');
    expect(TRIAGE_INSTRUCTIONS).toContain('diff_e2e_runs');
    expect(TRIAGE_INSTRUCTIONS).toContain('get_e2e_run');
    expect(TRIAGE_INSTRUCTIONS).toContain('get_workflow_result');
  });
  it('contains the integrity_class corrupted guardrail', () => {
    expect(TRIAGE_INSTRUCTIONS).toContain("integrity_class = 'corrupted'");
  });
  it('contains the canonical_url reference', () => {
    expect(TRIAGE_INSTRUCTIONS).toContain('canonical_url');
  });
});

describe('E2E_MCP_TOOLS', () => {
  it('exports exactly four tools', () => {
    expect(E2E_MCP_TOOLS).toHaveLength(4);
  });
  it('tool names are the canonical set', () => {
    const names = E2E_MCP_TOOLS.map((t) => t.name);
    expect(names).toContain('list_e2e_runs');
    expect(names).toContain('get_e2e_run');
    expect(names).toContain('get_workflow_result');
    expect(names).toContain('diff_e2e_runs');
  });
  it('every tool has a non-empty description and inputSchema', () => {
    for (const tool of E2E_MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema).toBeTruthy();
      expect((tool.inputSchema as { type: string }).type).toBe('object');
    }
  });
});

// ── Console server — REST endpoints ─────────────────────────────────────────
// All server tests use helpers defined at the top of the file: withOidcEnv,
// withAutomationEnv, authed(), and the closers afterEach hook.

describe('console server — GET /api/e2e/* REST endpoints', () => {
  it('GET /api/e2e/runs returns 501 when store not configured', async () => {
    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs',
        headers: { cookie: authed() },
      });
      expect(res.statusCode).toBe(501);
    });
  });

  it('GET /api/e2e/runs returns runs list when store is configured', async () => {
    const store = makeMockStore({ listAllRuns: vi.fn().mockResolvedValue([makeRun()]) });
    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs',
        headers: { cookie: authed() },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { data: EvalRun[] };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data[0]!.run_id).toBe('run_001');
    });
  });

  it('GET /api/e2e/runs/:run_id returns 404 when run not found', async () => {
    const store = makeMockStore({ getRun: vi.fn().mockResolvedValue(null) });
    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs/missing_run',
        headers: { cookie: authed() },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it('GET /api/e2e/runs/:run_id returns run detail with failures', async () => {
    const run = makeRun();
    const fail = makeWorkflow({ verdict: 'fail' });
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(run),
      listWorkflows: vi.fn().mockResolvedValue([fail]),
    });
    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs/run_001',
        headers: { cookie: authed() },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { data: { failure_count: number } };
      expect(body.data.failure_count).toBe(1);
    });
  });

  it('GET /api/e2e/runs/:run_id/workflows/:id returns 404 when workflow not found', async () => {
    const store = makeMockStore({ getWorkflow: vi.fn().mockResolvedValue(null) });
    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs/run_001/workflows/nope',
        headers: { cookie: authed() },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it('GET /api/e2e/runs/:run_id/workflows/:id returns full drilldown', async () => {
    const store = makeMockStore({
      getWorkflow: vi.fn().mockResolvedValue(makeWorkflow()),
      listScenes: vi.fn().mockResolvedValue([makeScene()]),
      listMcpCalls: vi.fn().mockResolvedValue([makeMcpCall()]),
      listClaims: vi.fn().mockResolvedValue([makeClaim()]),
    });
    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs/run_001/workflows/wf_row_01',
        headers: { cookie: authed() },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        data: { scenes: unknown[]; mcp_calls: unknown[]; claims: unknown[] };
      };
      expect(body.data.scenes).toHaveLength(1);
      expect(body.data.mcp_calls).toHaveLength(1);
      expect(body.data.claims).toHaveLength(1);
    });
  });

  it('GET /api/e2e/diff returns 400 when baseline_run_id missing', async () => {
    const store = makeMockStore();
    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/e2e/diff?run_id=run_002',
        headers: { cookie: authed() },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it('GET /api/e2e/diff returns 400 when run_id missing', async () => {
    const store = makeMockStore();
    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/e2e/diff?baseline_run_id=run_001',
        headers: { cookie: authed() },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  it('GET /api/e2e/diff returns diff result', async () => {
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(makeRun()),
      listWorkflows: vi.fn().mockResolvedValue([]),
    });
    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/e2e/diff?run_id=run_002&baseline_run_id=run_001',
        headers: { cookie: authed() },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { data: { run_id: string; regressions: unknown[] } };
      expect(body.data.run_id).toBe('run_002');
      expect(body.data.regressions).toHaveLength(0);
    });
  });
});

// ── Console server — MCP endpoint ────────────────────────────────────────────

describe('console server — GET /.well-known/oauth-protected-resource/mcp', () => {
  it('is public (no auth required)', async () => {
    // No OIDC env → fail-closed mode; the discovery doc should still be accessible.
    const app = buildServer(undefined, undefined, async () => null);
    closers.push(app);
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/mcp',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { resource: string };
    expect(body.resource).toMatch(/\/mcp$/);
  });
});

describe('console server — POST /mcp (JSON-RPC)', () => {
  it('returns 401 without auth', async () => {
    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  it('automation token can POST to /mcp (read-only exemption)', async () => {
    await withAutomationEnv(async () => {
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${AUTOMATION_TOKEN}` },
        payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
      });
      // NOT 403 — the MCP endpoint is exempt from the automation-token POST block.
      expect(res.statusCode).toBe(200);
    });
  });

  it('ping returns empty result', async () => {
    await withAutomationEnv(async () => {
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${AUTOMATION_TOKEN}` },
        payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
      });
      const body = JSON.parse(res.body) as { jsonrpc: string; id: number; result: unknown };
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      expect(body.result).toEqual({});
    });
  });

  it('initialize returns capabilities + triage instructions', async () => {
    await withAutomationEnv(async () => {
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${AUTOMATION_TOKEN}` },
        payload: { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      });
      const body = JSON.parse(res.body) as {
        result: { capabilities: unknown; instructions: string; serverInfo: { name: string } };
      };
      expect(body.result.serverInfo.name).toBe('forge-console-e2e');
      expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
      expect(body.result.instructions).toContain('guardrail 2');
    });
  });

  it('tools/list returns the four canonical tools', async () => {
    await withAutomationEnv(async () => {
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${AUTOMATION_TOKEN}` },
        payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      });
      const body = JSON.parse(res.body) as { result: { tools: Array<{ name: string }> } };
      expect(body.result.tools).toHaveLength(4);
      const names = body.result.tools.map((t) => t.name);
      expect(names).toContain('list_e2e_runs');
      expect(names).toContain('get_e2e_run');
      expect(names).toContain('get_workflow_result');
      expect(names).toContain('diff_e2e_runs');
    });
  });

  it('tools/call list_e2e_runs returns runs from store', async () => {
    const store = makeMockStore({ listAllRuns: vi.fn().mockResolvedValue([makeRun()]) });
    await withAutomationEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${AUTOMATION_TOKEN}` },
        payload: {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'list_e2e_runs', arguments: { limit: 5 } },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { result: { content: Array<{ text: string }> } };
      const data = JSON.parse(body.result.content[0]!.text) as EvalRun[];
      expect(data[0]!.run_id).toBe('run_001');
    });
  });

  it('tools/call get_e2e_run returns isError when run not found', async () => {
    const store = makeMockStore({ getRun: vi.fn().mockResolvedValue(null) });
    await withAutomationEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${AUTOMATION_TOKEN}` },
        payload: {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'get_e2e_run', arguments: { run_id: 'missing' } },
        },
      });
      const body = JSON.parse(res.body) as { result: { isError: boolean } };
      expect(body.result.isError).toBe(true);
    });
  });

  it('tools/call diff_e2e_runs returns regression info', async () => {
    const runWf = makeWorkflow({ workflow_id: 'case_1', verdict: 'fail', run_id: 'run_002', id: 'wf_r2' });
    const baseWf = makeWorkflow({ workflow_id: 'case_1', verdict: 'pass', run_id: 'run_001', id: 'wf_r1' });
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(makeRun()),
      listWorkflows: vi.fn().mockResolvedValueOnce([runWf]).mockResolvedValueOnce([baseWf]),
    });
    await withAutomationEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${AUTOMATION_TOKEN}` },
        payload: {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'diff_e2e_runs', arguments: { run_id: 'run_002', baseline_run_id: 'run_001' } },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as { result: { content: Array<{ text: string }> } };
      const data = JSON.parse(body.result.content[0]!.text) as { regressions: unknown[] };
      expect(data.regressions).toHaveLength(1);
    });
  });

  it('tools/call unknown tool returns JSON-RPC error -32601', async () => {
    await withAutomationEnv(async () => {
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${AUTOMATION_TOKEN}` },
        payload: {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'nonexistent_tool', arguments: {} },
        },
      });
      const body = JSON.parse(res.body) as { error: { code: number } };
      expect(body.error.code).toBe(-32601);
    });
  });

  it('tools/call returns isError when store not configured', async () => {
    await withAutomationEnv(async () => {
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${AUTOMATION_TOKEN}` },
        payload: {
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/call',
          params: { name: 'list_e2e_runs', arguments: {} },
        },
      });
      const body = JSON.parse(res.body) as { result: { isError: boolean } };
      expect(body.result.isError).toBe(true);
    });
  });

  it('JSON-RPC notification (no id field) returns 202 with empty body', async () => {
    await withAutomationEnv(async () => {
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${AUTOMATION_TOKEN}` },
        payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
      });
      expect(res.statusCode).toBe(202);
    });
  });
});

describe('console server — GET /mcp (SSE stream)', () => {
  it('returns 401 without auth', async () => {
    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({ method: 'GET', url: '/mcp' });
      expect(res.statusCode).toBe(401);
    });
  });
});

// ── POST /api/e2e/runs — e2e trigger ─────────────────────────────────────────

describe('POST /api/e2e/runs — e2e trigger', () => {
  /** Helper: set CONSOLE_E2E_JOB and restore on cleanup. */
  function withE2eJob(jobName: string, fn: () => Promise<void>): Promise<void> {
    const saved = process.env.CONSOLE_E2E_JOB;
    process.env.CONSOLE_E2E_JOB = jobName;
    return fn().finally(() => {
      if (saved === undefined) delete process.env.CONSOLE_E2E_JOB;
      else process.env.CONSOLE_E2E_JOB = saved;
    });
  }

  it('returns 401 without auth', async () => {
    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/api/e2e/runs',
        payload: { reason: 'manual test' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  it('returns 403 for automation token (read-only by construction)', async () => {
    await withAutomationEnv(async () => {
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/api/e2e/runs',
        headers: { authorization: `Bearer ${AUTOMATION_TOKEN}` },
        payload: { reason: 'manual test' },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(body.error.code).toBe('forbidden');
    });
  });

  it('returns 422 when reason is missing', async () => {
    await withOidcEnv(async () => {
      const secret = SESSION_SECRET;
      const cookie = makeSessionCookie('mark@mardash.ai', secret);
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/api/e2e/runs',
        headers: { cookie: `${OIDC_SESSION_COOKIE}=${cookie}` },
        payload: {},
      });
      expect(res.statusCode).toBe(422);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(body.error.code).toBe('reason_required');
    });
  });

  it('returns 422 when reason is too short', async () => {
    await withOidcEnv(async () => {
      const cookie = makeSessionCookie('mark@mardash.ai', SESSION_SECRET);
      const app = buildServer(undefined, undefined, async () => null);
      closers.push(app);
      const res = await app.inject({
        method: 'POST',
        url: '/api/e2e/runs',
        headers: { cookie: `${OIDC_SESSION_COOKIE}=${cookie}` },
        payload: { reason: 'ab' },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  it('returns 501 when CONSOLE_E2E_JOB is not configured', async () => {
    await withOidcEnv(async () => {
      // Ensure the env var is absent
      const saved = process.env.CONSOLE_E2E_JOB;
      delete process.env.CONSOLE_E2E_JOB;
      try {
        const cookie = makeSessionCookie('mark@mardash.ai', SESSION_SECRET);
        const app = buildServer(undefined, undefined, async () => null);
        closers.push(app);
        const res = await app.inject({
          method: 'POST',
          url: '/api/e2e/runs',
          headers: { cookie: `${OIDC_SESSION_COOKIE}=${cookie}` },
          payload: { reason: 'manual test' },
        });
        expect(res.statusCode).toBe(501);
        const body = JSON.parse(res.body) as { error: { code: string } };
        expect(body.error.code).toBe('not_configured');
      } finally {
        if (saved !== undefined) process.env.CONSOLE_E2E_JOB = saved;
      }
    });
  });

  it('returns 200 with run_id + state when job is configured and GCP accepts', async () => {
    await withOidcEnv(async () => {
      await withE2eJob('forge-e2e-runner', async () => {
        const cookie = makeSessionCookie('mark@mardash.ai', SESSION_SECRET);
        const store = makeMockStore({
          upsertRun: vi.fn().mockResolvedValue(makeRun()),
          updateRun: vi.fn().mockResolvedValue(makeRun()),
        });
        const app = buildServer(undefined, undefined, async () => store);
        closers.push(app);
        const res = await app.inject({
          method: 'POST',
          url: '/api/e2e/runs',
          headers: { cookie: `${OIDC_SESSION_COOKIE}=${cookie}` },
          payload: { reason: 'manual test run' },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { data: { run_id: string; state: string } };
        expect(body.data.run_id).toMatch(/^run-/);
        expect(body.data.state).toBe('running');
        // Store pre-create was called
        expect(store.upsertRun as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
        // Meta update with execution name was called
        expect(store.updateRun as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
          expect.stringMatching(/^run-/),
          expect.objectContaining({ meta: expect.objectContaining({ execution_name: expect.any(String) }) }),
        );
      });
    });
  });

  it('returns 200 without store pre-create when store is not configured', async () => {
    await withOidcEnv(async () => {
      await withE2eJob('forge-e2e-runner', async () => {
        const cookie = makeSessionCookie('mark@mardash.ai', SESSION_SECRET);
        const app = buildServer(undefined, undefined, async () => null);
        closers.push(app);
        const res = await app.inject({
          method: 'POST',
          url: '/api/e2e/runs',
          headers: { cookie: `${OIDC_SESSION_COOKIE}=${cookie}` },
          payload: { reason: 'no-store run', suite: 'privacy-tier', provider: 'openai' },
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { data: { run_id: string; state: string } };
        expect(body.data.run_id).toMatch(/^run-/);
        expect(body.data.state).toBe('running');
      });
    });
  });

  it('returns 502 when Cloud Run trigger fails and marks the pre-created run as failed', async () => {
    // Override the mock to throw for this test only
    const { triggerCloudRunJob: mockTrigger } = await import('../src/plugins/console-gcp/jobs');
    const savedImpl = (mockTrigger as ReturnType<typeof vi.fn>).getMockImplementation();
    (mockTrigger as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('GCP 403 jobs.run: permission denied'),
    );
    await withOidcEnv(async () => {
      await withE2eJob('forge-e2e-runner', async () => {
        const cookie = makeSessionCookie('mark@mardash.ai', SESSION_SECRET);
        const store = makeMockStore({
          upsertRun: vi.fn().mockResolvedValue(makeRun()),
          updateRun: vi.fn().mockResolvedValue(makeRun()),
        });
        const app = buildServer(undefined, undefined, async () => store);
        closers.push(app);
        const res = await app.inject({
          method: 'POST',
          url: '/api/e2e/runs',
          headers: { cookie: `${OIDC_SESSION_COOKIE}=${cookie}` },
          payload: { reason: 'test run that fails' },
        });
        expect(res.statusCode).toBe(502);
        const body = JSON.parse(res.body) as { error: { code: string } };
        expect(body.error.code).toBe('trigger_failed');
        // The pre-created run is marked failed so the tab does not show a ghost 'running' row.
        expect(store.updateRun as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
          expect.stringMatching(/^run-/),
          expect.objectContaining({ status: 'failed' }),
        );
      });
    });
    if (savedImpl) (mockTrigger as ReturnType<typeof vi.fn>).mockImplementation(savedImpl);
  });

  it('passes suite and workflow overrides to the job env', async () => {
    const { triggerCloudRunJob: mockTrigger } = await import('../src/plugins/console-gcp/jobs');
    await withOidcEnv(async () => {
      await withE2eJob('forge-e2e-runner', async () => {
        const cookie = makeSessionCookie('mark@mardash.ai', SESSION_SECRET);
        const app = buildServer(undefined, undefined, async () => null);
        closers.push(app);
        await app.inject({
          method: 'POST',
          url: '/api/e2e/runs',
          headers: { cookie: `${OIDC_SESSION_COOKIE}=${cookie}` },
          payload: {
            reason: 'scoped named-workflow run',
            workflows: ['draft-approve-sent', 'h9-privacy-sweep'],
            provider: 'openai',
          },
        });
        const lastCall = (mockTrigger as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
          env: Record<string, string>;
        };
        expect(lastCall?.env['E2E_WORKFLOWS']).toBe('draft-approve-sent,h9-privacy-sweep');
        expect(lastCall?.env['E2E_PROVIDER']).toBe('openai');
      });
    });
  });
});

// ── A run row must never sit at "running" after its execution has ended ─────────────────────────
//
// The row is pre-created as 'running' on click and finalised by the RUNNER. On 2026-08-13 the
// container could not exec, Cloud Run failed the execution in seconds, and the row stayed
// "running…" in the tab indefinitely because nothing ever revisited it. The execution is the
// source of truth; these tests pin that the row follows it.
describe('reconcileRunningRuns', () => {
  const rowRunning = (over: Record<string, unknown> = {}) => ({
    run_id: 'run-x',
    status: 'running',
    started_at: new Date().toISOString(),
    meta: { execution_name: 'projects/p/locations/r/jobs/j/executions/e' },
    ...over,
  });

  it('marks a row failed when its execution failed', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const store = { updateRun: async (_id: string, p: Record<string, unknown>) => void patches.push(p) };
    const rows = [rowRunning()];
    await reconcileRunningRuns(store, rows as never[], async () => ({
      state: 'failed',
      completed_at: '2026-08-13T20:00:00Z',
    }));
    expect(rows[0]!.status).toBe('failed');
    expect(patches[0]!['status']).toBe('failed');
    expect(patches[0]!['completed_at']).toBe('2026-08-13T20:00:00Z');
  });

  it('leaves a genuinely running execution alone', async () => {
    const patches: unknown[] = [];
    const store = { updateRun: async () => void patches.push(1) };
    const rows = [rowRunning()];
    await reconcileRunningRuns(store, rows as never[], async () => ({ state: 'running' }));
    expect(rows[0]!.status).toBe('running');
    expect(patches).toHaveLength(0);
  });

  it('never rewrites a row when the execution state cannot be read', async () => {
    // A lookup failure is not evidence of anything. Guessing here would replace one wrong status
    // with another, and an API blip would start marking healthy runs as failed.
    const patches: unknown[] = [];
    const store = { updateRun: async () => void patches.push(1) };
    const rows = [rowRunning()];
    await reconcileRunningRuns(store, rows as never[], async () => ({ state: 'unknown', message: '503' }));
    expect(rows[0]!.status).toBe('running');
    expect(patches).toHaveLength(0);
  });

  it('aborts a stale row that never recorded an execution', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const store = { updateRun: async (_id: string, p: Record<string, unknown>) => void patches.push(p) };
    const rows = [rowRunning({ meta: {}, started_at: new Date(Date.now() - 10 * 60_000).toISOString() })];
    await reconcileRunningRuns(store, rows as never[], async () => ({ state: 'running' }));
    expect(rows[0]!.status).toBe('aborted');
    expect(patches[0]!['status']).toBe('aborted');
  });

  it('does not abort a row whose trigger is still in flight', async () => {
    const patches: unknown[] = [];
    const store = { updateRun: async () => void patches.push(1) };
    const rows = [rowRunning({ meta: {}, started_at: new Date().toISOString() })];
    await reconcileRunningRuns(store, rows as never[], async () => ({ state: 'running' }));
    expect(rows[0]!.status).toBe('running');
    expect(patches).toHaveLength(0);
  });
});

// ── DELETE /api/e2e/runs/:run_id ─────────────────────────────────────────────
//
// Six behaviours, each proven to fail against a deliberately broken implementation.
// "Broken" is documented in comments on each test — the assertion(s) that would
// fail are marked so the red-against-broken story is explicit.

// ── 1. Cascade ───────────────────────────────────────────────────────────────
//
// A correct deleteRun removes the run AND cascades to all child tables via FK.
// A broken impl that deletes only the run row leaves orphan children accessible.

describe('DELETE /api/e2e/runs/:run_id — cascade', () => {
  it('deletes run and all child records; a store that orphans children causes 200 where 404 is expected', async () => {
    // Stateful in-memory state — simulates the ON DELETE CASCADE that the real DB enforces.
    const run = makeRun({ status: 'completed' });
    const wf = makeWorkflow();
    let runInStore = true;
    let childrenInStore = true;

    // BROKEN variant (for illustration): set childrenInStore = false in deleteRun but leave
    // childrenInStore = true — then getWorkflow returns the wf → workflow GET returns 200, not 404.
    // The correct store sets BOTH flags to false, which is what the test asserts below.
    const store = makeMockStore({
      getRun: vi.fn().mockImplementation(async () => (runInStore ? run : null)),
      getWorkflow: vi.fn().mockImplementation(async () => (childrenInStore ? wf : null)),
      listWorkflows: vi.fn().mockImplementation(async () => (childrenInStore ? [wf] : [])),
      listScenes: vi.fn().mockImplementation(async () => (childrenInStore ? [makeScene()] : [])),
      listMcpCalls: vi.fn().mockImplementation(async () => (childrenInStore ? [makeMcpCall()] : [])),
      listClaims: vi.fn().mockImplementation(async () => (childrenInStore ? [makeClaim()] : [])),
      deleteRun: vi.fn().mockImplementation(async () => {
        runInStore = false;
        childrenInStore = false; // correct cascade — a broken impl omits this line
        return true;
      }),
    });

    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);

      // Pre-condition: run and its workflow are accessible.
      const preRun = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs/run_001',
        headers: { cookie: authed() },
      });
      expect(preRun.statusCode).toBe(200);
      const preWf = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs/run_001/workflows/wf_row_01',
        headers: { cookie: authed() },
      });
      expect(preWf.statusCode).toBe(200);

      // Delete the run.
      const del = await app.inject({
        method: 'DELETE',
        url: '/api/e2e/runs/run_001',
        headers: { cookie: authed() },
      });
      expect(del.statusCode).toBe(200);
      const delBody = JSON.parse(del.body) as { deleted: boolean; run_id: string };
      expect(delBody.deleted).toBe(true);
      expect(delBody.run_id).toBe('run_001');

      // Run is gone — a broken impl that skips the run delete would fail here.
      const runAfter = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs/run_001',
        headers: { cookie: authed() },
      });
      expect(runAfter.statusCode).toBe(404);

      // Child workflow is gone — a broken impl that orphans children would return 200 here,
      // causing this assertion to fail.
      const wfAfter = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs/run_001/workflows/wf_row_01',
        headers: { cookie: authed() },
      });
      expect(wfAfter.statusCode).toBe(404);

      // The server must invoke deleteRun exactly once, not individual child-delete calls.
      expect(store.deleteRun as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
      expect(store.deleteRun as ReturnType<typeof vi.fn>).toHaveBeenCalledWith('run_001');
    });
  });
});

// ── 2. Running-run refused ────────────────────────────────────────────────────
//
// A run whose status is 'running' must be refused with 409; the row must still be
// present afterwards. A broken impl that deletes it anyway would fail the presence check.

describe('DELETE /api/e2e/runs/:run_id — running-run refused', () => {
  it('refuses 409 for a running run and the run is still present; a broken impl that deletes it would fail the presence check', async () => {
    let runInStore = true;
    const runningRun = makeRun({ status: 'running' });

    const store = makeMockStore({
      getRun: vi.fn().mockImplementation(async () => (runInStore ? runningRun : null)),
      listWorkflows: vi.fn().mockResolvedValue([]),
      // A broken impl calls deleteRun anyway — then runInStore becomes false and the GET
      // below returns 404 instead of 200, which fails the assertion.
      deleteRun: vi.fn().mockImplementation(async () => {
        runInStore = false;
        return true;
      }),
    });

    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);

      // Attempt to delete a running run — must be refused.
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/e2e/runs/run_001',
        headers: { cookie: authed() },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(body.error.code).toBe('run_is_active');

      // Run must still be present — a broken impl that deletes it would return 404 here.
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs/run_001',
        headers: { cookie: authed() },
      });
      expect(getRes.statusCode).toBe(200);

      // deleteRun must NOT have been called — a broken impl that calls it anyway exposes
      // the orphan via the runInStore flag check above and also via this assertion.
      expect(store.deleteRun as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });
  });
});

// ── 3. Audit ─────────────────────────────────────────────────────────────────
//
// An audit row (operator + time) must be written for BOTH the successful deletion
// AND the refused (409) deletion attempt. A broken impl that skips the audit on
// refusal leaves the log empty, causing the find() to return undefined → test fails.

describe('DELETE /api/e2e/runs/:run_id — audit', () => {
  beforeEach(() => {
    _resetAuditLog();
  });

  it('writes a succeeded audit row for a completed deletion; a no-audit impl leaves an empty log', async () => {
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(makeRun({ status: 'completed' })),
      deleteRun: vi.fn().mockResolvedValue(true),
    });

    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);

      await app.inject({
        method: 'DELETE',
        url: '/api/e2e/runs/run_001',
        headers: { cookie: authed() },
      });

      const auditRes = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { cookie: authed() },
      });
      expect(auditRes.statusCode).toBe(200);
      const auditBody = JSON.parse(auditRes.body) as {
        data: Array<{ action: string; target: string; actor: string; outcome: string; at: string }>;
      };
      // A broken impl that skips the audit call entirely would leave data empty → row undefined.
      const row = auditBody.data.find((r) => r.action === 'e2e.run.delete' && r.target === 'run_001');
      expect(row).toBeDefined();
      expect(row!.outcome).toBe('succeeded');
      expect(row!.actor).toBe('mark@mardash.ai');
      expect(typeof row!.at).toBe('string'); // timestamp must be present
    });
  });

  it('writes a failed audit row for a refused (409) deletion; a broken impl that exits before auditing leaves no row', async () => {
    // BROKEN baseline: the original endpoint returned 409 BEFORE calling audited(), leaving
    // no trace of the attempt. This test fails against that implementation (row === undefined).
    // The fix moves the 409 throw inside audited() so the row is always written.
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(makeRun({ status: 'running' })),
      listWorkflows: vi.fn().mockResolvedValue([]),
      deleteRun: vi.fn().mockResolvedValue(false),
    });

    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/e2e/runs/run_001',
        headers: { cookie: authed() },
      });
      expect(res.statusCode).toBe(409);

      const auditRes = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { cookie: authed() },
      });
      const auditBody = JSON.parse(auditRes.body) as {
        data: Array<{ action: string; target: string; actor: string; outcome: string }>;
      };
      // A broken impl (409 before audited) would leave data empty → row is undefined → fails.
      const row = auditBody.data.find((r) => r.action === 'e2e.run.delete' && r.target === 'run_001');
      expect(row).toBeDefined();
      expect(row!.outcome).toBe('failed'); // 'failed' = the attempt was made but refused
      expect(row!.actor).toBe('mark@mardash.ai');
    });
  });
});

// ── 4. Not-found ─────────────────────────────────────────────────────────────
//
// Deleting a non-existent run must return a clean 404 with error code 'not_found'.
// A broken impl that throws an unhandled error returns 500; a silent success returns
// 200 — both fail the status-code assertion.

describe('DELETE /api/e2e/runs/:run_id — not-found', () => {
  it('returns 404 with not_found when the run does not exist; a broken impl returning 500 or 200 fails the status check', async () => {
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(null),
    });

    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/e2e/runs/nonexistent-run',
        headers: { cookie: authed() },
      });
      // Not 500 (unhandled error), not 200 (silent success).
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');

      // deleteRun must not be called when the run doesn't exist.
      // A broken impl that calls deleteRun on a non-existent ID might silently succeed
      // (returning false), masking the not-found case.
      expect(store.deleteRun as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });
  });
});

// ── 5. Authorization ─────────────────────────────────────────────────────────
//
// Deletion uses the same authorization rules as the POST trigger: OIDC session only.
// The automation bearer token is read-only and must be refused with 403.
// An unauthenticated caller gets 401. A broken impl that permits either would fail.

describe('DELETE /api/e2e/runs/:run_id — authorization', () => {
  it('refuses deletion for the automation token (read-only identity) with 403; a broken impl that allows it fails the 403 assertion', async () => {
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(makeRun({ status: 'completed' })),
      deleteRun: vi.fn().mockResolvedValue(true),
    });

    await withAutomationEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/e2e/runs/run_001',
        headers: { authorization: `Bearer ${AUTOMATION_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(body.error.code).toBe('forbidden');

      // deleteRun must not have been called — the request was refused at the auth gate.
      // A broken impl that lets it through would flip this assertion.
      expect(store.deleteRun as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });
  });

  it('refuses deletion for an unauthenticated caller with 401', async () => {
    const store = makeMockStore({
      getRun: vi.fn().mockResolvedValue(makeRun({ status: 'completed' })),
      deleteRun: vi.fn().mockResolvedValue(true),
    });

    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);

      // No cookie, no bearer token.
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/e2e/runs/run_001',
      });
      expect(res.statusCode).toBe(401);
      expect(store.deleteRun as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });
  });
});

// ── 6. Recomputation ─────────────────────────────────────────────────────────
//
// After deletion the run must not appear in the run list and must not contribute
// any count or spend to aggregated views. A broken impl whose list endpoint
// returns stale data (ghost row) would fail the "run_id absent from list" assertion.

describe('DELETE /api/e2e/runs/:run_id — recomputation', () => {
  it('deleted run absent from run list with no ghost count or spend; a broken list that includes the ghost fails the absence assertion', async () => {
    const run = makeRun({
      status: 'completed',
      spend_cents: 500,
      workflows_passed: 8,
      workflows_failed: 2,
      pass_rate: 0.8,
    });
    let liveRuns: EvalRun[] = [run];

    const store = makeMockStore({
      getRun: vi.fn().mockImplementation(async (id: string) => liveRuns.find((r) => r.run_id === id) ?? null),
      listWorkflows: vi.fn().mockResolvedValue([]),
      listAllRuns: vi.fn().mockImplementation(async () => liveRuns),
      // Correct cascade: remove the run from the in-memory list so subsequent list calls see
      // zero rows. A broken impl that leaves liveRuns intact would make the post-delete list
      // still return the run → the "not in list" assertion below would fail.
      deleteRun: vi.fn().mockImplementation(async (id: string) => {
        const existed = liveRuns.some((r) => r.run_id === id);
        liveRuns = liveRuns.filter((r) => r.run_id !== id);
        return existed;
      }),
    });

    await withOidcEnv(async () => {
      const app = buildServer(undefined, undefined, async () => store);
      closers.push(app);

      // Pre-condition: run appears in the list with its spend contribution.
      const pre = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs',
        headers: { cookie: authed() },
      });
      expect(pre.statusCode).toBe(200);
      const preBody = JSON.parse(pre.body) as { data: EvalRun[] };
      expect(preBody.data.some((r) => r.run_id === 'run_001')).toBe(true);
      const preSpend = preBody.data.find((r) => r.run_id === 'run_001')!.spend_cents;
      expect(preSpend).toBe(500);

      // Delete the run.
      const del = await app.inject({
        method: 'DELETE',
        url: '/api/e2e/runs/run_001',
        headers: { cookie: authed() },
      });
      expect(del.statusCode).toBe(200);

      // After deletion: run must not appear in the list.
      // A broken list impl (stale cache / wrong filter) that still returns the run fails here.
      const post = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs',
        headers: { cookie: authed() },
      });
      expect(post.statusCode).toBe(200);
      const postBody = JSON.parse(post.body) as { data: EvalRun[] };
      expect(postBody.data.some((r) => r.run_id === 'run_001')).toBe(false);
      // No ghost contribution: list length drops by exactly 1.
      expect(postBody.data).toHaveLength(0);

      // Permalink for the deleted run must also return 404.
      const permalink = await app.inject({
        method: 'GET',
        url: '/api/e2e/runs/run_001',
        headers: { cookie: authed() },
      });
      expect(permalink.statusCode).toBe(404);
    });
  });
});
