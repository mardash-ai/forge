### Fixed

- **The e2e-runner job exported tenant credentials under names the runner does not read.** It wired
  `DORINDA_EMAIL` / `DORINDA_PASSWORD`; `hat remote` reads `DORINDA_TENANT_EMAIL` /
  `DORINDA_TENANT_PASSWORD`. The third name mismatch of the night, and the same symptom each time: a
  job that starts, looks correctly configured, and behaves as if unconfigured. forge-hat now carries
  a test that fails when this module exports a name the runner never consumes.
