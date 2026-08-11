import { defineConfig } from 'vitest/config';

/**
 * Default vitest configuration.
 *
 * When TEST_DATABASE_URL is set (injected by CI / the dorinda-orchestrator verify gate), this config
 * activates ALL Postgres backends and maps TEST_DATABASE_URL → FORGE_DB_URL — the same behaviour as
 * `vitest.pg.config.ts`, but triggered by the cross-project standard env var rather than a separate
 * npm script.  fileParallelism is disabled in that mode so concurrent files don't race on shared
 * Postgres tables (the same reason vitest.pg.config.ts disables it).
 *
 * When TEST_DATABASE_URL is NOT set the run uses the default filesystem backends; the pg-*.test.ts
 * files self-skip via `describe.skipIf(!HAS_PG)`.  The orchestrator gate catches this case before
 * vitest even starts:
 *
 *   test -n "$TEST_DATABASE_URL" || { echo '…would SILENTLY SKIP…'; exit 1 }; npx vitest run
 *
 * so a partial suite never passes as green.
 */
const pgUrl = process.env.TEST_DATABASE_URL;

export default defineConfig(
  pgUrl
    ? {
        test: {
          setupFiles: ['tests/setup.pg.ts'],
          fileParallelism: false,
          env: {
            // Map the orchestrator-standard TEST_DATABASE_URL to the forge-internal variable so the
            // pg backends and every pg-*.test.ts file can find it.
            FORGE_DB_URL: pgUrl,
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
            FORGE_PUSH_BACKEND: 'postgres',
            FORGE_CP_RESULTS_BACKEND: 'postgres',
            // Blobs: use S3 only when FORGE_S3_ENDPOINT is explicitly provided; otherwise leave
            // blobs on the filesystem backend so pg-blobs.test.ts self-skips rather than every
            // test file failing because MinIO is not in this environment.
            ...(process.env.FORGE_S3_ENDPOINT
              ? {
                  FORGE_BLOBS_BACKEND: 's3',
                  FORGE_S3_ENDPOINT: process.env.FORGE_S3_ENDPOINT,
                  FORGE_S3_BUCKET: process.env.FORGE_S3_BUCKET ?? 'forge-test-blobs',
                  FORGE_S3_ACCESS_KEY: process.env.FORGE_S3_ACCESS_KEY ?? 'minioadmin',
                  FORGE_S3_SECRET_KEY: process.env.FORGE_S3_SECRET_KEY ?? 'minioadmin',
                  FORGE_S3_REGION: process.env.FORGE_S3_REGION ?? 'us-east-1',
                }
              : {}),
          },
        },
      }
    : {
        // Filesystem-backed run: fast, no external dependencies, pg tests self-skip.
        test: {},
      },
);
