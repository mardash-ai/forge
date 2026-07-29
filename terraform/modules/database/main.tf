# forge module: database — Cloud SQL for PostgreSQL, the §9.9 posture.
#
# Zonal (single-zone) + automated backups + PITR. The availability upgrades are deliberately
# RUNTIME SETTINGS, not architecture (§9.9): availability_type = "REGIONAL" converts to HA in
# place, and a cross-region replica is additive later. What is NOT optional here: backups + PITR —
# closing the no-backups P0 is the single most valuable thing in the migration.
#
# Passwords are GENERATED here and land in Secret Manager; no human ever knows them, nothing is
# committed. Consumers read them at runtime via secret refs (service module).

variable "project_id" { type = string }
variable "region" { type = string }
variable "name" { type = string }
variable "network_id" {
  type        = string
  description = "VPC self-link from the network module (private IP only; no public address)."
}
variable "tier" {
  type        = string
  default     = "db-custom-1-3840" # 1 vCPU / 3.75GB — §9.9 right-sizing; resizable in minutes
}
variable "disk_gb" {
  type    = number
  default = 50
}
variable "databases" {
  type        = list(string)
  description = "logical databases, e.g. [dorinda_app, forge_platform]"
}
variable "app_user" {
  type    = string
  default = "app"
}

resource "google_sql_database_instance" "pg" {
  project             = var.project_id
  name                = var.name
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = true # a terraform destroy must not be able to take the data with it

  settings {
    tier              = var.tier
    availability_type = "ZONAL" # §9.9: regional HA is a later in-place upgrade, not architecture
    disk_type         = "PD_SSD"
    disk_size         = var.disk_gb
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false # private IP ONLY — the database has no public address
      private_network = var.network_id
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true # restore to any second in the window — the P0, closed
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
}

resource "google_sql_database" "db" {
  for_each = toset(var.databases)
  project  = var.project_id
  instance = google_sql_database_instance.pg.name
  name     = each.value
}

resource "random_password" "app" {
  length  = 32
  special = false
}

resource "google_sql_user" "app" {
  project  = var.project_id
  instance = google_sql_database_instance.pg.name
  name     = var.app_user
  password = random_password.app.result
}

resource "google_secret_manager_secret" "db_password" {
  project   = var.project_id
  secret_id = "${var.name}-db-password"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.app.result
}

output "instance_name" { value = google_sql_database_instance.pg.name }
output "connection_name" { value = google_sql_database_instance.pg.connection_name }
output "private_ip" { value = google_sql_database_instance.pg.private_ip_address }
output "db_user" { value = google_sql_user.app.name }
output "db_password_secret" { value = google_secret_manager_secret.db_password.secret_id }
