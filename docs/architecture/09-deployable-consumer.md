# 9 · The deployable-consumer scaffolding (current to 0.35.0)

The authoritative "what a consumer app needs to be deployable via `forge release`." Two audiences use
it: **forge-starter** (the template new apps clone) and an **already-built app** that has code but lacks
the deploy toolchain. Everything here is generic — placeholders `<APP>` (kebab app name) and `<DOMAIN>`
(public host) are the only app-specifics. Nothing below requires reading the platform's source.

Related: §1 (the two images), §2 (runtime topology), §8 (platform storage on Postgres). This document is
the operator/consumer-repo view those two feed into.

---

## 1 · Repo layout — the `app/` convention

A deployable consumer repo runs the **control plane** at the repo root and holds the **app itself under
`app/`** (the single-app layout: `FORGE_APP_LAYOUT=single` ⇒ the one app lives at `<workspace>/app`). The
deploy capabilities (`productionize`, `deploy`, `release`, `verify`) default to `app/compose.prod.yaml`
and `app/.env.prod`, and resolve the app **leniently** from `app/forge.app.json` — so **no `forge init`
and no control-plane store record are required on a deploy host**.

```
<repo>/
├── compose.yaml          # runs the forge CONTROL-PLANE `api` (pinned image); single-app → ./app
├── forge                 # the ./forge CLI wrapper (execs the CLI inside the api container)
├── Makefile              # up / provision / productionize / release / deploy-ps / deploy-logs / down
├── .forge/               # control-plane state (C5 vault, resources) — GITIGNORED
└── app/                  # ← THE CONSUMER APP (its own package.json + Next.js source)
    ├── package.json
    ├── next.config.mjs   # productionize ensures output:'standalone' + the /auth/* data-plane rewrite
    ├── forge.app.json    # app manifest (name, port, infra, production pins) — forge reads/writes it
    ├── forge.theme.json  # C16 theme (scaffolded starter; edit to brand auth + status pages)
    ├── forge.jobs.json   # (optional) C2 scheduled jobs — auto-mounted + registered on boot
    ├── Dockerfile        # productionize: Next standalone multi-stage         ┐
    ├── .dockerignore     # productionize                                       │ GENERATED — do not
    ├── compose.prod.yaml # productionize: web + data-plane [+ postgres] + Traefik │ hand-edit; re-run
    ├── .env.prod.example # productionize: documents .env.prod                   │ `forge productionize`
    ├── PROVISIONING.md   # productionize: per-app secret runbook               ┘
    └── .env.prod         # operator-filled REAL secrets — GITIGNORED, never committed
```

**An app currently at the repo root must restructure** into this shape: `git mv` all app files under
`app/`, then add the three root tooling files below. The app's own `.github/workflows/…` that builds its
image stays with the app (it can live at repo root or under `app/` — see §3 on image publishing).

`.gitignore` must contain at least: `.forge/`, `app/.env.prod`, `app/.env`, `app/node_modules`,
`app/.next`.

---

## 2 · The root tooling files (verbatim, generic)

### `compose.yaml` — the control-plane the `./forge` wrapper drives

Runs the **pinned** control-plane image (not a local build) in single-app mode, pointed at `./app`. The
`name:` is app-derived so **two consumer repos never collide on a shared host** (see §5).

```yaml
# The Forge control plane for this consumer repo. The ./forge wrapper execs the CLI
# inside this `api` container, which then calls the control-plane HTTP API.
name: <APP>-forge

services:
  api:
    image: ghcr.io/mardash-ai/forge-control-plane:0.35.0
    # (default CMD runs the API: tsx src/api/server.ts on :3717)
    ports:
      - "127.0.0.1:3717:3717"      # loopback only — the CLI execs in; nothing dials it over the network
    environment:
      - PORT=3717
      # Single-app layout: the one app lives at <workspace>/app.
      - FORGE_APP_LAYOUT=single
      # The repo root IS the workspace; ./app resolves under it. Bind-mounted at the SAME
      # absolute path host==container so nested `docker compose` (DooD) resolves app bind-mounts.
      - FORGE_WORKSPACE=${PWD}
      - FORGE_STATE_DIR=${PWD}/.forge
      # C5 vault master key — required to seal/read secrets with `forge secrets set`.
      - FORGE_SECRETS_KEY=${FORGE_SECRETS_KEY:?set FORGE_SECRETS_KEY in the control-plane env}
      # The data-plane pin `forge productionize` stamps into compose.prod.yaml (keep both pins in lockstep).
      - FORGE_DATA_PLANE_IMAGE=ghcr.io/mardash-ai/forge-data-plane:0.35.0
      # Platform storage on Postgres for THIS app's productionize (equivalent to `--platform-store postgres`).
      - FORGE_PLATFORM_STORE=postgres
      # For `forge release` (publish_mode=ci): polls GHCR for the app's CI-built image. Or use --publish-mode build.
      - GITHUB_TOKEN=${GITHUB_TOKEN:-}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock   # talk to the host Docker daemon (Docker-out-of-Docker)
      - ${PWD}:${PWD}                                # identical host==container path — app files + bind-mounts resolve
    working_dir: /forge                             # the image's baked CLI + node_modules live here — do NOT override
    restart: unless-stopped
```

### `forge` — the CLI wrapper (P16 `--`, P20 `127.0.0.1`, health-poll)

`chmod +x forge`. Verbatim; the three fixes are load-bearing (comments explain each).

```bash
#!/usr/bin/env bash
# Thin Forge CLI wrapper. It runs the CLI *inside* the platform container, which
# then calls the Forge HTTP API. The local machine only ever invokes Docker.
set -euo pipefail

cd "$(dirname "$0")"

# Ensure the platform is running.
if ! docker compose ps --status=running --services 2>/dev/null | grep -qx api; then
  echo "forge: platform not running — starting it (docker compose up -d)..." >&2
  docker compose up -d api >&2
  # Wait for the API to answer before handing off (P22 readiness poll).
  for _ in $(seq 1 30); do
    if docker compose exec -T api node -e "fetch('http://127.0.0.1:3717/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      break
    fi
    sleep 1
  done
fi

# The `--` after `tsx` is load-bearing (P16): tsx hoists ANY node CLI flag it finds anywhere in
# argv — even after the script — into node. Without it, `forge deploy … --env-file app/.env.prod`
# hands `--env-file` to NODE, which resolves it against the container CWD (/forge, no app files) and
# aborts before the CLI runs. `--` tells tsx everything after is the script + its args.
# P20: dial the IPv4 loopback literal, not `localhost`. The API binds IPv4 0.0.0.0 but `localhost`
# resolves to ::1 first in-container, so `localhost` misses the server.
exec docker compose exec -T \
  -e FORGE_API_URL=http://127.0.0.1:3717 \
  api ./node_modules/.bin/tsx -- src/cli/index.ts "$@"
```

> Note vs. the platform's own dev wrapper: a consumer runs a **pinned image**, so `docker compose up -d`
> needs **no `--build`** (there is no build context at the repo root; the app's image is built by
> `forge release`, not by this control plane).

### `Makefile` — operator targets

```makefile
# Consumer app — Forge deploy convenience targets. Everything delegates to Docker / the ./forge wrapper.
# No local Node/build tools are assumed.
APP  ?= <APP>
HOST ?= <DOMAIN>

.PHONY: up down logs provision productionize release deploy deploy-ps deploy-logs deploy-down

# Start / stop / tail the CONTROL PLANE (the ./forge wrapper also auto-starts it).
up:
	docker compose up -d --force-recreate
down:
	docker compose down
logs:
	docker compose logs -f api

# One-time: declare the app's env — platform storage on Postgres + the C10 session secret.
# (Only needed if you use `forge init`/`provision`; an already-built app can hand-write forge.app.json — see §4.)
provision:
	./forge provision --app $(APP) --platform-store postgres --secret AUTH_SESSION_SECRET

# Generate the production artifacts (Dockerfile, compose.prod.yaml, .env.prod.example, PROVISIONING.md).
productionize:
	./forge productionize --app $(APP) --host $(HOST)

# The capstone: publish/await the image → repin → deploy (start-first) → verify.
release deploy:
	./forge release --app $(APP) --host $(HOST)

# Inspect / tail / tear down the DEPLOYED app stack. It is a SEPARATE compose project
# (name: forge-$(APP)-prod inside the file), so these never touch another app's stack.
deploy-ps:
	docker compose -f app/compose.prod.yaml --env-file app/.env.prod ps
deploy-logs:
	docker compose -f app/compose.prod.yaml --env-file app/.env.prod logs -f
deploy-down:
	docker compose -f app/compose.prod.yaml --env-file app/.env.prod down
```

### `app/forge.jobs.json` — optional C2 scheduled jobs (current path + format)

The scheduled-jobs declaration is **`forge.jobs.json` in the app dir (`./app`)**, a JSON array. When
present, `forge productionize` bind-mounts it read-only into the data-plane sidecar and pins
`FORGE_JOBS_FILE`, so C2 registers the jobs on boot. (This supersedes any older `deploy/jobs.json` path.)

```json
[
  { "name": "daily-digest", "cron": "0 8 * * *", "target_path": "/api/cron/digest", "method": "POST" },
  { "name": "refresh-whats-next", "every": "6h", "target_path": "/api/cron/whats-next" }
]
```

Each entry: `name` (kebab-case, unique per app), exactly one of `every` (`30s`/`5m`/`6h`/`7d`) | `cron`
(5-field, UTC) | `at` (ISO one-shot), `target_path` (the app path the fire calls back, `/`-absolute), and
optional `method` (`GET`|`POST`, default `POST`) / `disabled`. The fire is service-authenticated
(`AUTH_SERVICE_TOKEN` when set), so the app gates `/api/cron/*` on it. C23's proactive scheduling
(`POST /mcp/proactive`) registers the same kind of job through this mechanism.

---

## 3 · The deploy flow — exact commands + flags

Prereqs on the host: **Docker + the Compose plugin**, an external Traefik reverse proxy on a shared
`proxy` Docker network terminating TLS (a `certresolver`, default name `letsencrypt`), and the app's web
image reachable in GHCR (see the publish note below). Set `FORGE_SECRETS_KEY` in the control-plane env.

```sh
# 0. Start the control plane (once). ./forge auto-starts it too.
make up

# 1. PROVISION — declare the app's infra. --platform-store postgres puts Forge's OWN state
#    (C10 identity, C23 OAuth tokens/consents/clients, C3/C4/C19, …) on a SEPARATE `forge_platform`
#    Postgres DB + least-privilege role. Add --with-postgres if the APP itself needs a database;
#    add --secret <NAME> for each C5 secret the app declares (e.g. AUTH_SESSION_SECRET).
./forge provision --app <APP> --platform-store postgres --secret AUTH_SESSION_SECRET
#    (An already-built app can SKIP this and hand-write app/forge.app.json instead — see §4.)

# 2. PRODUCTIONIZE — emit the canonical production artifacts (idempotent, digest-pinned R1):
#      app/Dockerfile (+ .dockerignore), output:'standalone' in next.config, app/compose.prod.yaml
#      (Traefik router for <DOMAIN> + the DB-aware data-plane sidecar wiring FORGE_DB_URL when
#      platform-store=postgres), app/.env.prod.example, app/PROVISIONING.md, forge.theme.json.
./forge productionize --app <APP> --host <DOMAIN>
#    Optional flags: --readiness-path /api/health (default), --cert-resolver <name> (default letsencrypt),
#    --web-image <ref@sha256:…> / --data-plane-image <ref@sha256:…> (else the data-plane defaults from
#    FORGE_DATA_PLANE_IMAGE). Values persist in forge.app.json `production`; a flag-less re-run reproduces them.

# 3. Fill app/.env.prod (copy from app/.env.prod.example) — see §4. NEVER commit it.

# 4. RELEASE — the capstone: assess → publish/await the commit's image → resolve digest →
#    repin compose (C8) → deploy start-first behind Traefik (C7 + P14 drift gate) → verify (C14).
#    Idempotent + fail-safe: any failure leaves prod on the last-good version.
./forge release --app <APP> --host <DOMAIN>
#    Useful flags: --dry-run (assess + print the plan, mutate nothing), --publish-mode build (build+push
#    the image locally with buildx instead of waiting for CI), --commit <sha>, --timeout-seconds 600.
```

**Publishing the app's web image (release step "publish/await").** `release` defaults to
`--publish-mode ci`: it WAITS (GHCR poll) for the commit's image at
`ghcr.io/<owner>/<app>-app:sha-<commit>` — so the app repo needs a GitHub Actions workflow that builds
`app/Dockerfile` and pushes that tag on push. Alternatively `--publish-mode build` builds + pushes the
image from the control plane itself (needs `docker buildx` + a registry login on the host).

`make deploy` / `make release` wrap step 4. Re-running `release` after a code change repeats
publish→repin→deploy→verify; an unchanged pin is a no-op (the drift gate + `isDeployCurrent` skip work).

---

## 4 · Secrets & `app/.env.prod` — the env contract

**Two ways a value reaches the runtime** (a capability resolves a secret by reading the **C5 encrypted
vault first, then process env**):

- **Dev / control plane (C5 vault):** `./forge secrets set --app <APP> --name <NAME> --from-env <NAME>`
  (or `--value <v>`). Sealed under `FORGE_SECRETS_KEY`; never lands in source, compose, or an image layer.
- **Prod / deployed sidecar (env file):** put `NAME=value` in **`app/.env.prod`**. The generated
  `compose.prod.yaml` interpolates each **declared** secret into **both** the web and data-plane
  containers (`${NAME:-}`; a deploy-required one like `AUTH_SESSION_SECRET` is `${NAME:?…}` so a missing
  value fails the deploy loudly). A secret must be **declared** (`--secret NAME` at provision, or listed
  in `forge.app.json` `infra.secrets`) for the interpolation line to exist. Changing a value needs a
  `forge deploy` (or a `data-plane` restart) to take effect.

**The variables a deployed consumer needs in `app/.env.prod`:**

| Var | Required? | What it is |
|---|---|---|
| `FORGE_SECRETS_KEY` | **Always** | C5 vault master key the data-plane uses to decrypt secrets at rest. `openssl rand -base64 32`. Keep stable. |
| `FORGE_PLATFORM_DB_PASSWORD` | When `platform-store=postgres` | Password for the least-priv `forge_platform` role that owns the separate `forge_platform` DB (Forge's own state, incl. **C23** OAuth). `openssl rand -base64 24`. **Not** the app DB password. |
| `AUTH_SESSION_SECRET` | For C10 auth **and C23** | HMAC key signing the `forge_session` JWS (HS256). **C23's OAuth AS reuses this** to read the logged-in user during authorize/consent — C23 adds **no new secret**. `openssl rand -base64 48`. Keep stable. |
| `POSTGRES_PASSWORD` | Only if `--with-postgres` (the app has its own DB) | Password for the app's `forge` DB role; also builds `DATABASE_URL`. `openssl rand -base64 24`. |
| `ANTHROPIC_API_KEY` | Only if the app uses C1 agent-run | Model API key. |
| `AUTH_SERVICE_TOKEN` | Optional | Token the C2 scheduler/cron presents to `/api/cron/*`. `openssl rand -hex 32`. |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Optional | Enable "Continue with Google" (no email dependency). Redirect URI: `https://<DOMAIN>/auth/google/callback`. |
| `SMTP_URL` + `EMAIL_FROM` | Optional | Enable email/password signup + verification + reset (C12). |

> **C10 sign-in trap:** hosted auth needs **at least one** working method — configure Google **or** SMTP,
> else `/auth/signup` shows no form and no one can sign in. `AUTH_SESSION_SECRET` is required for either.

**C23 (remote MCP hosting + OAuth 2.1) env — no new secret.** The OAuth authorization server issues
opaque access/refresh tokens + authorization codes that are **sha256-hashed at rest** and confidential
client secrets likewise hashed, so there is no signing key to provision. Its only requirements are
`AUTH_SESSION_SECRET` (above, for the consent step) and a **durable, multi-replica-safe store** — i.e.
platform storage on Postgres (`--platform-store postgres`), which puts the `mcp` store (tools,
instruction blocks, clients, consents, tokens) on the `forge_platform` DB along with C10/C3/C4/C19.
Optional tuning env (set on the data-plane, not secrets): `FORGE_OAUTH_PUBLIC_URL` (issuer override if
the OAuth/MCP edge is relocated off same-origin), and `FORGE_OAUTH_{CODE,ACCESS,REFRESH}_TTL_SECONDS`.

**Platform store selection is automatic.** When `platform-store=postgres`, the generated
`compose.prod.yaml` sets `FORGE_STORE_BACKEND=postgres` + `FORGE_DB_URL=…/forge_platform` on the
data-plane and makes it depend on a healthy Postgres — flipping **all** platform domains (identity,
events, notifications, search, secrets, resources, policy, **mcp**) onto Postgres. Filesystem is the
default when omitted (fine for a single replica; not for horizontal scale — see §8).

---

## 5 · Multi-app isolation on a shared host

Deploying a new app on a box that already runs others (forge-os + ~10 projects) must never touch an
existing stack, DB, or volume. Isolation is **structural**, from the compose **project name**:

- **Separate compose project per app.** `forge productionize` writes `name: forge-<APP>-prod` into
  `app/compose.prod.yaml`. `forge deploy` runs `docker compose -f app/compose.prod.yaml` from the repo
  root with **no `-p`**, so that `name:` is the project. Everything is namespaced by it:
  - containers → `forge-<APP>-prod-web-1`, `…-data-plane-1`, `…-postgres-1`
  - networks → `forge-<APP>-prod_internal` (a private bridge, per app)
  - volumes → `forge-<APP>-prod_forge_state` (the sidecar's auth/secrets/token state) and
    `forge-<APP>-prod_postgres_data`
  Two apps with different `<APP>` names share **nothing** here — different names ⇒ different project ⇒
  different containers/networks/volumes. **The one hard rule: app names must be unique on the host.**
- **Separate databases.** Each app's `postgres` service is its own container + its own `postgres_data`
  volume. The platform state rides a **separate `forge_platform` database + least-privilege role** on
  that instance (co-located with the app's DB via a first-init script, or a dedicated platform Postgres
  when the app has no DB of its own) — a platform bug can't reach app tables and vice versa (§8).
- **The only shared resource is the external `proxy` network** (Traefik). Routing is disambiguated by
  per-app Traefik keys the compose emits: `traefik.http.routers.<APP>.rule=Host(`<DOMAIN>`)` +
  `…routers.<APP>.*` + `…services.<APP>.loadbalancer.*`. Distinct `<APP>` router/service keys **and**
  distinct `<DOMAIN>` host rules ⇒ a new app's ingress never overrides an existing one. Requirements:
  the `proxy` network already exists (`docker network create proxy` once, before the first app) and each
  app has a unique hostname.
- **Separate control planes, uniquely named.** Each consumer repo's root `compose.yaml` uses
  `name: <APP>-forge`, so the `api` containers don't collide either. Its state is the repo-local
  `.forge/` (gitignored) — nothing global. (The control plane is only needed to *run* deploys; it can be
  stopped between releases.)

**Net:** to add a new app safely, give it a unique `<APP>` name and a unique `<DOMAIN>`, ensure the
shared `proxy` network exists, and run its own `./forge release` — its stack, DB, and volumes are wholly
its own, and no command ever references another app's project. The one destructive footgun to avoid:
`docker compose down -v` (or `down --remove-orphans` across files) removes **that project's** volumes —
run the `deploy-down` target (no `-v`) so a redeploy keeps `forge_state` (live sessions) + `postgres_data`.
