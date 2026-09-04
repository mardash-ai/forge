### Added
- **`generate:platform-model` npm script** (`scripts/generate-platform-model.ts`): build-time generator that reads the live capability registry, `RESOURCE_TYPES`, `EVENT_TYPES`, server route tables, and error taxonomy; emits a version-stamped `platform-model.json` committed into the repo. Consumers fetch the model by git tag.
- **`platform-model.json`** committed to the repo: version-stamped, comprehensive snapshot of every capability (slug, name, description, `plane`, resource type, events, input schema, endpoint), the closed resource-type set, the closed event catalog, the error taxonomy with retry semantics, and the per-server route tables for both the control and data planes.
- **CI drift guard** in `ci.yml`: after typecheck, re-runs `generate:platform-model` and diffs the output against the committed file; fails the build with a clear remediation message when the model is stale.

### Changed
- **`GET /capabilities` now includes `plane`** per capability (`'control' | 'data' | 'both'`), sourced consistently from the capability registry (`describeCapabilities()` in `src/core/registry.ts`). Absent on the capability definition defaults to `'control'`. Covered by 18 new tests in `tests/platform-model.test.ts`.
- **`src/core/registry.ts` lazy-initializes** the capability slug map (deferred from module-evaluation time to first-call time) to break a latent ESM circular initialization hazard (`eval/seed → billing/service → notifications/delivery → core/runtime → core/registry → capabilities/index → …`). No behavioral change for callers.
