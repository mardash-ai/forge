# forge-console

One operator surface over environments, observability, CI/CD and findings. Ships as a forge
component; deployed by the thin consumer stack `dorinda-forge-console` at `forge.dorinda.ai`.

## Where things live

| Path | What |
|---|---|
| `src/console/domain.ts` | The provider-neutral entity model. No vendor type appears here. |
| `src/console/providers/types.ts` | The provider contracts + registry + `aggregate()` |
| `src/console/correlate/graph.ts` | Correlation. **Pure** — no I/O, fully unit-testable |
| `src/console/findings.ts` | The findings engine. **Pure**, report-only by construction |
| `src/console/server.ts` | Fastify: API + SPA, auth, the single audited write |
| `src/plugins/console-gcp/*` | GCP implementations (inventory, metrics ×2, logs) |
| `src/plugins/console-github/*` | GitHub Actions (pipelines, runs, dispatch) |
| `console/` | The React + Vite SPA (its own package.json; forge's stays dependency-light) |
| `Dockerfile.console` | Two stages: build the SPA, then a slim runtime |

## The three design rules

1. **No vendor type above `providers/types.ts`.** A new backend is a directory under
   `src/plugins/console-*` and one registry entry — routes, correlation and UI are untouched.

2. **Discovery-first, never a declared catalogue.** Services are found by joining conventions that
   already hold (image-repo name, `<name>-backend`, the host→backend map, repo name, workflow path,
   secret prefix), each with an explicit confidence and a reason the UI renders. Overrides may
   *correct*, never *invent*: one naming a service discovery never produced becomes a finding rather
   than a phantom entry. Whatever cannot be placed is shown in `unbound`.

   This is the deliberate opposite of Backstage's `catalog-info.yaml`, whose upkeep is the single
   most-regretted decision its adopters report.

3. **Empty is never drawn as zero.** Every metric answer carries an `empty_reason` distinguishing
   *no samples in this window* from *never ingested*, and the UI prints it. For days in July 2026
   every dashboard drew a flat line at zero over a completely dead pipeline — which reads as a quiet
   system, not a broken one.

## Why it cannot mutate the cloud

Two independent guarantees, not one convention:

- `RuntimeProvider` exposes **no mutate method**. There is nothing to call.
- The deployed service account holds **viewer roles only**, and `secretmanager.viewer` rather than
  `accessor` — it can see that a secret exists and never read its value.

The single write in the entire surface is a **pipeline dispatch**. Every change therefore goes
through CI and inherits its read-back and behaviour gate, and the receipt is a real run URL. The
audit row is written **before** the attempt, because auditing only successes loses exactly the
interesting cases. A dispatch with no stated reason is refused.

## Configuration

| Variable | Purpose |
|---|---|
| `CONSOLE_BASIC_USER` / `CONSOLE_BASIC_PASS` | Interim auth. **Absent ⇒ the console serves nothing** (fails closed) |
| `CONSOLE_GITHUB_TOKEN` | Enables the CI plane. Absent ⇒ pipelines read-unavailable and dispatch disabled, stated plainly in the UI |
| `CONSOLE_GCP_PROJECT` / `CONSOLE_GCP_REGION` / `CONSOLE_ENV` | Scope |
| `CONSOLE_GITHUB_OWNER` / `CONSOLE_GITHUB_REPOS` | Which repositories to read |

Google OAuth restricted to the workspace domain is built behind the same `ConsoleAuth` interface and
switches on when its client secret is populated — no code change.

## Local development

```bash
CONSOLE_BASIC_USER=dev CONSOLE_BASIC_PASS=dev npx tsx src/console/server.ts   # :3000
cd console && npm run dev                                                     # :5173, proxies /api
```

GCP reads use the metadata server in production and Application Default Credentials locally
(`gcloud auth application-default login`). **A service-account key file is refused outright** — this
platform holds none, and accepting one here would be the easiest way to reintroduce them.
