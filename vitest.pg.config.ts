import { defineConfig } from 'vitest/config';

// P26 — the POSTGRES backend test run. It runs the SAME test files as the default (filesystem) run,
// but forces the identity store onto Postgres (FORGE_IDENTITY_BACKEND=postgres) and provides per-test
// isolation via tests/setup.pg.ts (truncate before each test). Requires FORGE_DB_URL in the env.
//
//   FORGE_DB_URL=postgres://user:pass@host:port/db  npm run test:pg
//
// fileParallelism is disabled so the shared database isn't truncated out from under a parallel file.
export default defineConfig({
  test: {
    setupFiles: ['tests/setup.pg.ts'],
    fileParallelism: false,
    env: {
      FORGE_IDENTITY_BACKEND: 'postgres',
      FORGE_SEARCH_BACKEND: 'postgres',
      FORGE_EVENTS_BACKEND: 'postgres',
      FORGE_NOTIFICATIONS_BACKEND: 'postgres',
    },
  },
});
