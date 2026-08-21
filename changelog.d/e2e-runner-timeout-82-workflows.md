### Changed

- **e2e-runner `job_timeout` 7200s → 7500s** — the workflow catalogue grew 76 → 82 (six Outlook/SMS
  acceptance workflows, 2026-08-20), and 82 × 58s measured wall clock × 1.5 margin = 7134s exceeded
  the old default. The catalogue-size guard in `e2e-runner-sweep-wired.test.ts` caught the drift
  exactly as designed (local red while CI, which lacks the sibling checkout, stayed green); both the
  guard's bound and the estimate constant now reflect the new catalogue.
