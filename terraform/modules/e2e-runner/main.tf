# forge module: e2e-runner — dedicated Cloud SQL + Cloud Run Job for the forge E2E harness.
#
# SEPARATION INVARIANT: this Cloud SQL instance is DEDICATED to the e2e/cp-results backend.
# It is NEVER a database on dorinda-prod's application instance. Its own instance, its own
# user, its own schema — no network or schema overlap with production.
#
# Cloud SQL: a small Postgres 16 instance for the cp-results backend (E2E run history,
# workflow results, tenant lease). The cp-results tables are append-mostly and modest in size;
# db-f1-micro at 10 GB with autoresize is correct sizing for this load.
#
# Cloud Run Job: runs the released forge control-plane image (image = var.image, defaulting to
# a placeholder at first apply, replaced by release CI). The job is TRIGGERED — not a long-
# running service. One execution per E2E run; max_retries = 0 (E2E is not idempotent).
#
# Secrets: the db password and composed DATABASE_URL are seeded by Terraform (random_password).
# The API-key and service-token containers are created here; values are added out-of-band per
# the standard pattern (RUNBOOK — never in state, never in git).
#
# Service account: least-privilege SA for the job. It reads only ITS secrets — not the
# project-level secretAccessor role.
#
# See PROVIDER_ACCOUNTS.md for the full GCP resource inventory.

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "project_id" { type = string }
variable "region" { type = string }

variable "name" {
  type        = string
  default     = "e2e-runner"
  description = "Base name for the Cloud Run Job, service account, and secret prefixes. Changing this creates new resources."
}

variable "sql_instance_name" {
  type        = string
  default     = "e2e-results"
  description = "Name of the dedicated Cloud SQL instance for E2E results. Separate from the job name to keep resource identity clear."
}

variable "network_id" {
  type        = string
  description = <<-EOT
    VPC network self-link for Cloud SQL private IP (PSA peering must already be established on
    this network — e.g. via the network module). Direct private-IP path; no Cloud SQL Auth Proxy.
  EOT
}

variable "subnet_id" {
  type        = string
  description = "Subnet self-link for Cloud Run direct VPC egress (private-ranges-only path to Cloud SQL)."
}

variable "image" {
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
  description = <<-EOT
    Full image reference for the E2E runner (forge control-plane image, digest-pinned in CI).
    Defaults to a public placeholder so the first apply creates the job resource before any
    release CI run has pushed the real image — the same placeholder-first pattern the service
    module uses. The release workflow updates the image out-of-band; TF ignores_changes on it.
  EOT
}

variable "tier" {
  type        = string
  default     = "db-f1-micro"
  description = "Cloud SQL machine tier. db-f1-micro (shared-core, 0.6 GB) — smallest correct sizing for the E2E/cp-results load."
}

variable "disk_gb" {
  type    = number
  default = 10
  description = <<-EOT
    Initial disk size in GB. disk_autoresize grows it on demand. Starting small because
    Cloud SQL disks cannot shrink — a 10 GB floor is right for this load; the app database
    started at 50 GB and was 0.11 GB in use (the lesson this number is already priced in).
  EOT
}

variable "job_timeout" {
  type        = string
  default     = "3600s"
  description = "Timeout for a single E2E runner job execution. An E2E suite can take O(minutes)."
}

# ---------------------------------------------------------------------------
# Cloud SQL: dedicated E2E / cp-results Postgres instance
# ---------------------------------------------------------------------------
# DEDICATED instance — NOT a database on dorinda-prod's application Cloud SQL.
# Isolation: separate instance, separate DB user, separate password, separate schema.
# No physical path from this instance to the production data even if credentials leaked.

resource "random_password" "db" {
  length  = 32
  special = false
  # No special chars: the password is interpolated into the postgresql:// URL — special
  # chars require percent-encoding, which every client library handles but introduces
  # a class of "works in psql but not in the app" bugs. Hex-safe avoids that class.
}

resource "google_sql_database_instance" "e2e_pg" {
  project             = var.project_id
  name                = var.sql_instance_name
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = true # a terraform destroy must not be able to take the data with it

  settings {
    # ENTERPRISE explicitly: the provider defaults to ENTERPRISE_PLUS (the +$90 tier), which
    # also rejects db-custom-* tiers. Matching the product database module.
    edition           = "ENTERPRISE"
    tier              = var.tier
    availability_type = "ZONAL" # E2E data is not HA-critical; REGIONAL is an in-place upgrade
    disk_type         = "PD_SSD"
    disk_size         = var.disk_gb
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false # private IP ONLY — no public address on this instance
      private_network = var.network_id
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 7
      }
    }

    maintenance_window {
      day  = 7 # Sunday
      hour = 8 # 08:00 UTC ≈ 3–4am US Eastern
    }
  }

  lifecycle {
    # disk_autoresize grows the disk without Terraform's involvement. Without this,
    # every plan after autoresize fires would try to shrink the disk back to disk_gb,
    # which Cloud SQL rejects — permanently red plan on a healthy growing database.
    ignore_changes = [settings[0].disk_size]
  }
}

resource "google_sql_database" "cp_results" {
  project  = var.project_id
  instance = google_sql_database_instance.e2e_pg.name
  name     = "cp_results"
}

resource "google_sql_user" "app" {
  project  = var.project_id
  instance = google_sql_database_instance.e2e_pg.name
  name     = "app"
  password = random_password.db.result
}

# ---------------------------------------------------------------------------
# Secrets: database (Terraform-seeded) + API keys + service token (OOB)
# ---------------------------------------------------------------------------

resource "google_secret_manager_secret" "db_password" {
  project   = var.project_id
  secret_id = "${var.name}-db-password"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db.result
}

resource "google_secret_manager_secret" "db_url" {
  project   = var.project_id
  secret_id = "${var.name}-db-url"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db_url" {
  secret = google_secret_manager_secret.db_url.id
  # Direct private-IP postgresql:// URL — no Cloud SQL Auth Proxy socket needed.
  # The Cloud Run Job reaches the private IP via Direct VPC Egress.
  secret_data = "postgresql://${google_sql_user.app.name}:${random_password.db.result}@${google_sql_database_instance.e2e_pg.private_ip_address}:5432/${google_sql_database.cp_results.name}"
}

# API key and service token containers: values supplied out-of-band (never in TF state).
# Operator: `gcloud secrets versions add <secret_id> --data-file=-`

resource "google_secret_manager_secret" "anthropic_key" {
  project   = var.project_id
  secret_id = "${var.name}-anthropic-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "openai_key" {
  project   = var.project_id
  secret_id = "${var.name}-openai-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "service_token" {
  project   = var.project_id
  secret_id = "${var.name}-service-token"
  replication {
    auto {}
  }
  # AUTH_SERVICE_TOKEN for minting MCP access tokens against the target app's forge instance.
  # Same token the app's data-plane uses for service-to-service auth (C10 §P34).
}

# Placeholder versions for OOB secrets — Cloud Run v2 requires ALL referenced secrets to have
# at least one version before the job resource can be created (the API validates existence of
# version "latest" at creation time). These placeholder versions allow bootstrapping; operators
# replace them out-of-band with real values. The ignore_changes lifecycle block prevents
# Terraform from reverting operator-seeded values on subsequent plan/apply cycles.
# See PROVIDER_ACCOUNTS.md § "Setting out-of-band secrets after first apply".

resource "google_secret_manager_secret_version" "anthropic_key" {
  secret      = google_secret_manager_secret.anthropic_key.id
  secret_data = "PLACEHOLDER_REPLACE_WITH_REAL_ANTHROPIC_KEY"

  lifecycle {
    # Operator adds the real value via:
    #   printf '%s' 'sk-ant-...' | gcloud secrets versions add e2e-runner-anthropic-key \
    #     --project dorinda-prod --data-file=-
    # TF must not revert the operator-seeded value on subsequent plan/apply.
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret_version" "openai_key" {
  secret      = google_secret_manager_secret.openai_key.id
  secret_data = "PLACEHOLDER_REPLACE_WITH_REAL_OPENAI_KEY"

  lifecycle {
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret_version" "service_token" {
  secret      = google_secret_manager_secret.service_token.id
  secret_data = "PLACEHOLDER_REPLACE_WITH_REAL_SERVICE_TOKEN"

  lifecycle {
    ignore_changes = [secret_data]
  }
}

# ---------------------------------------------------------------------------
# Service account (least-privilege): reads only the secrets it needs
# ---------------------------------------------------------------------------

resource "google_service_account" "runner" {
  project      = var.project_id
  account_id   = var.name
  display_name = "Forge E2E runner — Cloud Run Job SA"
}

resource "google_secret_manager_secret_iam_member" "runner_db_password" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.db_password.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runner.email}"
}

resource "google_secret_manager_secret_iam_member" "runner_db_url" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.db_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runner.email}"
}

resource "google_secret_manager_secret_iam_member" "runner_anthropic_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.anthropic_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runner.email}"
}

resource "google_secret_manager_secret_iam_member" "runner_openai_key" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.openai_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runner.email}"
}

resource "google_secret_manager_secret_iam_member" "runner_service_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.service_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runner.email}"
}

# Cloud SQL Client role: required for direct private-IP connections on Cloud SQL v2.
# The SA does NOT need cloudsql.instanceUser (direct-IP path; no Auth Proxy involved).
resource "google_project_iam_member" "runner_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.runner.email}"
}

# ---------------------------------------------------------------------------
# Cloud Run Job: E2E runner
# ---------------------------------------------------------------------------
# max_retries = 0: E2E is not idempotent — each execution mints a new run ID and writes
# to cp_results. An automatic retry would create a duplicate run, not fix the first one.
#
# vpc_access.egress = PRIVATE_RANGES_ONLY: Cloud SQL private IP is a private range and
# routes through the VPC; Anthropic/OpenAI/target-app calls are public and go direct
# (no NAT hairpin needed, and the subnet has private_ip_google_access = true for GCP APIs).
#
# image: placeholder at first apply; the release workflow updates it digest-pinned,
# same as the service module. ignore_changes keeps TF from fighting the release CI.

resource "google_cloud_run_v2_job" "runner" {
  project  = var.project_id
  location = var.region
  name     = var.name

  # google provider v6 added deletion_protection to Cloud Run v2 Jobs (defaults to true).
  # The job holds no durable state (all state is in Cloud SQL), so accidental deletion is
  # not a data-loss risk — set false to allow Terraform to manage the lifecycle.
  deletion_protection = false

  # Cloud Run v2 validates that all referenced secrets have a "latest" version at job creation
  # time. Without explicit depends_on, Terraform may attempt to create the job concurrently
  # with (or before) the secret versions, causing the GCP API to reject the job with "secret
  # version not found". The depends_on ensures versions exist before the job resource is sent
  # to the API.
  depends_on = [
    google_secret_manager_secret_version.db_url,
    google_secret_manager_secret_version.anthropic_key,
    google_secret_manager_secret_version.openai_key,
    google_secret_manager_secret_version.service_token,
  ]

  template {
    # task_count = 1 (default): each E2E run is a single sequential task.
    parallelism = 1
    task_count  = 1

    template {
      service_account = google_service_account.runner.email
      max_retries     = 0
      timeout         = var.job_timeout

      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          subnetwork = var.subnet_id
        }
      }

      containers {
        image = var.image

        # cp-results backend: use FORGE_DB_URL (the single connection-string secret).
        env {
          name = "FORGE_DB_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.db_url.secret_id
              version = "latest"
            }
          }
        }

        # Enable the Postgres cp-results backend (filesystem backend is the default).
        env {
          name  = "FORGE_CP_RESULTS_BACKEND"
          value = "postgres"
        }

        env {
          name = "ANTHROPIC_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.anthropic_key.secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "OPENAI_API_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.openai_key.secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "AUTH_SERVICE_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.service_token.secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    # The release workflow updates the image digest out-of-band (forge release-image or CI).
    # Without this, every plan that sees the CI-stamped digest would propose a replacement.
    ignore_changes = [template[0].template[0].containers[0].image]
  }
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "sql_instance_name" {
  value       = google_sql_database_instance.e2e_pg.name
  description = "Cloud SQL instance name (for gcloud / connection-string reference)."
}

output "sql_connection_name" {
  value       = google_sql_database_instance.e2e_pg.connection_name
  description = "Cloud SQL connection name (project:region:instance)."
}

output "sql_private_ip" {
  value       = google_sql_database_instance.e2e_pg.private_ip_address
  description = "Private IP of the Cloud SQL instance (direct VPC connection)."
}

output "runner_service_account" {
  value       = google_service_account.runner.email
  description = "SA email for the Cloud Run Job (least-privilege, reads only its own secrets)."
}

output "job_name" {
  value       = google_cloud_run_v2_job.runner.name
  description = "Cloud Run Job name — trigger via: gcloud run jobs execute <name> --region <region>"
}

output "db_url_secret" {
  value       = google_secret_manager_secret.db_url.secret_id
  description = "Secret ID for the composed postgresql:// URL (FORGE_DB_URL)."
}

output "db_password_secret" {
  value       = google_secret_manager_secret.db_password.secret_id
  description = "Secret ID for the raw database password (for break-glass / rotation)."
}
