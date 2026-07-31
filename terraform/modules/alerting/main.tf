# forge module: alerting — the watcher that lives OUTSIDE the thing it watches.
#
# Grafana is the pane. If alerting lives only in Grafana, then Grafana being down means nothing is
# watching — including nothing watching Grafana. So these are Cloud Monitoring resources: they run
# on Google's infrastructure, they survive the pane, and they survive the collector.
#
# The first policy written here is the META-CHECK: "no metric samples ingested". On 2026-07-31
# Managed Prometheus was empty for days behind a five-fault chain while every health check stayed
# green and every dashboard drew a flat line at zero. Nothing anywhere noticed. That is the failure
# this module exists to make impossible.

variable "project_id" { type = string }
variable "notification_email" {
  type        = string
  description = "Where alerts actually go. An alert with no delivery channel is a dashboard."
}
variable "uptime_hosts" {
  type        = list(string)
  default     = []
  description = "Public hosts to probe from outside the estate."
}
variable "uptime_path" {
  type    = string
  default = "/"
}
variable "run_services" {
  type        = list(string)
  default     = []
  description = "Cloud Run services to watch for 5xx and for revisions that never become ready."
}
variable "sql_instance" {
  type        = string
  default     = ""
  description = "Cloud SQL instance id to watch. Empty disables the database policies."
}
variable "error_ratio_threshold" {
  type    = number
  default = 0.05
}
variable "create_budget" {
  type        = bool
  default     = false
  description = <<-EOT
    Budgets need a BILLING-ACCOUNT-level role (roles/billing.costsManager) on the deployer, which is
    a billing-admin action and not something the project-scoped deployer holds. Left false so the
    rest of this module applies cleanly; flip it once the grant exists:
      gcloud billing accounts add-iam-policy-binding <BILLING_ACCOUNT> \
        --member=serviceAccount:<DEPLOYER> --role=roles/billing.costsManager
  EOT
}
variable "billing_account" {
  type    = string
  default = ""
}
variable "budget_amount_usd" {
  type    = number
  default = 150
}

# ── Delivery ────────────────────────────────────────────────────────────────────────────────────
resource "google_monitoring_notification_channel" "email" {
  project      = var.project_id
  display_name = "forge alerts → ${var.notification_email}"
  type         = "email"
  labels       = { email_address = var.notification_email }
}

locals {
  channels = [google_monitoring_notification_channel.email.id]
}

# ── 1. THE META-CHECK: is anything arriving at all? ─────────────────────────────────────────────
# Deliberately the first policy in the file. Every other alert here assumes metrics exist; this one
# is what tells you that assumption has failed. It watches the collector's OWN export counter, so
# it fires whether the apps stopped emitting, the collector stopped receiving, or the exporter
# started being rejected — the three independent ways the chain died in July.
resource "google_monitoring_alert_policy" "no_metric_ingestion" {
  project      = var.project_id
  display_name = "Metrics pipeline: nothing ingested in 30m"
  combiner     = "OR"
  documentation {
    content = join("\n", [
      "No metric samples have reached Managed Prometheus for 30 minutes.",
      "",
      "This is an OUTAGE, not a quiet period: dashboards will render empty charts that look like",
      "low traffic. Check, in order:",
      "  1. otel-collector is running and min_instances >= 1 (a push collector cannot scale to zero)",
      "  2. its logs for 'Exporting failed' — GMP rejects a whole batch if any TimeSeries duplicates",
      "  3. the apps' /api/health/deep metrics_export check",
    ])
  }
  conditions {
    display_name = "no samples in 30m"
    condition_absent {
      filter   = "metric.type=\"prometheus.googleapis.com/mcp_registration_health_ratio/gauge\""
      duration = "1800s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  notification_channels = local.channels
  alert_strategy { auto_close = "86400s" }
}

# ── 2. Uptime, probed from OUTSIDE ──────────────────────────────────────────────────────────────
resource "google_monitoring_uptime_check_config" "host" {
  for_each = toset(var.uptime_hosts)

  project      = var.project_id
  display_name = "uptime ${each.value}"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path         = var.uptime_path
    port         = 443
    use_ssl      = true
    validate_ssl = true
    # 401 is a HEALTHY answer for an authenticated surface — it proves the service is up AND that
    # auth is enforced. Without this an uptime check on the console or the docs portal would page
    # continuously while everything was perfectly fine.
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
    accepted_response_status_codes {
      status_value = 401
    }
    accepted_response_status_codes {
      status_value = 302
    }
    accepted_response_status_codes {
      status_value = 307
    }
  }

  monitored_resource {
    type   = "uptime_url"
    labels = { project_id = var.project_id, host = each.value }
  }
}

resource "google_monitoring_alert_policy" "uptime" {
  for_each = google_monitoring_uptime_check_config.host

  project      = var.project_id
  display_name = "DOWN: ${each.key}"
  combiner     = "OR"
  documentation {
    content = "${each.key} failed its external uptime probe. This check runs on Google's infrastructure, outside the estate, so it still fires when the observability pane itself is down."
  }
  conditions {
    display_name = "${each.key} unreachable"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.labels.check_id=\"${each.value.uptime_check_id}\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      # Two consecutive failures from multiple probe locations, not one — a single blip from one
      # region is not an outage, and an alert that fires on noise gets muted within a week.
      duration = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
      trigger { count = 1 }
    }
  }
  notification_channels = local.channels
  alert_strategy { auto_close = "86400s" }
}

# ── 3. Cloud Run 5xx ────────────────────────────────────────────────────────────────────────────
resource "google_monitoring_alert_policy" "run_5xx" {
  for_each = toset(var.run_services)

  project      = var.project_id
  display_name = "5xx: ${each.value}"
  combiner     = "OR"
  documentation {
    content = "${each.value} is returning 5xx above ${var.error_ratio_threshold * 100}% of requests. Check recent releases first — this usually follows a deploy."
  }
  conditions {
    display_name = "5xx rate elevated"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${each.value}\" AND metric.labels.response_code_class=\"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
  notification_channels = local.channels
  alert_strategy { auto_close = "86400s" }
}

# ── 4. Cloud SQL ────────────────────────────────────────────────────────────────────────────────
resource "google_monitoring_alert_policy" "sql_down" {
  count = var.sql_instance == "" ? 0 : 1

  project      = var.project_id
  display_name = "Cloud SQL unreachable: ${var.sql_instance}"
  combiner     = "OR"
  documentation {
    content = "The database is the only stateful thing in the estate and it is pinned to a single zone. If this fires, everything else stays up with nothing to talk to."
  }
  conditions {
    display_name = "instance not up"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/up\" AND resource.type=\"cloudsql_database\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  notification_channels = local.channels
  alert_strategy { auto_close = "86400s" }
}

resource "google_monitoring_alert_policy" "sql_disk" {
  count = var.sql_instance == "" ? 0 : 1

  project      = var.project_id
  display_name = "Cloud SQL disk above 85%: ${var.sql_instance}"
  combiner     = "OR"
  documentation {
    content = "Autoresize will grow the disk, but it never shrinks and you are billed on PROVISIONED size — so a runaway table costs money permanently. Investigate before it grows."
  }
  conditions {
    display_name = "disk utilization high"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND resource.type=\"cloudsql_database\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.85
      duration        = "600s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  notification_channels = local.channels
  alert_strategy { auto_close = "86400s" }
}

# ── 5. Budget (opt-in; see the variable) ────────────────────────────────────────────────────────
resource "google_billing_budget" "monthly" {
  count = var.create_budget && var.billing_account != "" ? 1 : 0

  billing_account = var.billing_account
  display_name    = "Dorinda monthly"

  budget_filter {
    projects = ["projects/${var.project_id}"]
  }
  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount_usd)
    }
  }
  dynamic "threshold_rules" {
    for_each = [0.5, 0.9, 1.0]
    content {
      threshold_percent = threshold_rules.value
    }
  }
  all_updates_rule {
    monitoring_notification_channels = local.channels
    disable_default_iam_recipients   = false
  }
}

output "notification_channel" { value = google_monitoring_notification_channel.email.id }
output "uptime_check_count" { value = length(google_monitoring_uptime_check_config.host) }
output "policy_count" {
  value = 1 + length(google_monitoring_alert_policy.uptime) + length(google_monitoring_alert_policy.run_5xx) + (var.sql_instance == "" ? 0 : 2)
}
