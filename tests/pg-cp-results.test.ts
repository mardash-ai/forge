import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgCpResultsBackend, ensureCpResultsSchema } from '../src/storage/backends/cp-results/pg';

// Control-plane eval-results store — Postgres backend tests.
// Runs only when FORGE_CP_RESULTS_BACKEND=postgres + FORGE_DB_URL are set (test:pg).
const HAS_PG =
  process.env.FORGE_CP_RESULTS_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

describe.skipIf(!HAS_PG)(
  'cp-results Postgres backend — schema, CRUD, lease, idempotency',
  () => {
    let pool: Pool;
    let backend: PgCpResultsBackend;

    const RUN_ID = 'run_test_01';
    const TENANT = 'tenant_test';
    const WF_ID = 'wf_test_01';

    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
      await ensureCpResultsSchema(pool);
      backend = new PgCpResultsBackend(pool);
      await backend.__truncateAllForTests();
    });

    afterAll(async () => {
      await backend.__truncateAllForTests();
      await pool.end();
    });

    // -----------------------------------------------------------------------
    // Run-level
    // -----------------------------------------------------------------------

    it('upsertRun — creates a new run row with defaults', async () => {
      const run = await backend.upsertRun({
        run_id: RUN_ID,
        tenant_id: TENANT,
        provider: 'anthropic',
        trigger_source: 'schedule',
        canonical_url: 'https://cp.example.com/runs/run_test_01',
      });
      expect(run.run_id).toBe(RUN_ID);
      expect(run.tenant_id).toBe(TENANT);
      expect(run.provider).toBe('anthropic');
      expect(run.status).toBe('running');
      expect(run.workflows_attempted).toBe(0);
      expect(run.pass_rate).toBeNull();
      expect(run.p50_duration_ms).toBeNull();
      expect(run.canonical_url).toBe('https://cp.example.com/runs/run_test_01');
    });

    it('upsertRun — idempotent on run_id (merges meta, preserves numeric defaults)', async () => {
      const run2 = await backend.upsertRun({
        run_id: RUN_ID,
        tenant_id: TENANT,
        meta: { extra: 'value' },
      });
      expect(run2.run_id).toBe(RUN_ID);
      expect(run2.meta).toMatchObject({ extra: 'value' });
      // Only one row in the DB.
      const count = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM forge_cp_eval_runs WHERE run_id=$1",
        [RUN_ID],
      );
      expect(Number(count.rows[0]!.n)).toBe(1);
    });

    it('updateRun — patches aggregates; getRun returns updated fields', async () => {
      const updated = await backend.updateRun(RUN_ID, {
        workflows_attempted: 10,
        workflows_passed: 8,
        workflows_failed: 2,
        pass_rate: 0.8,
        withheld_count: 3,
        rejected_count: 1,
        p50_duration_ms: 1200,
        p99_duration_ms: 4500,
        total_input_tokens: 50000,
        total_output_tokens: 12000,
        status: 'completed',
        completed_at: new Date().toISOString(),
      });
      expect(updated).not.toBeNull();
      expect(updated!.pass_rate).toBeCloseTo(0.8, 3);
      expect(updated!.workflows_attempted).toBe(10);
      expect(updated!.p50_duration_ms).toBe(1200);
      expect(updated!.p99_duration_ms).toBe(4500);
      expect(updated!.total_input_tokens).toBe(50000);
      expect(updated!.withheld_count).toBe(3);
      expect(updated!.rejected_count).toBe(1);
      expect(updated!.status).toBe('completed');
      expect(updated!.completed_at).not.toBeNull();
    });

    it('updateRun — returns null for unknown run_id', async () => {
      const r = await backend.updateRun('run_does_not_exist', { status: 'failed' });
      expect(r).toBeNull();
    });

    it('listRuns — returns runs for tenant, newest-first', async () => {
      await backend.upsertRun({ run_id: 'run_test_02', tenant_id: TENANT });
      const runs = await backend.listRuns(TENANT);
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(runs[0]!.started_at >= runs[1]!.started_at).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Per-workflow drilldown
    // -----------------------------------------------------------------------

    it('insertWorkflow — creates a workflow row; getWorkflow returns it', async () => {
      const wf = await backend.insertWorkflow({
        id: WF_ID,
        run_id: RUN_ID,
        workflow_id: 'wfdef_summarize',
        tenant_id: TENANT,
        verdict: 'pass',
        integrity_class: 'clean',
        prompt: 'Summarize the document',
        duration_ms: 2100,
        input_tokens: 1500,
        output_tokens: 300,
        provider: 'anthropic',
      });
      expect(wf.id).toBe(WF_ID);
      expect(wf.verdict).toBe('pass');
      expect(wf.integrity_class).toBe('clean');
      expect(wf.duration_ms).toBe(2100); // forge-hat duration field

      const fetched = await backend.getWorkflow(WF_ID);
      expect(fetched).not.toBeNull();
      expect(fetched!.prompt).toBe('Summarize the document');
    });

    it('insertWorkflow — idempotent on id (DO NOTHING)', async () => {
      const wf2 = await backend.insertWorkflow({
        id: WF_ID,
        run_id: RUN_ID,
        workflow_id: 'wfdef_summarize',
        tenant_id: TENANT,
        verdict: 'fail', // different verdict — should be ignored
      });
      expect(wf2.verdict).toBe('pass'); // original row preserved
    });

    it('listWorkflows — returns all workflows for a run', async () => {
      await backend.insertWorkflow({
        id: 'wf_test_02',
        run_id: RUN_ID,
        workflow_id: 'wfdef_classify',
        tenant_id: TENANT,
        verdict: 'fail',
      });
      const wfs = await backend.listWorkflows(RUN_ID);
      expect(wfs.length).toBe(2);
    });

    // -----------------------------------------------------------------------
    // Scenes
    // -----------------------------------------------------------------------

    it('insertScene — stores assertions + observed_values; listScenes returns ordered', async () => {
      await backend.insertScene({
        id: 'scene_01',
        workflow_id: WF_ID,
        run_id: RUN_ID,
        scene_index: 0,
        scene_name: 'topic detection',
        assertions: [{ name: 'topic', expected: 'finance', operator: 'eq' }],
        observed_values: [{ name: 'topic', value: 'finance' }],
        passed: true,
      });
      await backend.insertScene({
        id: 'scene_02',
        workflow_id: WF_ID,
        run_id: RUN_ID,
        scene_index: 1,
        scene_name: 'length check',
        assertions: [{ name: 'char_count', expected: 500, operator: 'gt' }],
        observed_values: [{ name: 'char_count', value: 620 }],
        passed: true,
      });

      const scenes = await backend.listScenes(WF_ID);
      expect(scenes.length).toBe(2);
      expect(scenes[0]!.scene_index).toBe(0);
      expect(scenes[1]!.scene_index).toBe(1);
      expect(scenes[0]!.assertions[0]!.operator).toBe('eq');
      expect(scenes[0]!.observed_values[0]!.value).toBe('finance');
    });

    it('insertScene — idempotent on (workflow_id, scene_index)', async () => {
      await backend.insertScene({
        id: 'scene_01_dup',
        workflow_id: WF_ID,
        run_id: RUN_ID,
        scene_index: 0, // same index
        scene_name: 'should be ignored',
      });
      const scenes = await backend.listScenes(WF_ID);
      expect(scenes.filter((s) => s.scene_index === 0).length).toBe(1);
      expect(scenes[0]!.scene_name).toBe('topic detection'); // original preserved
    });

    // -----------------------------------------------------------------------
    // MCP calls
    // -----------------------------------------------------------------------

    it('insertMcpCall — stores request + response; listMcpCalls ordered', async () => {
      await backend.insertMcpCall({
        id: 'call_01',
        workflow_id: WF_ID,
        run_id: RUN_ID,
        call_index: 0,
        tool_name: 'read_file',
        request: { path: '/tmp/doc.txt' },
        response: { content: 'hello world' },
        duration_ms: 42,
        called_at: new Date().toISOString(),
      });
      await backend.insertMcpCall({
        id: 'call_02',
        workflow_id: WF_ID,
        run_id: RUN_ID,
        call_index: 1,
        tool_name: 'write_file',
        request: { path: '/tmp/out.txt', content: 'summary' },
        error: 'Permission denied',
        duration_ms: 8,
      });

      const calls = await backend.listMcpCalls(WF_ID);
      expect(calls.length).toBe(2);
      expect(calls[0]!.tool_name).toBe('read_file');
      expect(calls[0]!.response).toMatchObject({ content: 'hello world' });
      expect(calls[0]!.duration_ms).toBe(42); // forge-hat duration
      expect(calls[1]!.error).toBe('Permission denied');
      expect(calls[1]!.response).toBeNull();
    });

    it('insertMcpCall — idempotent on (workflow_id, call_index)', async () => {
      await backend.insertMcpCall({
        id: 'call_01_dup',
        workflow_id: WF_ID,
        run_id: RUN_ID,
        call_index: 0,
        tool_name: 'should_be_ignored',
        request: {},
      });
      const calls = await backend.listMcpCalls(WF_ID);
      expect(calls[0]!.tool_name).toBe('read_file'); // original preserved
    });

    // -----------------------------------------------------------------------
    // Claims / cassette
    // -----------------------------------------------------------------------

    it('insertClaim — stores structured cassette; listClaims ordered', async () => {
      await backend.insertClaim({
        id: 'claim_01',
        workflow_id: WF_ID,
        run_id: RUN_ID,
        claim_index: 0,
        claim_type: 'factual',
        claim_text: 'The model correctly identified the topic as finance',
        verdict: 'verified',
        evidence: { source: 'scene_01', method: 'exact_match' },
        cassette: {
          prompt: 'Summarize the document',
          turns: [
            { role: 'user', content: 'What is the topic?' },
            { role: 'assistant', content: 'The topic is finance.' },
          ],
        },
      });
      await backend.insertClaim({
        id: 'claim_02',
        workflow_id: WF_ID,
        run_id: RUN_ID,
        claim_index: 1,
        claim_type: 'behavioral',
        claim_text: 'Model did not hallucinate a page count',
        verdict: 'verified',
        cassette: { prompt: 'How many pages?', turns: [] },
      });

      const claims = await backend.listClaims(WF_ID);
      expect(claims.length).toBe(2);
      expect(claims[0]!.claim_index).toBe(0);
      expect(claims[0]!.verdict).toBe('verified');
      expect(claims[0]!.cassette).toMatchObject({ prompt: 'Summarize the document' });
      expect((claims[0]!.cassette as { turns: unknown[] }).turns).toHaveLength(2);
      expect(claims[1]!.claim_type).toBe('behavioral');
    });

    it('insertClaim — idempotent on (workflow_id, claim_index)', async () => {
      await backend.insertClaim({
        id: 'claim_01_dup',
        workflow_id: WF_ID,
        run_id: RUN_ID,
        claim_index: 0,
        verdict: 'refuted', // should be ignored
      });
      const claims = await backend.listClaims(WF_ID);
      expect(claims[0]!.verdict).toBe('verified'); // original preserved
    });

    // -----------------------------------------------------------------------
    // Tenant lease (cross-host lock)
    // -----------------------------------------------------------------------

    it('acquireLease — inserts the single-row lease; getLease returns it', async () => {
      const lease = await backend.acquireLease({
        holder: 'runner-host-1',
        source: 'forge-runner-v1.23.0',
        staleAfterSeconds: 60,
      });
      expect(lease).not.toBeNull();
      expect(lease!.holder).toBe('runner-host-1');
      expect(lease!.source).toBe('forge-runner-v1.23.0');
      expect(lease!.since).toBeTruthy();
      expect(lease!.heartbeat).toBeTruthy();

      const current = await backend.getLease();
      expect(current!.holder).toBe('runner-host-1');
    });

    it('acquireLease — second caller cannot steal a live lease', async () => {
      const stolen = await backend.acquireLease({
        holder: 'runner-host-2',
        source: 'forge-runner-v1.23.0',
        staleAfterSeconds: 60,
      });
      // Heartbeat is fresh → WHERE clause fails → null
      expect(stolen).toBeNull();
      // Original holder is unchanged.
      const current = await backend.getLease();
      expect(current!.holder).toBe('runner-host-1');
    });

    it('renewLease — holder can renew; non-holder cannot', async () => {
      const renewed = await backend.renewLease('runner-host-1');
      expect(renewed).toBe(true);

      const notRenewed = await backend.renewLease('runner-host-2');
      expect(notRenewed).toBe(false);
    });

    it('releaseLease — non-holder cannot release; holder can', async () => {
      const notReleased = await backend.releaseLease('runner-host-2');
      expect(notReleased).toBe(false);

      const released = await backend.releaseLease('runner-host-1');
      expect(released).toBe(true);

      expect(await backend.getLease()).toBeNull();
    });

    it('acquireLease — new holder can acquire after release', async () => {
      const lease = await backend.acquireLease({
        holder: 'runner-host-2',
        source: 'forge-runner-v1.23.0',
      });
      expect(lease!.holder).toBe('runner-host-2');
    });

    it('acquireLease — steals a stale lease (staleAfterSeconds=0)', async () => {
      // Force stale by using 0-second threshold.
      const stolen = await backend.acquireLease({
        holder: 'runner-host-3',
        source: 'forge-runner-v1.23.1',
        staleAfterSeconds: 0,
      });
      expect(stolen).not.toBeNull();
      expect(stolen!.holder).toBe('runner-host-3');
    });

    // -----------------------------------------------------------------------
    // FK cascade: deleting a run cascades to workflows/scenes/calls/claims
    // -----------------------------------------------------------------------

    it('FK cascade — deleting a run removes all child rows', async () => {
      await pool.query('DELETE FROM forge_cp_eval_runs WHERE run_id=$1', [RUN_ID]);
      const wfs = await backend.listWorkflows(RUN_ID);
      expect(wfs).toHaveLength(0);
      const scenes = await backend.listScenes(WF_ID);
      expect(scenes).toHaveLength(0);
      const calls = await backend.listMcpCalls(WF_ID);
      expect(calls).toHaveLength(0);
      const claims = await backend.listClaims(WF_ID);
      expect(claims).toHaveLength(0);
    });
  },
);
