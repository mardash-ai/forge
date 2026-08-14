### Fixed

- **The e2e-runner can now keep its own MCP grant current.** The grant is single-use, so each run
  consumed the stored refresh token and left the next one to fail `invalid_grant`. The job's service
  account gets `secretVersionAdder` on the refresh-token secret **only**, and the job is told where
  to write (`HAT_REFRESH_TOKEN_SECRET` / `HAT_REFRESH_TOKEN_PROJECT`), so a rotation survives the
  container that performed it.
