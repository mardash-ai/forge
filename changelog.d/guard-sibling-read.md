### Fixed

- **A cross-repo test read a sibling checkout unconditionally and broke the build.** The
  catalogue-size assertion opened `../forge-hat/suites/full.yaml`, which exists on a dev box where
  both repos sit side by side and does not exist in CI, where only `forge` is checked out. ENOENT
  failed the test job and skipped the publish. The gate behaved correctly — the test was wrong.

  Now guarded with `existsSync`. Skipping is safe here rather than a silent hole: forge-hat pins the
  count in its own CI where the file always exists, and the assertion that actually protects this
  repo — job timeout > catalogue × measured rate — runs unconditionally off a constant.
