---
bump: minor
---

### Fixed

- **A background poll no longer unmounts the page under the operator.** `useApi` raised `loading` on
  *every* reload, and the E2E screen gates whole subtrees on it — so each poll made every gated block
  return false at once, the document collapsed to its header, and the browser clamped `scrollTop` to
  0. Remounting a moment later does not restore it, so anyone reading below the fold was thrown back
  to the top on every tick. `loading` now means "there is nothing to show yet"; a new `refreshing`
  flag means "a request is in flight". Deliberately not fixed by flipping `loading` globally — other
  screens rely on it during user-driven parameter changes and would have shown stale data with no
  indicator.

  Neither of the two hypotheses originally recorded was right: it was not data identity (`useApi`
  keeps the old payload) and not the `replaceState` URL sync (its deps are click-driven, and
  `replaceState` does not move scroll in any browser).

- **The "All integrity classes" filter is deleted.** Mark: *"I literally have no idea what this means
  and I built this entire system."* The control was dead: `integrity_class` is forge's own invention
  that forge-hat has never emitted, so the column is NULL on every production row, the dropdown
  offered one value, and selecting it filtered nothing. Deleted rather than relabelled — dressing up
  an empty column keeps a control that cannot answer a question.

- **Withheld causes moved to subtiles beneath the metric tiles, shown only when Withheld is
  selected** — the original mockup's position, instead of buried below the table. They are counted
  from the rows with the same helper the table filters by, so a cause can never again display a
  number and then filter to nothing.

### Changed

- **The triage prompt now carries the evidence instead of pointing at it.** It was run id, counters
  and a list of failing ids. It now emits a structured brief: run context; an explicit
  rejected-vs-withheld warning; per-failure failing bar, expected vs observed, flaky-vs-deterministic
  trial pattern, the transcript, the MCP calls actually made, and extracted claims; a separate
  withheld section stating plainly that nothing there is a product bug; and the classification
  protocol. Every cut announces itself (`… [+N chars truncated]`), and the fixed sections are
  assembled *before* the evidence so a large run can never produce a brief with all evidence and no
  protocol.
