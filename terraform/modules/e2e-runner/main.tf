# NOTE (2026-08-13): this module's changes apply ONLY on a push that touches infra/**,
# forge.infra.json, or terraform/modules/e2e-runner/**. A manual `workflow_dispatch` of infra.yml
# runs PLAN, not apply (the apply step is gated on event_name == 'push'), so dispatching it to
# "apply a fix" reports success and changes nothing — which is how the wrong entrypoint survived
# three separate attempts to remove it.
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
    In practice always overridden by the infra CI: the workflow resolves the current GHCR digest
    of ghcr.io/<owner>/forge-control-plane:latest and passes it as TF_VAR_runner_image (wired
    through infra/main.tf → var.runner_image → this var). The default placeholder is only
    reached on a completely out-of-band local apply where the CI step cannot run.
  EOT
}

variable "invoker_member" {
  type        = string
  default     = "serviceAccount:run-forge-console@dorinda-prod.iam.gserviceaccount.com"
  description = <<-EOT
    IAM member granted roles/run.invoker on this job resource ONLY (job-level, not project-level).
    The console SA needs this to trigger the job via the Cloud Run API; no other job is affected.
    Default: run-forge-console in dorinda-prod — override when adopting in a different project.
  EOT
}

variable "tier" {
  type        = string
  default     = "db-f1-micro"
  description = "Cloud SQL machine tier. db-f1-micro (shared-core, 0.6 GB) — smallest correct sizing for the E2E/cp-results load."
}

variable "disk_gb" {
  type        = number
  default     = 10
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
# hat-remote environment — mirrors exactly what the forge-hat binary reads
# when `hat remote` is invoked (the .hat/env contract).
# ---------------------------------------------------------------------------

variable "mcp_endpoint" {
  type        = string
  description = <<-EOT
    MCP server URL for the target app (e.g. https://dorinda.ai/mcp).
    Stored in Secret Manager (e2e-runner-mcp-endpoint) so the URL can be
    rotated without a TF re-apply — wired as DORINDA_MCP_ENDPOINT.
    Secret value is set out-of-band; this variable seeds the initial SM secret.
  EOT
}

variable "test_control_url" {
  type        = string
  description = <<-EOT
    Dorinda test-control API origin (e.g. https://api.dorinda.ai).
    Wired as DORINDA_TEST_CONTROL_URL — plain env var (not a credential, just a URL).
  EOT
}

variable "tenant" {
  type        = string
  default     = ""
  description = <<-EOT
    Test tenant identity (email address or owner ID) the harness runs against.
    Wired as DORINDA_TENANT — plain env var; override at invocation time if tests
    span multiple tenants. Empty string ⇒ harness picks a default from its own config.
  EOT
}

variable "e2e_provider" {
  type        = string
  default     = "anthropic"
  description = "LLM provider for e2e runs (anthropic | openai). Wired as E2E_PROVIDER. Override at invocation time."
}

variable "e2e_model" {
  type        = string
  default     = ""
  description = "LLM model for e2e runs. Wired as E2E_MODEL. Empty = provider's default model."
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

# API key containers: values supplied out-of-band (never in TF state).
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

# ---------------------------------------------------------------------------
# hat-remote durable credential containers (replace AUTH_SERVICE_TOKEN)
#
# The mint change (t1) switches from a static DORINDA_MCP_TOKEN to an OAuth
# refresh-token flow. Three SM secrets carry the durable credential set:
#   • e2e-runner-mcp-endpoint     → DORINDA_MCP_ENDPOINT
#   • e2e-runner-mcp-refresh-token → DORINDA_MCP_REFRESH_TOKEN
#   • e2e-runner-mcp-client-id     → DORINDA_MCP_CLIENT_ID
#
# A fourth secret carries the test-control surface credential:
#   • e2e-runner-test-control-token → DORINDA_TEST_CONTROL_TOKEN
#
# How to mint each value is documented in PROVIDER_ACCOUNTS.md.
# ---------------------------------------------------------------------------

resource "google_secret_manager_secret" "mcp_endpoint" {
  project   = var.project_id
  secret_id = "${var.name}-mcp-endpoint"
  replication {
    auto {}
  }
  # DORINDA_MCP_ENDPOINT — the MCP server URL (e.g. https://dorinda.ai/mcp).
  # Stored in SM so the URL can be updated without a TF re-apply.
}

resource "google_secret_manager_secret" "mcp_refresh_token" {
  project   = var.project_id
  secret_id = "${var.name}-mcp-refresh-token"
  replication {
    auto {}
  }
  # DORINDA_MCP_REFRESH_TOKEN — OAuth refresh token for the hat harness's MCP client.
  # Minted by completing an authorization_code flow on the dorinda MCP server and storing
  # the resulting refresh_token. See PROVIDER_ACCOUNTS.md for the exact minting procedure.
}

resource "google_secret_manager_secret" "mcp_client_id" {
  project   = var.project_id
  secret_id = "${var.name}-mcp-client-id"
  replication {
    auto {}
  }
  # DORINDA_MCP_CLIENT_ID — the OAuth client ID assigned to the hat harness by DCR on
  # the dorinda MCP server. See PROVIDER_ACCOUNTS.md for the minting procedure.
}

resource "google_secret_manager_secret" "test_control_token" {
  project   = var.project_id
  secret_id = "${var.name}-test-control-token"
  replication {
    auto {}
  }
  # DORINDA_TEST_CONTROL_TOKEN — auth token for the dorinda test-control surface
  # (POST /api/test/tenants, DELETE /api/test/tenants/:id, etc.).
  # See PROVIDER_ACCOUNTS.md for the minting procedure.
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

# ── Placeholder versions: terraform owns the CONTAINER, an operator owns the VALUE ────────────────
#
# Each secret below is created with a placeholder version and `ignore_changes = [secret_data]`, so
# terraform never holds a real credential and never fights the operator over its value.
#
# ⚠️ The placeholder is the LATEST version until someone adds a real one. The job resolves these by
# `latest`, so between the apply and the operator's `versions add` the runner starts and then
# authenticates with the literal string "PLACEHOLDER_…". That surfaces as a confusing rejection from
# Dorinda rather than an honest missing-credential error — the run looks like a product failure when
# it is an unfinished setup. Adding the real versions is part of the apply, not a follow-up.
#
# ⛔ Do NOT pre-create these secrets by hand ahead of the code. On 2026-08-13 they were created
# early to "unblock" this wiring, and the apply died on `409 already exists` for three of them,
# leaving a partial apply in which the job had no MCP env at all — so every console run kept exiting
# 2 within twenty-five seconds. Let terraform create the containers, then add versions on top.
resource "google_secret_manager_secret_version" "mcp_endpoint" {
  secret      = google_secret_manager_secret.mcp_endpoint.id
  secret_data = "PLACEHOLDER_REPLACE_WITH_MCP_ENDPOINT_URL"

  lifecycle {
    # Operator sets the real MCP server URL:
    #   printf '%s' 'https://dorinda.ai/mcp' | gcloud secrets versions add e2e-runner-mcp-endpoint \
    #     --project dorinda-prod --data-file=-
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret_version" "mcp_refresh_token" {
  secret      = google_secret_manager_secret.mcp_refresh_token.id
  secret_data = "PLACEHOLDER_REPLACE_WITH_MCP_REFRESH_TOKEN"

  lifecycle {
    # See PROVIDER_ACCOUNTS.md for the OAuth minting procedure.
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret_version" "mcp_client_id" {
  secret      = google_secret_manager_secret.mcp_client_id.id
  secret_data = "PLACEHOLDER_REPLACE_WITH_MCP_CLIENT_ID"

  lifecycle {
    # See PROVIDER_ACCOUNTS.md for the DCR minting procedure.
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret_version" "test_control_token" {
  secret      = google_secret_manager_secret.test_control_token.id
  secret_data = "PLACEHOLDER_REPLACE_WITH_TEST_CONTROL_TOKEN"

  lifecycle {
    # See PROVIDER_ACCOUNTS.md for the minting procedure.
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

# hat-remote durable credentials — least-privilege secretAccessor on each secret only.
resource "google_secret_manager_secret_iam_member" "runner_mcp_endpoint" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.mcp_endpoint.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runner.email}"
}

resource "google_secret_manager_secret_iam_member" "runner_mcp_refresh_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.mcp_refresh_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runner.email}"
}

resource "google_secret_manager_secret_iam_member" "runner_mcp_client_id" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.mcp_client_id.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runner.email}"
}

resource "google_secret_manager_secret_iam_member" "runner_test_control_token" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.test_control_token.secret_id
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

  # The image is owned by forge-hat's publish-image workflow, which rolls this job by digest on
  # every release and reads the value back. Terraform must not fight it.
  #
  # This block was DOCUMENTED above ("the release workflow updates the image out-of-band; TF
  # ignores_changes on it") but never actually written, so every apply reverted the published
  # runner image — and, worse, replaced it with `ghcr.io/<owner>/forge-control-plane`, an image
  # Cloud Run cannot pull (ContainerImageUnauthorized) and the wrong program besides: the E2E
  # runner is forge-hat, the acceptance harness, not forge's control plane. The job sat Ready=False
  # and every click of "Run tests" answered FAILED_PRECONDITION (2026-08-13).
  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image]
  }

  labels = {
    managed-by = "terraform"
    stack      = "forge"
    purpose    = "e2e-runner"
  }

  # google provider v6 added deletion_protection to Cloud Run v2 Jobs (defaults to true).
  # The job holds no durable state (all state is in Cloud SQL), so accidental deletion is
  # not a data-loss risk — set false to allow Terraform to manage the lifecycle fully
  # (destroy+recreate without a two-step apply ceremony).
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
    google_secret_manager_secret_version.mcp_endpoint,
    google_secret_manager_secret_version.mcp_refresh_token,
    google_secret_manager_secret_version.mcp_client_id,
    google_secret_manager_secret_version.test_control_token,
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

        # ⛔ NO command/args override. This job runs FORGE-HAT — the acceptance harness — whose
        # image already declares the right entrypoint and default command:
        #
        #   ENTRYPOINT ["node", "--experimental-strip-types", "src/cli/main.ts"]
        #   CMD        ["remote", "--suite", "full", "--record", "--provider", "openai"]
        #
        # This block used to force `./node_modules/.bin/tsx src/cli/index.ts eval` — forge's own
        # eval CLI, which does not exist in the forge-hat image (no tsx binary, no src/cli/index.ts,
        # no `eval` command). The container could not exec at all, so the first real click died
        # instantly with "Application failed to start" instead of running the suite (2026-08-13).
        #
        # Scope and provider reach the run as ENVIRONMENT variables (E2E_SUITE, E2E_WORKFLOWS,
        # E2E_PROVIDER, set by POST /api/e2e/runs), not as argv — so nothing here needs to vary
        # per invocation. Leaving both unset means the image is the single source of truth for how
        # it is started, and a forge-hat change to its own entrypoint cannot be silently overridden
        # by this stack.

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

        # -------------------------------------------------------------------------
        # hat-remote credential set — mirrors .hat/env exactly (no extras, no less).
        #
        # MCP durable credentials (replaces AUTH_SERVICE_TOKEN / DORINDA_MCP_TOKEN):
        #   DORINDA_MCP_ENDPOINT      — MCP server URL; in SM so URL changes need no re-apply.
        #   DORINDA_MCP_REFRESH_TOKEN — OAuth refresh token; hat mints short-lived access tokens.
        #   DORINDA_MCP_CLIENT_ID     — DCR-assigned client ID paired with the refresh token.
        #
        # Test-control surface:
        #   DORINDA_TEST_CONTROL_URL   — origin for POST/DELETE /api/test/tenants/*.
        #   DORINDA_TEST_CONTROL_TOKEN — auth token for that surface (x-dorinda-test-token header).
        #
        # Tenant identity:
        #   DORINDA_TENANT — email / owner ID the harness runs against.
        #
        # Provider / model selection:
        #   E2E_PROVIDER — which LLM provider (anthropic | openai). Override at invocation time.
        #   E2E_MODEL    — which model. Empty = provider default. Override at invocation time.
        # -------------------------------------------------------------------------

        env {
          name = "DORINDA_MCP_ENDPOINT"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.mcp_endpoint.secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "DORINDA_MCP_REFRESH_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.mcp_refresh_token.secret_id
              version = "latest"
            }
          }
        }

        env {
          name = "DORINDA_MCP_CLIENT_ID"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.mcp_client_id.secret_id
              version = "latest"
            }
          }
        }

        env {
          name  = "DORINDA_TEST_CONTROL_URL"
          value = var.test_control_url
        }

        env {
          name = "DORINDA_TEST_CONTROL_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.test_control_token.secret_id
              version = "latest"
            }
          }
        }

        env {
          name  = "DORINDA_TENANT"
          value = var.tenant
        }

        env {
          name  = "E2E_PROVIDER"
          value = var.e2e_provider
        }

        env {
          name  = "E2E_MODEL"
          value = var.e2e_model
        }
      }
    }
  }

}
# image lifecycle note: no ignore_changes on the image field. The infra CI (infra.yml) resolves
# the current GHCR digest in the t-runner-image step and passes it as TF_VAR_runner_image on every
# plan/apply. Because the step always reads the live GHCR :latest digest, the declared value
# converges with the running job's image — no spurious diffs. Release CI (publish-image.yml) pushes
# a new :latest after every tagged release; the next infra run picks it up via the same digest lookup.

# ---------------------------------------------------------------------------
# IAM: console invoker — job-level only, not project-level
# ---------------------------------------------------------------------------
# The forge console SA needs roles/run.invoker on THIS job so it can call
# POST /apis/run.googleapis.com/v1/namespaces/{project}/jobs/{name}:run.
# Binding is on the job resource — not the project — so the console can start
# only the e2e-runner job, not any other Cloud Run resource in dorinda-prod.

resource "google_cloud_run_v2_job_iam_member" "console_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.runner.name
  role     = "roles/run.invoker"
  member   = var.invoker_member
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
