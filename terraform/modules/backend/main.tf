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
/**
 * Optional PATH-SCOPED IP allow-list (Cloud Armor), for surfaces that should only be reachable from
 * known egress — the acceptance harness's test-control routes being the motivating case
 * (HAT-PLAN-003 §13 q14).
 *
 * ⛔ SCOPED BY PATH, NOT BY BACKEND. One backend service fronts the WHOLE app, so an allow-list on
 * the backend would restrict every route the product has. Cloud Armor evaluates a CEL expression,
 * so the rule can say "this path prefix, from these ranges" and leave the rest of the API alone.
 *
 * ⛔ DEFAULT OFF, and off means ABSENT — no policy resource is created when `paths` is empty. A
 * capability that ships enforcing something is a capability that locks somebody out on the day it
 * lands; this one does nothing until an operator supplies both a path prefix and the ranges, which
 * is also the only point at which they can know what those ranges are.
 */
variable "restricted_paths" {
  type = object({
    paths      = optional(list(string), [])
    allow_cidrs = optional(list(string), [])
  })
  default = { paths = [], allow_cidrs = [] }
  validation {
    // Allowing paths with no ranges would deny EVERYONE, including the operator who just applied
    // it. Refuse at plan time rather than at 3am.
    condition     = length(var.restricted_paths.paths) == 0 || length(var.restricted_paths.allow_cidrs) > 0
    error_message = "restricted_paths.paths is set with no allow_cidrs — that would deny every caller, including you. Supply the ranges."
  }
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

locals {
  # One policy only when there is something to restrict — see the variable's DEFAULT OFF note.
  armor_enabled = length(var.restricted_paths.paths) > 0
}

resource "google_compute_security_policy" "paths" {
  count   = local.armor_enabled ? 1 : 0
  project = var.project_id
  name    = "${var.name}-restricted-paths"

  # DENY the restricted paths from anywhere outside the allow-list. Evaluated before the default.
  rule {
    action   = "deny(403)"
    priority = 1000
    match {
      expr {
        expression = join(" && ", [
          "(${join(" || ", [for p in var.restricted_paths.paths : "request.path.startsWith('${p}')"])})",
          "!(inIpRange(origin.ip, '${join("') || inIpRange(origin.ip, '", var.restricted_paths.allow_cidrs)}'))",
        ])
      }
    }
    description = "restricted paths reachable only from the allow-list"
  }

  # Everything else is untouched — this policy exists to narrow a few paths, not to gate the app.
  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config { src_ip_ranges = ["*"] }
    }
    description = "default allow — the rest of the API is unaffected"
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

  security_policy = local.armor_enabled ? google_compute_security_policy.paths[0].id : null

  # §9.4b: names are load-bearing — dorinda-api's mcp-mtls.ts reads exactly these, and fails
  # CLOSED when the verdict header is absent.
  custom_request_headers = var.mtls_headers ? [
    "X-Client-Cert-Leaf:{client_cert_leaf}",
    "X-Client-Cert-Chain-Verified:{client_cert_chain_verified}",
  ] : null
}

output "backend_self_link" { value = google_compute_backend_service.backend.self_link }
