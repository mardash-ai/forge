# forge/terraform/modules/runner — Runbook

## What this module does

A single Spot `e2-medium` VM in a regional Managed Instance Group (MIG).  The VM
registers itself as an **org-level GitHub Actions self-hosted runner** using a PAT
stored in Secret Manager.  The MIG holds `target_size = 1`; when the Spot VM is
preempted or autohealing fires, the MIG replaces it automatically.

---

## Runner-liveness autohealing (added 2026-08-07)

### Why it exists

On 2026-08-06 an Actions/control-plane outage wedged the self-hosted runner for 7+
hours: the VM stayed `RUNNING`, the MIG reported stable, and terraform showed zero
drift — because the failure was runtime behavior Terraform doesn't model.  All
automated remedy routes (forge-infra verbs, credential-less operator machines) flowed
through the wedged runner, creating a deadlock.  Autohealing breaks that loop by
replacing the instance when the runner itself declares sick.

### How the probe works

A Python HTTP server runs as `runner-health-probe.service` on `:9090` (configurable
via `health_check_port`).  `GET /health` returns:

| Response | Condition |
|----------|-----------|
| `200 OK` | Runner systemd unit active **AND** `.runner` config exists (registered) **AND** any `_diag/*.log` updated within the last `idle_threshold_minutes` minutes (default 15) |
| `503 Unhealthy` | Any of the above conditions fails |

The MIG health check polls this endpoint every 30 s.  After **3 consecutive 503
responses** (90 s of sustained failure), the MIG replaces the instance.

A fresh instance gets an **`initial_delay_sec = 300` grace window** (5 min) before
health checks begin — enough time for OS boot + toolchain install + runner binary
download + GitHub registration (empirically 2–3 min on `e2-medium` Spot).

### Idle-stuck detection vs. GitHub outages — the key design choice

The GitHub Actions runner pings GitHub approximately every 50 seconds and writes a
`Runner_*.log` entry on each attempt — **including connection-error retries during a
GitHub-side outage**.  This means the diagnostic log stays fresh during a GitHub
outage, so the probe returns `200 OK` and autohealing does **not** fire.

Only a genuinely **hung process** (one that has stopped writing entirely) lets the
log go stale past `idle_threshold_minutes`.  A 7-hour outage like the 2026-08-06
incident would have been detected and replaced within ~16 min (15 min threshold + 90 s
MIG confirmation), well before the 7-hour mark.

During a long-running CI job (> 15 min), `Worker_*.log` files are written
continuously, so a legitimate long job does **not** falsely trip the threshold.

### Tuning summary

| Parameter | Default | Rationale |
|-----------|---------|-----------|
| `idle_threshold_minutes` | 15 | Comfortably above the ~50 s normal log cadence; well below the 7-hour incident |
| `check_interval_sec` | 30 | Fast enough to detect problems; slow enough to avoid health-check API costs |
| `unhealthy_threshold` | 3 | 90 s of sustained failure rules out transient probe timeouts |
| `initial_delay_sec` | 300 | Covers boot + install + registration (empirically 2–3 min) with headroom |

To make autohealing more or less aggressive, adjust `idle_threshold_minutes` and
`autohealing_initial_delay_sec` in the module call.

---

## Break-glass: replace a runner instance immediately

Use this when you need to force-replace the runner outside the normal autohealing
cadence (e.g. the runner is holding a zombie job lock, or you want to force a clean
re-registration after a GitHub token rotation):

```sh
# Replace all instances in the regional MIG now (one instance by default).
gcloud compute instance-groups managed rolling-action replace \
  ci-runner \
  --region=us-central1 \
  --project=YOUR_PROJECT_ID
```

Replace `ci-runner`, `us-central1`, and `YOUR_PROJECT_ID` with the values from your
deployment.  The `mig_name` and `region` outputs from the module make these available
as Terraform outputs.

**Effect**: the MIG immediately terminates and recreates the instance.  Any running CI
job on that instance is aborted and the job returns to the Actions queue to be retried.
This is safe to run at any time — it is the same operation autohealing performs.

To watch the replacement proceed:
```sh
gcloud compute instance-groups managed describe-instances ci-runner \
  --region=us-central1 \
  --project=YOUR_PROJECT_ID
```

---

## Checking health probe status on a live instance

SSH into the runner instance and query the probe directly:

```sh
# From the instance itself:
curl -s http://localhost:9090/health

# Check the probe service:
systemctl status runner-health-probe

# Tail probe logs:
journalctl -u runner-health-probe -f

# Check the runner service:
systemctl list-units 'actions.runner.*'
```

---

## PAT rotation

The GitHub PAT is stored in Secret Manager as `github-runner-pat`.  After rotating
the PAT value (add a new secret version, set it as latest, disable old version):

1. The running runner instance does **not** need a restart — the PAT is only read at
   boot time to mint a registration token.  The runner's registration persists until it
   is replaced or removed.
2. The next natural MIG replacement (preemption, autohealing, or a manual break-glass
   replace) will pick up the new PAT automatically.
3. To force immediate rotation: use the break-glass command above.

---

## Adding this module to a root module

```hcl
module "runner" {
  source = "../../modules/runner"

  project_id   = var.project_id
  region       = var.region
  subnet_id    = module.network.subnet_id
  github_owner = "your-org"

  # Optional — pass the VPC name so the health-check firewall rule is scoped correctly.
  network = module.network.network_name

  # Optional overrides (safe defaults apply):
  # idle_threshold_minutes        = 15
  # health_check_port             = 9090
  # autohealing_initial_delay_sec = 300
  # runner_version                = "2.326.0"
}
```
