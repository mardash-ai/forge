### Fixed

- **C3 `caller` attribution**: `POST /app-events` now accepts and persists the `caller` field that dorinda-api sends on `mcp.tool_call` and stamped domain events. Previously the field was absent from `AppEvent` and `AppEventInput` and silently dropped; events now carry caller verbatim (filesystem JSONL + Postgres column).
- **C3 `DELETE /app-events`**: Added owner-scoped tenant-reset route (`DELETE /app-events { owner }`). dorinda-api calls this during account teardown; it previously returned 404 because the route was not registered. Deletes only the requesting owner's events, never another tenant's. Returns `{ deleted: N }`.
- **C3 trace stamping**: forge-written C3 events (`mcp.tool_call`, `authz.decision`, `policy.set/removed`, `connector.*`, `message.*`) now carry `data.trace_id` (W3C trace id from the active span) and a top-level `trace_id` field for cross-hop trace correlation. App-emitted events (via `POST /app-events`) are not stamped — the app controls its own tracing boundary.
- **Postgres schema**: `forge_app_events` table gains `caller` and `trace_id` columns with idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` migrations; a B-tree index on `(app_id, trace_id)` enables trace-scoped queries.

### Added

- `store.deleteAppEventsByOwner(app_id, owner)` — new store method for owner-scoped event deletion (used by `DELETE /app-events` and future C34 account-teardown flows).
- Cross-source contract guard (`tests/c3-cross-source.guard.test.ts`) — guardrail #5 asserting forge's C3 vocabulary matches dorinda-api's emitter contract; was RED (9/12 failing) against the pre-fix code, GREEN (12/12) after.
- C3 catalog entry and `c23-mcp-host-runbook.md` updated with `DELETE /app-events`, `caller` attribution semantics, and trace stamping reference.
