# forge module: backend — a SECOND LB backend over an EXISTING Cloud Run service.
#
# Exists for exactly one topology (found at authoring, 2026-07-29): mcp.dorinda.ai and
# api.dorinda.ai are two hosts over the SAME app, but the mcp backend must add the client_cert_*
# mTLS headers (§9.4b) and the api one must not. Instantiating the service module twice would
# duplicate the Cloud Run service; this module adds only NEG + backend service over it.

variable "project_id" { type = string }
variable "region" { type = string }
variable "name" { type = string }
variable "cloud_run_service" {
  type        = string
  description = "name of the EXISTING Cloud Run service this backend fronts"
}
variable "mtls_headers" {
  type    = bool
  default = false
}

resource "google_compute_region_network_endpoint_group" "neg" {
  project               = var.project_id
  region                = var.region
  name                  = "${var.name}-neg"
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = var.cloud_run_service
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

  # §9.4b: names are load-bearing — dorinda-api's mcp-mtls.ts reads exactly these, and fails
  # CLOSED when the verdict header is absent.
  custom_request_headers = var.mtls_headers ? [
    "X-Client-Cert-Leaf:{client_cert_leaf}",
    "X-Client-Cert-Chain-Verified:{client_cert_chain_verified}",
  ] : null
}

output "backend_self_link" { value = google_compute_backend_service.backend.self_link }
