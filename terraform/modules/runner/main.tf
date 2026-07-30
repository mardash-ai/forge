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

locals {
  startup = <<-EOT
    #!/usr/bin/env bash
    set -euo pipefail
    # The CI TOOLCHAIN, not just docker. Found live (2026-07-29): setup-terraform dies without
    # unzip; `npm ci` needs system node (the runner bundles node for ACTIONS only). Node 22 via
    # nodesource — Debian 12's packaged node is too old for the forge CLI.
    if ! command -v node >/dev/null || ! command -v unzip >/dev/null; then
      apt-get update -y && apt-get install -y docker.io jq curl unzip git ca-certificates
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
      apt-get install -y nodejs
      systemctl enable --now docker
    fi
    useradd -m runner 2>/dev/null || true
    usermod -aG docker runner

    cd /home/runner
    if [ ! -d actions-runner ]; then
      mkdir actions-runner && cd actions-runner
      curl -sL "https://github.com/actions/runner/releases/download/v${var.runner_version}/actions-runner-linux-x64-${var.runner_version}.tar.gz" | tar xz
      chown -R runner:runner /home/runner/actions-runner
    else
      cd actions-runner
    fi

    PAT="$(gcloud secrets versions access latest --secret=github-runner-pat --project=${var.project_id})"
    # org-level registration token (short-lived; the PAT never touches the runner config)
    TOKEN="$(curl -s -X POST -H "Authorization: Bearer $PAT" \
      "https://api.github.com/orgs/${var.github_owner}/actions/runners/registration-token" | jq -r .token)"

    sudo -u runner ./config.sh --unattended --replace \
      --url "https://github.com/${var.github_owner}" \
      --token "$TOKEN" \
      --name "$(hostname)" \
      --labels "gcp,self-hosted,linux,x64" || true

    ./svc.sh install runner || true
    ./svc.sh start
  EOT
}

resource "google_compute_instance_template" "runner" {
  project      = var.project_id
  name_prefix  = "${var.name}-"
  machine_type = var.machine_type
  region       = var.region

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

  metadata_startup_script = local.startup

  lifecycle {
    create_before_destroy = true
  }
}

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
}

output "runner_service_account" { value = google_service_account.runner.email }
output "pat_secret" { value = google_secret_manager_secret.runner_pat.secret_id }
