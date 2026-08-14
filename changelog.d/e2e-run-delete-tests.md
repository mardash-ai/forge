### Added
- Six red-against-broken tests for `DELETE /api/e2e/runs/:run_id` in `tests/console-e2e-api.test.ts`:
  cascade (children gone), running-run refused (409 + still present), audit (success and refusal both recorded), not-found (clean 404), authorization (automation token 403, no-cookie 401), and recomputation (deleted run absent from list with no ghost spend).

### Fixed
- `DELETE /api/e2e/runs/:run_id` now writes an audit row for refused (409) deletion attempts; previously the handler returned 409 before calling `audited()`, leaving no record of the attempt. The 409 check now throws inside the `audited()` block so refusals are recorded with `outcome='failed'`.
- Exported `_resetAuditLog()` from `src/console/server.ts` for test isolation.
