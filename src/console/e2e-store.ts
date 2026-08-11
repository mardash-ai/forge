/**
 * forge-console — lazy eval-results store accessor.
 *
 * The console reads the cp-results Postgres tables (forge_cp_eval_*) to serve the
 * /api/e2e/* REST endpoints and the /mcp MCP tools. It uses its own dedicated pool
 * (CONSOLE_CP_DB_URL, falling back to FORGE_DB_URL) so the console's read traffic
 * never competes with the platform's write path.
 *
 * Returns null when no database URL is configured — every caller degrades gracefully
 * (REST endpoints return 501, MCP tools return an informative error result).
 */
import { Pool } from 'pg';
import { PgCpResultsBackend, ensureCpResultsSchema } from '../storage/backends/cp-results/pg';

export type { EvalRun, EvalWorkflow, EvalScene, EvalMcpCall, EvalClaim } from '../storage/backends/cp-results/types';

let _pool: Pool | null = null;
let _initPromise: Promise<PgCpResultsBackend | null> | null = null;

async function init(): Promise<PgCpResultsBackend | null> {
  const url = process.env.CONSOLE_CP_DB_URL ?? process.env.FORGE_DB_URL ?? '';
  if (!url) return null;
  const pool = new Pool({ connectionString: url, max: 5 });
  try {
    await ensureCpResultsSchema(pool);
    _pool = pool;
    return new PgCpResultsBackend(pool);
  } catch {
    await pool.end().catch(() => undefined);
    return null;
  }
}

/** Get the eval-results backend. Returns null when no database URL is configured. */
export function getEvalStore(): Promise<PgCpResultsBackend | null> {
  if (!_initPromise) _initPromise = init();
  return _initPromise;
}

/** Reset the singleton (tests only — never call from production code). */
export async function _resetEvalStore(): Promise<void> {
  const prev = _initPromise;
  _initPromise = null;
  if (_pool) {
    await _pool.end().catch(() => undefined);
    _pool = null;
  }
  await prev?.catch(() => undefined);
}
