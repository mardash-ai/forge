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
| `src/console/timeline.ts` | The unified "what changed" axis. **Pure** — merges, never fetches |
| `src/console/quota.ts` | Quota headroom. **Pure**; never invents a ceiling |
| `src/console/docs.ts` | The developer portal, absorbed by reference (extraction is pure) |
| `src/console/server.ts` | Fastify: API + SPA, auth, the single audited write |
| `src/plugins/console-gcp/*` | GCP implementations (inventory, metrics ×2, logs, credentials, runtime, alerts/drift/cost) |
| `src/plugins/console-github/*` | GitHub Actions (pipelines, runs, dispatch, API quota) |
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

3. **Empty is never drawn as zero, and a number is never invented.** Every metric answer carries an `empty_reason` distinguishing
   *no samples in this window* from *never ingested*, and the UI prints it. For days in July 2026
   every dashboard drew a flat line at zero over a completely dead pipeline — which reads as a quiet
   system, not a broken one. The same rule governs every other unknown: Cloud SQL publishes no
   `max_connections`, so Headroom prints "unknown" instead of a percentage against a guessed ceiling;
   no BigQuery billing export exists, so Cost says so instead of drawing an empty spend chart; Cloud
   Monitoring has no open-incident API, so Alerts says *that*, which is not the same statement as
   "nothing is firing".

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
| `CONSOLE_DECLARED_EXPIRIES` | `name\|kind\|iso8601\|detail`, semicolon-free CSV. For expiries no API exposes (a GitHub PAT); badged **declared** in the UI so a hand-typed date never reads as observed |
| `CONSOLE_STATE_BUCKET` | Where Drift reads each stack's published state hash (no terraform binary needed) |
| `CONSOLE_BILLING_ACCOUNT` | Budgets are a billing-**account** resource, so the id cannot be derived from the project. Needs `roles/billing.viewer` for the console's SA, granted at the billing account |
| `CONSOLE_DOCS_ORIGIN` / `CONSOLE_DOCS_USER` / `CONSOLE_DOCS_PASS` | The developer portal the Docs screen fetches. Absent ⇒ the screen says it is unconfigured |

Google OAuth restricted to the workspace domain is built behind the same `ConsoleAuth` interface and
switches on when its client secret is populated — no code change.

## The screens

| Screen | Answers | Notable |
|---|---|---|
| Overview | what is broken right now, in five seconds | a sentence, not a chart |
| What changed | what happened just before this started | deploys × CI × console actions on one axis |
| Findings | what the console noticed | report-only **by construction** — a rule gets a frozen snapshot and no client |
| Alerts | is anything watching, and does it reach a human | flags a policy with zero notification channels: a dashboard, not an alert |
| Deploys | what is serving, by digest | rollback is a CI dispatch, never a traffic flip from this page |
| Pipelines | recent CI across every repo | |
| Drift | the **third** axis: is the declaration itself stale | the foundation once ran six releases behind with every check green |
| Inventory | what exists, scoped as the cloud scopes it | global / regional / zonal, billable marked |
| Services | how it all correlates | every binding shows the rule that produced it |
| Credentials | what expires next | declared vs discovered is badged |
| Cost | budgets, thresholds, what bills | no billing export ⇒ says so, never an empty chart |
| Headroom | ceilings nobody watches | `max_instances = 10` is a forge default, not a decision |
| Explore | metrics and logs over one scope | states WHICH store answered |
| Audit | every write the console attempted | written before the attempt |
| Docs | the developer portal | fetched live, never copied |

⌘K (or `/`) opens the palette; `1`–`9` jump to the first nine screens; `.` toggles density.

## Local development

```bash
CONSOLE_BASIC_USER=dev CONSOLE_BASIC_PASS=dev npx tsx src/console/server.ts   # :3000
cd console && npm run dev                                                     # :5173, proxies /api
```

GCP reads use the metadata server in production and Application Default Credentials locally
(`gcloud auth application-default login`). **A service-account key file is refused outright** — this
platform holds none, and accepting one here would be the easiest way to reintroduce them.
