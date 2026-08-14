### Changed

- **Dropped the "Accepted (sparkline)" column from the E2E run list.** The status column now reports
  completed-of-expected, which carries the same signal in a form you can read per row — the sparkline
  restated it once, on the first row only, in 260px of table width. Removed the column, its cell, the
  `E2ESparkline` component and the `sparklineRuns` slice rather than leaving dead code behind.
