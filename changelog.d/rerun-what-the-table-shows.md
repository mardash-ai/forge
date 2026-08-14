---
bump: minor
---

### Added

- **"Re-run these N" on the run detail view** — filter the workflow table (click the Rejected tile,
  a withheld cause, a lane) and re-run exactly that set. Mark, 2026-08-14: *"a very common usecase
  will be to re-run all rejected tests."*

  It takes **every filtered row, not just the current page** — "re-run all rejected" has to mean all
  of them; a control that silently re-ran page 1 of 2 would spend half the money and report success.
  Row ids (`W-004:openai`) are reduced to the ids the trigger accepts (`W-004`) and de-duplicated, so
  a workflow that ran on two lanes is sent once.

  The count on the button, the list in the dialog and the workflows actually sent all read **one
  array**. That is not incidental: a tile counting from one source while a table filtered from
  another was the bug reported this same morning, and a run-triggering control is the worst place to
  repeat it.

  It opens the dialog rather than firing a run — the estimate is recomputed for the subset, and the
  confirm step stands. The failing run's provider is carried over as the default lane, and the
  prefill is cleared on both exits so a later plain "Run" is never silently scoped to a filter that
  has since been cleared. Offered only when a filter is active; re-running everything is what the
  list view's Run button already does.
