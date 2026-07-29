# forge module: edge — the product's global external entry: DNS, certs, LB, and the mTLS host.
#
# TWO ENTRY POINTS, deliberately (mirrors the proven Traefik topology; see dorinda-api
# src/platform/mcp-mtls.ts):
#
#   MAIN  — one global IP + HTTPS proxy for the browser/API hosts (site, www, app, api). NO client
#           cert is ever requested here: attaching an mTLS ServerTlsPolicy to a shared proxy would
#           make browsers that carry client certs show a certificate picker on app.<domain>.
#   MCP   — a SECOND global IP + proxy for ONLY the mTLS host. Client validation mode is
#           ALLOW_INVALID_OR_MISSING_CLIENT_CERT — REJECT_INVALID would break the CERTLESS
#           /.well-known discovery OpenAI's submission portal requires (it broke the Create-plugin
#           flow once; ACCEPTANCE §5f MTLS-2). The app fails closed instead, reading the
#           client_cert_* headers the mcp backend service must add (service module, mtls_headers).
#
# THE §2.4 SEAM: the URL map is a singleton here, but each service owns its backend service. This
# module takes `host_backends` (host → backend-service self link). Onboarding a service = create the
# backend in the service repo, then add one entry here. Hosts without a backend yet fall through to
# a placeholder backend bucket, which is what makes the foundation applyable standalone —
# "a load balancer with nothing behind it".
#
# CERTS: Certificate Manager, DNS-authorization based, so certificates provision BEFORE the DNS
# cutover (the zone still lives at the registrar until Phase 3). The DNS-authorization CNAMEs are
# printed as an output — adding them at the registrar is a RUNBOOK (🔒 third-party) step.

variable "project_id" { type = string }
variable "name" { type = string }
variable "domain" {
  type        = string
  description = "apex domain, e.g. dorinda.ai"
}
variable "main_hosts" {
  type        = list(string)
  description = "hosts served by the MAIN entry, e.g. [dorinda.ai, www.dorinda.ai, app.dorinda.ai, api.dorinda.ai]"
}
variable "mcp_host" {
  type        = string
  description = "the dedicated mTLS host, e.g. mcp.dorinda.ai"
}
variable "host_backends" {
  type        = map(string)
  default     = {}
  description = "host → backend service self_link. The §2.4 seam: one line here per onboarded service."
}
variable "mcp_trust_anchor_pem" {
  type        = string
  description = "PEM of the ROOT CA (self-signed) anchoring connector client certs. ONE block — a bundle here fails with 'unexpected data after the PEM block' (hit live, 2026-07-29)."
}
variable "mcp_intermediate_pems" {
  type        = list(string)
  default     = []
  description = "Intermediate CA PEMs (e.g. OpenAI-Connectors-mTLS-CA), one block each — GCP builds the chain from these."
}

locals {
  all_hosts = concat(var.main_hosts, [var.mcp_host])
}

# ── DNS zone (records point at the two LB IPs; the zone is LIVE only after registrar delegation) ──
resource "google_dns_managed_zone" "zone" {
  project     = var.project_id
  name        = replace(var.domain, ".", "-")
  dns_name    = "${var.domain}."
  description = "Managed by forge infra — do not hand-edit records."
}

resource "google_compute_global_address" "main" {
  project = var.project_id
  name    = "${var.name}-main"
}

resource "google_compute_global_address" "mcp" {
  project = var.project_id
  name    = "${var.name}-mcp"
}

resource "google_dns_record_set" "main_a" {
  for_each     = toset(var.main_hosts)
  project      = var.project_id
  managed_zone = google_dns_managed_zone.zone.name
  name         = "${each.value}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.main.address]
}

resource "google_dns_record_set" "mcp_a" {
  project      = var.project_id
  managed_zone = google_dns_managed_zone.zone.name
  name         = "${var.mcp_host}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.mcp.address]
}

# ── Certificates: DNS-authorization based, so they provision pre-cutover ──────────────────────────
resource "google_certificate_manager_dns_authorization" "auth" {
  for_each = toset(local.all_hosts)
  project  = var.project_id
  name     = "auth-${replace(each.value, ".", "-")}"
  domain   = each.value
}

resource "google_certificate_manager_certificate" "cert" {
  for_each = toset(local.all_hosts)
  project  = var.project_id
  name     = "cert-${replace(each.value, ".", "-")}"
  managed {
    domains            = [each.value]
    dns_authorizations = [google_certificate_manager_dns_authorization.auth[each.value].id]
  }
}

resource "google_certificate_manager_certificate_map" "main" {
  project = var.project_id
  name    = "${var.name}-main"
}

resource "google_certificate_manager_certificate_map_entry" "main" {
  for_each     = toset(var.main_hosts)
  project      = var.project_id
  name         = "entry-${replace(each.value, ".", "-")}"
  map          = google_certificate_manager_certificate_map.main.name
  hostname     = each.value
  certificates = [google_certificate_manager_certificate.cert[each.value].id]
}

resource "google_certificate_manager_certificate_map" "mcp" {
  project = var.project_id
  name    = "${var.name}-mcp"
}

resource "google_certificate_manager_certificate_map_entry" "mcp" {
  project      = var.project_id
  name         = "entry-${replace(var.mcp_host, ".", "-")}"
  map          = google_certificate_manager_certificate_map.mcp.name
  hostname     = var.mcp_host
  certificates = [google_certificate_manager_certificate.cert[var.mcp_host].id]
}

# ── mTLS trust: TrustConfig + ServerTlsPolicy (§9.4 — CAS is NOT needed; we issue no certs) ───────
resource "google_certificate_manager_trust_config" "mcp" {
  project     = var.project_id
  name        = "${var.name}-mcp-clients"
  location    = "global"
  description = "Trust anchor for connector client certificates (we trust their CA; we issue nothing)."
  trust_stores {
    trust_anchors { pem_certificate = var.mcp_trust_anchor_pem }
    dynamic "intermediate_cas" {
      for_each = var.mcp_intermediate_pems
      content {
        pem_certificate = intermediate_cas.value
      }
    }
  }
}

resource "google_network_security_server_tls_policy" "mcp" {
  project     = var.project_id
  name        = "${var.name}-mcp-mtls"
  location    = "global"
  description = "ALLOW_INVALID_OR_MISSING_CLIENT_CERT: certless discovery must pass (§5f MTLS-2); the app fails closed."
  mtls_policy {
    client_validation_mode         = "ALLOW_INVALID_OR_MISSING_CLIENT_CERT"
    client_validation_trust_config = "projects/${var.project_id}/locations/global/trustConfigs/${google_certificate_manager_trust_config.mcp.name}"
  }
}

# ── Placeholder backend for not-yet-onboarded hosts ("nothing behind it" must still apply) ────────
resource "google_storage_bucket" "placeholder" {
  project                     = var.project_id
  name                        = "${var.project_id}-${var.name}-placeholder"
  location                    = "US"
  uniform_bucket_level_access = true
}

resource "google_storage_bucket_object" "placeholder_404" {
  bucket        = google_storage_bucket.placeholder.name
  name          = "index.html"
  content       = "<!doctype html><title>not yet provisioned</title><h1>This host has no service behind it yet.</h1>"
  content_type  = "text/html"
  cache_control = "no-store"
}

resource "google_compute_backend_bucket" "placeholder" {
  project     = var.project_id
  name        = "${var.name}-placeholder"
  bucket_name = google_storage_bucket.placeholder.name
}

# ── URL maps: MAIN routes per-host; MCP routes only its host ──────────────────────────────────────
resource "google_compute_url_map" "main" {
  project         = var.project_id
  name            = "${var.name}-main"
  default_service = google_compute_backend_bucket.placeholder.id

  dynamic "host_rule" {
    for_each = { for h in var.main_hosts : h => h if contains(keys(var.host_backends), h) }
    content {
      hosts        = [host_rule.value]
      path_matcher = replace(host_rule.value, ".", "-")
    }
  }

  dynamic "path_matcher" {
    for_each = { for h in var.main_hosts : h => var.host_backends[h] if contains(keys(var.host_backends), h) }
    content {
      name            = replace(path_matcher.key, ".", "-")
      default_service = path_matcher.value
    }
  }
}

resource "google_compute_url_map" "mcp" {
  project         = var.project_id
  name            = "${var.name}-mcp"
  default_service = lookup(var.host_backends, var.mcp_host, google_compute_backend_bucket.placeholder.id)
}

resource "google_compute_target_https_proxy" "main" {
  project         = var.project_id
  name            = "${var.name}-main"
  url_map         = google_compute_url_map.main.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.main.id}"
}

resource "google_compute_target_https_proxy" "mcp" {
  project         = var.project_id
  name            = "${var.name}-mcp"
  url_map         = google_compute_url_map.mcp.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.mcp.id}"
  server_tls_policy = google_network_security_server_tls_policy.mcp.id
}

resource "google_compute_global_forwarding_rule" "main" {
  project               = var.project_id
  name                  = "${var.name}-main"
  target                = google_compute_target_https_proxy.main.id
  ip_address            = google_compute_global_address.main.address
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

resource "google_compute_global_forwarding_rule" "mcp" {
  project               = var.project_id
  name                  = "${var.name}-mcp"
  target                = google_compute_target_https_proxy.mcp.id
  ip_address            = google_compute_global_address.mcp.address
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

output "main_ip" { value = google_compute_global_address.main.address }
output "mcp_ip" { value = google_compute_global_address.mcp.address }
output "dns_zone" { value = google_dns_managed_zone.zone.name }
output "dns_name_servers" { value = google_dns_managed_zone.zone.name_servers }
output "url_map_main" { value = google_compute_url_map.main.name }
output "url_map_mcp" { value = google_compute_url_map.mcp.name }
output "mtls_trust_config" { value = google_certificate_manager_trust_config.mcp.id }
output "mtls_server_tls_policy" { value = google_network_security_server_tls_policy.mcp.id }

# 🔒 RUNBOOK step: these CNAMEs go at the REGISTRAR (GoDaddy) so certs provision pre-cutover.
output "dns_authorization_cnames" {
  value = {
    for host, auth in google_certificate_manager_dns_authorization.auth :
    host => { record = auth.dns_resource_record[0].name, type = auth.dns_resource_record[0].type, data = auth.dns_resource_record[0].data }
  }
}
