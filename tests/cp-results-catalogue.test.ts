/**
 * ⛔ THE CATALOGUE IS WHAT THE RUN DIALOG IS ALLOWED TO OFFER.
 *
 * 2026-08-16. The console knew exactly one fact about the catalogue — its SIZE — so the run dialog
 * offered a free-text box and validated nothing that went into it. A run was triggered with
 * `W-001:blocked`, a store row id copied out of the results table because it is the only id the
 * console ever displays. The runner found no such workflow file and exited 2: the entire run dead
 * in 16 seconds, nothing executed.
 *
 * This table is what lets ids be CHOSEN rather than typed, and what lets the picker disable a
 * workflow that cannot run on the selected provider.
 *
 * Two behaviours here are load-bearing and neither is obvious:
 *
 *   - REPLACE, not merge. A workflow deleted upstream must stop being offered; merging would leave
 *     a retired id in the picker forever, and a retired id is a run that dies at resolve time.
 *   - An EMPTY manifest is IGNORED. "The catalogue is empty" and "we failed to read the catalogue"
 *     look identical in a payload, and only one of them should wipe the picker — so neither does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PgCpResultsBackend, ensureCpResultsSchema } from '../src/storage/backends/cp-results/pg';

const HAS_PG = process.env.FORGE_CP_RESULTS_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

describe.skipIf(!HAS_PG)('the catalogue store', () => {
  let pool: Pool;
  let backend: PgCpResultsBackend;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
    // Prove the UPGRADE path, not only the fresh-create one: a database that predates this table
    // is what production actually is. `CREATE TABLE IF NOT EXISTS` on an existing table is a no-op,
    // which is how a column added in the DDL alone once emptied every cassette.
    await pool.query('DROP TABLE IF EXISTS forge_cp_eval_catalogue');
    await ensureCpResultsSchema(pool);
    backend = new PgCpResultsBackend(pool);
  });

  afterAll(async () => {
    await pool?.query('DELETE FROM forge_cp_eval_catalogue').catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  it('creates the table on a database that has never had one', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'forge_cp_eval_catalogue'`,
    );
    const cols = r.rows.map((x) => x.column_name).sort();
    // in_main / in_runner arrived with the repo-as-source-of-truth redesign. This assertion is a
    // completeness check on the table shape, so it is SUPPOSED to fail when a column is added —
    // that is how a column added to the CREATE block but not ALTERed gets noticed.
    expect(cols).toEqual([
      'family',
      'in_main',
      'in_runner',
      'name',
      'requires',
      'suites',
      'tags',
      'updated_at',
      'workflow_id',
    ]);
  });

  it('stores a manifest and reads it back with its provider requirement intact', async () => {
    const written = await backend.replaceCatalogue([
      {
        workflow_id: 'W-002',
        name: 'Memory is grounded',
        requires: 'any',
        tags: ['p0'],
        suites: ['full', 'critical'],
        family: 'W-0xx',
      },
      {
        workflow_id: 'W-001',
        name: 'Session binds',
        requires: 'openai',
        tags: ['p0'],
        suites: ['full'],
        family: 'W-0xx',
      },
      {
        workflow_id: 'W-210',
        name: 'Phone brain, laptop brain',
        requires: 'both',
        tags: [],
        suites: ['full'],
        family: 'W-2xx',
      },
    ]);
    expect(written).toBe(3);

    const rows = await backend.listCatalogue();
    expect(rows.map((r) => r.workflow_id)).toEqual(['W-001', 'W-002', 'W-210']);
    // The field the whole picker turns on.
    expect(rows.find((r) => r.workflow_id === 'W-001')!.requires).toBe('openai');
    expect(rows.find((r) => r.workflow_id === 'W-210')!.requires).toBe('both');
    expect(rows.find((r) => r.workflow_id === 'W-002')!.suites).toEqual(['full', 'critical']);
  });

  it('⛔ REPLACES rather than merges — a retired workflow stops being offered', async () => {
    // W-001 is gone from the manifest. Leaving it in the picker would offer an id whose file no
    // longer exists: a run that dies the moment it is selected.
    await backend.replaceCatalogue([
      { workflow_id: 'W-002', name: 'Memory is grounded', requires: 'any' },
      { workflow_id: 'W-210', name: 'Phone brain, laptop brain', requires: 'both' },
    ]);
    const rows = await backend.listCatalogue();
    expect(rows.map((r) => r.workflow_id)).toEqual(['W-002', 'W-210']);
  });

  it('updates an existing row in place rather than duplicating it', async () => {
    await backend.replaceCatalogue([
      { workflow_id: 'W-002', name: 'Memory is grounded, never invented', requires: 'openai' },
    ]);
    const rows = await backend.listCatalogue();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Memory is grounded, never invented');
    // A pin that changes upstream must change here, or the picker enables a row the runner refuses.
    expect(rows[0]!.requires).toBe('openai');
  });

  it('⛔ an EMPTY manifest is IGNORED, never applied', async () => {
    // A failed read and a genuinely empty catalogue are indistinguishable in the payload. Applying
    // an empty one would silently empty the picker and send the operator back to typing ids.
    const written = await backend.replaceCatalogue([]);
    expect(written).toBe(0);
    const rows = await backend.listCatalogue();
    expect(rows).toHaveLength(1);
  });

  it('refuses a requirement outside the vocabulary', async () => {
    // The CHECK constraint is the last line of defence against a value the picker cannot interpret.
    // An unknown `requires` would render as neither runnable nor blocked.
    await expect(
      backend.replaceCatalogue([{ workflow_id: 'W-003', requires: 'gpt' as never }]),
    ).rejects.toThrow();
  });

  it('a failed replace leaves the previous catalogue intact', async () => {
    // The transaction. A half-applied catalogue offers some workflows and hides others with no way
    // to tell which — worse than either outcome on its own.
    const before = await backend.listCatalogue();
    await backend
      .replaceCatalogue([
        { workflow_id: 'W-004', requires: 'any' },
        { workflow_id: 'W-005', requires: 'nonsense' as never },
      ])
      .catch(() => undefined);
    const after = await backend.listCatalogue();
    expect(after.map((r) => r.workflow_id)).toEqual(before.map((r) => r.workflow_id));
  });
});

describe.skipIf(!HAS_PG)('⛔ upgrading a catalogue table that predates in_main / in_runner', () => {
  // Production created this table at the v1.39.0 shape. CREATE TABLE IF NOT EXISTS is a NO-OP
  // against it, columns included — so a column added only to the CREATE block ships as
  // "column does not exist" on every write. That is exactly how `attempt` emptied every cassette
  // on 2026-08-14, and the reason these arrive as ALTERs.
  let pool: Pool;
  let backend: PgCpResultsBackend;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
    await pool.query('DROP TABLE IF EXISTS forge_cp_eval_catalogue');
    // The PREVIOUS shape, exactly as v1.39.0 created it.
    await pool.query(`
      CREATE TABLE forge_cp_eval_catalogue (
        workflow_id text        PRIMARY KEY,
        name        text        NOT NULL DEFAULT '',
        requires    text        NOT NULL DEFAULT 'any'
                      CHECK (requires IN ('any','openai','anthropic','both')),
        tags        jsonb       NOT NULL DEFAULT '[]',
        suites      jsonb       NOT NULL DEFAULT '[]',
        family      text,
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(
      `INSERT INTO forge_cp_eval_catalogue (workflow_id, name, requires) VALUES ('W-900','legacy','any')`,
    );
    await ensureCpResultsSchema(pool);
    backend = new PgCpResultsBackend(pool);
  });

  afterAll(async () => {
    await pool?.query('DELETE FROM forge_cp_eval_catalogue').catch(() => undefined);
    await pool?.end().catch(() => undefined);
  });

  it('adds both columns to the existing table', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'forge_cp_eval_catalogue' AND column_name IN ('in_main','in_runner')`,
    );
    expect(r.rows.map((x) => x.column_name).sort()).toEqual(['in_main', 'in_runner']);
  });

  it('a row written before the columns existed reads as in_main=true, in_runner=NULL', async () => {
    // The defaults must leave legacy rows SELECTABLE. in_runner defaulting to false would have
    // blocked every pre-existing workflow the moment this shipped.
    const rows = await backend.listCatalogue();
    const legacy = rows.find((x) => x.workflow_id === 'W-900');
    expect(legacy?.in_main).toBe(true);
    expect(legacy?.in_runner).toBeNull();
  });

  it('⛔ a write with the new columns succeeds against the upgraded table', async () => {
    // The thing production actually does. This fails with the real Postgres error, not a mock's.
    await backend.replaceCatalogue([
      { workflow_id: 'W-901', name: 'new', requires: 'any', in_main: true, in_runner: false },
    ]);
    const rows = await backend.listCatalogue();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.in_runner).toBe(false);
  });
});
