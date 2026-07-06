# Changelog

All notable changes to the **Forge control plane** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Each released version maps to a published control-plane image tag
(`ghcr.io/mardash-ai/forge-control-plane:<version>`).

## [Unreleased]

### Added
- `CHANGELOG.md` following Keep a Changelog + SemVer. The `add-platform-capability`
  skill now updates it automatically as part of shipping each capability.

## [0.2.0] — 2026-07-06

### Added
- **Platform capability C5 — Secrets / credential management.** New `SetSecret`
  Capability and `secrets-local` Implementation (AES-256-GCM): an app declares the
  secrets it needs (`forge provision --app <app> --secret <NAME>`, or a `"secrets"`
  array in `forge.app.json`), Forge stores them encrypted under the gitignored state
  dir, and injects the decrypted values into the app's `docker compose` process at
  `forge dev` — never into a tracked file or an image layer. The `Secret` Resource
  records only that a secret is set (name + status), never its value.
- `forge secrets set` / `forge secrets list` CLI commands and a `forge inspect secrets`
  view (names only).
- `add-platform-capability` skill — codifies the platform-builder's relay turn
  (read the ledger → build the next capability → publish a pinned image → fill the
  Delivery block → emit a forge-os adoption prompt).

### Changed
- `ProvisionEnvironment` accepts declared secrets and emits an empty-by-default
  `- <NAME>=${<NAME>:-}` interpolation line per secret, so an unset secret is detectable
  and the app degrades gracefully (e.g. returns 503) instead of crashing. Apps that
  declare no secrets are byte-for-byte unchanged.

## [0.1.1] — 2026-07-05

### Added
- Single-app `./app` workspace layout via `FORGE_APP_LAYOUT=single`: every repo holds
  exactly one app at `./app`, and a second `init` is rejected.

### Changed
- `appDir()` resolves to `./app` in single-app mode; any other value keeps the
  multi-app `./apps/<name>` layout, so existing projects are unaffected.

## [0.1.0] — 2026-07-05

### Added
- Initial Forge v1 control plane: a Docker-first, API-first platform (Fastify API,
  filesystem-backed Resource/Event store) that can initialize, provision, install, run,
  build, test, lint, inspect, explain failures for, and plan a Dockerized Next.js app,
  driven by a thin `./forge` CLI.

[Unreleased]: https://github.com/mardash-ai/forge/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mardash-ai/forge/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mardash-ai/forge/compare/defed64...v0.1.1
[0.1.0]: https://github.com/mardash-ai/forge/commit/defed64
