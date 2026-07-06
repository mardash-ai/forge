# Changelog

All notable changes to the **Forge control plane** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Each released version maps to a published control-plane image tag
(`ghcr.io/mardash-ai/forge-control-plane:<version>`).

## [Unreleased]

## [0.6.1] — 2026-07-06

### Fixed
- **`Deploy` no longer requires a registered Application.** Deploy targets a production
  compose stack at the project root, and a deploy host may never have run `forge init` — so
  `--app` is now a soft label (resolved if present, else the `Deployment` is recorded with no
  `app_id`) instead of a hard `resolveApp` that 404s. Lets `forge deploy` run on a host that
  carries only the manifests + images (e.g. via a transiently-started control plane).

## [0.6.0] — 2026-07-06

### Added
- **Platform capability C7 — Deploy (zero-downtime rollout).** A new `Deploy`
  Capability + `deploy-compose-rollout` Implementation performs a **start-first**
  release of an app's production stack behind a reverse proxy (Traefik): it
  reconciles the non-public services in place, then rolls the public `--service`
  (default `web`) by bringing up a new replica alongside the old, waiting until it
  is **healthy**, draining the old out of the proxy network, and removing it — so
  there is never a moment with zero healthy backends (no 502 window). A new replica
  that never becomes healthy is discarded and the old one keeps serving (automatic
  rollback → `DeploymentRolledBack`). Drive it with `forge deploy --app <app>
  [--service <s>] [--context <docker-context>] [--compose-file <f>]`; each deploy is
  a `Deployment` Resource recording old→new container ids + outcome, emitting
  `DeploymentStarted` / `DeploymentCompleted` / `DeploymentRolledBack` facts.
  Targets the local Docker daemon by default; `--context` targets a remote daemon
  over Docker's native transport. Ports the proven forge-os `deploy/rollout.sh`
  into the platform so apps **consume** the behavior instead of copying the script.

## [0.5.1] — 2026-07-06

### Fixed
- **Generated Postgres healthcheck now names the database.** `generateCompose` emitted
  `pg_isready -U forge` with no `-d`, which probes a database named after the *user* (`forge`)
  — but the db is the app name (e.g. `forge_os`). For any app whose name isn't `forge`, every
  10s healthcheck logged a harmless-but-alarming `FATAL: database "forge" does not exist`. Now
  emits `pg_isready -U forge -d <db>`. Re-run `forge provision` to regenerate `compose.yaml`.

## [0.5.0] — 2026-07-06

### Added
- **Data-plane image + deployment split (R3).** A `plane` field on the Capability contract
  (`control` / `data` / `both`) classifies each capability, and a new **data-plane server**
  (`src/data-plane/server.ts`) exposes only the data-plane capabilities (scheduler C2, secrets
  store C5, and read/observe surfaces) and runs the scheduler — no build/test/lint/provision.
- A slim **`forge-data-plane`** image (`Dockerfile.data-plane`, ~403 MB vs the control plane's
  ~799 MB): no Docker CLI, no dev dependencies. Published multi-arch by a new **continuous**
  workflow (on push to `main` → `:latest` + `:sha-…`, and on version tags → `:X.Y.Z`).
- The scheduler reaches the app in production via `FORGE_APP_CALLBACK_HOST` /
  `FORGE_APP_CALLBACK_PORT` (sidecar mode, no provisioned state), and the data plane can register
  jobs from a mounted `FORGE_JOBS_FILE` at boot.

## [0.4.0] — 2026-07-06

### Added
- **Platform capability C2 — Scheduler / background jobs.** A new `ScheduleJob`
  Capability + `scheduler-node` Implementation (an in-process ticker in the always-on
  control plane): register durable **recurring** (`--every <dur>` or `--cron "<expr>"`,
  evaluated in UTC) or **one-shot** (`--at <iso>`) jobs that Forge fires on cadence by
  calling back into the app (`--target <path>`). Jobs are `ScheduledJob` Resources, so
  the ticker resumes across restarts (a job due while the plane was down fires on the
  next tick); a failed run retries with backoff, then skips to the next fire. Manage and
  observe with `forge schedule` / `forge jobs` (and `inspect jobs`); every run records a
  `JobRan` / `JobRunFailed` event. The app callback host is `host.docker.internal` by
  default (override with `FORGE_APP_CALLBACK_HOST`).

## [0.3.0] — 2026-07-06

### Fixed
- **`provision` is no longer destructive (P1).** It now **converges** the desired
  environment from `forge.app.json` (+ this call's flags) instead of regenerating
  `compose.yaml` from *only* the flags, so a flag-less re-provision no longer silently
  drops a service (e.g. Postgres and its data volume) or resets a host-port remap. Apps
  provisioned before this fix are recovered from their existing `compose.yaml` on the
  first re-provision. Dropping a data-volume service now requires an explicit `--force`.

### Added
- `provision` persists the desired infra (postgres / redis / secrets / host-ports) under
  an `infra` key in `forge.app.json`, so a re-provision needs no flags. New flags:
  `--without-postgres` / `--without-redis` (explicit removal), `--postgres-port` /
  `--redis-port` / `--web-port` (host-port overrides), and `--force`. `inspect app` now
  surfaces the persisted `infra`.
- `CHANGELOG.md` following Keep a Changelog + SemVer; the `add-platform-capability` skill
  maintains it automatically as part of shipping each capability.

### Changed
- The publish workflow builds **multi-arch** images (`linux/amd64` + `linux/arm64`) via
  QEMU + buildx, so control-plane images run natively on arm64 (Apple Silicon) dev hosts
  as well as x86 servers; `0.2.0` was republished multi-arch and all future images are
  multi-arch.

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

[Unreleased]: https://github.com/mardash-ai/forge/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/mardash-ai/forge/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/mardash-ai/forge/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/mardash-ai/forge/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/mardash-ai/forge/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mardash-ai/forge/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mardash-ai/forge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mardash-ai/forge/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mardash-ai/forge/compare/defed64...v0.1.1
[0.1.0]: https://github.com/mardash-ai/forge/commit/defed64
