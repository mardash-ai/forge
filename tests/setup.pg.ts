import { beforeEach, afterAll } from 'vitest';
import { loadStoreConfig, needsDatabase } from '../src/storage/backends/config';
import { getBackends, resetBackends } from '../src/storage/backends';

// P26 — per-test isolation for the Postgres backend run. The filesystem backend isolates via a fresh
// temp FORGE_STATE_DIR per test; Postgres shares one database, so truncate every Postgres-backed store's
// tables before each test. A no-op when no domain is on Postgres (so this setup file is harmless if ever
// loaded outside the PG config). Runs BEFORE each test file's own beforeEach (setup files register
// first), so a test starts from a clean store.
beforeEach(async () => {
  if (!needsDatabase(loadStoreConfig())) return;
  const b = await getBackends();
  await b.identity.__truncateAllForTests?.();
  await b.search.__truncateAllForTests?.();
  await b.events.__truncateAllForTests?.();
  await b.notifications.__truncateAllForTests?.();
});

// Close the pool at the end of each file (vitest isolates modules per file, so the singleton — and its
// pool — is per file).
afterAll(async () => {
  await resetBackends();
});
