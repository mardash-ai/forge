### Added
- Run-history list rows with `status='running'` now render a counter-driven progress bar
  showing completed workflows (passed + failed + withheld) over the intended total
  (`workflows_attempted`), with the count displayed in words beside the bar (e.g. `31 / 75`)
  and elapsed time computed from `started_at`.
- When `workflows_attempted` is absent or zero the bar is suppressed; the row shows an
  indeterminate `running · started N ago` label instead of implying a false completion fraction.
- When `updated_at` has not advanced for more than 2 minutes the bar turns muted and surfaces
  the stall age (`stalled · updated N ago`), so a stuck run reads as stuck rather than quietly
  busy.
- The Evals tab now polls at 5 s (reduced from 15 s) while any run is running, so bar counters
  advance promptly; polling stops automatically when nothing is running.
- Completed, failed, and aborted rows are visually unchanged.
