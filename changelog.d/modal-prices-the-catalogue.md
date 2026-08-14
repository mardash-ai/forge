### Fixed

- **The run modal priced "Full catalogue" from the last run instead of the catalogue.** The line
  read `const catalogue = runs[0]?.workflows_attempted` — sitting directly beneath a comment
  explaining why deriving it from run history is wrong. It looked right for weeks because the
  previous run was usually a full one; then two 2-workflow verification runs made the dialog offer
  **"Full catalogue — 2 workflows · Estimated spend $0.16"** for a 76-workflow, ~$5, 75-minute run,
  above a checkbox reading *"I confirm: spend approximately $0.16"*.

  The run itself was correct throughout — "Full catalogue" posts `suite: "full"` and the count never
  enters the payload — so nothing downstream would ever have caught it. Only the operator's consent
  was wrong, which is the one thing that dialog exists to get right.

  The size now comes from `meta.catalogue_size`, which forge-hat counts from `suites/full.yaml` and
  reports on every run. Spend scales **per workflow** rather than reusing a previous run's total,
  and the duration derives from measured wall clock instead of a hardcoded `~40 min` — a guess that
  understated a full run by nearly half, and that an existing test had pinned in place.
