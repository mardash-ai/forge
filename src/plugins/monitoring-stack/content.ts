// Generated-once from the live-validated stack configs (2026-07-26) — now OWNED by forge.
// Edit HERE and re-release; never hand-edit a provisioned stack dir (regen clobbers it).
// Datasource uids/types/names come from ONE committed list — src/console/datasource-catalog.ts —
// which the datasource declarations, every dashboard panel and every alert rule derive from.
// Never write a datasource uid as a literal: Grafana silently substitutes the DEFAULT datasource
// for an unknown uid, so a wrong reference renders as a working page showing nothing (F-DD-5).
// The box-era `forge-loki` datasource is RETIRED (2026-09-05): production has no Loki — logs are
// Cloud Logging (`cloud-logging`, googlecloud-logging-datasource). Logs-type panels query it via
// Cloud Logging filters; LogQL-aggregation panels and the Loki-based alert rules are gone
// (estate alerting is Cloud Monitoring's job — see dorinda-shared-infra/infra/main.tf).
// 0.75.1: metric names fixed to what Traefik OTLP actually emits (entrypoint/service — router-level
// series do not exist), TLS rule ms→s,
// Dead-MCP-Registration re-based on the mcp_tools_registered gauge (register lines only log at boot).

import {
  DS_PROMETHEUS,
  DS_CLOUD_LOGGING,
  DS_CLOUD_MONITORING,
  DS_FORGE_PLATFORM_DB,
  DS_DORINDA_APP_DB,
} from '../../console/datasource-catalog';

/** Panel-side datasource reference — ALWAYS derived from the catalog, never a literal. */
function dsRef(d: { type: string; uid: string }): string {
  return `{ "type": "${d.type}", "uid": "${d.uid}" }`;
}

/** Loki 3.x single-binary config — 30d retention via compactor (delete_request_store REQUIRED) */
export const LOKI_CONFIG = `# Loki — single-process (monolithic) mode with filesystem storage.
#
# Receives logs from the otel-collector via OTLP HTTP at port 3100.
# The otel-collector pushes to http://loki:3100/otlp (LOKI_ENDPOINT default in ../docker-compose.yaml).
# Loki 2.9+ is required for /otlp OTLP ingest — this config assumes Loki 3.x.
#
# Retention: 30 days, enforced by the compactor (retention_enabled: true).
# Storage: named Docker volume \`loki-data\` mounted at /loki.
#
# Scaling note: this is a single-instance config. For multi-replica, switch to an
# object store backend (S3/GCS/Minio) and a microservices target.

auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096
  log_level: warn

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

# Schema: TSDB index (Loki 2.8+) with v13 schema (Loki 3.x default).
schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

# Query range: embedded cache reduces redundant compactor lookups.
query_range:
  results_cache:
    cache:
      embedded_cache:
        enabled: true
        max_size_mb: 100

# Retention policy: reject samples older than 168 h (7 days) on ingest;
# compactor enforces 30-day hard retention for stored data.
limits_config:
  reject_old_samples: true
  reject_old_samples_max_age: 168h   # 7-day ingest window; data already stored is kept up to 30d
  retention_period: 720h             # 30 days hard retention (enforced by compactor)
  # OTLP ingest limits — raise if Traefik log volume is high
  ingestion_rate_mb: 4
  ingestion_burst_size_mb: 8
  per_stream_rate_limit: 3MB
  per_stream_rate_limit_burst: 10MB

compactor:
  working_directory: /loki/compactor
  retention_enabled: true            # required to enforce limits_config.retention_period
  delete_request_store: filesystem   # Loki 3.x: REQUIRED when retention_enabled (startup fails without it)
  retention_delete_delay: 2h
  retention_delete_worker_count: 150

# Analytics: disable phone-home reporting
analytics:
  reporting_enabled: false
`;

/** Prometheus scrape config — otel-collector:8889 + self */
export const PROMETHEUS_CONFIG = `# Prometheus scrape config.
#
# Single scrape target: the otel-collector's Prometheus scrape endpoint at :8889.
# All Traefik OTLP metrics (request counts, latencies, error rates) and any OTLP
# metrics pushed by apps on the box flow through the otel-collector and appear here.
#
# Retention: 30d (set via --storage.tsdb.retention.time flag in docker-compose).
# Alert rules: see rules/alerts.yml — loaded via rule_files glob.
#
# Adding a new scrape target: add a job below and document it.
# Reloading without restart: POST http://localhost:9090/-/reload
#   (only from the host; prometheus has no host-bound port in compose).
#   Or: docker exec prometheus wget -q --post-data='' http://localhost:9090/-/reload -O -

global:
  scrape_interval: 15s       # Default — individual jobs can override
  evaluation_interval: 15s   # How often alert rules are evaluated

rule_files:
  - /etc/prometheus/rules/*.yml

scrape_configs:

  # OTel Collector → all Traefik edge metrics + any app OTLP metrics.
  # The collector's prometheus exporter exposes all received OTLP metrics as a
  # Prometheus scrape endpoint. Traefik pushes via OTLP to otel-collector:4318,
  # which the collector then re-exposes here.
  #
  # Key Traefik metric names (after OTLP→Prometheus name translation, dots→underscores):
  #   traefik_entrypoint_requests_total{entrypoint, method, code}
  #   traefik_entrypoint_request_duration_seconds_bucket{entrypoint, le}   (histogram)
  #   traefik_service_requests_total{service, method, code}
  # NOTE: router-level series are NOT emitted by Traefik OTLP (verified live 2026-07-26).
  #
  # Verify actual names after first scrape:
  #   curl -s http://localhost:9090/api/v1/label/__name__/values | jq '.data[] | select(startswith("traefik"))'
  - job_name: otel-collector
    static_configs:
      - targets:
          - otel-collector:8889    # proxy network: otel-collector container
        labels:
          source: traefik          # hint for dashboard queries
    # Increase scrape timeout if the collector is slow to respond under load
    scrape_timeout: 10s

  # Prometheus self-scrape (optional: useful for monitoring Prometheus itself).
  - job_name: prometheus
    static_configs:
      - targets:
          - localhost:9090
`;

/** Prometheus-native alert rules (edge error rate / outage / TLS expiry) — entrypoint metrics */
export const PROMETHEUS_RULES = `# Prometheus alert rules — metric-based alerts.
#
# The log-based alerts (silent tool-call death, sweep error streaks, dead MCP
# registration) are provisioned in Grafana unified alerting (see
# ../grafana/provisioning/alerting/alert_rules.yml) because they require LogQL
# queries against Loki. This file covers the Prometheus-metric-based alert.
#
# Validate offline:  python3 ../../scripts/validate_prometheus_rules.py alerts.yml
# Reload live:       curl -X POST http://localhost:9090/-/reload  (from the box host)
#
# TUNING NOTE: Traefik OTLP metric names are translated by the OTel collector's
# prometheus exporter (dots → underscores, _total suffix added to counters).
# Verify actual metric names after first scrape:
#   curl -s http://localhost:9090/api/v1/label/__name__/values \\
#     | jq '.data[] | select(startswith("traefik"))'

groups:

  - name: edge-5xx
    interval: 30s   # evaluate every 30 s so the alert fires promptly
    rules:

      # ── Recording rule: 5-minute error ratio ────────────────────────────────
      # Pre-computes the ratio used by the alert below.  Having a recording rule
      # lets the alert expression stay simple and also makes the ratio queryable
      # in dashboards without repeating the math.
      - record: job:traefik_error_ratio:rate5m
        expr: |
          (
            sum(rate(traefik_entrypoint_requests_total{code=~"5.."}[5m]))
            /
            sum(rate(traefik_entrypoint_requests_total[5m]))
          )

      # ── Alert: edge 5xx spike ────────────────────────────────────────────────
      # Fires when the 5xx ratio exceeds 5% for 2 consecutive minutes AND there
      # is meaningful traffic (> 0.1 req/s total — avoids spurious fires when
      # only a handful of requests arrive during quiet hours).
      #
      # Tuning:
      #   Raise the 0.05 threshold if your baseline error rate is naturally > 5%
      #     (rare legitimate 5xxs from client disconnects, LB probes, etc.).
      #   Raise the 0.1 req/s guard if the quiet-hours false-positive rate is high.
      #   Lower \`for: 2m\` to 1m for faster paging; raise to 5m to reduce noise.
      - alert: EdgeHighErrorRate
        expr: |
          job:traefik_error_ratio:rate5m > 0.05
          and on()
          sum(rate(traefik_entrypoint_requests_total[5m])) > 0.1
        for: 2m
        labels:
          severity: critical
          team: forge-mon
        annotations:
          summary: "Edge 5xx rate > 5% for 2 min"
          description: >
            Edge HTTP 5xx error rate is {{ $value | humanizePercentage }} over the last
            5 minutes. Check Traefik logs and backend health.
          dashboard_url: "https://grafana.dorinda.ai/d/forge-mon-edge/edge-overview"
          runbook: |
            1. docker logs traefik --tail 100 | jq 'select(.DownstreamStatus >= 500)'
            2. Check the Edge Overview dashboard for the failing router/service.
            3. Confirm the backend container is healthy: docker ps -a.

      # ── Alert: all traffic is errors ─────────────────────────────────────────
      # A separate alert for the total-blackout case where 100% of requests fail
      # (the ratio alert above still fires, but this one fires faster at 30s).
      - alert: EdgeTotalOutage
        expr: |
          sum(rate(traefik_entrypoint_requests_total[1m])) > 0
          and on()
          sum(rate(traefik_entrypoint_requests_total{code=~"5.."}[1m]))
            / sum(rate(traefik_entrypoint_requests_total[1m])) >= 1.0
        for: 30s
        labels:
          severity: critical
          team: forge-mon
        annotations:
          summary: "Edge: 100% requests are 5xx"
          description: >
            ALL edge requests are returning 5xx. Traefik or all backends may be down.
          runbook: |
            1. docker ps — are traefik and otel-collector still running?
            2. docker logs traefik --tail 50
            3. curl -vk https://proxy.chazmar.com — does TLS even terminate?

  - name: edge-cert
    interval: 1h   # daily check is sufficient for cert expiry
    rules:
      # ── Alert: TLS certificate expiring soon ─────────────────────────────────
      # Traefik pushes the \`traefik_tls_certs_not_after\` gauge (seconds-since-epoch
      # of cert expiry) via OTLP. Fire when any cert expires within 14 days.
      - alert: TLSCertExpiringIn14Days
        expr: |
          (traefik_tls_certs_not_after_milliseconds / 1000 - time()) / 86400 < 14
        for: 1h
        labels:
          severity: warning
          team: forge-mon
        annotations:
          summary: "TLS cert expires in {{ $value | humanizeDuration }}"
          description: >
            A TLS certificate managed by Traefik expires in less than 14 days.
            Traefik renews Let's Encrypt certs automatically; if this alert fires
            check that port 80 is reachable for the HTTP-01 challenge.
`;

/** Options the datasource provisioning needs (subset of the plugin's Resolved). */
export interface DatasourceRenderOptions {
  /** GCP project the Cloud Logging / Cloud Monitoring datasources read (gce workload identity). */
  gcpProject?: string;
  /** Read-only Postgres hookup — declares BOTH DB datasources (forge platform + dorinda app).
   *  The two databases live on the SAME instance (dorinda-pg hosts forge_platform AND
   *  dorinda_api — verified 2026-09-05); each gets its OWN SELECT-only role and secret. */
  appDb?: {
    host: string;
    port: number;
    /** forge platform database (catalog-pinned default: forge_platform). */
    database: string;
    /** SELECT-only role for the platform DB — NEVER a superuser. */
    user: string;
    /** dorinda-api's application database (catalog-pinned default: dorinda_api). */
    dorindaDatabase: string;
    /** SELECT-only role for the app DB — NEVER a superuser, never the platform role. */
    dorindaUser: string;
  };
}

/** Grafana datasource provisioning — every uid/type/name comes from the committed catalog
 *  (src/console/datasource-catalog.ts); alert rules and panels reference the same entries. */
export function renderGrafanaDatasources(o: DatasourceRenderOptions = {}): string {
  const gcpAuth = `      authenticationType: gce${o.gcpProject ? `\n      defaultProject: ${o.gcpProject}` : ''}`;
  const appDbBlock = o.appDb
    ? `
  # ── ${DS_FORGE_PLATFORM_DB.name} ──────────────────────────────────────────
  # Forge's OWN platform database (forge_identity_users + forge_app_events) — the email→owner
  # picker on the User Experience dashboard. NOT the app's data (that is ${DS_DORINDA_APP_DB.uid}
  # below — naming this one "App DB" was finding F-DD-3). The role must be SELECT-only
  # (${o.appDb.user}); the password reaches the CONTAINER env from the stack .env, and Grafana's
  # provisioning expands \$VAR references from that env.
  - name: ${DS_FORGE_PLATFORM_DB.name}
    uid: ${DS_FORGE_PLATFORM_DB.uid}
    type: ${DS_FORGE_PLATFORM_DB.type}
    access: proxy
    url: ${o.appDb.host}:${o.appDb.port}
    user: ${o.appDb.user}
    editable: false
    secureJsonData:
      password: $GRAFANA_PG_RO_PASSWORD
    jsonData:
      database: ${o.appDb.database}
      sslmode: disable
      maxOpenConns: 2
      postgresVersion: 1500

  # ── ${DS_DORINDA_APP_DB.name} ─────────────────────────────────────────────
  # dorinda-api's application database — events, messages, approvals, every table its
  # migrations create. Same instance as the platform DB, its OWN database and its OWN
  # dedicated SELECT-only role (${o.appDb.dorindaUser}) with its OWN secret — NEVER a
  # superuser, never the platform role.
  - name: ${DS_DORINDA_APP_DB.name}
    uid: ${DS_DORINDA_APP_DB.uid}
    type: ${DS_DORINDA_APP_DB.type}
    access: proxy
    url: ${o.appDb.host}:${o.appDb.port}
    user: ${o.appDb.dorindaUser}
    editable: false
    secureJsonData:
      password: $GRAFANA_DORINDA_PG_RO_PASSWORD
    jsonData:
      database: ${o.appDb.dorindaDatabase}
      sslmode: disable
      maxOpenConns: 2
      postgresVersion: 1500
`
    : '';
  return `# Grafana datasource provisioning.
#
# EVERY uid/type/name here comes from the committed catalog (src/console/datasource-catalog.ts).
# UIDs are fixed so dashboards + alert rules can reference them without depending on
# auto-assigned IDs. Grafana does NOT error on an unknown datasource uid — it silently
# substitutes the default datasource — so declaration and reference must come from one list.
#
# There is deliberately NO Loki datasource: production logs are Cloud Logging. The
# box-era Loki declaration was retired 2026-09-05 (it declared a store production does not
# have, which made dead panels look merely misconfigured).

apiVersion: 1

datasources:

  # ── ${DS_PROMETHEUS.name} ──────────────────────────────────────────────────
  # Prometheus-compatible metrics. Locally: the stack's own Prometheus (scrapes
  # otel-collector:8889 — all Traefik OTLP metrics). In production: the Google Managed
  # Prometheus frontend proxy. Same uid either way — panels bind to the uid.
  - name: ${DS_PROMETHEUS.name}
    uid: ${DS_PROMETHEUS.uid}
    type: ${DS_PROMETHEUS.type}
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
    jsonData:
      httpMethod: POST
      timeInterval: "15s"        # matches scrape_interval in prometheus.yml

  # ── ${DS_CLOUD_LOGGING.name} ───────────────────────────────────────────────
  # THE logs datasource (googlecloud-logging-datasource, gce workload-identity auth — no key
  # material, nothing to rotate). Logs-type panels query it with Cloud Logging filters.
  - name: ${DS_CLOUD_LOGGING.name}
    uid: ${DS_CLOUD_LOGGING.uid}
    type: ${DS_CLOUD_LOGGING.type}
    access: proxy
    editable: false
    jsonData:
${gcpAuth}

  # ── ${DS_CLOUD_MONITORING.name} ────────────────────────────────────────────
  # GCP service metrics — the Service Health dashboard's RED panels (Cloud Run request
  # count/latency), Cloud SQL. Same gce auth as Cloud Logging.
  - name: ${DS_CLOUD_MONITORING.name}
    uid: ${DS_CLOUD_MONITORING.uid}
    type: ${DS_CLOUD_MONITORING.type}
    access: proxy
    editable: false
    jsonData:
${gcpAuth}
${appDbBlock}`;
}

/** Grafana dashboard provider — loads /var/lib/grafana/dashboards */
export const GRAFANA_DASHBOARD_PROVIDER = `# Grafana dashboard provisioning.
#
# Dashboards are loaded from the /var/lib/grafana/dashboards directory
# (bind-mounted from ./grafana/dashboards in the compose).
# updateIntervalSeconds: how often Grafana re-reads the directory for changes.
# allowUiUpdates: false — UI edits are rejected, keeping the files canonical.

apiVersion: 1

providers:
  - name: forge-mon
    orgId: 1
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: false
    options:
      path: /var/lib/grafana/dashboards
      foldersFromFilesStructure: false
    folder: forge-mon
    folderUid: forge-mon-folder
`;

/** Grafana unified-alerting rules — Dead MCP Registration (gauge-based, Prometheus).
 *  The three box-era Loki rules (MCP Dispatch Errors · Sweep Error Streak · Edge 5xx log-spike)
 *  were RETIRED with the forge-loki datasource (2026-09-05): production has no Loki, and estate
 *  alerting deliberately lives in Cloud Monitoring (see dorinda-shared-infra/infra/main.tf) so
 *  the observability pane is never its own alerting path. The Prometheus 5xx alert survives in
 *  prometheus/rules/alerts.yml. */
export const GRAFANA_ALERT_RULES = `# Grafana unified alerting — provisioned alert rules.
#
# ONE rule group: metric-based rules over the ${DS_PROMETHEUS.uid} datasource. The box-era
# Loki-based rules are gone with the retired Loki datasource (production logs are Cloud Logging,
# which is a logs pane, not an alerting store — estate alerting is Cloud Monitoring's job).
#
# Datasource UIDs must match the committed catalog (src/console/datasource-catalog.ts):
#   ${DS_PROMETHEUS.uid}
#   -100  (special: Grafana expression/math datasource — always present)
#
# Reference: https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/

apiVersion: 1

groups:

  - orgId: 1
    name: forge-mon-alerts
    folder: forge-mon
    interval: 1m
    rules:

      # ── Dead MCP Registration ───────────────────────────────────────────
      # GAUGE-based (0.75.1): registration log lines only appear at app boot, so an
      # absence-of-lines check would fire constantly. Instead: the data-plane exports
      # mcp_tools_registered continuously; the surface is dead when it drops below the
      # full tool count (26) or the series disappears entirely (or-vector(0) → 0 < 26).
      - uid: dead-mcp-registration
        title: Dead MCP Registration
        condition: B
        for: 10m
        data:
          # Step A: current registered-tool count (0 when the series is absent)
          - refId: A
            queryType: ''
            relativeTimeRange:
              from: 900   # 15 min window to catch the 10-min absence
              to: 0
            datasourceUid: ${DS_PROMETHEUS.uid}
            model:
              # ⛔ RANGE-AWARE. mcp_tools_registered is a SPARSE gauge (emitted once at
              # registration), and Prometheus treats a sample as stale after 5 minutes — so an
              # INSTANT query returns nothing shortly after boot, falls through to vector(0), and
              # this rule fires permanently having never evaluated its real condition. Observed
              # live on 2026-07-31: firing as NoData directly beneath a panel reading a healthy 31.
              expr: 'max_over_time(mcp_tools_registered[6h]) or on() vector(0)'
              instant: true
              intervalMs: 1000
              maxDataPoints: 43200
              queryType: instant
              refId: A
          # Step B: fire when the registered count is below the full surface (26)
          - refId: B
            queryType: ''
            relativeTimeRange:
              from: 900
              to: 0
            datasourceUid: '-100'
            model:
              conditions:
                - evaluator:
                    params:
                      - 26
                    type: lt
                  operator:
                    type: and
                  query:
                    params:
                      - A
                  reducer:
                    params: []
                    type: last
                  type: query
              datasource:
                type: __expr__
                uid: '-100'
              expression: ''
              hide: false
              intervalMs: 1000
              maxDataPoints: 43200
              refId: B
              type: classic_conditions
        noDataState: OK      # NoData = no streams exist at all → don't alert (no logs yet)
        execErrState: Error
        labels:
          severity: warning
          team: forge-mon
        annotations:
          summary: "No MCP registration events in 10 min"
          description: >
            No log lines matching 'mcp' + 'register' in the last 10 minutes.
            The MCP server may have died or lost its registration.
            Check: docker logs <mcp-container> and docker ps.
`;

/** Grafana contact points — __ALERT_EMAIL__ substituted by the generator */
export const GRAFANA_CONTACT_POINTS_TEMPLATE = `# Grafana unified alerting — contact points and notification policy.
#
# The default contact point sends alert notifications. Configure the email
# address below (or swap for Slack/PagerDuty/webhook) to actually receive alerts.
#
# TUNING: Replace the email below or add a receiver of your preferred type.
# Grafana supports: email, slack, webhook, pagerduty, opsgenie, victorops, etc.
#
# Reference: https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/

apiVersion: 1

contactPoints:
  - orgId: 1
    name: forge-mon-default
    receivers:
      # Email notification — configure SMTP in GF_SMTP_* env vars to activate.
      # Without SMTP config, Grafana logs the notification but does not send email.
      - uid: forge-mon-email
        type: email
        settings:
          addresses: __ALERT_EMAIL__      # ← operator email; change if needed
          singleEmail: false
        disableResolveMessage: false

policies:
  - orgId: 1
    receiver: forge-mon-default
    group_by:
      - alertname
      - severity
    group_wait: 30s
    group_interval: 5m
    repeat_interval: 4h
    routes:
      - receiver: forge-mon-default
        matchers:
          - severity = critical
        group_wait: 10s
        repeat_interval: 1h
`;

/** Dashboard: Edge Overview (entrypoint/service metrics — verified live names) */
export const DASHBOARD_EDGE_OVERVIEW = `{
  "id": null,
  "uid": "forge-mon-edge",
  "title": "Edge Overview",
  "description": "Traefik edge traffic: request rates, error rates, latency. Data from otel-collector Prometheus scrape endpoint.",
  "tags": [
    "forge-mon",
    "traefik",
    "edge"
  ],
  "timezone": "browser",
  "schemaVersion": 39,
  "version": 1,
  "refresh": "30s",
  "time": {
    "from": "now-1h",
    "to": "now"
  },
  "timepicker": {},
  "fiscalYearStartMonth": 0,
  "graphTooltip": 1,
  "panels": [
    {
      "id": 1,
      "type": "stat",
      "title": "5xx Rate (last 5m)",
      "description": "HTTP 5xx error ratio over the last 5 minutes. Alert threshold: 5%.",
      "gridPos": {
        "h": 4,
        "w": 4,
        "x": 0,
        "y": 0
      },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        {
          "refId": "A",
          "datasource": ${dsRef(DS_PROMETHEUS)},
          "expr": "sum(rate(traefik_entrypoint_requests_total{code=~\\"5..\\"}[5m])) / sum(rate(traefik_entrypoint_requests_total[5m]))",
          "instant": true,
          "legendFormat": "error ratio"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "yellow",
                "value": 0.01
              },
              {
                "color": "red",
                "value": 0.05
              }
            ]
          },
          "mappings": []
        },
        "overrides": []
      },
      "options": {
        "reduceOptions": {
          "values": false,
          "calcs": [
            "lastNotNull"
          ],
          "fields": ""
        },
        "orientation": "auto",
        "textMode": "auto",
        "colorMode": "background",
        "graphMode": "none",
        "justifyMode": "auto"
      }
    },
    {
      "id": 2,
      "type": "stat",
      "title": "Request Rate (last 5m)",
      "description": "Total edge request rate (all status codes).",
      "gridPos": {
        "h": 4,
        "w": 4,
        "x": 4,
        "y": 0
      },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        {
          "refId": "A",
          "datasource": ${dsRef(DS_PROMETHEUS)},
          "expr": "sum(rate(traefik_entrypoint_requests_total[5m]))",
          "instant": true,
          "legendFormat": "req/s"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "reqps",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "blue",
                "value": null
              }
            ]
          }
        },
        "overrides": []
      },
      "options": {
        "reduceOptions": {
          "values": false,
          "calcs": [
            "lastNotNull"
          ],
          "fields": ""
        },
        "orientation": "auto",
        "textMode": "auto",
        "colorMode": "value",
        "graphMode": "none",
        "justifyMode": "auto"
      }
    },
    {
      "id": 3,
      "type": "stat",
      "title": "P95 Latency (last 5m)",
      "description": "95th-percentile end-to-end latency across all routers.",
      "gridPos": {
        "h": 4,
        "w": 4,
        "x": 8,
        "y": 0
      },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        {
          "refId": "A",
          "datasource": ${dsRef(DS_PROMETHEUS)},
          "expr": "histogram_quantile(0.95, sum(rate(traefik_entrypoint_request_duration_seconds_bucket[5m])) by (le))",
          "instant": true,
          "legendFormat": "p95"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "yellow",
                "value": 1
              },
              {
                "color": "red",
                "value": 5
              }
            ]
          }
        },
        "overrides": []
      },
      "options": {
        "reduceOptions": {
          "values": false,
          "calcs": [
            "lastNotNull"
          ],
          "fields": ""
        },
        "orientation": "auto",
        "textMode": "auto",
        "colorMode": "background",
        "graphMode": "none",
        "justifyMode": "auto"
      }
    },
    {
      "id": 4,
      "type": "timeseries",
      "title": "Request Rate by Status Code",
      "description": "Edge request rate split by HTTP status code. Healthy: green (2xx) dominates.",
      "gridPos": {
        "h": 8,
        "w": 24,
        "x": 0,
        "y": 4
      },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        {
          "refId": "A",
          "datasource": ${dsRef(DS_PROMETHEUS)},
          "expr": "sum(rate(traefik_entrypoint_requests_total[2m])) by (code)",
          "legendFormat": "{{code}}"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "reqps",
          "custom": {
            "lineWidth": 1,
            "fillOpacity": 10,
            "spanNulls": false
          }
        },
        "overrides": [
          {
            "matcher": {
              "id": "byRegexp",
              "options": "^2.."
            },
            "properties": [
              {
                "id": "color",
                "value": {
                  "mode": "fixed",
                  "fixedColor": "green"
                }
              }
            ]
          },
          {
            "matcher": {
              "id": "byRegexp",
              "options": "^4.."
            },
            "properties": [
              {
                "id": "color",
                "value": {
                  "mode": "fixed",
                  "fixedColor": "yellow"
                }
              }
            ]
          },
          {
            "matcher": {
              "id": "byRegexp",
              "options": "^5.."
            },
            "properties": [
              {
                "id": "color",
                "value": {
                  "mode": "fixed",
                  "fixedColor": "red"
                }
              }
            ]
          }
        ]
      },
      "options": {
        "tooltip": {
          "mode": "multi",
          "sort": "desc"
        },
        "legend": {
          "showLegend": true,
          "displayMode": "table",
          "placement": "right"
        },
        "fillOpacity": 10
      }
    },
    {
      "id": 5,
      "type": "timeseries",
      "title": "5xx Error Rate %",
      "description": "Percentage of edge requests returning 5xx. Alert fires at 5%.",
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 0,
        "y": 12
      },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        {
          "refId": "A",
          "datasource": ${dsRef(DS_PROMETHEUS)},
          "expr": "100 * sum(rate(traefik_entrypoint_requests_total{code=~\\"5..\\"}[5m])) / sum(rate(traefik_entrypoint_requests_total[5m]))",
          "legendFormat": "5xx %"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percent",
          "min": 0,
          "custom": {
            "lineWidth": 2,
            "fillOpacity": 20
          },
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 5
              }
            ]
          }
        },
        "overrides": []
      },
      "options": {
        "tooltip": {
          "mode": "single"
        },
        "legend": {
          "showLegend": true
        },
        "thresholdsStyle": {
          "mode": "line"
        }
      }
    },
    {
      "id": 6,
      "type": "timeseries",
      "title": "Latency Percentiles (P50 / P95 / P99)",
      "description": "End-to-end request latency percentiles across all routers.",
      "gridPos": {
        "h": 8,
        "w": 12,
        "x": 12,
        "y": 12
      },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        {
          "refId": "A",
          "datasource": ${dsRef(DS_PROMETHEUS)},
          "expr": "histogram_quantile(0.50, sum(rate(traefik_entrypoint_request_duration_seconds_bucket[5m])) by (le))",
          "legendFormat": "p50"
        },
        {
          "refId": "B",
          "datasource": ${dsRef(DS_PROMETHEUS)},
          "expr": "histogram_quantile(0.95, sum(rate(traefik_entrypoint_request_duration_seconds_bucket[5m])) by (le))",
          "legendFormat": "p95"
        },
        {
          "refId": "C",
          "datasource": ${dsRef(DS_PROMETHEUS)},
          "expr": "histogram_quantile(0.99, sum(rate(traefik_entrypoint_request_duration_seconds_bucket[5m])) by (le))",
          "legendFormat": "p99"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "s",
          "custom": {
            "lineWidth": 1
          }
        },
        "overrides": []
      },
      "options": {
        "tooltip": {
          "mode": "multi",
          "sort": "desc"
        },
        "legend": {
          "showLegend": true,
          "displayMode": "table",
          "placement": "right"
        }
      }
    },
    {
      "id": 7,
      "type": "timeseries",
      "title": "Request Rate by Router",
      "description": "Per-router request rate. Useful for identifying hot paths or missing traffic.",
      "gridPos": {
        "h": 8,
        "w": 24,
        "x": 0,
        "y": 20
      },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        {
          "refId": "A",
          "datasource": ${dsRef(DS_PROMETHEUS)},
          "expr": "sum(rate(traefik_service_requests_total[2m])) by (service)",
          "legendFormat": "{{router}}"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "reqps",
          "custom": {
            "lineWidth": 1
          }
        },
        "overrides": []
      },
      "options": {
        "tooltip": {
          "mode": "multi",
          "sort": "desc"
        },
        "legend": {
          "showLegend": true,
          "displayMode": "table",
          "placement": "right",
          "calcs": [
            "mean",
            "max"
          ]
        }
      }
    }
  ],
  "templating": {
    "list": []
  },
  "annotations": {
    "list": [
      {
        "builtIn": 1,
        "datasource": {
          "type": "grafana",
          "uid": "-- Grafana --"
        },
        "enable": true,
        "hide": true,
        "iconColor": "rgba(0, 211, 255, 1)",
        "name": "Annotations & Alerts",
        "type": "dashboard"
      }
    ]
  },
  "links": [
    {
      "asDropdown": false,
      "icon": "external link",
      "includeVars": false,
      "keepTime": true,
      "tags": [
        "forge-mon"
      ],
      "targetBlank": true,
      "title": "Log Explorer",
      "tooltip": "Open log search / correlation-id journey",
      "type": "dashboards",
      "url": ""
    }
  ]
}`;

// DASHBOARD_LOG_EXPLORER (box-era, all-Loki) was RETIRED 2026-09-05 with the forge-loki
// datasource: production log exploration is Cloud Logging Explore / the forge console,
// and every one of its panels was LogQL over a store production does not have.

/** Dashboard: MCP Tool Health (RED per tool + registration + dispatch log) */
export const DASHBOARD_MCP_TOOL_HEALTH = `{
  "uid": "forge-mon-mcp-tools",
  "title": "MCP Tool Health",
  "tags": [
    "dorinda",
    "mcp"
  ],
  "timezone": "browser",
  "schemaVersion": 39,
  "refresh": "30s",
  "time": {
    "from": "now-6h",
    "to": "now"
  },
  "panels": [
    {
      "id": 1,
      "type": "stat",
      "title": "Tools registered",
      "gridPos": {
        "h": 5,
        "w": 4,
        "x": 0,
        "y": 0
      },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        {
          "refId": "A",
          "expr": "max(mcp_tools_registered)"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "red",
                "value": null
              },
              {
                "color": "green",
                "value": 26
              }
            ]
          }
        },
        "overrides": []
      }
    },
    {
      "id": 2,
      "type": "stat",
      "title": "Registration health",
      "gridPos": {
        "h": 5,
        "w": 4,
        "x": 4,
        "y": 0
      },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        {
          "refId": "A",
          "expr": "max(mcp_registration_health_ratio)"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "percentunit",
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "red",
                "value": null
              },
              {
                "color": "green",
                "value": 1
              }
            ]
          }
        },
        "overrides": []
      }
    },
    {
      "id": 3,
      "type": "timeseries",
      "title": "Tool calls / min (by tool)",
      "gridPos": {
        "h": 9,
        "w": 16,
        "x": 8,
        "y": 0
      },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (tool) (rate({__name__=~\\"mcp_tool_calls(_total)?\\", app=~\\".+\\"}[5m])) * 60",
          "legendFormat": "{{tool}}"
        }
      ]
    },
    {
      "id": 4,
      "type": "timeseries",
      "title": "Tool errors / min (by tool, error class)",
      "gridPos": {
        "h": 9,
        "w": 12,
        "x": 0,
        "y": 9
      },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (tool, error_class) (rate({__name__=~\\"mcp_tool_errors(_total)?\\", app=~\\".+\\"}[5m])) * 60",
          "legendFormat": "{{tool}} \\u00b7 {{error_class}}"
        }
      ]
    },
    {
      "id": 5,
      "type": "timeseries",
      "title": "Tool duration p95 (ms, by tool)",
      "gridPos": {
        "h": 9,
        "w": 12,
        "x": 12,
        "y": 9
      },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        {
          "refId": "A",
          "expr": "histogram_quantile(0.95, sum by (le, tool) (rate({__name__=~\\"mcp_tool_duration_ms(_milliseconds)?_bucket\\", app=~\\".+\\"}[5m])))",
          "legendFormat": "{{tool}}"
        }
      ]
    },
    {
      "id": 6,
      "type": "logs",
      "title": "MCP dispatch log (app tier \\u2014 tool, owner, gate, outcome, correlation id)",
      "gridPos": {
        "h": 10,
        "w": 24,
        "x": 0,
        "y": 18
      },
      "datasource": ${dsRef(DS_CLOUD_LOGGING)},
      "targets": [
        {
          "refId": "A",
          "projectId": "PROJECT_ID",
          "queryText": "resource.type=\\"cloud_run_revision\\" resource.labels.service_name=\\"dorinda-api\\" jsonPayload.op=\\"mcp.dispatch\\""
        }
      ],
      "options": {
        "showTime": true,
        "wrapLogMessage": true,
        "sortOrder": "Descending"
      }
    }
  ]
}`;

/** Dashboard: Background Plane (sweeps, gcal-sync per-owner causes) */
export const DASHBOARD_BACKGROUND_PLANE = `{
  "uid": "forge-mon-background",
  "title": "Background Plane (sweeps · sync · routines)",
  "tags": [
    "dorinda",
    "background"
  ],
  "timezone": "browser",
  "schemaVersion": 39,
  "refresh": "1m",
  "time": {
    "from": "now-24h",
    "to": "now"
  },
  "panels": [
    {
      "id": 3,
      "type": "logs",
      "title": "gcal-sync per-owner log (WITH error cause — the ok=0/errors=N killer)",
      "gridPos": {
        "h": 10,
        "w": 24,
        "x": 0,
        "y": 9
      },
      "datasource": ${dsRef(DS_CLOUD_LOGGING)},
      "targets": [
        {
          "refId": "A",
          "projectId": "PROJECT_ID",
          "queryText": "resource.type=\\"cloud_run_revision\\" resource.labels.service_name=\\"dorinda-api\\" jsonPayload.type=\\"gcal.sync.owner\\""
        }
      ],
      "options": {
        "showTime": true,
        "wrapLogMessage": true,
        "sortOrder": "Descending"
      }
    },
    {
      "id": 4,
      "type": "logs",
      "title": "Background errors (any sweep/sync line carrying an error)",
      "gridPos": {
        "h": 10,
        "w": 24,
        "x": 0,
        "y": 19
      },
      "datasource": ${dsRef(DS_CLOUD_LOGGING)},
      "targets": [
        {
          "refId": "A",
          "projectId": "PROJECT_ID",
          "queryText": "resource.type=\\"cloud_run_revision\\" resource.labels.service_name=\\"dorinda-api\\" (severity>=ERROR OR jsonPayload.error:*)"
        }
      ],
      "options": {
        "showTime": true,
        "wrapLogMessage": true,
        "sortOrder": "Descending"
      }
    },
    {
      "id": 5,
      "type": "timeseries",
      "title": "Domain + account-lifecycle counters — appear on first event",
      "gridPos": {
        "h": 9,
        "w": 24,
        "x": 0,
        "y": 29
      },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (__name__) (rate({__name__=~\\"(gcal_sync|message_staged|message_sent|approval|reminders_fired|routines_ran|account_purged|account_created).*\\"}[15m])) * 900",
          "legendFormat": "{{__name__}}"
        }
      ]
    }
  ]
}`;

/**
 * Dashboard 6: Service Health (HTTP) — the RED metrics for every Cloud Run service.
 *
 * ⛔ WHY THIS EXISTS: until 2026-07-31 Grafana had NO panel for any HTTP surface. Its datasources
 * were Managed Prometheus (MCP tool metrics) and Cloud Logging, so every non-MCP flow — signup,
 * email verification, login, trial start, admin operations — was invisible in Grafana **by
 * construction**. An acceptance run checking "is this flow visible in both UIs?" could only ever
 * answer "console yes, Grafana no", for the majority of the product's traffic.
 *
 * Cloud Run publishes request_count and request_latencies to Cloud Monitoring, which needs no
 * instrumentation in the app and cannot be broken by an app-side telemetry regression — the
 * independent-failure-mode argument that made this platform run two metric sources in the first
 * place. Queried through the `stackdriver` datasource with workload-identity auth (`gce`), the same
 * way the Cloud Logging datasource already authenticates.
 */
export const DASHBOARD_SERVICE_HTTP = `{
  "id": null,
  "uid": "forge-mon-service-http",
  "title": "Service Health (HTTP · RED)",
  "tags": ["forge", "http"],
  "timezone": "browser",
  "schemaVersion": 39,
  "refresh": "1m",
  "time": { "from": "now-6h", "to": "now" },
  "panels": [
    {
      "id": 1,
      "type": "timeseries",
      "title": "Requests / s (by service)",
      "description": "Every HTTP surface: the app, the data plane, the web BFF. Answers 'did my flow reach the server at all', which no other dashboard here can.",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 0 },
      "fieldConfig": { "defaults": { "unit": "reqps" }, "overrides": [] },
      "datasource": ${dsRef(DS_CLOUD_MONITORING)},
      "targets": [
        {
          "refId": "A",
          "datasource": ${dsRef(DS_CLOUD_MONITORING)},
          "queryType": "timeSeriesList",
          "timeSeriesList": {
            "projectName": "PROJECT_ID",
            "filters": ["metric.type", "=", "run.googleapis.com/request_count"],
            "crossSeriesReducer": "REDUCE_SUM",
            "perSeriesAligner": "ALIGN_RATE",
            "alignmentPeriod": "60s",
            "groupBys": ["resource.label.service_name"]
          }
        }
      ]
    },
    {
      "id": 2,
      "type": "timeseries",
      "title": "5xx / s (by service)",
      "description": "Server errors only. A flat line here during a flow that LOOKED fine is the reassurance; a spike is the first place to look.",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 0 },
      "fieldConfig": { "defaults": { "unit": "reqps" }, "overrides": [] },
      "datasource": ${dsRef(DS_CLOUD_MONITORING)},
      "targets": [
        {
          "refId": "A",
          "datasource": ${dsRef(DS_CLOUD_MONITORING)},
          "queryType": "timeSeriesList",
          "timeSeriesList": {
            "projectName": "PROJECT_ID",
            "filters": ["metric.type", "=", "run.googleapis.com/request_count", "AND", "metric.label.response_code_class", "=", "5xx"],
            "crossSeriesReducer": "REDUCE_SUM",
            "perSeriesAligner": "ALIGN_RATE",
            "alignmentPeriod": "60s",
            "groupBys": ["resource.label.service_name"]
          }
        }
      ]
    },
    {
      "id": 3,
      "type": "timeseries",
      "title": "Latency p95 (ms, by service)",
      "description": "Cloud Run measures this at the edge, so it includes cold starts — which is what the user actually waits through.",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 8 },
      "fieldConfig": { "defaults": { "unit": "ms" }, "overrides": [] },
      "datasource": ${dsRef(DS_CLOUD_MONITORING)},
      "targets": [
        {
          "refId": "A",
          "datasource": ${dsRef(DS_CLOUD_MONITORING)},
          "queryType": "timeSeriesList",
          "timeSeriesList": {
            "projectName": "PROJECT_ID",
            "filters": ["metric.type", "=", "run.googleapis.com/request_latencies"],
            "crossSeriesReducer": "REDUCE_PERCENTILE_95",
            "perSeriesAligner": "ALIGN_DELTA",
            "alignmentPeriod": "60s",
            "groupBys": ["resource.label.service_name"]
          }
        }
      ]
    },
    {
      "id": 4,
      "type": "timeseries",
      "title": "Container instances (by service)",
      "description": "Reads against max_instances, a ceiling nobody watches. A collector or app pinned at zero is why pushed telemetry silently disappears.",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 8 },
      "datasource": ${dsRef(DS_CLOUD_MONITORING)},
      "targets": [
        {
          "refId": "A",
          "datasource": ${dsRef(DS_CLOUD_MONITORING)},
          "queryType": "timeSeriesList",
          "timeSeriesList": {
            "projectName": "PROJECT_ID",
            "filters": ["metric.type", "=", "run.googleapis.com/container/instance_count"],
            "crossSeriesReducer": "REDUCE_SUM",
            "perSeriesAligner": "ALIGN_MEAN",
            "alignmentPeriod": "60s",
            "groupBys": ["resource.label.service_name"]
          }
        }
      ]
    }
  ]
}`;

/** Dashboard 5: MCP Tool Drilldown — pick ONE tool, see all its metrics + logs. */
export const DASHBOARD_TOOL_DRILLDOWN = `{
  "id": null,
  "uid": "forge-tool-drilldown",
  "title": "MCP Tool Drilldown",
  "description": "Pick a tool from the dropdown: transport-family RED metrics (calls, errors, latency), app-tier gate decisions, and both log tiers (app dispatch + data-plane, with Claude/ChatGPT client attribution). Payloads live in the forge console's log view.",
  "tags": ["forge-mon", "mcp", "drilldown"],
  "timezone": "browser",
  "schemaVersion": 39,
  "version": 1,
  "refresh": "30s",
  "time": { "from": "now-6h", "to": "now" },
  "timepicker": {},
  "graphTooltip": 0,
  "templating": {
    "list": [
      {
        "name": "tool",
        "label": "MCP tool",
        "type": "query",
        "datasource": ${dsRef(DS_PROMETHEUS)},
        "query": "label_values({__name__=~\\"mcp_tool_calls(_total)?\\", app=~\\".+\\"}, tool)",
        "current": { "value": "whats_next", "text": "whats_next" },
        "includeAll": false,
        "hide": 0,
        "refresh": 2,
        "sort": 1,
        "multi": false
      }
    ]
  },
  "panels": [
    {
      "id": 1, "type": "stat", "title": "Calls (selected range)",
      "gridPos": { "h": 4, "w": 8, "x": 0, "y": 0 },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [{ "refId": "A", "instant": true, "expr": "sum(increase({__name__=~\\"mcp_tool_calls(_total)?\\", app=~\\".+\\", tool=\\"$tool\\"}[$__range])) or on() vector(0)" }]
    },
    {
      "id": 2, "type": "stat", "title": "Errors (selected range)",
      "gridPos": { "h": 4, "w": 8, "x": 8, "y": 0 },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "fieldConfig": { "defaults": { "thresholds": { "mode": "absolute", "steps": [ { "color": "green", "value": null }, { "color": "red", "value": 1 } ] } }, "overrides": [] },
      "targets": [{ "refId": "A", "instant": true, "expr": "sum(increase({__name__=~\\"mcp_tool_errors(_total)?\\", app=~\\".+\\", tool=\\"$tool\\"}[$__range])) or on() vector(0)" }]
    },
    {
      "id": 3, "type": "stat", "title": "p95 latency (15m, ms)",
      "gridPos": { "h": 4, "w": 8, "x": 16, "y": 0 },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [{ "refId": "A", "instant": true, "expr": "histogram_quantile(0.95, sum by (le) (rate({__name__=~\\"mcp_tool_duration_ms(_milliseconds)?_bucket\\", app=~\\".+\\", tool=\\"$tool\\"}[15m])))" }]
    },
    {
      "id": 4, "type": "timeseries", "title": "Calls / min (by outcome)",
      "gridPos": { "h": 9, "w": 12, "x": 0, "y": 4 },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [{ "refId": "A", "expr": "sum by (outcome) (rate({__name__=~\\"mcp_tool_calls(_total)?\\", app=~\\".+\\", tool=\\"$tool\\"}[5m])) * 60", "legendFormat": "{{outcome}}" }]
    },
    {
      "id": 5, "type": "timeseries", "title": "Errors / min (by class)",
      "gridPos": { "h": 9, "w": 12, "x": 12, "y": 4 },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [{ "refId": "A", "expr": "sum by (error_class) (rate({__name__=~\\"mcp_tool_errors(_total)?\\", app=~\\".+\\", tool=\\"$tool\\"}[5m])) * 60", "legendFormat": "{{error_class}}" }]
    },
    {
      "id": 6, "type": "timeseries", "title": "Latency p50 / p95 (ms)",
      "gridPos": { "h": 9, "w": 12, "x": 0, "y": 13 },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [
        { "refId": "A", "expr": "histogram_quantile(0.50, sum by (le) (rate({__name__=~\\"mcp_tool_duration_ms(_milliseconds)?_bucket\\", app=~\\".+\\", tool=\\"$tool\\"}[5m])))", "legendFormat": "p50" },
        { "refId": "B", "expr": "histogram_quantile(0.95, sum by (le) (rate({__name__=~\\"mcp_tool_duration_ms(_milliseconds)?_bucket\\", app=~\\".+\\", tool=\\"$tool\\"}[5m])))", "legendFormat": "p95" }
      ]
    },
    {
      "id": 7, "type": "timeseries", "title": "Gate decisions / min (app tier: allow · pending · deny)",
      "gridPos": { "h": 9, "w": 12, "x": 12, "y": 13 },
      "datasource": ${dsRef(DS_PROMETHEUS)},
      "targets": [{ "refId": "A", "expr": "sum by (gate) (rate({__name__=~\\"mcp_tool_gate(_total)?\\", tool=\\"$tool\\"}[5m])) * 60", "legendFormat": "{{gate}}" }]
    },
    {
      "id": 8, "type": "logs", "title": "App dispatch log — owner, gate, outcome, duration",
      "gridPos": { "h": 10, "w": 24, "x": 0, "y": 22 },
      "datasource": ${dsRef(DS_CLOUD_LOGGING)},
      "options": { "showTime": true, "wrapLogMessage": true, "sortOrder": "Descending", "enableLogDetails": true },
      "targets": [{ "refId": "A", "projectId": "PROJECT_ID", "queryText": "resource.type=\\"cloud_run_revision\\" resource.labels.service_name=\\"dorinda-api\\" jsonPayload.op=\\"mcp.dispatch\\" jsonPayload.tool=\\"$tool\\"" }]
    },
    {
      "id": 9, "type": "logs", "title": "Data-plane log — which AI called (client = Claude / ChatGPT), transport outcome",
      "gridPos": { "h": 10, "w": 24, "x": 0, "y": 32 },
      "datasource": ${dsRef(DS_CLOUD_LOGGING)},
      "options": { "showTime": true, "wrapLogMessage": true, "sortOrder": "Descending", "enableLogDetails": true },
      "targets": [{ "refId": "A", "projectId": "PROJECT_ID", "queryText": "resource.type=\\"cloud_run_revision\\" resource.labels.service_name=\\"forge-data-plane\\" \\"mcp.tool_call\\" jsonPayload.tool=\\"$tool\\"" }]
    }
  ]
}`;

/** Dashboard 6: User Experience Drilldown — pick a user BY EMAIL, see their whole MCP experience.
 *  Requires the read-only platform-DB datasource (forge-appdb) for the email picker — logs never
 *  carry an email (emails must not outlive a purged account), so email → owner-id resolution
 *  happens at query time against forge_identity_users. Per-user log panels ride Cloud Logging.
 *  Per-user rate/latency panels are deliberately absent: per-user metric labels are a cardinality
 *  trap (per-tool rates live on the Tool Drilldown), and the Cloud Logging datasource returns log
 *  lines, not series. Mirrors the production board validated live 2026-08-27 (dorinda-metrics). */
export function renderUserExperienceDashboard(o: { appId: string }): string {
  return `{
  "id": null,
  "uid": "forge-user-experience",
  "title": "User Experience Drilldown",
  "description": "Pick a user by email: every MCP tool call they made, problems only, and which AI they used. The email picker resolves email -> owner id via the read-only Forge platform DB datasource. Payload digging (requests/responses) lives in the forge console's log view, filtered by the owner id shown in the header.",
  "tags": ["forge-mon", "mcp", "user", "drilldown"],
  "timezone": "browser",
  "schemaVersion": 39,
  "version": 1,
  "refresh": "30s",
  "time": { "from": "now-24h", "to": "now" },
  "timepicker": {},
  "graphTooltip": 0,
  "templating": {
    "list": [
      {
        "name": "user",
        "label": "User (by email)",
        "type": "query",
        "datasource": ${dsRef(DS_FORGE_PLATFORM_DB)},
        "query": "SELECT email AS __text, id AS __value FROM forge_identity_users WHERE app_id = '${o.appId}' ORDER BY email",
        "current": {},
        "includeAll": false,
        "hide": 0,
        "refresh": 1,
        "sort": 0,
        "multi": false
      }
    ]
  },
  "panels": [
    {
      "id": 1, "type": "text", "title": "",
      "gridPos": { "h": 7, "w": 24, "x": 0, "y": 0 },
      "options": { "mode": "markdown", "content": "### Everything one user's AI did\\nSelected owner id: **\`\${user}\`** — logs are keyed by owner id, never email (emails must not outlive a purged account), so the picker above resolves email → owner via the read-only Forge platform DB.\\n\\n**Payloads (requests/responses) live in the forge console** — open its Logs view and filter by this owner id. Per-user rate/latency graphs are deliberately absent here: per-user metric labels would explode cardinality (per-tool rates live on the MCP Tool Drilldown), and Cloud Logging panels show lines, not series.\\n\\n**Reading an empty panel:** the bottom panel shows the latest dispatch lines for *any* user. If it has lines and the user panels are empty, this user was quiet in the window. If it is empty too, the feed or the filter is broken — do not read empty as \\"no activity\\"." }
    },
    {
      "id": 2, "type": "logs", "title": "Every tool call — this user (api dispatch, newest first)",
      "gridPos": { "h": 11, "w": 24, "x": 0, "y": 7 },
      "datasource": ${dsRef(DS_CLOUD_LOGGING)},
      "options": { "showTime": true, "wrapLogMessage": true, "sortOrder": "Descending", "enableLogDetails": true },
      "targets": [{ "refId": "A", "projectId": "PROJECT_ID", "queryText": "resource.type=\\"cloud_run_revision\\" resource.labels.service_name=\\"dorinda-api\\" jsonPayload.op=\\"mcp.dispatch\\" jsonPayload.owner=\\"\${user}\\"" }]
    },
    {
      "id": 3, "type": "logs", "title": "Problems only — errors and denials (gate=pending is NOT a problem: it is beat one of an approval)",
      "gridPos": { "h": 9, "w": 12, "x": 0, "y": 18 },
      "datasource": ${dsRef(DS_CLOUD_LOGGING)},
      "options": { "showTime": true, "wrapLogMessage": true, "sortOrder": "Descending", "enableLogDetails": true },
      "targets": [{ "refId": "A", "projectId": "PROJECT_ID", "queryText": "resource.type=\\"cloud_run_revision\\" resource.labels.service_name=\\"dorinda-api\\" jsonPayload.op=\\"mcp.dispatch\\" jsonPayload.owner=\\"\${user}\\" (jsonPayload.outcome=\\"error\\" OR jsonPayload.gate=\\"deny\\")" }]
    },
    {
      "id": 4, "type": "logs", "title": "Which AI — data-plane attribution (expand a line: \`client\` = Claude vs ChatGPT)",
      "gridPos": { "h": 9, "w": 12, "x": 12, "y": 18 },
      "datasource": ${dsRef(DS_CLOUD_LOGGING)},
      "options": { "showTime": true, "wrapLogMessage": true, "sortOrder": "Descending", "enableLogDetails": true },
      "targets": [{ "refId": "A", "projectId": "PROJECT_ID", "queryText": "resource.type=\\"cloud_run_revision\\" resource.labels.service_name=\\"forge-data-plane\\" \\"mcp.tool_call\\" jsonPayload.user=\\"\${user}\\"" }]
    },
    {
      "id": 5, "type": "logs", "title": "Feed liveness — latest dispatch lines, ANY user (empty here = broken feed/filter, not a quiet user)",
      "gridPos": { "h": 8, "w": 24, "x": 0, "y": 27 },
      "datasource": ${dsRef(DS_CLOUD_LOGGING)},
      "options": { "showTime": true, "wrapLogMessage": false, "sortOrder": "Descending", "enableLogDetails": true },
      "targets": [{ "refId": "A", "projectId": "PROJECT_ID", "queryText": "resource.type=\\"cloud_run_revision\\" resource.labels.service_name=\\"dorinda-api\\" jsonPayload.op=\\"mcp.dispatch\\"" }]
    }
  ]
}`;
}
