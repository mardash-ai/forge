---
bump: minor
---

### Added

- `POST /api/e2e/runs` — authenticated console write endpoint that starts a Cloud Run job execution (via `jobs.run` as the console Workload Identity), pre-creates an `EvalRun` record in the cp-results store so the run appears immediately in the Evals tab, and returns the execution identity (`run_id` + `state`). Accepts a full-suite run or a named workflow/suite subset. Requires a reason (audit trail). Automation token refused (read-only by construction).
- Cost-confirm modal: replaced the disabled "Run" button (which used to call `alert()`, then was truthfully disabled in v1.26.17) with a working confirm flow — an explicit checkbox stating the expected spend and workflow count must be checked before the endpoint is called. The run is attributable to whoever confirmed it (actor email in the `trigger_source` field).
- Live-updating Evals tab: the runs list and run detail view auto-refresh every 15 s while any run has `status: 'running'`, transitioning to its terminal state (success/failure) without a manual reload.
- Status column in the run history table shows `⏺ running…`, `✗ failed · Cloud Run ↗` (with a link to the GCP Console execution page), or `⊘ aborted` for non-completed runs.
- `src/plugins/console-gcp/jobs.ts` — `triggerCloudRunJob` + `buildExecutionConsoleUrl` for the Cloud Run Jobs v2 REST API.
