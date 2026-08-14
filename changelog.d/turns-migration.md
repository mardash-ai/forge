### Fixed

- **Every cassette in a live run read "No transcript was recorded" — a missing migration.** `attempt`
  was added to `forge_cp_eval_turns` in the `CREATE TABLE IF NOT EXISTS` block and nowhere else. That
  is a no-op against a database where the table already exists, and it did — created hours earlier by
  the release that introduced the turns table. Every `insertTurn` failed with *column "attempt" does
  not exist*.

  What made it convincing: `mcp_calls`, `claims` and `scenes` populated perfectly, because only
  `turns` had gained a column. The drilldown looked alive; only the transcript was missing, and the
  empty-state confidently blamed an old forge-hat for a fault in the store. Adding a column to an
  existing table is a MIGRATION, never a `CREATE` edit.

- **A rejected row now names its cause and reaches the service log.** `lastWorkflowError` was
  attached to the response only when WORKFLOWS were rejected, so a run where every workflow inserted
  and every child failed answered `200 updated: true` with a bare `children_rejected` count and no
  log line. The exact Postgres error sat in a local variable and was discarded — the information
  that would have diagnosed this in seconds. Rejections are now logged and carry `children_error` /
  `scenes_error`.

### Added

- **`tests/cp-results-upgrades-existing-db.test.ts`** — creates the turns table at its PREVIOUS
  shape, runs the real initialiser over it, then inserts. Every existing schema test ran against a
  database created from the current DDL, where the column is present by construction; the upgrade
  path — the only path production ever takes — was untested. Verified red against the real error
  before the fix: `column "attempt" of relation "forge_cp_eval_turns" does not exist`.
