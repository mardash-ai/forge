### Fixed

- **The e2e-runner job exported env names the runner does not read.** It set `DORINDA_MCP_ENDPOINT`
  and `DORINDA_TENANT`; `hat remote` reads `DORINDA_MCP_URL` and `DORINDA_TEST_TENANT`. Every run
  triggered from the console therefore died with `DORINDA_MCP_URL is not set` about twenty-five
  seconds after the click — with correct credentials sitting one variable name away. The tenant value
  is now the owner **id** (an email fails as "tenant is not flagged as a test tenant", an error that
  points at the tenant rather than at the value), and `HAT_EXTRACTOR_MODEL` is pinned so a silent
  provider-side model change cannot move every baseline at once.
