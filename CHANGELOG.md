# Changelog

All notable changes to the **Forge control plane** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Each released version maps to a published control-plane image tag
(`ghcr.io/mardash-ai/forge-control-plane:<version>`).

## [Unreleased]

## [0.12.0] — 2026-07-07

### Added
- **C6 — a standard health / telemetry contract the platform owns and observes.** Apps used to
  hand-roll `/api/health` as a liveness-only endpoint that returned `200 {status:'ok'}` even when a
  dependency (e.g. Postgres) was down — it lied about readiness. C6 standardizes the shape, the
  readiness → HTTP-code convention, and adds a way to inspect it. The route STAYS in the app
  (framework-native); the platform owns the contract.
  - **Standard health schema (`src/shared/health.ts`).** `{ status: 'ok'|'degraded'|'unavailable';
    service; time: ISO-8601; checks: [{ name; status: 'ok'|'unavailable'; detail? }] }`
    (`checks: []` = valid liveness-only). Recognized/validated by `parseHealthResponse`.
  - **Readiness → HTTP-code convention.** `httpStatusFor`: **200** when `ok` (all required checks
    pass, or none) or `degraded` (a *non-required* check failed, flagged); **503** when a *required*
    check fails (`unavailable`). Every prober already treats non-2xx as unhealthy, so 503-on-not-ready
    needs no prober change (dev/prod compose healthchecks, the C7 Traefik `loadbalancer.healthcheck`).
  - **Platform-owned check aggregation.** `aggregateHealth(service, results)` rolls a list of resolved
    check results up into `{ body, httpStatus }` per the convention above. The app supplies its checks
    (opaque thunks, e.g. a DB `SELECT 1`) + its service name; the platform owns the shape + rollup.
  - **`forge inspect health --app <app>`.** New `health` inspection type: reads
    `production.readiness_path` from `forge.app.json` (default `/api/health`), fetches it LIVE
    (no-cache, 5s timeout) over the same app-callback convention the scheduler uses
    (`FORGE_APP_CALLBACK_HOST`/`_PORT`, else `host.docker.internal` + the provisioned web port), and
    renders the parsed schema — overall status + per-check. Flags a reachable-but-non-conforming
    endpoint and a 200/503 convention mismatch; degrades (never throws) when unreachable.

### Changed
- **The `init app` scaffold now emits the standard health handler** (distribution (A) — the reference
  snippet, materialized), replacing the retired always-`ok` `healthPayload`. New apps get a vendored
  `lib/health.ts` (`buildHealth({ service, probes })` → `{ body, httpStatus }`), an `/api/health` route
  that returns real 200/503 readiness, and matching tests. No new distribution mechanism, no npm
  package, no data-plane code — the contract is platform-owned; the route is app-owned.

## [0.11.1] — 2026-07-07

### Fixed
- **`productionize` — the generated `compose.prod.yaml` now matches the runtime contract the
  platform’s own capabilities (C1–C5, C7) establish.** Adopting C8 surfaced four seams where the
  emitted prod stack didn’t line up with how the shipped capabilities actually run; the generator
  now derives all four from the app’s declared `infra`/manifest (still generic — no app specifics):
  - **P6 — the data-plane sidecar can now read the C5 secrets vault.** The sidecar runs the
    **data-plane** capabilities (C1 agent-run reads `ANTHROPIC_API_KEY` from the C5 vault here), but
    the generated compose gave it **no `FORGE_SECRETS_KEY`** and injected the declared secrets only
    into `web` — so prod agent-run would 503. The generated `data-plane` service now gets
    `FORGE_SECRETS_KEY` (to decrypt the vault at rest on the `forge_state` volume) **and** each
    declared secret as a defined-but-empty interpolation (the process-env fallback), mirroring the
    web tier. `.env.prod.example` documents `FORGE_SECRETS_KEY`.
  - **P7.1 — the web app now reaches the data-plane under the name the shipped clients read.** The
    C1/C3/C4 delivery has apps read the data-plane base URL from **`FORGE_EVENTS_URL`**; the
    generator only set `FORGE_DATA_PLANE_URL`, so prod lost data-plane reachability. `web` now sets
    **`FORGE_EVENTS_URL=http://data-plane:3718`** (the load-bearing contract), keeping
    `FORGE_DATA_PLANE_URL` as a compatible alias.
  - **P7.2 — `forge productionize` and `forge deploy` now agree on the compose path.**
    `productionize` writes `app/compose.prod.yaml`, but `forge deploy` defaulted `--compose-file` to
    `compose.prod.yaml` at the workspace root and couldn’t find it. `forge deploy` now defaults to
    **`app/compose.prod.yaml`** (the single-app layout `provision` uses), so a plain
    `forge productionize` → `forge deploy` works end-to-end and the compose’s relative bind-mounts
    resolve from `./app`.
  - **P7.3 — declared C2 scheduled jobs are now mounted into the sidecar.** The generated sidecar
    set `FORGE_JOBS_FILE` but never mounted the file, so scheduled jobs never registered in prod.
    When the app declares jobs (a `forge.jobs.json` at the repo root), the compose now bind-mounts it
    read-only into the data-plane (`./forge.jobs.json:/app/forge.jobs.json:ro`) and pins
    `FORGE_JOBS_FILE` at it, so C2 registers them on boot (their `ScheduledJob` state persists on the
    `forge_state` volume). With no jobs declared the `FORGE_JOBS_FILE` seam stays optional.

## [0.11.0] — 2026-07-07

### Added
- **`forge productionize` — generate the app’s canonical production artifacts (C8).** A new
  control-plane `Productionize` Capability (HTTP `POST /capabilities/productionize`,
  `forge productionize --app <app> --host <domain> [--readiness-path /api/health]
  [--web-image <ref@sha256:…>] [--data-plane-image <ref@sha256:…>] [--cert-resolver <name>]`) that
  EMITS files — like `provision` generates the dev `compose.yaml`; nothing new runs in prod. It
  writes, into the app repo:
  - a multi-stage **`Dockerfile`** that builds a slim runtime image from Next’s
    `output: 'standalone'` (no build tooling in the runner, non-root, `CMD ["node","server.js"]`)
    and a matching **`.dockerignore`**;
  - **`output: 'standalone'`** set in the app’s Next config — injected idempotently, never clobbering
    a hand-set `output` (a config is created if the app has none);
  - **`compose.prod.yaml`** — the CANONICAL production stack, derived from the app’s declared `infra`
    (postgres/redis/secrets, per P1) + `--host`: the **Traefik** ingress labels (host rule + the
    `loadbalancer.healthcheck` that **C7 Deploy** gates on), `stop_grace_period`, the external
    `proxy` network, the **Forge data-plane sidecar** (C3/C4 — reached at `http://data-plane:3718`
    via `FORGE_DATA_PLANE_URL`, state on a volume), and the **DB** service (healthcheck names the db).
    It is **exactly what `forge deploy` rolls**;
  - **`.env.prod.example`** documenting the values `.env.prod` must supply (never a real secret).

  **Idempotent + convergent** like `provision`: the converged production config (host, readiness
  path, image pins, cert resolver) is persisted under `forge.app.json` `production`, so a flag-less
  re-run reproduces byte-identical artifacts and never resets a value it isn’t given. **R1:** the
  generated compose references only **digest-pinned** images (`ref@sha256:…`) for the web and
  data-plane services — a non-digest `--web-image`/`--data-plane-image` (or a bare tag / `latest`) is
  rejected `422 invalid_input`; postgres/redis use the same fixed tags `provision` uses. A new
  `ProductionArtifacts` Resource + `ProductionArtifactsGenerated` Event record what was generated.
  Pairs with **C7 Deploy**; additive — no change to already-adopted capabilities. Consumers replace
  their hand-authored `app/Dockerfile` + `compose.prod.yaml` (and any template deploy-image staging)
  with this generator’s output.

## [0.10.0] — 2026-07-07

### Added
- **`forge secrets unset` — remove/revoke a secret (P2, C5 follow-up).** C5 shipped `secrets set`/
  `list` but no way to remove a secret; this adds `forge secrets unset --app <app> --name <NAME>`
  (a new `UnsetSecret` Capability, HTTP `POST /capabilities/unset-secret { app, name }`). It deletes
  the encrypted entry from the app's vault and retires the `Secret` Resource, emitting a `SecretUnset`
  fact (name only). **Idempotent** (unsetting an absent secret succeeds), `404 not_found` for an
  unknown app, `422 invalid_input` for an invalid name, and it **never logs, echoes, or returns the
  value**. Served on both planes like `set-secret`, so a live `unset` revokes the key the running app
  reads — its next lookup sees it absent and degrades (e.g. `agent-run` → `503`).

### Fixed
- **`forge build` then `forge dev` no longer corrupts the shared `.next` (P4).** `next build`
  (production) and `next dev` (development) both write `.next`, which Forge runs over the same
  bind-mounted directory — so a build-then-dev sequence left the dev server loading stale production
  chunks and 500ing every route (`Cannot find module './chunks/vendor-chunks/next.js'`), recoverable
  only by manually wiping `.next`. `RunDevServer` now detects a leftover **production** `.next` (by
  its build-only markers — `BUILD_ID` / `required-server-files.json` / `prerender-manifest.json`) and
  resets it before starting dev, so the build→dev order can never corrupt dev state. A dev-mode
  `.next` is left untouched (the cache stays warm); the reset is reported on `DevServerStarted`.
  Transparent to apps on the image bump — no app change or reprovision.
- **The C4 notification store is now safe under concurrent writes (P5).** Each mutation
  (`POST /notifications`, `/notifications/dismiss`, `/notifications/clear`) is a read-modify-write of
  the whole per-app list; that RMW was **not atomic**, so concurrent writes — even to different keys —
  lost updates (identical GETs returned different subsets). Mutations now run under a **per-app async
  mutex** so the RMW is serialized, and the store file is replaced **atomically** (temp + rename) so a
  concurrent reader never sees a half-written file. Concurrent `upsert`/`dismiss`/`clear` to distinct
  keys all persist. Contract unchanged; transparent on image bump.

## [0.9.0] — 2026-07-06

### Added
- **Platform capability C1 — Agent runtime (model access + Agent Task / Artifact resources).** A new
  `AgentRun` Capability + `model-anthropic` Implementation lets the running app invoke a model with a
  **system prompt + user input + an enforced output schema** and get back the **parsed structured
  result** — the platform absorbs the model SDK so apps don't carry one. Data-plane capability
  (`plane: 'data'`): served by the data-plane sidecar in prod and by the control plane in `forge dev`,
  the established app→Forge HTTP pattern.
  - `POST /capabilities/agent-run { app?, capability, system, input, schema, model?, max_tokens? }`
    → `{ capability: "AgentRun", resource: <AgentTask> }`. `capability` is a free-form **label/kind**
    (generic — no goal/planner domain concepts); `app` defaults to the sidecar's `FORGE_APP_NAME`, so
    the app usually needn't pass it. Structured output is enforced provider-natively via a forced
    tool whose `input_schema` is the caller's **JSON Schema**; the model's output is **untrusted** and
    returned (not acted on) so the consumer can post-validate it.
  - **Durable run records.** Every run — success *and* failure — is persisted as an inspectable
    **`AgentTask`** Resource (`id` = runId, `label`/kind, `status`, `model`, `artifact`, `error`,
    `created_at`); a successful run's result is a first-class **`Artifact`** Resource (the parsed
    result + the schema it conformed to), referenced by `AgentTask.artifact_id` and echoed inline on
    the run. Survives restart; observable via `forge inspect agent-runs --app <app>` and
    `/resources?type=AgentTask|Artifact`. Emits `AgentRunSucceeded` / `AgentRunFailed` /
    `ArtifactCreated` facts.
  - **Detectable absence → graceful degradation.** The model key is the C5 secret `ANTHROPIC_API_KEY`,
    resolved from Forge's encrypted vault (falling back to the runtime env). When it is
    absent/unconfigured, `agent-run` returns **`503 dependency_unavailable`** (a typed error, never an
    unhandled throw), so the consuming app can return 503 and never crash. Defaults to
    `claude-opus-4-8`; the caller may specify `model`. Implemented with native `fetch` (no new
    dependency) so both images stay slim.

## [0.8.0] — 2026-07-07

### Added
- **Platform capability C4 — Notifications.** A durable, per-app notification store the running app
  drives over HTTP (on **both** the control-plane API and the data-plane sidecar, like C3):
  - `POST /notifications { app?, key, title, body?, data?, subject? }` — upsert by stable `key`
    (idempotent; re-deriving the same condition updates in place and **preserves `dismissed` +
    `created_at`**, so a still-true dismissed notification never resurfaces).
  - `POST /notifications/dismiss { app?, key }` — dismissal **persists** (leaves the active feed but
    not `?include_dismissed=`).
  - `POST /notifications/clear { app?, key }` — remove one whose condition no longer applies.
  - `GET /notifications?app=&include_dismissed=` — the active feed, newest-first.

  The app owns WHICH conditions matter (derivation stays domain); Forge owns produce/track/dismiss/
  clear. A scheduled job (C2) can upsert while the user is away, so the inbox/badge is current before
  they open the app. Observable via `forge inspect notifications`.

## [0.7.0] — 2026-07-06

### Added
- **Platform capability C3 — Application event log.** A running app can now emit its own typed
  DOMAIN events and query them back as a per-app feed, via new routes on **both** the control-plane
  API (dev) and the data-plane sidecar (prod) — the first *app→Forge* direction:
  - `POST /app-events { app?, type, subject?, data? }` — best-effort emit (a failed emit must never
    break the mutation that triggered it).
  - `GET /app-events?app=&subject=&limit=` — the feed, newest-first, filterable by subject.
  - `GET /app-events/latest?app=` — latest event time per subject (the primitive cold-subject /
    "stale goal" detection needs).

  App events (`AppEvent`) are an open-`type`, subject-keyed, denormalized fact log kept in a per-app
  `app-events/<app_id>.jsonl` — deliberately separate from the platform's closed `ForgeEvent`
  catalog (facts about *Resources*). Observable via `forge inspect app-events --app <app>`. `app`
  defaults to the sidecar's `FORGE_APP_NAME`, so the app usually needn't pass it.

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

[Unreleased]: https://github.com/mardash-ai/forge/compare/v0.12.0...HEAD
[0.12.0]: https://github.com/mardash-ai/forge/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/mardash-ai/forge/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/mardash-ai/forge/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/mardash-ai/forge/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/mardash-ai/forge/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/mardash-ai/forge/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/mardash-ai/forge/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/mardash-ai/forge/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/mardash-ai/forge/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/mardash-ai/forge/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/mardash-ai/forge/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mardash-ai/forge/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mardash-ai/forge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mardash-ai/forge/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mardash-ai/forge/compare/defed64...v0.1.1
[0.1.0]: https://github.com/mardash-ai/forge/commit/defed64
