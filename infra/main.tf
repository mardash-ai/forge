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

# platform contract — written by forge infra CLI as contract.auto.tfvars.json after reading
# the foundation stack's published contract. Declared here to satisfy terraform variable
# resolution; values are not consumed directly (data sources resolve VPC/subnet instead).
variable "platform" {
  type    = any
  default = {}
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

module "e2e_runner" {
  source = "../terraform/modules/e2e-runner"

  project_id        = var.project_id
  region            = var.region
  network_id        = data.google_compute_network.vpc.id
  subnet_id         = data.google_compute_subnetwork.subnet.id
  name              = "e2e-runner"
  sql_instance_name = "e2e-results"
  tier              = "db-f1-micro"
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
