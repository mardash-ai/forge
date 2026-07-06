# Forge

> **The AI-native software creation platform for Builders.**
>
> *The last generation of developer platforms optimized for engineers
> writing code. Forge optimizes for Builders creating software.*

------------------------------------------------------------------------

## Open Source from Day One

Forge is released under the **MIT License**.

The goal of Forge is to establish an open foundation for AI-native
software creation. We believe the concepts, architecture, and platform
should be freely available for the community to learn from, build upon,
and evolve.

See the `LICENSE` file for details.

------------------------------------------------------------------------

## What is Forge?

Forge is an AI-native software creation platform designed around a
simple idea:

> **Software is built, not written.**

Modern software is created by Builders---engineers, designers, product
managers, researchers, security engineers, and intelligent agents
working together through a common platform.

Forge provides stable **Capabilities**, durable **Resources**, and replaceable
**Implementations** so Builders can focus on outcomes instead of
infrastructure. It is **Docker-first** and **API-first**: every Capability runs
in Docker and is exposed through a stable HTTP API, so humans and agents use the
same contracts. Forge is a **platform provider**, not a shared library —
applications (e.g. `forge-os`) consume it through the CLI, API, and event stream
and never import internal Forge packages.

> Capabilities perform behavior. Resources represent state. Events record facts.
> Policies govern. Permissions authorize.

------------------------------------------------------------------------

## Read the Specification

Forge is defined by a layered specification in [`docs/`](docs/). Read it in order:

1.  `01_FORGE_MANIFESTO.md`
2.  `02_FORGE_DOMAIN_MODEL.md`
3.  `03_FORGE_LAWS.md`
4.  `04_FORGE_ARCHITECTURE.md`
5.  `05_FORGE_API_PHILOSOPHY.md`
6.  `06_FORGE_REPOSITORY.md`
7.  `07_FORGE_PLAYBOOK.md`

Each document builds on the one before it.

------------------------------------------------------------------------

## Running the platform (v1)

The first slice makes a **Dockerized Next.js web app** easy to initialize,
provision, build, test, lint, inspect, and debug — reproducibly, with structured
Resources, an Event history, and token-conscious output.

**Requirements:**

- **Docker** (with the Compose plugin) — the platform and all app work run in containers.
  No local Node, npm, Python, Postgres, or Redis is needed or assumed.
- **GitHub CLI (`gh`), authenticated** — run `gh auth login` once. Releases publish images
  through GitHub Actions, and `gh` is how you watch publish/CI runs, inspect failed jobs, and
  manage pull requests (e.g. `gh run watch`, `gh run view --log-failed`).

### Capabilities

| Capability | CLI | Resource created |
|---|---|---|
| InitializeApp | `forge init app --name <n>` | `Application` |
| ProvisionEnvironment | `forge provision --app <n>` | `Environment` |
| InstallDependencies | `forge install --app <n>` | `DependencyInstall` |
| RunDevServer | `forge dev --app <n>` | `DevServer` |
| Build | `forge build --app <n>` | `Build` |
| Test | `forge test --app <n>` | `TestRun` |
| Lint | `forge lint --app <n>` | `CheckRun` |
| Inspect | `forge inspect <type> --app <n>` | `Inspection` |
| ExplainFailure | `forge explain --resource <id>` | `Analysis` |
| GenerateFeaturePlan | `forge plan --app <n> --goal "…"` | `Plan` |

### Quick start

```bash
make up                                  # build + start the platform (in Docker)

./forge init app --name forge-os         # scaffold a Dockerized Next.js app
./forge provision --app forge-os         # generate compose.yaml + .env.example
./forge install   --app forge-os         # npm install (in Docker)
./forge build     --app forge-os         # next build (in Docker)
./forge test      --app forge-os         # vitest (in Docker)
./forge lint      --app forge-os         # eslint (in Docker)
./forge dev       --app forge-os         # dev server at http://localhost:3000

./forge inspect app     --app forge-os   # compact JSON project summary
./forge inspect routes  --app forge-os   # discovered routes, no repo dump
./forge explain --resource <build_id>    # compact failure diagnosis
```

Generated apps live under `workspace/apps/<name>/`; Resources, Events, and logs
live under `workspace/.forge/`.

### Output is designed for agents

Every command returns **compact JSON** by default with a `suggested_next`
command. Full logs are never dumped — they live at a `log_ref` and require an
explicit `forge logs <id> --full`.

```json
{"resource":"build_…","status":"failed","summary":"…","log_ref":"…","suggested_next":"forge explain --resource build_…"}
```

Flags: `--summary` (human-readable), `--raw` (full resource), `--json` (default).

### HTTP API

The CLI is a thin client over the API (default `http://localhost:3717`):

```
GET  /health
GET  /capabilities                  # discovery
POST /capabilities/:slug            # perform a Capability
GET  /resources[?type=&app_id=]     # list state
GET  /resources/:type/:id           # one Resource
GET  /events[?app_id=&resource_id=] # facts
GET  /logs/:resourceId              # full log (explicit only)
```

### Architecture

```
Builder Interface (CLI / API)
   → Capability API        (src/api)
   → Capability Runtime    (src/core: routing, policy, permission, audit)
   → Implementation        (src/plugins: scaffold, docker-compose, npm, eslint…)
   → Resource Store        (src/storage: filesystem JSON)
   → Event Stream          (workspace/.forge/events/events.jsonl)
```

Provider-specific code lives only in `src/plugins/`; the core knows nothing about
npm, Next.js, or Docker specifics. See [`docs/06_FORGE_REPOSITORY.md`](docs/06_FORGE_REPOSITORY.md).

### Make targets

```bash
make up      # build + start platform     make logs   # tail platform logs
make down    # stop platform              make shell  # shell into the container
make test    # run the platform's own tests
```

All targets delegate to Docker only.

------------------------------------------------------------------------

## Contributing

Before contributing:

-   Read the specification.
-   Use the canonical domain vocabulary.
-   Keep domain concepts separate from architecture.
-   Prefer concrete designs over speculative abstractions.
-   Ask one question before every change:

> **Does this help Builders build?**
