# forge stack — root terraform configuration.
#
# Provisions the forge platform's own GCP resources in dorinda-prod.
# State: gs://dorinda-tf-state/stacks/forge/<env>
# Backend init (CI / operator): terraform -chdir=infra init \
#   -backend-config=bucket=dorinda-tf-state \
#   -backend-config=prefix=stacks/forge/prod-a
#
# The forge infra CLI (forge infra plan/apply --env prod-a) handles init + var injection + §3.7
# read-back convergence check automatically.

terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
  # Backend block is intentionally EMPTY — bucket and prefix are injected at init time via
  # -backend-config flags (forge infra CLI / CI workflow). Hard-coding them here would prevent
  # the same config from being used across envs and would put the bucket name in git.
  backend "gcs" {}
}

# ---------------------------------------------------------------------------
# Variables — injected by the forge infra CLI from forge.infra.json envs
# ---------------------------------------------------------------------------

variable "project_id" { type = string }
variable "region" { type = string }
variable "env_name" { type = string }

# runner_image — the E2E runner's container.
#
# ⛔ This is forge-hat (the acceptance harness), NOT forge's control plane. It was previously wired
# to `ghcr.io/<owner>/forge-control-plane:latest`, which is the wrong program AND unpullable by
# Cloud Run (GHCR needs auth; the job went Ready=False with ContainerImageUnauthorized and every
# "Run tests" click failed with FAILED_PRECONDITION, 2026-08-13).
#
# The live value is owned by forge-hat's publish-image workflow, which rolls the job by digest on
# every release and verifies the read-back; the module carries ignore_changes on the image so
# Terraform does not revert it. This variable therefore only supplies the FIRST value, before any
# forge-hat release has run.
variable "runner_image" {
  type    = string
  default = "us-east1-docker.pkg.dev/dorinda-prod/forge-hat/app:latest"
}

# platform contract — written by forge infra CLI as contract.auto.tfvars.json after reading
# the foundation stack's published contract. Declared here to satisfy terraform variable
# resolution; values are not consumed directly (data sources resolve VPC/subnet instead).
variable "platform" {
  type    = any
  default = {}
}

# ---------------------------------------------------------------------------
# hat-remote environment variables — mirrors .hat/env (the forge-hat harness
# reads these when `hat remote` is invoked). Values are passed to the e2e_runner
# module, which wires them as env vars on the Cloud Run Job template.
# ---------------------------------------------------------------------------

variable "mcp_endpoint" {
  type        = string
  default     = "https://dorinda.ai/mcp"
  description = <<-EOT
    MCP server URL for the dorinda target app. Passed to e2e-runner as DORINDA_MCP_ENDPOINT
    (stored in SM so URL can rotate without a TF re-apply). Override via TF_VAR_mcp_endpoint
    or a .tfvars file if the endpoint differs between environments.
  EOT
}

variable "test_control_url" {
  type        = string
  default     = "https://api.dorinda.ai"
  description = "Dorinda test-control API origin. Passed to e2e-runner as DORINDA_TEST_CONTROL_URL."
}

variable "tenant" {
  type = string
  # The standing acceptance tenant's OWNER ID. ⛔ Not the email: `hat remote` looks the tenant up
  # by owner id, and an email here fails as "tenant exists but is not flagged as a test tenant" —
  # an error that points at the tenant's flag rather than at this value, and costs an hour.
  default     = "user_54f358ae87974f43b5e0"
  description = <<-EOT
    Test tenant OWNER ID the harness runs against (robin@dorinda.test).
    Passed to e2e-runner as DORINDA_TEST_TENANT — the name `hat remote` reads.
    Set via TF_VAR_tenant or a .tfvars file; empty = harness falls back to its own default.
  EOT
}

variable "e2e_provider" {
  type        = string
  default     = "anthropic"
  description = "LLM provider for e2e runs (anthropic | openai). Passed to e2e-runner as E2E_PROVIDER."
}

variable "e2e_model" {
  type        = string
  default     = ""
  description = "LLM model for e2e runs. Empty = provider default. Passed to e2e-runner as E2E_MODEL."
}

# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "random" {}

# ---------------------------------------------------------------------------
# Data sources — resolve existing dorinda VPC / subnet
# ---------------------------------------------------------------------------
# The network and subnet were created by the shared-infra foundation stack; forge consumes
# them via data sources (§2.5 rule 2: never read another stack's state directly).

data "google_compute_network" "vpc" {
  project = var.project_id
  name    = "dorinda"
}

data "google_compute_subnetwork" "subnet" {
  project = var.project_id
  region  = var.region
  # Convention from the network module: <vpc-name>-<region>
  name = "dorinda-${var.region}"
}

# ---------------------------------------------------------------------------
# E2E runner — dedicated Cloud SQL (e2e-results) + Cloud Run Job (e2e-runner)
# ---------------------------------------------------------------------------
# Mark's apply approval: 2026-08-11.
# Cost: ~$7–10/mo (db-f1-micro Cloud SQL) + $0 at rest for the Cloud Run Job.
# Separation invariant: this Cloud SQL instance is NEVER shared with dorinda-pg.
# Re-apply 2026-08-11: previous CI run cancelled after 11m (in-progress SQL creation);
# no resources exist yet — this apply is the first successful one, NON-ZERO changes expected.

module "e2e_runner" {
  source = "../terraform/modules/e2e-runner"

  project_id        = var.project_id
  region            = var.region
  network_id        = data.google_compute_network.vpc.id
  subnet_id         = data.google_compute_subnetwork.subnet.id
  name              = "e2e-runner"
  sql_instance_name = "e2e-results"
  tier              = "db-f1-micro"
  # image: first value only — forge-hat's publish-image workflow owns it thereafter (rolled by
  # digest, read back, and protected from revert by the module's ignore_changes).
  image = var.runner_image
  # invoker_member: hardcoded to the forge-console SA — this is the only member that needs
  # job-level run.invoker; if the SA email ever changes, update here and re-apply.
  invoker_member = "serviceAccount:run-forge-console@${var.project_id}.iam.gserviceaccount.com"

  # hat-remote environment — passed through to the Cloud Run Job template.
  # These variables mirror exactly what `hat remote` reads (.hat/env contract).
  mcp_endpoint     = var.mcp_endpoint
  test_control_url = var.test_control_url
  tenant           = var.tenant
  e2e_provider     = var.e2e_provider
  e2e_model        = var.e2e_model
}

# ---------------------------------------------------------------------------
# Outputs (available via forge infra outputs --env prod-a)
# ---------------------------------------------------------------------------

output "e2e_sql_instance_name" {
  value       = module.e2e_runner.sql_instance_name
  description = "Cloud SQL instance name for the E2E results backend."
}

output "e2e_sql_connection_name" {
  value       = module.e2e_runner.sql_connection_name
  description = "Cloud SQL connection name (project:region:instance)."
}

output "e2e_job_name" {
  value       = module.e2e_runner.job_name
  description = "Cloud Run Job name for the E2E runner."
}

output "e2e_runner_sa" {
  value       = module.e2e_runner.runner_service_account
  description = "Service account email for the E2E runner job."
}
