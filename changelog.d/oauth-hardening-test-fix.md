### Fixed

- **redirect-uri test isolation**: `tests/redirect-uri-fix.test.ts` now reads back registered clients from `getBackends().mcp` (the active backend — FS or Postgres, whichever the route wrote to) instead of a hardcoded `new FsMcpBackend()`. When the verify gate sets `TEST_DATABASE_URL` vitest.config.ts activates the Postgres MCP backend, so the route wrote to PG but the test read from the filesystem — a systematic backend mismatch that caused two integrity-check assertions to always fail under the gate. No production behaviour changed; only the test infrastructure is corrected.
