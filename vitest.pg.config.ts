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
      FORGE_SECRETS_BACKEND: 'postgres',
      FORGE_RESOURCES_BACKEND: 'postgres',
      FORGE_POLICY_BACKEND: 'postgres',
      FORGE_MCP_BACKEND: 'postgres',
      FORGE_CONNECTIONS_BACKEND: 'postgres',
      FORGE_MEMBERSHIP_BACKEND: 'postgres',
      FORGE_BILLING_BACKEND: 'postgres',
      FORGE_BLOBS_BACKEND: 's3',
      // S3 defaults for the local MinIO the test:pg run + CI use; overridable from the environment.
      FORGE_S3_ENDPOINT: process.env.FORGE_S3_ENDPOINT ?? 'http://127.0.0.1:59000',
      FORGE_S3_BUCKET: process.env.FORGE_S3_BUCKET ?? 'forge-test-blobs',
      FORGE_S3_ACCESS_KEY: process.env.FORGE_S3_ACCESS_KEY ?? 'minioadmin',
      FORGE_S3_SECRET_KEY: process.env.FORGE_S3_SECRET_KEY ?? 'minioadmin',
      FORGE_S3_REGION: process.env.FORGE_S3_REGION ?? 'us-east-1',
    },
  },
});
