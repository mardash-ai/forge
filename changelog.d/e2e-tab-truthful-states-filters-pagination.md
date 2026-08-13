### Fixed

- **P0 — eliminate silent fixture fallback in E2E tab**: `/api/e2e/runs` returning 501 (store not configured) no longer silently substitutes compiled-in sample data. The tab now renders three visually-distinct, truthful store states: *connected* (real data only), *not-configured* (prominent amber banner naming the unset `CONSOLE_CP_DB_URL`, empty state with no numbers), and *unreachable/error* (red banner with the error message, empty state). Fixture data is only rendered when `import.meta.env.DEV` is true, behind an unmissable "⚠ SAMPLE DATA" marker.

### Added

- **E2E tab — lane, integrity-class, and tier filters** composable with the existing verdict filter; all active filters are encoded in the URL (`&lane=…&ic=…&tier=…`) alongside the existing `run`, `f`, `wf`, and `cause` params so filtered views survive a page reload and are shareable. A single "✕ Clear filters" button resets all active filters at once.
- **E2E tab — `Showing N of M` caption** above the workflow table where M is the run's `workflows_attempted` count and N is the number of rows the current filters leave visible. When the store holds fewer detail rows than the run attempted, the caption self-explains (e.g. "the store holds detail for 6").
- **E2E tab — workflow table pagination** (25 per page with Prev / Next controls); the expanded row is automatically brought into view regardless of which page is active.
- **`ApiError` class in `console/src/lib/api.ts`** with `status` (HTTP status code) and `code` (server-supplied error code) properties, exposed as `httpStatus` and `errorCode` on the `Query<T>` interface. Consumers can now distinguish "not configured" (501) from genuine errors without string-matching the message.
