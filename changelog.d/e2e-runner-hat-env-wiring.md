### Changed
- Wired the `e2e-runner` Cloud Run Job with the full `.hat/env` credential set that `hat remote`
  reads after the OAuth mint change: `DORINDA_MCP_ENDPOINT`, `DORINDA_MCP_REFRESH_TOKEN`, and
  `DORINDA_MCP_CLIENT_ID` (all from Secret Manager) replace the former static `AUTH_SERVICE_TOKEN`
  / `DORINDA_MCP_TOKEN`; `DORINDA_TEST_CONTROL_TOKEN` (SM) and `DORINDA_TEST_CONTROL_URL` (plain)
  wire the test-control surface; `DORINDA_TENANT`, `E2E_PROVIDER`, and `E2E_MODEL` carry tenant
  identity and provider/model selection. The job's SA now holds `secretAccessor` on the four new
  secrets (`mcp-endpoint`, `mcp-refresh-token`, `mcp-client-id`, `test-control-token`) and no
  longer holds it on the removed `service-token`. `PROVIDER_ACCOUNTS.md` records each new secret,
  where it lives, and the exact minting procedure. Ships via push-gated CI apply.
