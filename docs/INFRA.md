# `forge infra` (I1) — provision a product's cloud stack

> Design + full rationale: `dorinda-orchestrator/PRODUCTIONALIZATION_PLAN.md` §2–§3. Manual-step
> boundary: the consuming product's `RUNBOOK.md`. This doc is the capability reference.

## The model in five sentences

The repo you are standing in **is** the stack selector — `forge.infra.json` declares what the repo
owns; there is no `--stack` flag and no way to provision another repo's infrastructure. Reusable
Terraform modules live in this repo under `terraform/modules/` and are referenced by consumers with
a **version-pinned git source** (`?ref=vX.Y.Z`) — adopting a new module version is a reviewed bump,
exactly like adopting a released image. `apply` is **CI-only**; the §3.8 escape hatch
(`--local --allow-local-apply`) exists for the two bootstrap applies that must precede CI, and no
others. `apply` **does not believe exit codes** (§3.7): it re-plans after applying and fails unless
the diff is empty, then publishes the declared-config hash and (foundation) the platform contract.
Consumer stacks refuse to plan/apply until the published contract satisfies their declared
`required_platform_contract` (§3.5).

## ⚠️ Execution model — deliberately unlike every other forge command

Every other capability executes in the control plane behind `/capabilities/<slug>`. `forge infra`
executes **locally**: its inputs (the repo checkout, your cwd) and credentials (operator ADC, or the
CI runner's WIF-federated token) exist only on the invoking machine, and no service-account key may
ever be minted to hand the control plane (§2.5 rule 3). The `forge` wrapper intercepts the `infra`
noun before the docker-exec path. **No key files, ever** — locally `gcloud auth login` +
`gcloud auth application-default login`; in CI, `google-github-actions/auth` with the WIF pool that
`bootstrap` creates.

## Verbs

| Verb | What | Guards |
|---|---|---|
| `bootstrap --env E [--component C] [--repo R]` | folder · project · billing · core APIs · state bucket · WIF pool + deployer SA | idempotent; the ONE verb allowed to create resources outside TF state. **Scope it**: `--component project\|state\|identity\|all`, and `--repo` registers ONE declared repo instead of all. A repo absent from `github.repos` is refused — scoping narrows work, never the trust boundary |
| `lint` | schema + `terraform fmt -check` + `validate` | no provider calls |
| `plan --env E` | contract gate → init → plan | read-only |
| `apply --env E` | plan-preflight → apply → **§3.7 read-back (re-plan must be empty)** → publish hash (+ contract) | CI-only; `--local --allow-local-apply` = the §3.8 hatch |
| `status --env E` | declared vs applied hash + drift plan | exit 2 on drift — the nightly drift-detection job is this verb on a schedule |
| `outputs --env E` | `terraform output -json` | |
| `verify --env E` | the repo-DECLARED behaviour checks (§3.2) | CI post-deploy gate; red verify = rollback |
| `release-image --env E --service S --image REF` | CODE plane (§3.3): roll ONE Cloud Run service by digest → wait for revision **Ready** → run the declared **behaviour** checks | refuses a non-digest ref (R1); refuses **before rolling** if the stack declares no behaviour check; `--allow-unverified-release` is the deliberate hatch |
| `destroy --env E` | teardown | never in CI; prod-named envs need `--i-know-this-is-prod` |

## `forge.infra.json`

Schema: `src/infra/config.ts` (zod — the rules live in the schema, not in docs). Kinds:
`foundation` (owns org-level singletons; may `publishes_contract`) · `service` · `runner` ·
`telemetry` (all three must declare `required_platform_contract`).

Verify checks: `dns_resolves` · `http` (with `resolve_to_output` for pre-cutover checks against the
LB IP) · `certless_discovery` (ACCEPTANCE §5f MTLS-2 — discovery must answer 200 with NO client
cert) · `cloud_run_ready` · `command` (keeps existing proof scripts like `verify-mcp-edge.sh`
first-class; `cwd` is relative to the REPO ROOT, not the process cwd — in CI the CLI runs from a
sibling `.forge` checkout).

### Behaviour checks vs existence checks (0.79.21)

`release-image` already reads back that the revision went **Ready**. Ready is not working: the GCP
cutover's worst bug was an unset `FORGE_APP_CALLBACK_URL` that produced a perfectly Ready revision
while every MCP tool call died. So only checks that make a **request** satisfy the release gate:

| Kind | Gate? | Why |
|---|---|---|
| `cloud_run_ready`, `dns_resolves` | ❌ | re-prove what the read-back already proved |
| `command` running `true` / `:` | ❌ | a placeholder must not satisfy the gate it stands in for |
| `http`, `certless_discovery`, real `command` | ✅ | something actually answers |

Only the pre-cutover forms (`resolve_to_output`, `expect_output`) need terraform outputs, so the
code plane never needs a terraform binary — and once DNS points at the LB, resolving normally is the
stronger check anyway: it takes the path a real client takes.

## The contract (§3.5)

Foundation `apply` publishes `gs://<state_bucket>/contract/<env>.json`:
`{ platform_contract_version, published_at, declared_config_hash, values }` — `values` is the
foundation's `terraform output`. The version is itself **an output of the stack**, so bumping it is
a reviewed config change. Consumers get the values materialized into
`infra/contract.auto.tfvars.json` (gitignored, regenerated each run) as the `platform` variable —
they never read foundation state.

## The canonical consumer variable

```hcl
variable "platform" {
  type        = any   # NOT map(string)/map(any) — the contract carries lists + objects (hit live)
  description = "the §3.5 platform contract, materialized by forge infra"
}
```

## Modules (`terraform/modules/`)

| Module | Owns | Notable |
|---|---|---|
| `network` | VPC, subnet, PSA | Direct VPC egress — no connectors ($0, faster) |
| `edge` | DNS zone, certs, **two** LB entries, TrustConfig + ServerTlsPolicy | main proxy never requests a client cert (browser cert-picker hazard); mcp proxy uses `ALLOW_INVALID_OR_MISSING_CLIENT_CERT` so certless discovery survives (§9.4b); DNS-authorization certs provision **pre-cutover**; `host_backends` is the §2.4 seam |
| `database` | Cloud SQL PG16 zonal + **backups + PITR**, private-IP-only | availability is a runtime setting (REGIONAL later, in place); generated password → Secret Manager |
| `service` | Cloud Run v2, SA, AR repo, secret containers, NEG + backend service | ingress = LB-only; `mtls_headers` adds the `client_cert_*` headers **only** on the mcp backend; image is `ignore_changes` — `forge release` owns code, `forge infra` owns the stack (§3.3) |
| `runner` | Spot MIG(1) GitHub Actions runner | org-level registration via PAT from Secret Manager; preemption self-heals |

Secret **containers** are Terraform's; secret **values** are supplied out-of-band
(`gcloud secrets versions add` — RUNBOOK Part 5). Terraform never sees a value.
