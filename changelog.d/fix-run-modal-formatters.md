### Fixed
- Run-modal scope label no longer renders a raw `null` when no historical run exists in the store; it now says "workflow count not yet known" in words.
- Run-modal spend-estimate duration now scales with the selection: a single named workflow shows `~1 min`, a suite run shows `~20 min`, and only the full-catalogue selection shows `~40 min`. Previously `~40 min` was hardcoded for every scope, inflating the estimate ~40× for small selections.
- Both fixes are backed by a new `fmtE2eFullScopeLabel` / `fmtE2eRunDuration` formatter pair in `console/src/lib/e2e-format.ts`, following the same "name the number when you have it, say plainly when you don't" rule applied to the Attempted tile.
