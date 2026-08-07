# forge module: runner — the self-hosted GitHub Actions runner pool (plan §4, decision 2).
#
# One Spot e2-medium in a size-1 MIG: ~$6/mo, auto-recreated on preemption (CI tolerates the
# occasional dead job; that IS the Spot trade, priced in §9.9 lever 5). The runner registers itself
# at the GitHub ORG level via a registration token minted from a PAT read out of Secret Manager —
# the PAT value is a RUNBOOK Part-5 item (never in Terraform, never in git).
#
# This VM is where everything security-sensitive in CI actually executes (checkout, secrets,
# deploys) — GitHub only ever supplies the control plane. That asymmetry is the whole §10.3-A
# decision.
#
# AUTOHEALING (added 2026-08-07, closes 2026-08-06 incident):
# A local HTTP probe (:health_check_port/health) returns 200 only when the runner service is
# active, registered with GitHub, and has written a diagnostic log within idle_threshold_minutes.
# The MIG autohealing policy keys on this signal: unhealthy for more than
# (unhealthy_threshold × check_interval_sec) seconds after the initial_delay_sec grace window
# causes the instance to be automatically replaced.
#
# See RUNBOOK.md for tuning rationale and break-glass procedures.

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "project_id" { type = string }
variable "region" { type = string }
variable "name" {
  type    = string
  default = "ci-runner"
}
variable "subnet_id" { type = string }
variable "github_owner" { type = string }
variable "machine_type" {
  type    = string
  default = "e2-medium"
}
variable "runner_version" {
  type    = string
  default = "2.326.0"
}

# --- Autohealing variables (all have safe defaults; existing callers need no changes) ---

variable "network" {
  type        = string
  default     = "default"
  description = <<-EOT
    VPC network name (or self-link) that the MIG instances are attached to.
    Used to scope the health-check firewall ingress rule.
    Defaults to "default" for backward compatibility; override with the name
    exported from the network module (e.g. module.network.network_name).
  EOT
}

variable "health_check_port" {
  type        = number
  default     = 9090
  description = <<-EOT
    TCP port on which the runner-liveness probe listens.
    GCP health check probers reach this port; a firewall rule is created
    automatically to allow 35.191.0.0/16 + 130.211.0.0/22 ingress.
  EOT
}

variable "idle_threshold_minutes" {
  type    = number
  default = 15
  description = <<-EOT
    Number of minutes without ANY _diag/*.log update before the runner is
    considered idle-stuck and the health probe returns 503.

    Rationale (see RUNBOOK.md for the full story):
    • The runner pings GitHub ~every 50 s and writes Runner_*.log on each attempt,
      including connection-error retries during a GitHub-side outage.
    • That means the log stays fresh during a GitHub outage → autohealing does NOT
      fire while GitHub is merely unavailable (no pool thrashing on outages).
    • Only a genuinely hung process — one that has stopped writing entirely — lets
      the log go stale past this threshold.
    • 15 min gives substantial margin above the ~50 s normal write cadence while
      staying well below the 7-hour incident that motivated this feature.
    • During a long-running CI job, Worker_*.log files are written continuously, so
      a job lasting > 15 min does NOT falsely trip the threshold.
  EOT
}

variable "autohealing_initial_delay_sec" {
  type    = number
  default = 300
  description = <<-EOT
    Seconds the MIG waits after instance creation before starting health checks.
    Must cover: OS boot + toolchain install (apt docker/node) + runner binary
    download + GitHub registration. Empirically 2–3 min on e2-medium Spot;
    300 s (5 min) provides comfortable headroom for slow package mirrors.
    Replacing without this grace period would create a boot-loop.
  EOT
}

# ---------------------------------------------------------------------------
# Secret + service account (unchanged)
# ---------------------------------------------------------------------------

resource "google_secret_manager_secret" "runner_pat" {
  project   = var.project_id
  secret_id = "github-runner-pat"
  replication {
    auto {}
  }
}

resource "google_service_account" "runner" {
  project      = var.project_id
  account_id   = "ci-runner"
  display_name = "GitHub Actions self-hosted runner"
}

resource "google_secret_manager_secret_iam_member" "pat_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.runner_pat.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runner.email}"
}

# ---------------------------------------------------------------------------
# Health check — MIG autohealing signal
# ---------------------------------------------------------------------------
# Global health check (accepted by regional MIGs for auto_healing_policies).
# check_interval_sec  = 30  → probe every 30 s
# timeout_sec         = 5   → probe must respond within 5 s
# healthy_threshold   = 1   → one pass restores healthy state
# unhealthy_threshold = 3   → three consecutive failures (90 s) → declare unhealthy
#
# Why threshold=3 (not lower): transient probe timeouts (brief OS load spike, GC
# pause) should not trigger a replacement.  Three consecutive failures = 90 s of
# sustained unhealthiness, which is meaningful rather than noise.

resource "google_compute_health_check" "runner_liveness" {
  project             = var.project_id
  name                = "${var.name}-liveness"
  check_interval_sec  = 30
  timeout_sec         = 5
  healthy_threshold   = 1
  unhealthy_threshold = 3

  http_health_check {
    port         = var.health_check_port
    request_path = "/health"
  }
}

# ---------------------------------------------------------------------------
# Firewall — allow GCP health check probers to reach :health_check_port
# ---------------------------------------------------------------------------
# Source ranges are the well-known GCP health-check probe origin CIDRs.
# The target_tag scopes the rule to runner instances only.

resource "google_compute_firewall" "runner_health_check_ingress" {
  project     = var.project_id
  name        = "${var.name}-hc-ingress"
  network     = var.network
  description = "Allow GCP health-check probers to reach the runner liveness probe."
  direction   = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = [tostring(var.health_check_port)]
  }

  # Well-known GCP health check probe source ranges (documented at
  # https://cloud.google.com/load-balancing/docs/health-check-concepts#ip-ranges).
  source_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
  target_tags   = ["${var.name}-hc"]
}

# ---------------------------------------------------------------------------
# Instance template
# ---------------------------------------------------------------------------

resource "google_compute_instance_template" "runner" {
  project      = var.project_id
  name_prefix  = "${var.name}-"
  machine_type = var.machine_type
  region       = var.region

  # Network tag used by the health-check firewall rule above.
  tags = ["${var.name}-hc"]

  scheduling {
    provisioning_model = "SPOT"
    preemptible        = true
    automatic_restart  = false
    # STOP, not DELETE: "Spot VMs with termination action DELETE cannot be used with Managed
    # Instance Groups" (live API error, 2026-07-29). The MIG restarts a STOPPED instance to hold
    # target_size — same self-healing, the spelling the API accepts.
    instance_termination_action = "STOP"
  }

  disk {
    source_image = "projects/debian-cloud/global/images/family/debian-12"
    auto_delete  = true
    boot         = true
    disk_size_gb = 60
  }

  network_interface {
    subnetwork = var.subnet_id
    access_config {} # ephemeral public IP — the runner must reach github.com
  }

  service_account {
    email  = google_service_account.runner.email
    scopes = ["cloud-platform"] # IAM is the real boundary, not legacy scopes
  }

  metadata_startup_script = templatefile("${path.module}/startup.sh.tpl", {
    runner_version         = var.runner_version
    project_id             = var.project_id
    github_owner           = var.github_owner
    health_check_port      = var.health_check_port
    idle_threshold_minutes = var.idle_threshold_minutes
  })

  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Regional MIG with autohealing policy
# ---------------------------------------------------------------------------

resource "google_compute_region_instance_group_manager" "runner" {
  project            = var.project_id
  region             = var.region
  name               = var.name
  base_instance_name = var.name
  target_size        = 1

  version {
    instance_template = google_compute_instance_template.runner.id
  }

  update_policy {
    type                  = "PROACTIVE"
    minimal_action        = "REPLACE"
    max_unavailable_fixed = 3
    max_surge_fixed       = 0
  }

  # Autohealing: replace an instance when the liveness probe fails for
  # (unhealthy_threshold × check_interval_sec) = 90 s after the initial grace window.
  # initial_delay_sec covers boot + toolchain install + runner registration
  # (empirically 2-3 min; 300 s gives comfortable headroom).
  auto_healing_policies {
    health_check      = google_compute_health_check.runner_liveness.id
    initial_delay_sec = var.autohealing_initial_delay_sec
  }
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "runner_service_account" { value = google_service_account.runner.email }
output "pat_secret" { value = google_secret_manager_secret.runner_pat.secret_id }
output "health_check_id" {
  value       = google_compute_health_check.runner_liveness.id
  description = "Self-link of the MIG liveness health check (useful for dashboards/alerts)."
}
output "mig_name" {
  value       = google_compute_region_instance_group_manager.runner.name
  description = "Name of the regional MIG — used in break-glass replacement commands."
}
