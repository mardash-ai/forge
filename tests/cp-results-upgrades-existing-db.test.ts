/**
 * ⛔ THE SCHEMA MUST UPGRADE AN EXISTING DATABASE, NOT ONLY CREATE A FRESH ONE.
 *
 * 2026-08-14, caught by Mark inside a live full-catalogue run he was paying for.
 *
 * `attempt` was added to `forge_cp_eval_turns` in the `CREATE TABLE IF NOT EXISTS` block and nowhere
 * else. That is a no-op against a database where the table already exists — and it did, created
 * hours earlier by the release that introduced the turns table. So every `insertTurn` failed with
 * *column "attempt" does not exist*, the ingest route counted it into `children_rejected` and
 * carried on, and EVERY cassette in the run read "No transcript was recorded for this workflow."
 *
 * What made it so convincing: `mcp_calls`, `claims` and `scenes` all populated perfectly, because
 * only `turns` had gained a column. The drilldown looked alive. Only the transcript was missing, and
 * the message it showed — "a run from a forge-hat older than v0.24.0 did not ship its turns" —
 * confidently blamed the runner for a fault in the store.
 *
 * Every test that existed ran against a database created FROM the current DDL, where the column is
 * present by construction. The upgrade path — the only path production ever takes — was untested.
 * This test creates the table at its PREVIOUS shape, runs the initialiser over it, and then does
 * what production does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgCpResultsBackend, ensureCpResultsSchema } from '../src/storage/backends/cp-results/pg';

const HAS_PG = process.env.FORGE_CP_RESULTS_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

describe.skipIf(!HAS_PG)('cp-results schema — upgrading a database that already exists', () => {
  let pool: Pool;
  let backend: PgCpResultsBackend;

  const RUN_ID = 'run_upgrade_01';
  const WF_ID = 'wf_upgrade_01';

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });

    // Reproduce the PREVIOUS shape of the estate: the turns table as v1.36.0 created it, WITHOUT
    // `attempt`. Dropping and recreating is what makes this an upgrade test rather than a fresh one.
    await pool.query('DROP TABLE IF EXISTS forge_cp_eval_turns CASCADE');
    await pool.query(`
      CREATE TABLE forge_cp_eval_turns (
        id                    text        PRIMARY KEY,
        workflow_id           text        NOT NULL,
        run_id                text        NOT NULL,
        turn_index            int         NOT NULL,
        scene                 text,
        prompt                text        NOT NULL DEFAULT '',
        reply                 text        NOT NULL DEFAULT '',
        tool_calls            jsonb       NOT NULL DEFAULT '[]',
        tool_trace_unreadable boolean     NOT NULL DEFAULT false,
        created_at            timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workflow_id, turn_index)
      )
    `);

    // Now run the initialiser exactly as production does, against that older database.
    await ensureCpResultsSchema(pool);
    backend = new PgCpResultsBackend(pool);
  });

  afterAll(async () => {
    await pool?.query('DROP TABLE IF EXISTS forge_cp_eval_turns CASCADE').catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  it('⛔ adds `attempt` to a turns table that predates it', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'forge_cp_eval_turns' AND column_name = 'attempt'`,
    );
    expect(
      r.rowCount,
      'init() left an existing turns table without `attempt` — every insertTurn will fail and every ' +
        'cassette will read "No transcript was recorded"',
    ).toBe(1);
  });

  it('⛔ insertTurn succeeds against the upgraded table — the thing production actually does', async () => {
    // The assertion that would have caught this. It fails with the real Postgres error rather than
    // a mock's opinion of one.
    const turn = await backend.insertTurn({
      id: `${RUN_ID}:t1`,
      workflow_id: WF_ID,
      run_id: RUN_ID,
      turn_index: 0,
      attempt: 2,
      prompt: 'Use Dorinda.',
      reply: "I'm connected to your household.",
    });
    expect(turn.attempt).toBe(2);

    const listed = await backend.listTurns(WF_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.attempt).toBe(2);
    expect(listed[0]!.reply).toBe("I'm connected to your household.");
  });

  it('rows that predate the column read as attempt 1, not null', async () => {
    // Existing turns must remain renderable — the default backfills them into a single conversation
    // rather than leaving the console to divide by an absent value.
    await pool.query(
      `INSERT INTO forge_cp_eval_turns (id, workflow_id, run_id, turn_index, prompt, reply)
       VALUES ('legacy', $1, $2, 99, 'old', 'older')`,
      [WF_ID, RUN_ID],
    );
    const listed = await backend.listTurns(WF_ID);
    const legacy = listed.find((t) => t.turn_index === 99);
    expect(legacy?.attempt).toBe(1);
  });
});

describe.skipIf(!HAS_PG)('withheld becomes a first-class verdict on an existing database', () => {
  let pool2: Pool;

  beforeAll(async () => {
    pool2 = new Pool({ connectionString: process.env.FORGE_DB_URL });
    // The PREVIOUS shape: verdict CHECK without 'withheld', and rows already written under the old
    // mapping where UNARMED/INFRA-FAIL collapsed into 'error'.
    // Simulate a genuine first upgrade: no migration marker yet. Without this the earlier describe
    // block's initialiser has already stamped the marker (against a database that had no legacy
    // rows), and the backfill correctly skips — a test artefact, not a product fault, but one that
    // would otherwise read as the backfill being broken.
    await pool2.query('DROP TABLE IF EXISTS forge_cp_migrations');
    await pool2.query('DROP TABLE IF EXISTS forge_cp_eval_workflows CASCADE');
    await pool2.query(`
      CREATE TABLE forge_cp_eval_workflows (
        id              text PRIMARY KEY,
        run_id          text NOT NULL,
        workflow_id     text NOT NULL,
        tenant_id       text NOT NULL,
        verdict         text NOT NULL CHECK (verdict IN ('pass','fail','error','skip')),
        integrity_class text,
        meta            jsonb NOT NULL DEFAULT '{}',
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool2.query(
      `INSERT INTO forge_cp_eval_workflows (id, run_id, workflow_id, tenant_id, verdict, created_at)
       VALUES ('old_withheld','r','W-009','t','error', timestamptz '2026-08-14T19:53:00Z'),
              ('old_pass','r','W-001','t','pass',      timestamptz '2026-08-14T19:53:00Z'),
              ('old_fail','r','W-002','t','fail',      timestamptz '2026-08-14T19:53:00Z')`,
    );
    await ensureCpResultsSchema(pool2);
  });

  afterAll(async () => {
    await pool2?.end().catch(() => undefined);
  });

  it('⛔ the CHECK constraint is migrated, not merely widened in CREATE', async () => {
    // Widening the list in `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists
    // — the exact mistake that made every cassette empty earlier the same day.
    await pool2.query(
      `INSERT INTO forge_cp_eval_workflows (id, run_id, workflow_id, tenant_id, verdict)
       VALUES ('new_withheld','r2','W-010','t','withheld')`,
    );
    const r = await pool2.query(`SELECT verdict FROM forge_cp_eval_workflows WHERE id='new_withheld'`);
    expect(r.rows[0].verdict).toBe('withheld');
  });

  it("⛔ historical 'error' rows are backfilled — W-009 stops being a rejection", async () => {
    const r = await pool2.query(`SELECT verdict FROM forge_cp_eval_workflows WHERE id='old_withheld'`);
    expect(r.rows[0].verdict).toBe('withheld');
  });

  it('leaves genuine passes and rejections untouched', async () => {
    const r = await pool2.query(
      `SELECT id, verdict FROM forge_cp_eval_workflows WHERE id IN ('old_pass','old_fail') ORDER BY id`,
    );
    expect(r.rows.map((x) => `${x.id}=${x.verdict}`)).toEqual(['old_fail=fail', 'old_pass=pass']);
  });

  it('⛔ the backfill is bounded in time, so a FUTURE unrecognised verdict is not eaten', async () => {
    // 'error' now means "the store refused to guess" — precisely the rows a human must see. A later
    // restart must not silently reclassify them as withheld. A DATE bound failed this: the deploy
    // happens on 2026-08-14, so same-day rows written afterwards still fell inside the window.
    await pool2.query(
      `INSERT INTO forge_cp_eval_workflows (id, run_id, workflow_id, tenant_id, verdict, created_at)
       VALUES ('future_error','r3','W-011','t','error', now())`,
    );
    await ensureCpResultsSchema(pool2);
    const r = await pool2.query(`SELECT verdict FROM forge_cp_eval_workflows WHERE id='future_error'`);
    expect(r.rows[0].verdict).toBe('error');
  });
});
