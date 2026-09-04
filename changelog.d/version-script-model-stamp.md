### Fixed

- **`version` npm lifecycle script** added to `package.json`: `npm version <level>` now automatically runs `generate:platform-model` and stages `platform-model.json` in the same commit, so the model's version stamp can never drift from the package version again.
- **`platform-model.json` version stamp corrected** to `1.56.1` (was `1.56.0`): the 1.56.1 re-tag published a stale model; regeneration now ensures parity.
- **Duplicated `## [1.56.1]` CHANGELOG section collapsed** to a one-line note: 1.56.1 was a re-tag whose publish failed; the next release supersedes it.
- **Generator header comment updated** to document the `version` script as the primary regeneration path alongside `npm run generate:platform-model` and the CI drift guard.
- **`tests/version-script.test.ts` added**: structural checks that the `version` script exists and contains both required commands, plus an end-to-end mechanism test that bumps a temporary `package.json`, runs the generator, and asserts the model stamp follows — fails if the `version` script is absent.
