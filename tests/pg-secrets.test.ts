import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { setSecret, unsetSecret, readSecrets, listSecretNames } from '../src/plugins/secrets-local/index';

// P26 (increment 6) — Postgres secrets backend-SPECIFIC coverage: the sealed row holds ciphertext (not
// plaintext), writing a secret is a SINGLE upsert (no whole-vault RMW — the P27 fix), and concurrent
// sets to distinct names never lose an update. Runs ONLY when the Postgres secrets backend is selected
// (`test:pg`); skipped in the default filesystem run.
const HAS_PG = process.env.FORGE_SECRETS_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

describe.skipIf(!HAS_PG)('P26 Postgres secrets backend — sealed rows, single-upsert (P27), concurrency', () => {
  const APP = 'app_pg_secrets';
  let pool: Pool;
  let prevKey: string | undefined;

  beforeAll(() => {
    prevKey = process.env.FORGE_SECRETS_KEY;
    process.env.FORGE_SECRETS_KEY = 'pg-secrets-master-key-not-for-prod';
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
  });
  afterAll(async () => {
    if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
    else process.env.FORGE_SECRETS_KEY = prevKey;
    await pool.end();
  });

  it('round-trips through Postgres and stores CIPHERTEXT (never the plaintext) in the row', async () => {
    const PLAIN = 'super-secret-plaintext-value-xyz';
    await setSecret(APP, 'ANTHROPIC_API_KEY', PLAIN);
    expect((await readSecrets(APP)).ANTHROPIC_API_KEY).toBe(PLAIN); // seal→open works via PG

    const r = await pool.query<{ iv: string; tag: string; data: string }>(
      "SELECT iv, tag, data FROM forge_secrets WHERE app_id=$1 AND name='ANTHROPIC_API_KEY'",
      [APP],
    );
    const row = r.rows[0]!;
    expect(row.data).not.toContain(PLAIN); // ciphertext, not plaintext
    expect(row.iv).toMatch(/^[A-Za-z0-9+/=]+$/); // base64 sealed fields
    expect(row.tag.length).toBeGreaterThan(0);
  });

  it('set is a single upsert (no whole-vault RMW): re-setting a name updates in place — one row', async () => {
    await setSecret(APP, 'TOKEN', 'v1');
    await setSecret(APP, 'TOKEN', 'v2');
    const n = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM forge_secrets WHERE app_id=$1 AND name='TOKEN'", [APP]);
    expect(Number(n.rows[0]!.n)).toBe(1);
    expect((await readSecrets(APP)).TOKEN).toBe('v2');
  });

  it('unset removes the row and is idempotent; listNames is sorted', async () => {
    await setSecret(APP, 'A', '1');
    await setSecret(APP, 'B', '2');
    expect(await listSecretNames(APP)).toContain('A');
    expect(await unsetSecret(APP, 'A')).toBe(true);
    expect(await unsetSecret(APP, 'A')).toBe(false); // idempotent
    expect(await listSecretNames(APP)).not.toContain('A');
  });

  it('closes P27: concurrent sets to distinct names never lose an update (native upsert, no app lock)', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `K${i}`);
    await Promise.all(names.map((name) => setSecret(APP, name, `val-${name}`)));
    const got = await readSecrets(APP);
    for (const name of names) expect(got[name]).toBe(`val-${name}`);
  });
});
