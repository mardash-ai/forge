# forge module: network — the product VPC.
#
# One VPC per product (plan §2.2). Cloud Run reaches it via DIRECT VPC EGRESS (no Serverless VPC
# Access connectors — those cost ~$30/mo and are slower; §9.2). Direct egress needs only a subnet.
# Private Services Access (PSA) is what gives Cloud SQL a private IP on this VPC; the database
# module consumes it via the exported network id.

variable "project_id" { type = string }
variable "region" { type = string }
variable "name" {
  type        = string
  description = "VPC name, e.g. dorinda"
}
variable "subnet_cidr" {
  type    = string
  default = "10.10.0.0/24"
}
variable "psa_range_prefix" {
  type        = number
  default     = 16
  description = "Prefix length of the reserved Private Services Access range (Cloud SQL et al)."
}

resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = var.name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "primary" {
  project                  = var.project_id
  name                     = "${var.name}-${var.region}"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}

# Reserved range + peering for Private Services Access — Cloud SQL private IP lives here.
resource "google_compute_global_address" "psa" {
  project       = var.project_id
  name          = "${var.name}-psa"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.psa_range_prefix
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa.name]
}

output "network_id" { value = google_compute_network.vpc.id }
output "network_name" { value = google_compute_network.vpc.name }
output "subnet_id" { value = google_compute_subnetwork.primary.id }
output "subnet_name" { value = google_compute_subnetwork.primary.name }
output "psa_connection" { value = google_service_networking_connection.psa.id }
