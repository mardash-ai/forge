# Changelog

All notable changes to the **Forge control plane** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Each released version maps to a published control-plane image tag
(`ghcr.io/mardash-ai/forge-control-plane:<version>`).

## [Unreleased]

## [0.26.2] — 2026-07-09

### Changed
- **P21 — the control-plane image build is now reproducible (installs from the committed lockfile).**
  The control-plane `Dockerfile` used to `COPY package.json` (only) and run `npm install`, which
  **ignores `package-lock.json`** — so every image build resolved dependencies **fresh** and could drift
  onto a different (newer, possibly broken) transitive version than the audited lockfile that source +
  CI test. That is the one and only structural *"works from source, fails in the built image"* gap
  (the reported P21 shape: `:0.26.1` container `Running` but its API never reachable at `:3717`, while
  the same code served fine from `tsx src/api/server.ts`). It now `COPY`s `package-lock.json` and runs
  `npm ci` (all deps — the control plane keeps its `tsx`/`tsc`/`vitest` toolchain; `|| npm install`
  fallback if the lock is ever momentarily out of sync), matching the data-plane image, so the image's
  dependency tree is **byte-identical to source**. NOTE: the exact not-serving symptom could **not** be
  reproduced from Forge alone — the published `:0.26.1` (amd64 + arm64), a HEAD build, a fresh lockless
  install, and `--omit=dev` all bind `:3717` and answer `/health` 200 on a clean host (incl. under
  128 MB / 0.25 CPU); this change removes the non-determinism that is the most likely real cause and the
  guards below turn the whole class into a failing check.

### Added
- **P21 guard (static) — `tests/runtime-deps.test.ts`.** Asserts every external package imported by
  `src/**` is declared in `dependencies` (not merely a `devDependency` or a transitive that the dev tree
  happens to have). This is the exact failure class it guards: a route that `import`s a package which is
  present in dev but **dropped by the slim `--omit=dev` data-plane image** would throw at import before
  the server could `.listen()`. Parsed with the TypeScript compiler, so specifiers that appear only
  inside string literals (e.g. the scaffold plugin's Next.js code templates) are correctly ignored.
- **P21 guard (runtime) — `tests/smoke/image-serves.sh` + the `image-smoke` CI job.** Builds the
  control-plane **and** data-plane images the way they actually ship and probes each container's
  in-container `/health`, asserting HTTP 200 — the check a source-only test can never make. Now runs on
  every PR / push to `main`, so *"the built image doesn't serve"* fails CI instead of a production host.

## [0.26.1] — 2026-07-09

### Fixed
- **P20 — `forge release` could not reach a healthy control-plane API (IPv4/IPv6 loopback mismatch).**
  The CLI runs in-container (the `./forge` wrapper `docker compose exec … src/cli/index.ts`) and dialed
  the co-located API by the name `localhost`. The API binds IPv4 `0.0.0.0`, but on the base image
  `localhost` resolves to IPv6 `::1` **first** (`getent hosts localhost` → `::1  localhost …`), and Node 22
  keeps DNS results in resolver order by default. So `fetch('http://localhost:3717')` dialed `[::1]:3717`,
  which the IPv4-only server refuses (ECONNREFUSED); Happy-Eyeballs' IPv4 fallback did not fire within the
  release fetch's window, so `forge release` reported `Cannot reach Forge API at http://localhost:3717 …`
  even though the API was up. The CLI now dials the **IPv4 loopback literal `127.0.0.1`** for the local
  control plane — both the code default (`src/cli/api-base.ts` → `resolveApiBaseUrl`) and the `./forge`
  wrapper's `FORGE_API_URL` / boot-probe — matching the `0.0.0.0` bind with no `::1` detour and no reliance
  on fallback. The server bind is unchanged (IPv4 `0.0.0.0`); `127.0.0.1` + `0.0.0.0` is the clean,
  guaranteed-matching pair. Regression origin: the client host has been `localhost` since the first commit
  — nothing in Forge code changed it between 0.23.0 and 0.24.1; the regression was environmental (base-image
  loopback ordering under Node's `verbatim` DNS), which the literal-IPv4 dial removes the dependency on.

## [0.26.0] — 2026-07-09

### Added
- **C20 — File / blob storage.** A generic, per-app, owner-scoped blob store. An app uploads a user's
  file (avatar, attachment, export, …), gets back an opaque `blob_id`, and later streams the bytes back —
  reached server-side the same way the app reaches the C3 app-event log / C4 notifications / C19 search
  (base URL via `FORGE_EVENTS_URL`; the `app` field defaults to the sidecar's `FORGE_APP_NAME`). The
  endpoints are **data-plane**, registered on BOTH the control-plane API (dev) and the data-plane sidecar
  (prod), like app-events/notifications/search:
  - `POST /blobs` — **app-proxied multipart upload** (`multipart/form-data`: a `file` part + fields
    `{ app?, owner (required), content_type, filename?, attrs? }`) → `201 { blob_id, content_type, size,
    checksum (sha256), filename?, created_at }`. The upload is **streamed** (never buffered whole) through
    an incremental hash + size counter into a durable temp file.
  - `GET /blobs/:id?owner=<userId>` — streams the bytes with `Content-Type`, `Content-Length`, an
    `ETag` (the sha256), `Cache-Control`, and `Accept-Ranges`; supports a single **Range** request (206 /
    416) and conditional `If-None-Match` (304).
  - `DELETE /blobs/:id?owner=` — owner-scoped, removes bytes + metadata; **204** on success, **404** if
    absent/already-gone/not-owner (idempotent by effect).
  - `GET /blobs?owner=` — the owner's blobs (newest-first) + a `usage` readout `{ bytes, count,
    quota_bytes, quota_objects }`.
- **Owner-scoping is structural (mandatory).** Every blob is stamped with `owner` on upload; the metadata
  store is keyed by `(owner, blob_id)`, so a `get`/`delete`/`list` for one owner can only ever name records
  in that owner's slice — a blob owned by someone else is therefore **404, absent, never 403** (the
  "absent not forbidden" rule). The consuming app fronts these with its own auth-checked route; Forge
  enforces owner on the raw GET/DELETE as defense-in-depth. Trust model is app-asserted (the private
  data-plane trusts the verified `owner` the app sends, exactly as C3/C4/C1/C19 do); no per-user token
  scheme.
- **Content allowlist + magic-byte sniffing (security).** Only allowlisted types are accepted
  (`image/png` · `image/jpeg` · `image/webp` · `image/gif` · `application/pdf` · `text/plain` ·
  `text/markdown`, configurable via `FORGE_BLOB_ALLOWED_TYPES`); the declared `content_type` is validated
  against the actual leading bytes, so a spoofed header (declaring `image/png` while sending a PDF, or
  `text/plain` while sending a PNG) is rejected **415**, not stored.
- **Per-file + per-owner limits.** Configurable max file size (`FORGE_BLOB_MAX_BYTES`, default **15 MB**)
  and per-owner quota (`FORGE_BLOB_QUOTA_BYTES`, default **500 MB**, and `FORGE_BLOB_QUOTA_OBJECTS`,
  default **1000**). **Upload is NOT best-effort** (the app needs the `blob_id`), so it surfaces real
  errors: file too large → **413**; disallowed type / magic-byte mismatch → **415**; owner byte quota →
  **413**; owner object quota → **409**; missing owner → **422**; client abort mid-stream → **400** with
  **nothing persisted**; disk-full/IO → **507/503**; not-found/not-owner → **404**.
- **Durable, atomic backend — no new dependency.** Metadata is one JSON doc per app (a keyed map,
  atomic temp-and-rename, per-app mutex) and the bytes are one opaque file per blob, both on the SAME
  durable state volume the data-plane already uses (`FORGE_STATE_DIR`, e.g. `/forge-state` on the
  `forge_state` named volume) — so uploads survive a redeploy like C10 auth / C5 secrets. Writes are
  atomic: a fully-streamed temp file is quota-checked and only then moved into place + recorded (or fully
  cleaned up), so a failed or aborted upload never orphans bytes. An object store (S3/MinIO) is a
  documented scale-out swap behind the SAME API — the app only ever sees the `blob_id`. The optional
  presigned-URL / signed-URL direct paths are documented generic alternatives; C20 ships the multipart
  proxy + owner-scoped serve first.

### Changed
- The control-plane API and the data-plane sidecar both register the C20 blob routes (via
  `@fastify/multipart`), alongside app-events/notifications/search.

### Added
- **C19 — Search / indexing.** A generic, per-app, owner-scoped full-text search capability. An app
  indexes its own resources and queries them back over the internal network, reached server-side the
  same way the app reaches the C3 app-event log + C4 notifications (base URL via `FORGE_EVENTS_URL`;
  the `app` field defaults to the sidecar's `FORGE_APP_NAME`). Four **data-plane** endpoints,
  registered on BOTH the control-plane API (dev) and the data-plane sidecar (prod), like
  app-events/notifications:
  - `POST /index` — upsert one indexable document, **idempotent by `(owner, type, id)`** (re-indexing
    updates in place, exactly the C4 upsert-by-key pattern). Best-effort: the app calls it alongside
    its mutations and fire-and-forgets.
  - `POST /index/delete` — remove one document by `{owner, type, id}` (idempotent).
  - `POST /reindex` — bulk-upsert an array (backfill / cutover reconciliation).
  - `POST /search` — `{ owner, q, types?, limit?, offset?, date_from?, date_to? }` →
    `{ hits: [{ type, id, title, snippet, score, attrs?, created_at? }], total, took_ms }`.
- **Type-agnostic indexable document** `{ owner (required), type, id, title, body?, tags?, attrs?,
  created_at?, updated_at? }` — the app's resource kinds (goal/task/note/…) are just `type` values, so
  one index serves everything the app owns. `attrs` is a small denormalized bag round-tripped verbatim
  on every hit so the app can render a result without a second lookup.
- **Owner-scoping is structural (mandatory).** Every write is stamped with (and keyed by) `owner`, and
  every search filters to `owner` **before** ranking — a `/search` is implicitly `WHERE owner =
  <caller>` and can never return another owner's document; two owners may hold the same `(type, id)` as
  distinct records. Trust model is app-asserted (the private data-plane trusts the verified `owner` the
  app sends, exactly as C3/C4/C1 do). The document shape + `/search` are designed so a future
  `mode: 'semantic' | 'hybrid'` (vector/RAG search) extends cleanly; **semantic search is out of C19
  scope.**
- **BM25(F)-lite ranking** over a self-contained inverted view built per query (no Postgres dependency
  — Forge's own data-plane state is file-backed, so C19 ships in the slim data-plane image like the
  C3/C4/C15 stores). `title` is weighted above `body` (a title match outranks a body-only match),
  tokens are case-folded and lightly stemmed, the snippet is a highlighted excerpt with matched terms
  wrapped in HTML `<mark>…</mark>` (surrounding doc text HTML-escaped), and the tie-break is
  deterministic (`updated_at` desc, then `id`).
- **Failure modes.** Index writes are best-effort (non-fatal; `/reindex` is the backstop); a
  user-invoked `/search` degrades on an internal store failure to a **503 `search_unavailable`** the
  app can soft-handle (empty results), **never a 500**; an empty `q` → **400**; pagination past the end
  → empty hits (a 200, not an error); `limit` is clamped server-side to `[1, 100]` (default 20).

## [0.24.1] — 2026-07-09

### Fixed
- **P19 — `forge release` failed at ASSESS on a deploy host whose control-plane store was never
  populated by `forge init app`.** Symptom, deterministic on the box: `forge release --app forge-os
  --host forge-os.mardash.ai …` aborted with `not_found: No Application named "forge-os". Run: forge
  init app --name forge-os` — even though the **same app deployed fine via `forge deploy`** on that
  same host, and `forge release --dry-run` planned all five phases on a *local* control plane where
  the store **did** have the app.
  - **Root cause: the release path's app lookup was STRICTER than the `forge deploy` it composes.**
    `forge deploy` resolves the target **leniently** — a store-registered `Application` is optional;
    it infers the app from the single-app layout + the committed `app/forge.app.json` (name, host,
    current `web_image` pin), so a prod host that only ever ran `forge deploy`/`forge productionize`
    (never `forge init app`) deploys fine with an empty store. `forge release`, by contrast, resolved
    the app with the strict `resolveApp` (a store `Application` lookup by name that throws
    `not_found`) — so it broke exactly where the store lacked the registration. The strictness was
    **not** unique to assess: the `productionize` (repin) and `verify` (post-deploy gate) capabilities
    that `release` composes used the same strict lookup, so a real (non-dry-run) release of a new
    commit would also have failed at repin/verify on that host, not only at assess.
  - **Fix — the deploy-time capabilities now share one lenient resolver, so they can't drift apart.**
    A new `resolveAppLenient` in `capabilities/_shared.ts` resolves a store `Application` when present
    (its id still links Resources/Events) and otherwise infers the app from the single-app layout +
    `app/forge.app.json` — the SAME repo `forge deploy` operates on. `release` (assess), `productionize`
    (repin), and `verify` (the gate) all resolve through it now; a store record's **absence is no
    longer fatal** when `forge.app.json` resolves the app, so none of them require a box-side `forge
    init app`. `forge deploy` itself is unchanged (already lenient; it needs no repo path). If NEITHER
    a store record NOR a usable `app/forge.app.json` resolves the app, it still fails clearly with a
    `not_found` that names the fix. Everything else about `forge release` — the 5 phases, the fail-safe
    abort, the idempotent resume — is intact.
  - **Verified.** New hermetic regression tests (`tests/release-app-resolution.test.ts`) lock the box
    condition: `resolveAppLenient` resolves from `app/forge.app.json` with an empty store (previously
    `not_found`), a store record still wins, and a truly-unresolvable app still fails 404. Driven
    end-to-end in-process: with **0** registered Applications, the real `release` capability
    `--dry-run` for a `forge.app.json`-only app now **succeeds at assess** and plans all five phases
    (assess → publish → repin → deploy → verify), recovering the host + current pin from the manifest.

## [0.24.0] — 2026-07-09

### Added
- **Status page Phase 3 (C15) — operator-declared INCIDENTS on top of the public `/status`
  page.** Phases 1+2 aggregate live C6 health into a banner + per-component rows and an opt-in
  uptime timeline; Phase 3 lets an operator DECLARE an incident the probes can't see (a partner
  API down, a data issue, maintenance) with a status, an impact, affected components, and an
  ordered timeline of updates. Incidents are a separate FACT from measured health: they colour
  the LIVE banner but never rewrite the sampled uptime history.
  - **Operator CLI (control-plane).** A new `forge status incident …` family:
    - `create --app --title --status <investigating|identified|monitoring|resolved> --impact <none|minor|major|critical> [--component <key> …] [--body <text>]` → the created incident.
    - `update --app --incident <id> --status <…> [--body <text>]` — append an update, moving status.
    - `resolve --app --incident <id> [--body <text>]` — force `status:resolved`, stamp `resolved_at`, append a final update.
    - `list --app` — active (newest-first) then recent-resolved.
    These hit the incident routes (`POST /status/incidents`, `/status/incidents/update`,
    `/status/incidents/resolve`, `GET /status/incidents`), registered on BOTH planes (dev control
    plane + prod data-plane sidecar), like the other status/notification routes.
  - **Public rendering (data-plane, no auth — same as `/status`).** `/status` renders an **Active
    Incidents** section (title, current-status pill, impact, affected components, and the update
    timeline newest-first) above the component rows while anything is unresolved, plus a
    resolved-incident **Past incidents** disclosure — all themed through the existing C16
    `--forge-*` tokens (no new theming path). `/status.json` gains an additive **`incidents`**
    array (`id, title, status, impact, affected_components, updates[], created_at, resolved_at`),
    active then recent-resolved.
  - **Banner precedence (documented).** The live `overall` is `max(measured health, incident
    floor)` on the `operational < degraded < partial_outage < major_outage` ladder — an
    operator-declared outage can only make the banner WORSE, never better. Only UNRESOLVED
    incidents contribute: `critical → major_outage`, `major → partial_outage`, `minor → degraded`,
    `none → no floor`. So an unresolved critical forces at least **Major Outage** even when every
    probe is green; resolving it lets the banner recover.
  - **Bounded per-app store.** Incidents persist to a per-app JSON doc under the state dir
    (`/forge-state/incidents/<appId>.json`), OUT of the generic `/resources` API — like the C2
    uptime + C4 notification stores. Every write serializes under a per-app async mutex and
    replaces the file atomically (temp + rename); retention keeps all active incidents plus a
    bounded resolved-history (most-recent 50, resolved within 90 days), pruned on every write.
  - **Events.** Emits `IncidentOpened` / `IncidentUpdated` / `IncidentResolved` platform facts
    (carrying only the incident id/title/status/impact — no PII).
  - **Backward compatible.** An app that has declared NO incidents renders `/status` **byte-for-
    byte** the Phase-2 page (the incident section + its `<style>` are emitted only when an incident
    exists), and `/status.json`'s existing `overall`/`components`/`uptime` fields are unchanged
    (the `incidents` array is additive). Subscriptions/notification of subscribers are explicitly
    **out of scope** for this phase (deferred to a separate delivery-channels capability).

## [0.23.0] — 2026-07-09

### Added
- **`forge release` (C18) — one command runs the ENTIRE production deploy pipeline, end-to-end,
  idempotently and fail-safe.** The capstone over Deploy (C7), Productionize/repin (C8), and
  Verify (C14): given a committed app it goes to *deployed + verified* without a human or an
  agent hand-orchestrating the ~10 steps. Phases, in order: **assess** (resolve the commit +
  the target image ref `ghcr.io/<owner>/<app>-app:sha-<commit>`, probe whether it is already
  published, read the current pin + host) → **publish** (ensure the commit's web image is in
  GHCR and resolve its digest) → **repin** (`forge productionize --web-image <ref>@sha256:…`,
  keeping the data-plane pin) → **deploy** (the C7 start-first roll + the P14 drift gate) →
  **verify** (the C14 post-deploy contract smoke — the final gate). It **reuses** those
  capabilities' code paths in-process; it reimplements none of them.
  - **Idempotent + resumable.** A re-run after a partial/interrupted release **assesses current
    state** and continues from the first unfinished phase: publish is skipped when the commit's
    digest already resolves, repin when the compose is already pinned to that digest, deploy when
    the running web container is already on the target image (compared by local image id, the
    same identity the drift gate uses). A fully-landed release re-run is a **no-op** — only the
    read-only verify re-confirms. (Built for the failure the manual flow hit: it died twice on
    transient GHCR API errors mid-roll and had to be recovered by hand; `forge release` self-
    recovers — the CI-mode publish poll retries through transient errors + not-found until a
    configurable timeout.)
  - **Fail-safe.** ANY phase failing (CI never publishes → timeout, a digest mismatch, the P14
    drift gate catching a stale image, a non-zero `forge verify`) **aborts with a precise,
    actionable error and leaves prod on the last-good version** — no later phase runs, so a
    deploy is never half-applied. Exits non-zero on failure. Non-destructive: it recreates
    containers but never touches volumes/DB.
  - **Observable.** Prints each phase with progress; `--json` for a machine-readable Release
    resource; `--dry-run` shows the plan (which phases would run vs. skip) mutating nothing; a
    configurable GHCR poll `--timeout` / `--poll-interval`. `--publish-mode ci` (default) waits
    for the app's publish workflow; `--publish-mode build` cross-builds + pushes a multi-arch
    image itself. A `Release` Resource records the ordered per-phase outcome and links the
    Deployment (C7) + Verification (C14) it produced; `ReleaseStarted` / `ReleaseCompleted` /
    `ReleaseFailed` events are emitted.
  - The control-plane image now carries **git** (resolve the app's HEAD commit + GHCR owner) and
    the **Buildx** plugin (resolve an image's registry digest via `docker buildx imagetools
    inspect`; cross-build in `--publish-mode build`).

## [0.22.0] — 2026-07-08

### Fixed
- **A production deploy could silently log every signed-in user out.** Reported symptom: after
  `forge deploy`, active users had to sign in again. Diagnosed to the auth/session/`forge_refresh`
  store on the data-plane sidecar + the productionize-generated `compose.prod.yaml`.
  - **The store itself is already durable — that half was a red herring.** C10's users, sessions,
    and `forge_refresh` records live at `/forge-state/auth/<appId>.json`, and the generator has
    (since C8) mounted the data-plane's whole state dir (`FORGE_STATE_DIR=/forge-state`) on the
    **durable named volume `forge_state`**. `forge deploy` recreates the sidecar onto its new pin,
    and a named volume **persists across that container recreate** — so a valid session/refresh
    survives a deploy. Reproduced end-to-end: create a session → `docker compose up -d
    --force-recreate data-plane` → `GET /auth/session` **200** and `POST /auth/refresh` **200**
    (still authenticated). The negative control (same sidecar with the store on the container's
    ephemeral fs, no volume) reproduced the exact symptom: **401 / 401** — every session + refresh
    token wiped. The C5 secrets vault (`/forge-state/secrets`, including its master key) rides the
    same volume, so it does not regenerate across a recreate either.
  - **Root cause (the remaining silent-logout surface): the session-signing secret defaulted to
    empty.** The generator injected every declared secret — including `AUTH_SESSION_SECRET`, the
    HS256 key that BOTH signs (data-plane) AND verifies (app middleware) the `forge_session` access
    token — as `${NAME:-}` (defined-but-**empty** when unset). If that required key was ever unset
    or emptied in `.env.prod` (a typo, a dropped var), the whole stack silently came up with an
    **empty** signing key: the data-plane could neither mint nor verify a session, so every user was
    logged out — while `docker compose config` and the deploy still reported **success**. An empty
    signing secret is the "silently rotate to nothing" footgun, not a durability problem.
  - **Fix — a missing required auth secret now FAILS THE DEPLOY LOUDLY, never silently empties.**
    `AUTH_SESSION_SECRET` is now emitted as `${AUTH_SESSION_SECRET:?…}` in **both** the web and
    data-plane services — the exact fail-loud shape `POSTGRES_PASSWORD` already uses — so a
    missing/empty value aborts `docker compose config` (the step the C7 roll runs) with a clear
    message (`… logs every signed-in user out on deploy`) **before** any replica starts, instead of
    shipping a stack that logs everyone out. A stable, operator-set value (the normal case)
    interpolates fine and — with the durable `forge_state` store — keeps sessions alive across the
    deploy. Verified: `docker compose config` now exits non-zero + names the fix when
    `AUTH_SESSION_SECRET` is unset, and exits 0 when it is set.

### Changed
- **Productionize secret injection is catalog-driven and distinguishes *deploy-required* from
  *optional* secrets.** The C13 secret catalog gains a `deploy_required_reason`, and a new
  `secretInterpolation(name)` helper picks the compose interpolation per secret: a deploy-required
  secret (currently only `AUTH_SESSION_SECRET`) renders fail-loud `${NAME:?reason}`; every other
  secret keeps the defined-but-empty `${NAME:-}` so it still degrades detectably (real values come
  from `.env.prod`, never the compose file). The optional sign-in **alternatives** — `GOOGLE_*`,
  `SMTP_URL`, `EMAIL_FROM` — stay `${NAME:-}` on purpose: their absence disables one method, it does
  not log anyone out. New regression tests lock (a) `AUTH_SESSION_SECRET` fail-loud in both tiers,
  (b) the optional alternatives staying non-fatal, and (c) the deploy-survival guard that the
  auth/session/refresh store is mounted on the durable named `forge_state` volume (so an ephemeral
  regression can't silently return). No app re-scaffold needed; adopt by re-running
  `forge productionize` (regenerates `compose.prod.yaml`) then `forge deploy`.

## [0.21.1] — 2026-07-08

### Fixed
- **P16 — `forge deploy` aborted on a relative `--env-file`, breaking `make deploy`.** An operator
  running `forge deploy --app <app> --env-file app/.env.prod` (a relative path, as `make deploy`
  passes) failed immediately with `node: app/.env.prod: not found` (exit 9), **before any rollout** —
  never reaching the P14 drift gate.
  - **Root cause (the CLI launch, not the deploy path).** The `forge` wrapper ran the CLI as
    `tsx src/cli/index.ts "$@"`. `tsx` hoists **any** node CLI flag it finds in argv — even one that
    appears *after* the script — into the underlying `node` process. `--env-file` **is** such a node
    flag, so node consumed the operator's `--env-file app/.env.prod`, resolved it against the
    control-plane container's **process CWD (`/forge`)** — which holds no app files — and aborted at
    startup, so forge's own parser (which resolves against **`FORGE_WORKSPACE`**, where Compose runs)
    never ran. `--compose-file` was unaffected (it is not a node flag). This is a launch-layer trap,
    **not** the 0.19.0 P14 refactor: the deploy/rollout path code is byte-identical to 0.18.0.
  - **Fix.** The `forge` wrapper now launches the CLI as `tsx -- src/cli/index.ts "$@"`. The `--`
    tells `tsx` that everything after is the script + its args, so operator flags reach forge's own
    parser and a relative `--env-file`/`--compose-file` resolves under `FORGE_WORKSPACE` (never CWD).
    Absolute paths still pass through unchanged.
  - **Hardening.** The Deploy capability's env-file existence probe now uses `path.resolve(workspace,
    arg)` instead of `path.join`, so an **absolute** `--env-file` is no longer mis-joined under the
    workspace (which would have silently dropped a valid absolute env-file); relative args still
    resolve under `FORGE_WORKSPACE`.
  - **P14 drift gate intact.** No rollout/drift logic changed — a deploy now finds the env/compose
    files, runs the start-first roll, and reaches the running-vs-pinned drift gate (recreate-on-pin
    change + fail-loud-on-drift) exactly as before. New regression tests lock both the CLI launch
    (a relative `--env-file` reaches forge instead of aborting node) and the workspace-relative /
    absolute-passthrough path math; the existing deploy-rollout + drift tests stay green.

## [0.21.0] — 2026-07-08

### Added
- **C15 Phase 2 — uptime history on the status page.** The public `/status` dashboard grows a
  Statuspage-style **per-component uptime timeline** (a per-day bar + windowed uptime %), backed by a
  periodic health **sampler** and a durable, **bounded** snapshot store. Phase 1 (the live banner +
  component rows) is unchanged; history is **opt-in** and additive.
  - **Sampling (C2).** A platform-internal periodic probe run by the **scheduler-node** Implementation
    (the same always-on, non-overlapping, unref'd ticker as the job scheduler — NOT an app-callback
    `ScheduledJob`). Each tick it does a **cheap, read-only GET** to every app's C6 health and records
    a `HealthSnapshot` (overall + per-component state at that instant), **reusing the same `probeHealth`
    + `computeStatus` core** the live page uses — one health definition, no writes to the app.
    **Opt-in + safe by default:** runs only when **`FORGE_STATUS_SAMPLE`** is truthy on the plane;
    cadence is **`FORGE_STATUS_SAMPLE_INTERVAL`** (e.g. `1m`, `5m`; default **5m**, floored at 30s).
    When off, `startHealthSampler` is a no-op and every app still gets the exact Phase-1 page.
  - **Durable store + retention/rollup (bounded storage).** A per-app store under the state dir keeps
    **raw** snapshots for a short window (default **2 days**) so today/yesterday are exact, **rolls up**
    completed days to per-day counts kept for a long window (default **90 days**), and prunes both on
    every write — so storage stays bounded no matter how long sampling runs. Kept out of the generic
    Resource store (like the C3 app-event log / C4 notifications), so it never bloats `/resources`.
  - **Page + JSON.** `/status` renders each **live** component's per-day bar (themed via the C16
    `--forge-color-success/warning/danger` tokens, muted for no-data days; responsive) plus its uptime %.
    `/status.json` gains an **additive** `uptime` section: `{ window_days, sampling, overall_uptime_pct,
    components:[{ name, uptime_pct, days:[{ date, state, uptime_pct }] }] }`. **No breaking change** to
    the Phase-1 `/status.json` shape (`overall`/`banner`/`components`/`checked_at` are untouched); an app
    with no history reads `sampling:false` + empty components ("collecting…").
  - **Out of scope (Phase 3, not built):** incident management + subscriptions (not stubbed).

### Changed
- The status aggregation (`computeStatus` + the status type unions) moved from `src/api/status-routes.ts`
  to a pure **`src/shared/status.ts`**, shared by the status route and the new health sampler so there is
  a single definition of "what the app's health says." Re-exported from `status-routes.ts` — no importer
  change. `src/shared/health-probe.ts` (the C6/C14/C15 probe core) is untouched.

## [0.20.0] — 2026-07-08

### Added
- **C14 — `forge verify`: a generic post-deploy contract smoke for deployed apps.** One read-only
  command asserts that a deployed forge app actually honors the platform contracts it adopted, against
  its public host, and **exits non-zero on any failed assertion** (the CI post-deploy gate). It is the
  platform lift of an app-local smoke suite: the app declares which of its own paths/methods to probe;
  the platform owns the contract assertions, so **forge-starter inherits post-deploy smoke for free**.
  - **Command:** `forge verify --app <app> --host <host>` (host may be a bare `app.example.com` — https
    is assumed — or a full URL). Flags: `--page-path` (default `/`), `--health-path` (default
    `/api/health`), `--api-path <path>` (repeatable), `--cron-path <path>`, `--expect google,email,password-signup`
    (or `--expect-google` / `--expect-email` / `--expect-password-signup`), `--check-refresh`,
    `--timeout-ms`. Human-readable pass/fail report by default; `--json` emits the machine-readable
    `Verification` resource.
  - **Assertions (read-only; a fresh request each; redirects not followed):** (1) **C6 health** — `GET
    /api/health` is 200, **public** (not behind an auth redirect/401), and matches the standard schema;
    (2) **C10 page gate** — an unauthenticated page 302-redirects to `/auth/login?next=…`; (3) **C10 API
    gate** — each `--api-path` is 401 unauthenticated (skipped-with-note if none given, never guessing
    app routes); (4) **C10 service gate** — `--cron-path` is **403** (not 401) with no service token
    (optional); (5) **C10 `/auth/config`** — 200 + the `{methods,configured}` shape, and any declared
    `--expect` methods are enabled; (6) optional **`/auth/refresh`** — a cookie-less POST is 401.
  - **Shares the C15/C6 logic, not a duplicate.** The health assertion reuses the same `probeHealth` +
    C6 schema recognizer the C15 status page uses (`src/shared/health-probe.ts` + `src/shared/health.ts`).
    `probeHealth` is refactored onto a new generic never-throws `httpProbe` primitive (with redirect
    control) that all the contract checks build on; `forge inspect health` + `/status` output are
    unchanged. New `src/shared/contract-checks.ts` holds the parameterized assertions.
  - **Domain:** new **Verify** Capability (`plane: 'both'` — usable from CI against the control plane and
    from the data plane), a **Verification** Resource (durable record: host, `passed`, per-assertion
    outcomes — status codes only, never a body or credential), and a **VerificationCompleted** Event.
    Non-destructive: GET-only (plus the optional cookie-less refresh POST); never writes, never needs
    credentials.

## [0.19.0] — 2026-07-08

### Fixed
- **C16 theming — a pinned `mode` now makes `colors{}` the WHOLE palette (neutral surfaces included).**
  Found adopting the theme during the forge-os prod cutover: with `mode:'dark'`, the **brand** colors from
  `colors{}` carried into dark but the **neutral surfaces** (`background`/`surface`/`text`/`textMuted`/`border`)
  reverted to the platform dark defaults unless the app *also* mirrored them into a redundant `dark{}` block
  (so `colors.background:#16120e` + `mode:'dark'` rendered on the platform's `#0b0f19`). Now a **pinned mode
  is self-contained:** `mode:'dark'` (and `mode:'light'`) treats the base `colors{}` — merged over that mode's
  default for any unset field — as the **entire palette for the mode, surfaces and all**, so no `dark{}` is
  needed. `mode:'auto'` is **unchanged** (there `colors{}` is the light palette and `dark{}` supplies the dark
  overrides — the only mode where `dark{}` is meaningful). **Regression-safe:** a theme that sets `colors{}`
  **and** a matching `dark{}` (the previous forge-os shape) renders **identically**. Schema comments + the
  generated starter theme now say it plainly: *`colors{}` is your palette for the chosen `mode`; add a `dark{}`
  block only for `mode:auto`.*
- **P14 — `forge deploy` no longer silently runs a stale image.** The image pull was quietly non-fatal, so a
  failed pull (e.g. a locked Docker keychain over non-interactive SSH) left the already-cached **old**
  container running while deploy reported **success** — "requested pin X, running Y" drift with no warning
  (it cost two no-op prod deploys). Deploy now:
  - **Verifies against the pins (drift gate).** After the reconcile + roll it compares each digest-pinned
    service's **running** image against the image its **compose pin** resolves to; on any mismatch it **fails
    loudly** (non-zero) naming the service + `running <Y>` vs `pinned <X>` and why (e.g. the pull failed — is
    the registry authenticated?), instead of reporting success.
  - **Recreates on a pin change.** A reconciled digest-pinned sidecar (the data-plane) left on a stale image by
    the `restart: unless-stopped` + only-image-changed trap is **force-recreated onto its pin**; the public web
    tier keeps its start-first, zero-downtime roll.
  - **Surfaces pull failures.** A failed pull is no longer swallowed — it is reported and, when it caused any
    drift, blocks the success report.
  Fixed for **every** consumer + forge-starter — no deploy needs hand-forcing.

### Changed
- **`make up` now `--force-recreate`s the control-plane container** — the P14 sibling trap: a container under
  `restart: unless-stopped` is not swapped by `compose up` when only its image changed (a rebuilt / re-pinned
  `FORGE_IMAGE`), silently keeping the old one. `make up` now always lands the freshly built/pinned image
  instead of leaving `forge productionize`/commands running on a stale one.

## [0.18.0] — 2026-07-08

### Added
- **C16 — app theming for platform-served UI: one declarative contract brands every hosted page.**
  A single `forge.theme.json` at the app repo root now brands **all** platform-served UI the app
  leverages — the C10 hosted auth pages, the new C15 status page, and any future UI capability — from
  **one token set**, not per-capability knobs.
  - **Schema** (`src/shared/theme.ts`, pure/testable): app display `name`, `logo`, `favicon`, `mode`
    (`auto`|`light`|`dark`), `font`, `radius`, a full `colors` palette (primary + auto-derived
    contrast, accent, background, surface, text, textMuted, border, success, warning, danger), an
    optional `dark` override block, and a sandboxed `custom_css` / `custom_css_path` escape hatch.
    Every declared value is sanitized (colors/font/size against allowlists; asset URLs against a
    scheme allowlist — no `javascript:`) so a theme value can never break out of the page `<style>`.
  - **Token set:** pages render from CSS custom properties (`--forge-color-primary`, `--forge-font`,
    `--forge-radius`, …) — the **same** properties across every UI capability, so theming once themes
    auth + status together. Light/dark switch at the token level (`mode:auto` emits a light `:root`
    plus a dark `@media` override).
  - **Serving:** a new **`GET /theme.css`** (both planes, public) serves the token set + sandboxed
    custom CSS as a linkable/cacheable stylesheet; the auth + status pages ALSO inline the same tokens
    so they render with no flash-of-unthemed-content and no extra round trip.
  - **Escape hatch:** an optional custom CSS (inline or file) is injected as a trailing `<style>`,
    sandboxed CSS-only — HTML/script breakout, `@import`, `expression()`, IE `behavior`, and
    non-https/data `url()` are all stripped.
  - **Neutral default:** an app that declares no theme gets a clean, professional default look.
  - **`forge productionize` scaffolds + carries it:** a neutral starter `forge.theme.json` is written
    once (never clobbered), mounted read-only into the data-plane sidecar, and pinned via
    `FORGE_THEME_FILE`, so the hosted pages render branded in production.
- **C15 — public status page (Phase 1): a per-app, themed health dashboard.**
  A **public, no-auth** `GET /status` (+ `GET /status.json`) served by the platform on both planes
  (like `/auth/*`; the app proxies it same-origin — no app page code). It aggregates the app's **live
  C6 health** into a Statuspage-style **overall banner** (*All Systems Operational / Degraded
  Performance / Partial Outage / Major Outage*) plus **per-component rows** (the web tier, each C6
  check, and the serving platform plane). Rendered through the C16 theme — responsive, light/dark,
  brandable. Uptime history, incident management, and subscriptions (Phase 2/3) are explicitly
  deferred.

### Changed
- **C10 hosted auth pages are now theme-driven.** Login / signup / verify / reset / logout and the
  interstitial pages render from the C16 `--forge-*` tokens (brand color, surface, text, radius,
  font, status colors) with the app's logo, display name (in the `<title>`), favicon, and custom-CSS
  override applied. No behavior change to auth — purely presentational.
- **`forge productionize` now wires the app-callback env into the data-plane sidecar**
  (`FORGE_APP_CALLBACK_HOST=web`, `FORGE_APP_CALLBACK_PORT`, `FORGE_READINESS_PATH`), so the C15
  status page can probe the app's C6 health over the internal network in production (this is also the
  documented config the C2 scheduler's prod callback expects).
- **Refactor:** the live C6 health probe (`resolveAppBase` + fetch/parse) is extracted to
  `src/shared/health-probe.ts` and shared by `forge inspect health` and the C15 status page — one
  definition of "where the app is" and "what its health says." `forge inspect health` output is
  unchanged.

## [0.17.0] — 2026-07-07

### Added
- **C13 — the operator provisioning contract: an operator can now tell what they must provision.**
  Driven by a real report — prod `/auth/signup` showed *no form* and *"Email/password sign-up is
  unavailable"* because **both** SMTP (C12) and Google OAuth (C10) were unset, so there was **no
  working sign-in method** — and nothing told the operator what `GOOGLE_CLIENT_ID` / `SMTP_URL` / … are,
  which capability needs them, or how to set them. This fixes the class:
  - **A canonical secret catalog** (`src/plugins/productionize-nextjs-compose/secret-catalog.ts`) — the
    single source of truth describing every provisioning value (capability, required-vs-optional, what
    it is, external setup, how to generate, how to set). Both the human guide and the generated
    per-app artifacts derive from it, so they can't drift.
  - **`forge productionize` now emits a per-app operator runbook** — a generated **`PROVISIONING.md`**
    in the app repo listing exactly the secrets **that** app needs (its subset of the matrix), each
    explained, with the exact dev (`forge secrets set`) and prod (`.env.prod` + `forge deploy`)
    commands. Generated from the app's declared capabilities → convergent/idempotent, inherited like
    `compose.prod.yaml`. When the app uses C10 auth but has **neither** Google nor SMTP declared, the
    runbook spells out the unblock (the exact Google redirect URI `https://<host>/auth/google/callback`
    and a `provision → productionize → deploy` snippet naming the missing secrets).
  - **The generated `.env.prod.example` is now annotated** — each secret is preceded by a `#` comment
    (what it is · which capability · required/optional · how to obtain · how to generate) instead of a
    bare `NAME=`.
  - **An authoritative `PROVISIONING.md` at the forge repo root** — the operator guide: how to bring up
    the control plane and a data-plane sidecar, how secrets reach the runtime (C5 vault vs `.env.prod`),
    the full per-capability secret/token matrix, and an explicit "no sign-in method ⇒ no signup path"
    section (Google unblocks sign-in with no email dependency; SMTP unblocks email/password
    signup+verify+reset). `AUTH_SESSION_SECRET` is required for either to function; `GET /auth/config`
    reports what's enabled.

### Changed
- **No regression to existing productionize output.** The Dockerfile / `compose.prod.yaml` / next-config
  generation is unchanged; `.env.prod.example` gains explanatory comments (same variable lines) and a new
  `PROVISIONING.md` is added to the emitted file set (and to the generated `.dockerignore`).

## [0.16.0] — 2026-07-07

### Added
- **P8 — logout/revocation is now real: short-lived access token + a revocable, rotating refresh
  token.** Before this, the app's gate verified the long-lived (`~30d`) `forge_session` cookie
  **locally with no round-trip**, so a **replayed** cookie still passed the gate after
  logout/reset/leak until its far-off `exp`. C10 now issues **two** cookies:
  - **`forge_session` (access)** — the **same** HS256-JWS shape/verification an app already mirrors
    (`{ userId, email, sessionId, iat, exp }`, signed with `AUTH_SESSION_SECRET`, verified locally with
    no round-trip), but its JWS **`exp` is short (~15m)**. That short window is what now bounds exposure
    after a revocation. The cookie's `Max-Age` is the session lifetime so the browser keeps presenting
    the (soon-expired) token, which drives the gate's decision to refresh.
  - **`forge_refresh` (refresh)** — a **new**, **opaque**, high-entropy httpOnly + Secure +
    SameSite=Lax cookie (NOT a JWS). The server persists only its **SHA-256 hash** in the per-app auth
    store (`{ id(hashed), user_id, session_id, created_at, expires_at(~30d), revoked_at, rotated_from?,
    rotated_to? }`), so a store leak can't be replayed. **Path=/** (not `/auth`) on purpose — the app's
    gate runs on every path and must read this cookie to decide whether to refresh.
  - **`POST /auth/refresh`** (both planes) — reads `forge_refresh`, validates it (exists, unrevoked,
    unexpired, live session), then **issues a fresh short access token AND rotates the refresh**
    (mints a new `forge_refresh`, single-use-revokes the old, links them). Returns `200 { userId,
    email, exp }` + `Set-Cookie` for both; on failure `401` + clears both cookies. **Refresh-token
    rotation** makes a stolen refresh single-use and reuse **detectable**: re-presenting an
    already-rotated token (outside a small benign-concurrency grace) **revokes the whole session's
    refresh chain + the server session**.
  - **Revocation is real.** **Logout** revokes the session **and** its refresh chain (works even when
    the access token has already expired, via the refresh record) and clears both cookies. **Password
    reset** revokes **all** of the user's sessions **and** refresh tokens ("sign out everywhere"). After
    a revocation the current access token still works only until its ~15-min `exp`, and **no new access
    can be minted** — so the session dies within the window.
  - Every sign-in path (`/auth/login`, OAuth callback) now sets **both** cookies; the `/auth/session`
    accessor signs the short access token and transparently refreshes on expiry so accessor-pattern
    apps keep a ~30d session. New event **`SessionRefreshed`**; `SessionRevoked` now also fires on a
    detected refresh reuse. New TTL knobs (env, with defaults): `FORGE_AUTH_ACCESS_TTL_SECONDS`
    (900), `FORGE_AUTH_REFRESH_TTL_SECONDS` (2592000), `FORGE_AUTH_REFRESH_REUSE_GRACE_SECONDS` (15).
- **P9 — the multi-app control plane can scope `/auth` for a dev app without a single-app sidecar
  workaround.** The single-app data-plane sidecar infers the app from `FORGE_APP_NAME`, but the
  multi-app control plane (dev) serves `/auth` for many apps and couldn't infer which — a pure
  same-origin form POST 404'd (`Unknown app`). The `/auth` routes now resolve the target app from a
  new **`X-Forge-App`** request header (which a dev proxy sets), **and** honor the `app` query param
  uniformly on **POST** as well as GET (so a `?app=<name>` rewrite destination works too). Precedence:
  explicit `app` → `X-Forge-App` header → the server default (`FORGE_APP_NAME`).

### Changed
- **Backward compatible for adopters; a re-verify, not a breaking change.** The access cookie keeps the
  **same name and JWS verification** an app already mirrors — only its `exp` shrinks — so an app's local
  `verifySessionToken` path is unchanged. To gain real revocation an app adds the small refresh step to
  its middleware: when `forge_session` is expired/absent **and** `forge_refresh` is present, do a
  server-side same-origin `POST /auth/refresh`; on `200` set the rotated cookies and admit the request,
  on `401` treat it as unauthenticated. Public/service paths are unchanged. **Prod is un-regressed:** the
  single-app data-plane path (no header, no `app` param) still defaults from `FORGE_APP_NAME`.

## [0.15.1] — 2026-07-07

### Fixed
- **P10 — a plain `forge deploy` now loads the documented secrets file (`app/.env.prod`).** The
  Productionize generator emits the secrets template as `.env.prod.example` and the generated
  `compose.prod.yaml` interpolation hints name `.env.prod` (`${POSTGRES_PASSWORD:?… in .env.prod}`),
  but `forge deploy` ran `docker compose -f app/compose.prod.yaml` with **no `--env-file`**, so
  Compose auto-read only `app/.env` — secrets placed in the documented file were **silently ignored**
  and the deploy aborted at interpolation (`required variable … is missing a value`). `forge deploy`
  now **defaults `--env-file` to `app/.env.prod`** (mirroring the P7.2 `--compose-file` default), so
  the emitted example, the compose hint, and the deploy default all name the **same** file and a
  flag-less deploy interpolates the secrets. It is passed only when the file is present (Compose
  errors on a named-but-absent env-file, and a secret-less app legitimately ships none — Compose's
  own `app/.env` auto-read still applies).
- **P11 — the generated `next.config.mjs` no longer compiles the `/auth/*` rewrite out of the image.**
  C10 apps proxy `/auth/*` to the data-plane sidecar via Next `rewrites()`. Next evaluates
  `rewrites()` (like `headers()`/`redirects()`) at **build** time, so a config gating the destination
  on a **runtime-only** env (`FORGE_DATA_PLANE_URL`, set by compose but absent at `next build` in CI)
  returned `[]` and baked the rewrite **out** of the image → `/auth/login` 404'd in prod. The
  generated config now **always emits** the `/auth/:path*` rewrite with the destination **defaulted to
  the in-cluster `http://data-plane:3718`**; a runtime `FORGE_DATA_PLANE_URL`/`FORGE_EVENTS_URL` still
  **overrides** it (e.g. `next dev`). Fixed in **one shared config** (`src/shared/next-config.ts`) used
  by both the Productionize generator and the `init app` scaffold, so neither a productionized nor a
  newly-scaffolded app re-discovers it. **forge-starter inherits the generator**, so its template is
  corrected too.

## [0.15.0] — 2026-07-07

### Added
- **C11 — permissions / access control (per-user ownership).** Now that C10 ships a multi-user
  session (`getSession() → { userId }`), the shared stores are made **owner-aware** so records no
  longer leak across users. Every shared store gains an opaque **`owner`** dimension (the app passes
  C10's `userId`): **write** takes an `owner`; **feed/query/inspect** filter by `(app, owner)` so a
  read scoped to an owner returns **only** that owner's records — user A can never read user B.
  Generic + opaque (no goal/task/auth specifics); the platform provides the owner-scoping primitive
  the app builds its own tables on.
  - **C3 application event log (`POST/GET /app-events`, `GET /app-events/latest`).** Emit accepts
    `owner`; the feed, subject filter, and `latest` (cold-subject) map all filter by owner, so one
    user's activity never resets another's clock. `AppEvent` carries `owner?`.
  - **C4 notifications (`POST /notifications[/dismiss|/clear]`, `GET /notifications`).** Scoping is by
    `(app, owner, key)`: two users may hold the **same** app key (e.g. `cold:g1`) as **distinct**
    notifications (namespaced internally by an owner + NUL storage key — the returned `.key` is
    unchanged), and dismiss/clear/list act only on the caller's own. `Notification` carries `owner?`.
  - **C1 agent runs (`agent-run` capability + `GET /resources?...&owner=`).** `agent-run` input takes
    `owner`; **both** the `AgentTask` and its `Artifact` are stamped, so a run and its result stay
    attributed to the same user (success **and** failure). `listResources` gains an `owner` filter;
    `BaseResource` carries `owner?` (set only by owner-scoped stores).
  - **`forge inspect <app-events|notifications|agent-runs> --owner <id>`** and
    **`forge resources --owner <id>`** scope those views to one user.
  - **One-time migration — `POST /owner/claim-legacy` / `forge owner claim-legacy --app --owner`.**
    Assigns every owner-**less** record across C3 + C4 + C1 to a seeded owner (pairs with C10's
    `auth seed-owner`) on cutover. Idempotent — already-owned records are untouched.
  - **Convention (for the consumer): 404-not-403.** An unknown/other-owner id returns **404** (not
    403) so existence never leaks; the app enforces this on its own tables using this owner-scoping
    primitive (a cross-owner read returns empty/nothing to render → 404).

### Changed
- **Backward compatible.** `owner` is optional everywhere: a caller that doesn't pass one is
  **app-scoped** exactly as before C11 (a C10-less app is unaffected), and legacy/pre-C11 records
  (no owner) still read under app-scope. An owner-scoped query excludes legacy records until they're
  claimed via `claim-legacy` — no data is lost or broken, no re-provision required.

## [0.14.0] — 2026-07-07

### Added
- **C10 — hosted, multi-user identity / auth.** Auth is generic platform machinery — apps must not
  hand-roll it. C10 lets any app gate itself while shipping **no auth UI and no auth tables**: it
  proxies `/auth/*` to the platform and reads a signed session. Google OAuth **and** email+password
  are both live at launch; anyone can sign up (each user is a distinct account). Like C3/C4, this is
  delivered as **routes** (registered on the control-plane API for dev and the **data-plane** sidecar
  for prod), not a Capability — so password hashes/session material never touch the `/resources` API.
  - **Hosted pages + routes (`src/api/auth-routes.ts`, `registerAuthRoutes`).** Platform-rendered
    `GET/POST /auth/{login,signup,forgot,reset}`, `GET /auth/verify`, `GET /auth/{google,google/callback}`,
    `GET|POST /auth/logout`, plus `GET /auth/session` (the session accessor / verify-endpoint option →
    `{ userId, email }` | 401) and `GET /auth/config` (which methods are enabled). The app proxies
    `/auth/*` same-origin so the session cookie lands on the app's domain.
  - **Signed session token + tiny app surface (`src/shared/session.ts`).** A compact HS256 JWS signed
    with a C5 key; the app's middleware **verifies it locally** (`verifySessionToken`) with no
    per-request round-trip. Ships the exact reference the app mirrors: `SESSION_COOKIE`,
    `signSessionToken`/`verifySessionToken`, `sessionCookie`/`clearSessionCookie` (**httpOnly + Secure
    + SameSite=Lax**, 30-day sliding), `parseCookies`, `isPublicPath`/`isServicePath`, and
    `SERVICE_TOKEN_HEADER`. Public list defaults to `/auth`, `/api/health`, `/api/cron`. Unauthenticated
    **pages → redirect to hosted login**; unauthenticated **`/api/*` → 401**.
  - **Durable, multi-user store (`src/plugins/auth-identity/`).** Users + sessions + verify/reset
    tokens persist per-app under the (gitignored) state dir — a private store like the C5 vault, never
    a Forge Resource. Passwords hashed with **scrypt** (memory-hard KDF; per-user salt; constant-time
    verify) — never stored or logged in plaintext. Google users are linked by provider id (or adopt an
    existing email account). Verify/reset tokens are **single-use + expiring** and stored only as a
    SHA-256 hash. Sign-out revokes the server session; a password reset revokes all of a user's sessions.
  - **Email via C12.** Signup verification and password reset send through **`send-email`** with
    `template:'verify-email'|'reset-password'` + the `data.url` link **C10 generates** (C10 owns
    token/link generation; C12 only delivers).
  - **Service/cron auth (§5).** The **C2 scheduler** now authenticates its `/api/cron/*` callbacks as a
    **service** — it attaches the `AUTH_SERVICE_TOKEN` (C5) under both `X-Forge-Service-Token` and
    `Authorization: Bearer`, closing what used to be fully-open cron endpoints. Absent token ⇒ no header
    ⇒ the app's gate rejects it (detectable, not silently reopened).
  - **Secrets via C5.** `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (OAuth), `AUTH_SESSION_SECRET`
    (session signing), `AUTH_SERVICE_TOKEN` (service auth) resolve vault→env, same pattern as
    `ANTHROPIC_API_KEY`. Nothing hardcoded.
  - **Detectable degradation (§7).** No Google creds → OAuth disabled, email/pw still works. No
    C12/email → email/pw signup is blocked cleanly (503), Google still works, no half-account. No
    session key → sign-in is cleanly unavailable, never a crash. All surfaced via `GET /auth/config`
    and `forge inspect auth`.
  - **Owner migration hook (§8).** `POST /auth/admin/seed-owner` / `forge auth seed-owner` designates a
    verified first/owner user (with or without a password) so a consumer can assign existing app data
    to it on cutover.
  - **Observability without leaking.** New facts `UserSignedUp` / `UserVerified` / `UserAuthenticated`
    / `SessionRevoked` / `PasswordResetRequested` / `PasswordChanged` / `OwnerSeeded` carry a **redacted**
    email + ids only — never a password, hash, or token. Inspect with **`forge inspect auth`** /
    **`forge auth users`** (redacted emails, verified/provider/owner, active-session count, and what's
    configured).
  - **Dependency-clean, multi-arch-safe.** All crypto is Node built-ins (scrypt, HMAC, timing-safe
    compare) and the form parser is `URLSearchParams` — no argon2/bcrypt native module, no OAuth SDK, no
    `@fastify/formbody`, so the slim data-plane image stays clean and cross-builds for amd64+arm64.

## [0.13.0] — 2026-07-07

### Added
- **C12 — transactional email delivery.** A generic, provider-agnostic capability to *deliver* a
  transactional email — the platform surface C10 (identity/auth) will call to send signup-verification
  and password-reset messages, and later the channel behind C4 Notifications' email. It composes +
  delivers a message it is handed; it does **not** generate tokens or links (that stays C10's job).
  Runs on the **data plane** (email is sent at runtime by the app / an auth flow); the control plane
  only inspects it.
  - **`SendEmail` Capability (`send-email`, plane `data`).** Input
    `{ to; subject?; html?; text?; template?; data?; app? }` — provide **either** an inline
    `subject` + `html`/`text` **or** a built-in `template` (+ `data`). Returns a durable
    **`EmailDelivery`** Resource (`status: 'sent' | 'failed'`, `message_id?`, `error?`). Persists
    **every attempted** send (success *and* failure) so a delivery failure is reported, never silently
    dropped. Primary caller is platform-internal (C10 via `executeCapability('send-email', …)` / the
    data-plane `POST /capabilities/send-email`); the same route is available to an app later.
  - **Built-in templates.** `verify-email` and `reset-password` render subject + HTML + plain-text from
    the `data.url` link the caller supplies (HTML is escaped — no injection). C10 generates the link;
    C12 only composes and delivers it.
  - **Provider-agnostic, configured via C5.** Credentials come from the C5 secret store (or process
    env), never hardcoded: **`SMTP_URL`** (`smtp[s]://user:pass@host:port` — any SMTP relay: SES /
    Postmark / Sendgrid / Mailgun / Postfix) + **`EMAIL_FROM`** (the From address). The transport is
    Node's built-in `net`/`tls` (implicit TLS, opportunistic STARTTLS, AUTH LOGIN) — **no new
    dependency**, so the slim data-plane image stays clean. The `email-smtp` Implementation is a real
    technology boundary a future `email-api` Implementation can replace without touching the contract.
  - **Detectable absence → graceful degrade.** When email is unconfigured (missing `SMTP_URL` and/or
    `EMAIL_FROM`), `SendEmail` throws a typed **503 `dependency_unavailable`** naming exactly what is
    missing — it never crashes, and no delivery is persisted (there was no send). C10 can detect this
    and decide (block a signup that needs verification, or surface the state).
  - **Observable without leaking.** An `EmailDelivery` and the `EmailSent`/`EmailFailed` Events record
    **to (redacted, e.g. `j***@example.com`) / subject / status** only — never credentials, never the
    message body/PII; a provider error is scrubbed of any recipient address before it is stored.
    Inspect with **`forge inspect email --app <app>`** / **`forge email list`**; send manually with
    **`forge email send`**.

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

[Unreleased]: https://github.com/mardash-ai/forge/compare/v0.26.2...HEAD
[0.26.2]: https://github.com/mardash-ai/forge/compare/v0.26.1...v0.26.2
[0.26.1]: https://github.com/mardash-ai/forge/compare/v0.26.0...v0.26.1
[0.26.0]: https://github.com/mardash-ai/forge/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/mardash-ai/forge/compare/v0.24.1...v0.25.0
[0.24.1]: https://github.com/mardash-ai/forge/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/mardash-ai/forge/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/mardash-ai/forge/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/mardash-ai/forge/compare/v0.21.1...v0.22.0
[0.21.1]: https://github.com/mardash-ai/forge/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/mardash-ai/forge/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/mardash-ai/forge/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/mardash-ai/forge/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/mardash-ai/forge/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/mardash-ai/forge/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/mardash-ai/forge/compare/v0.15.1...v0.16.0
[0.15.1]: https://github.com/mardash-ai/forge/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/mardash-ai/forge/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/mardash-ai/forge/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/mardash-ai/forge/compare/v0.12.0...v0.13.0
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
