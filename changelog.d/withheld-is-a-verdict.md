---
bump: minor
---

### Fixed

- **A withheld workflow was displayed as rejected.** forge-hat's `UNARMED` / `INFRA-FAIL` mean the
  RIG failed — nothing was tested, so there is no verdict — and both collapsed into `error`, which
  the console rendered as `✗ rejected`. W-009 on 2026-08-14 showed every trial step green under a red
  verdict, because it had never been rejected at all. That inverts accepted/rejected/withheld, the
  third-outcome discipline the harness rests on, sends someone to debug a product that did nothing
  wrong, and inflates every run's failure count.

  `withheld` is now a first-class verdict, carried from the runner's vocabulary into the store.

- **Tiles and table can no longer disagree.** The metric tiles counted from run-level counters the
  runner reports; the table filtered on each row's stored verdict. Two independent sources — so the
  Withheld tile read `1` while clicking it produced an empty table, because nothing was ever stored
  as `skip`. One helper (`bucketOf`) now decides the bucket, and the tiles count the ROWS the table
  will show. Mark's requirement, exactly: *"the number reported in any tile should always match the
  number listed in the table."*

- **Historical runs are backfilled.** Every existing `error` row is provably a withheld workflow:
  forge-hat's verdict type is exactly `ACCEPTED | REJECTED | UNARMED | INFRA-FAIL`, the first two
  were mapped explicitly, and `skip` was never reachable from the runner. Gated behind a
  `forge_cp_migrations` marker so it runs exactly once — a date bound was tried first and was wrong,
  because the deploy happens on the same day the cutoff named.

  ⛔ The original plan was to backfill from `integrity_class`. That would have matched **nothing** —
  forge-hat has never emitted that column, so it is NULL on every production row. A backfill
  predicate that silently matches zero rows looks exactly like one that worked.

- **The CHECK constraint is migrated, not just widened in `CREATE`.** Widening the list in
  `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists — the same mistake that
  emptied every cassette earlier the same day.
