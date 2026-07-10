import { beforeEach, afterAll } from 'vitest';
import { loadStoreConfig } from '../src/storage/backends/config';
import { getBackends, resetBackends } from '../src/storage/backends';

// P26 — per-test isolation for the Postgres backend run. The filesystem backend isolates via a fresh
// temp FORGE_STATE_DIR per test; Postgres shares one database, so truncate the identity tables before
// each test. A no-op when the filesystem backend is active (so this setup file is harmless if ever
// loaded outside the PG config). Runs BEFORE each test file's own beforeEach (setup files register
// first), so a test starts from a clean identity store.
beforeEach(async () => {
  if (loadStoreConfig().identity !== 'postgres') return;
  const b = await getBackends();
  await b.identity.__truncateAllForTests?.();
});

// Close the pool at the end of each file (vitest isolates modules per file, so the singleton — and its
// pool — is per file).
afterAll(async () => {
  await resetBackends();
});
