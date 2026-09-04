---
bump: minor
---

### Added

- **CLI surface in `platform-model.json`**: the generator now embeds a `cli_surface` array — every `forge` verb, its arguments (flag, required, description), and the route it calls — keeping the model a complete API contract for agents and consumers. The CI drift guard continues to cover the new field.
- **`scripts/diff-platform-model.ts`** (`npm run diff:platform-model -- <fromTag> <toTag>`): computes the semantic diff of two platform-model snapshots — added / removed / changed capabilities, resource types, events, error codes, routes, and CLI verbs — and emits `platform-changes.json` (machine-readable) and `platform-changes.md` (human-readable). An empty diff is represented explicitly (`"empty": true`), not as an error.
- **`publish-image.yml` `release-assets` job**: every tag release now attaches `platform-model.json`, `platform-changes.json`, and `platform-changes.md` as GitHub release assets (the diff is computed vs. the previous semver tag; first-release has `from_version: "(none)"`).
- **`docs/architecture/PLATFORM_FEED.md`**: describes the feed schema, fetch URLs, diff script usage, and CI integration.
- **`tests/platform-model-diff.test.ts`**: fixture-model tests covering all diff dimensions; determinism assertions prove identical inputs yield identical JSON bytes and Markdown bytes; empty-diff path verified explicitly.
