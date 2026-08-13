### Fixed

- **e2e-runner infra — clean working tree after release**: the previous release commit folded the
  changelog fragment into `CHANGELOG.md` but did not commit its deletion, leaving the working tree
  dirty. This commit stages the deletion of the stale fragment alongside the new entry so `git status`
  is clean after publish. No functional changes — the terraform wiring (t-runner-image digest,
  `roles/run.invoker` job-level binding) was already shipped in v1.28.1 and is unchanged.
