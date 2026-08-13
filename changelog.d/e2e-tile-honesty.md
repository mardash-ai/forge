### Fixed

- **The E2E Attempted tile no longer claims "100% of catalogue" under a zero.** A run that died
  before attempting a single workflow rendered `ATTEMPTED 0` above a confident "100% of catalogue",
  and an unknown catalogue size produced the same string — the numbers were real and the sentence
  beside them was invented. It now reads `nothing attempted` or `catalogue size unknown`, and only
  states a percentage when both numbers are known. The two tile formatters moved to
  `console/src/lib/e2e-format.ts` so the claims they make are unit-tested.
