# forge module: service — one product service on Cloud Run (plan §2.2 "product services" tier).
#
# Owns everything ONLY this service can break: the Cloud Run service, its service account (least
# privilege — it gets secretAccessor on ITS secrets, not the project), its Artifact Registry repo,
# its Secret Manager containers, and its LB backend service + serverless NEG. The URL-map ENTRY
# stays in the foundation repo (§2.4) — onboarding = apply here, then one host_backends line there.
#
# Secrets: this module creates the CONTAINERS; values are supplied by the operator out-of-band
# (`gcloud secrets versions add` / a forge prompt — RUNBOOK Part 5). Terraform never sees a value.
#
# Ingress is INTERNAL_AND_GCLB: nothing reaches the service except through the LB (and the mTLS
# host's guard headers cannot be spoofed from outside, because the only path in sets them).

variable "project_id" { type = string }
variable "region" { type = string }
variable "name" { type = string }
variable "image" {
  type        = string
  description = "full image ref (digest-pinned in real deploys; a public placeholder at first apply)"
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}
variable "env" {
  type        = map(string)
  default     = {}
  description = "plain (non-secret) environment"
}
variable "secret_env" {
  type        = map(string)
  default     = {}
  description = "ENV_NAME → secret_id. Containers created here; values added out-of-band (RUNBOOK Part 5)."
}
variable "subnet_id" {
  type        = string
  description = "subnet for Direct VPC egress (private ranges only — no NAT needed)"
}
variable "sql_connection_name" {
  type        = string
  default     = ""
  description = "Cloud SQL connection for the sidecar-less private-IP path; empty = no DB"
}
variable "min_instances" {
  type    = number
  default = 0
}
variable "port" {
  type    = number
  default = 3000
}
variable "invoker_iam_disabled" {
  type        = bool
  default     = true
  description = <<-EOT
    Normally true (Domain Restricted Sharing rejects allUsers; LB-only ingress is the boundary).
    CONFIGURABLE for one reason: the field forces REPLACEMENT on services created before it existed,
    and the provider requires deletion_protection=false to be applied IN-PLACE first. The two-phase
    dance: pin false (apply #1 = in-place, unlocks protection) → flip true (apply #2 = replacement).
  EOT
}
variable "vpc_egress" {
  type        = string
  default     = "PRIVATE_RANGES_ONLY"
  description = "ALL_TRAFFIC when this service must CALL an internal-ingress Cloud Run service (requests then traverse the VPC and count as internal; non-Google outbound rides Cloud NAT)."
}
variable "external_secret_env" {
  type        = map(string)
  default     = {}
  description = "ENV → EXISTING secret_id, referenced not created — for secrets whose container is declared elsewhere in the consuming stack (e.g. a TF-composed DATABASE_URL). Creating it here too would 409 (hit live)."
}
variable "secret_files" {
  type        = map(string)
  default     = {}
  description = "mount path -> secret_id. For config files the box bind-mounted (forge.jobs.json etc.); value = file content, added out-of-band like any secret."
}
variable "mtls_headers" {
  type        = bool
  default     = false
  description = <<-EOT
    Add the client_cert_* custom request headers on the BACKEND SERVICE (the mcp host only).
    Names are load-bearing: dorinda-api's mcp-mtls.ts reads exactly x-client-cert-leaf and
    x-client-cert-chain-verified, and fails CLOSED when the verdict header is absent — so a typo
    here breaks requests loudly rather than silently disabling enforcement (§9.4b).
  EOT
}

resource "google_artifact_registry_repository" "repo" {
  project       = var.project_id
  location      = var.region
  repository_id = var.name
  format        = "DOCKER"
}

resource "google_service_account" "svc" {
  project      = var.project_id
  account_id   = "run-${var.name}"
  display_name = "Cloud Run · ${var.name}"
}

resource "google_secret_manager_secret" "file_secrets" {
  for_each  = var.secret_files
  project   = var.project_id
  secret_id = each.value
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "file_access" {
  for_each  = var.secret_files
  project   = var.project_id
  secret_id = google_secret_manager_secret.file_secrets[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.svc.email}"
}

resource "google_secret_manager_secret_iam_member" "external_access" {
  for_each  = var.external_secret_env
  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.svc.email}"
}

resource "google_secret_manager_secret" "secrets" {
  for_each  = var.secret_env
  project   = var.project_id
  secret_id = each.value
  replication {
    auto {}
  }
}

# Least privilege: THIS service account can read THESE secrets — never roles on the project.
resource "google_secret_manager_secret_iam_member" "access" {
  for_each  = var.secret_env
  project   = var.project_id
  secret_id = google_secret_manager_secret.secrets[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.svc.email}"
}

resource "google_cloud_run_v2_service" "svc" {
  project  = var.project_id
  location = var.region
  name     = var.name
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  # See the note below: replaces the allUsers invoker grant that Domain Restricted Sharing rejects.
  invoker_iam_disabled = var.invoker_iam_disabled
  # STATELESS by design — all state is in Cloud SQL (which keeps ITS deletion protection) and
  # Secret Manager. The provider default (true) blocked a legitimate field-change replacement live;
  # protecting a stateless service only protects downtime.
  deletion_protection = false

  template {
    service_account = google_service_account.svc.email
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = 10
    }

    vpc_access {
      egress = var.vpc_egress
      network_interfaces {
        subnetwork = var.subnet_id
      }
    }

    dynamic "volumes" {
      for_each = var.secret_files
      content {
        name = replace(basename(volumes.key), ".", "-")
        secret {
          secret = volumes.value
          items {
            version = "latest"
            path    = basename(volumes.key)
          }
        }
      }
    }

    containers {
      image = var.image
      ports {
        container_port = var.port
      }

      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "volume_mounts" {
        for_each = var.secret_files
        content {
          name       = replace(basename(volume_mounts.key), ".", "-")
          mount_path = dirname(volume_mounts.key)
        }
      }

      dynamic "env" {
        for_each = var.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.secrets[env.key].secret_id
              version = "latest"
            }
          }
        }
      }

      dynamic "env" {
        for_each = var.external_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      # forge release moves the image; forge infra must not fight it (§3.3 — infra vs code).
      template[0].containers[0].image,
      # the API back-fills a SERVICE-level scaling{} block with zeros that we never declare (we
      # scale per-revision in template.scaling) — a perma-diff the §3.7 read-back refused, live.
      scaling,
      # release-image (gcloud) stamps its client fingerprint on every roll; the code plane is
      # SUPPOSED to touch the service, so infra ignores its telemetry (first nightly drift catch).
      client,
      client_version,
    ]
  }
}

# NO allUsers invoker grant — Workspace orgs enforce Domain Restricted Sharing by default and
# REJECT allUsers in IAM policies ("users named in the policy do not belong to a permitted
# customer" — hit live, first service apply). `invoker_iam_disabled` on the service (below) is the
# cleaner boundary anyway: ingress INTERNAL_AND_GCLB means only the LB can reach it regardless.

resource "google_compute_region_network_endpoint_group" "neg" {
  project               = var.project_id
  region                = var.region
  name                  = "${var.name}-neg"
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.svc.name
  }
}

resource "google_compute_backend_service" "backend" {
  project               = var.project_id
  name                  = "${var.name}-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"

  backend {
    group = google_compute_region_network_endpoint_group.neg.id
  }

  # §9.4b: the mcp backend forwards the edge's mTLS verdict to the app. The app REQUIRES the
  # chain-verified header ("missing verdict = failure"), so mis-wiring here fails closed, not open.
  # NOTE: a list ATTRIBUTE, not a block — `dynamic "custom_request_headers"` fails terraform
  # validate (caught by lint before any CI run).
  custom_request_headers = var.mtls_headers ? [
    "X-Client-Cert-Leaf:{client_cert_leaf}",
    "X-Client-Cert-Chain-Verified:{client_cert_chain_verified}",
  ] : null
}

output "service_name" { value = google_cloud_run_v2_service.svc.name }
output "service_uri" { value = google_cloud_run_v2_service.svc.uri }
output "backend_self_link" { value = google_compute_backend_service.backend.self_link }
output "artifact_repo" { value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.repo.repository_id}" }
output "service_account" { value = google_service_account.svc.email }
