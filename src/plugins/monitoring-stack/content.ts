// Generated-once from the live-validated stack configs (2026-07-26) — now OWNED by forge.
// Edit HERE and re-release; never hand-edit a provisioned stack dir (regen clobbers it).
// Datasource uids are forge-loki / forge-prometheus everywhere (datasources, dashboards, alerts).
// 0.75.1: metric names fixed to what Traefik OTLP actually emits (entrypoint/service — router-level
// series do not exist), TLS rule ms→s, Loki alert selectors on service_name (job label never set),
// Dead-MCP-Registration re-based on the mcp_tools_registered gauge (register lines only log at boot).

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

/** Grafana datasources — fixed uids forge-loki / forge-prometheus */
export const GRAFANA_DATASOURCES = `# Grafana datasource provisioning.
#
# UIDs are fixed so the alerting rules can reference them without depending on
# auto-assigned IDs. These UIDs must match the \`datasourceUid\` values in
# grafana/provisioning/alerting/alert_rules.yml.
#
# deleteDatasources: any datasource listed here is removed on Grafana startup if
# it exists with that name but NOT in this file.

apiVersion: 1

datasources:

  # ── Prometheus ─────────────────────────────────────────────────────────────
  # Scraped from otel-collector:8889 — contains all Traefik OTLP metrics.
  - name: Prometheus
    uid: forge-prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
    jsonData:
      httpMethod: POST
      timeInterval: "15s"        # matches scrape_interval in prometheus.yml
      exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: forge-loki   # link trace IDs in metrics to Loki logs

  # ── Loki ───────────────────────────────────────────────────────────────────
  # Receives structured logs from otel-collector via OTLP.
  # Log labels injected by the OTel collector include: job, service_name, etc.
  - name: Loki
    uid: forge-loki
    type: loki
    access: proxy
    url: http://loki:3100
    isDefault: false
    editable: false
    jsonData:
      maxLines: 1000
      derivedFields:
        # Derive a TraceID field from Traefik's JSON access log \`TraceID\` key
        # and link it to Langfuse (external URL).
        - matcherRegex: '"TraceID":"([a-f0-9]+)"'
          name: TraceID
          url: "http://langfuse-web:3000/trace/$\${__value.raw}"
          urlDisplayLabel: "Open in Langfuse"
`;

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

/** Grafana unified-alerting rules: MCP Dispatch Errors · Sweep Error Streak · Edge 5xx Spike · Dead MCP Registration (gauge-based) */
export const GRAFANA_ALERT_RULES = `# Grafana unified alerting — log-based alert rules (Loki datasource).
#
# These four alerts cover the failure modes in the acceptance criteria:
#   1. silent-tool-call-death   — tool call started but timed out / never completed
#   2. sweep-error-streak       — repeated sweep errors in a short window
#   3. edge-5xx-spike           — high 5xx rate at the edge  (Prometheus-metric version;
#                                  the Prometheus rules file has the same alert —
#                                  this Grafana copy fires via Loki-derived log count
#                                  as a belt-and-suspenders check from a different source)
#   4. dead-mcp-registration    — no MCP registration events seen in the last 10 minutes
#
# TUNING: The LogQL expressions below use broad patterns (|= "keyword").
# After first deployment, inspect actual log labels and field names with Grafana Explore
# and tighten the selectors (e.g. {service_name="dorinda-api"} instead of {service_name=~".+"}).
#
# Datasource UIDs must match grafana/provisioning/datasources/datasources.yml:
#   forge-loki
#   forge-prometheus
#   -100  (special: Grafana expression/math datasource — always present)
#
# Reference: https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/

apiVersion: 1

groups:

  # ── Loki-based alert group ─────────────────────────────────────────────────
  - orgId: 1
    name: forge-mon-loki-alerts
    folder: forge-mon
    interval: 1m
    rules:

      # ── 1. MCP Dispatch Errors ──────────────────────────────────────────
      # Detects tool calls that were started but never produced a result or error.
      # The LogQL looks for lines that mention "tool_call" AND contain a timeout /
      # dead / hung keyword — indicating the call entered but never exited cleanly.
      #
      # TUNING: Replace the match patterns with your app's actual log vocabulary.
      # A more precise approach once logs are flowing: use two separate queries —
      # count_over_time of "tool_call_started" vs "tool_call_completed" — and alert
      # when started count > completed count for > 5 minutes. That requires two data
      # steps and a math expression referencing both (refId D: "$A - $B > 0").
      - uid: loki-silent-tool-call-death
        title: MCP Dispatch Errors (burst)
        condition: B
        for: 5m
        data:
          # Step A: count log lines indicating a tool call died without completing
          - refId: A
            queryType: ''
            relativeTimeRange:
              from: 300   # last 5 min
              to: 0
            datasourceUid: forge-loki
            model:
              expr: 'sum(count_over_time({service_name=~"forge-dorinda-api-prod-web.*"} |= "mcp.dispatch" | json | outcome != \`ok\` [5m]))'
              instant: true
              intervalMs: 1000
              maxDataPoints: 43200
              queryType: instant
              refId: A
          # Step B: fire if any such lines exist
          - refId: B
            queryType: ''
            relativeTimeRange:
              from: 300
              to: 0
            datasourceUid: '-100'
            model:
              conditions:
                - evaluator:
                    params:
                      - 0
                    type: gt
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
        noDataState: OK
        execErrState: Error
        labels:
          severity: warning
          team: forge-mon
        annotations:
          summary: "Tool-call death detected"
          description: >
            Log lines matching tool_call + timeout/hung/dead/no_result appeared in the
            last 5 minutes. Check app logs for silent tool-call failures.
            Tune the LogQL in alert_rules.yml once actual log format is known.

      # ── 2. Sweep Error Streak ──────────────────────────────────────────────
      # Fires when more than 5 sweep-related ERROR log lines appear in 5 minutes,
      # indicating a persistent error loop rather than a transient blip.
      - uid: loki-sweep-error-streak
        title: Sweep Error Streak
        condition: C
        for: 2m
        data:
          # Step A: count ERROR lines in sweep context
          - refId: A
            queryType: ''
            relativeTimeRange:
              from: 300
              to: 0
            datasourceUid: forge-loki
            model:
              # no_calendars_selected is a SKIP (connected, nothing chosen to sync — dorinda-api
              # 53ed52d counts it apart from errors); a streak of it must never page anyone.
              expr: 'sum(count_over_time({service_name=~"forge-dorinda-api-prod-web.*"} |= "gcal.sync.owner" | json | status !~ \`ok|no_calendars_selected\` [30m]))'
              instant: true
              intervalMs: 1000
              maxDataPoints: 43200
              queryType: instant
              refId: A
          # Step C: fire if count exceeds threshold
          - refId: C
            queryType: ''
            relativeTimeRange:
              from: 300
              to: 0
            datasourceUid: '-100'
            model:
              conditions:
                - evaluator:
                    params:
                      - 5          # > 5 sweep errors in 5 min = streak, not a one-off
                    type: gt
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
              refId: C
              type: classic_conditions
        noDataState: OK
        execErrState: Error
        labels:
          severity: warning
          team: forge-mon
        annotations:
          summary: "Sweep error streak: >5 errors in 5 min"
          description: >
            More than 5 sweep-related ERROR log lines in the last 5 minutes.
            This suggests a repeating failure loop rather than a one-off error.

      # ── 3. Edge 5xx Spike (Loki / log-count version) ──────────────────────
      # Belt-and-suspenders: the Prometheus rule fires on metrics; this fires on
      # Traefik's JSON access log lines where DownstreamStatus >= 500.
      # Both fire independently; the Prometheus version is more precise.
      - uid: loki-edge-5xx-spike
        title: Edge 5xx Spike (log-based)
        condition: B
        for: 2m
        data:
          # Step A: count access-log lines with DownstreamStatus 5xx
          # Traefik JSON access log format: {"DownstreamStatus":503,...}
          - refId: A
            queryType: ''
            relativeTimeRange:
              from: 300
              to: 0
            datasourceUid: forge-loki
            model:
              expr: 'sum(count_over_time({service_name="traefik"} |~ \`"DownstreamStatus":5\` [5m]))'
              instant: true
              intervalMs: 1000
              maxDataPoints: 43200
              queryType: instant
              refId: A
          - refId: B
            queryType: ''
            relativeTimeRange:
              from: 300
              to: 0
            datasourceUid: '-100'
            model:
              conditions:
                - evaluator:
                    params:
                      - 10         # > 10 access-log 5xx lines in 5 min
                    type: gt
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
        noDataState: OK
        execErrState: Error
        labels:
          severity: critical
          team: forge-mon
        annotations:
          summary: "Edge 5xx spike (>10 in 5 min)"
          description: >
            Traefik access log shows more than 10 5xx responses in the last 5 minutes.
            Check the Edge Overview dashboard for the failing router.

      # ── 4. Dead MCP Registration ───────────────────────────────────────────
      # GAUGE-based (0.75.1): registration log lines only appear at app boot, so an
      # absence-of-lines check would fire constantly. Instead: the data-plane exports
      # mcp_tools_registered continuously; the surface is dead when it drops below the
      # full tool count (26) or the series disappears entirely (or-vector(0) → 0 < 26).
      - uid: loki-dead-mcp-registration
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
            datasourceUid: forge-prometheus
            model:
              expr: 'min(mcp_tools_registered) or on() vector(0)'
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
  "description": "Traefik edge traffic: request rates, error rates, latency. Data from otel-collector Prometheus scrape endpoint. Langfuse remains the LLM-trace pane.",
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
      "datasource": {
        "type": "prometheus",
        "uid": "forge-prometheus"
      },
      "targets": [
        {
          "refId": "A",
          "datasource": {
            "type": "prometheus",
            "uid": "forge-prometheus"
          },
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
      "datasource": {
        "type": "prometheus",
        "uid": "forge-prometheus"
      },
      "targets": [
        {
          "refId": "A",
          "datasource": {
            "type": "prometheus",
            "uid": "forge-prometheus"
          },
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
      "datasource": {
        "type": "prometheus",
        "uid": "forge-prometheus"
      },
      "targets": [
        {
          "refId": "A",
          "datasource": {
            "type": "prometheus",
            "uid": "forge-prometheus"
          },
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
      "datasource": {
        "type": "prometheus",
        "uid": "forge-prometheus"
      },
      "targets": [
        {
          "refId": "A",
          "datasource": {
            "type": "prometheus",
            "uid": "forge-prometheus"
          },
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
      "datasource": {
        "type": "prometheus",
        "uid": "forge-prometheus"
      },
      "targets": [
        {
          "refId": "A",
          "datasource": {
            "type": "prometheus",
            "uid": "forge-prometheus"
          },
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
      "datasource": {
        "type": "prometheus",
        "uid": "forge-prometheus"
      },
      "targets": [
        {
          "refId": "A",
          "datasource": {
            "type": "prometheus",
            "uid": "forge-prometheus"
          },
          "expr": "histogram_quantile(0.50, sum(rate(traefik_entrypoint_request_duration_seconds_bucket[5m])) by (le))",
          "legendFormat": "p50"
        },
        {
          "refId": "B",
          "datasource": {
            "type": "prometheus",
            "uid": "forge-prometheus"
          },
          "expr": "histogram_quantile(0.95, sum(rate(traefik_entrypoint_request_duration_seconds_bucket[5m])) by (le))",
          "legendFormat": "p95"
        },
        {
          "refId": "C",
          "datasource": {
            "type": "prometheus",
            "uid": "forge-prometheus"
          },
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
      "datasource": {
        "type": "prometheus",
        "uid": "forge-prometheus"
      },
      "targets": [
        {
          "refId": "A",
          "datasource": {
            "type": "prometheus",
            "uid": "forge-prometheus"
          },
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

/** Dashboard: Log Explorer (trace-id search; detected_level panels) */
export const DASHBOARD_LOG_EXPLORER = `{
  "id": null,
  "uid": "forge-mon-log-explorer",
  "title": "Log Explorer / Correlation-ID Journey",
  "description": "Search logs across all services. Enter a trace_id or correlation_id to see the full request journey from edge to backend. Data source: Loki (OTLP logs from otel-collector).",
  "tags": [
    "forge-mon",
    "loki",
    "logs",
    "tracing"
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
  "graphTooltip": 0,
  "templating": {
    "list": [
      {
        "name": "trace_id",
        "label": "Trace / Correlation ID",
        "description": "Paste a trace ID from Langfuse, or a correlation_id / request_id from any log line, to see the full request journey across all services.",
        "type": "textbox",
        "current": {
          "value": "",
          "text": ""
        },
        "hide": 0,
        "options": [],
        "query": ""
      },
      {
        "name": "service",
        "label": "Service filter",
        "description": "Filter by service_name label (leave empty for all services).",
        "type": "query",
        "datasource": {
          "type": "loki",
          "uid": "forge-loki"
        },
        "query": "label_values(service_name)",
        "current": {
          "value": "$__all",
          "text": "All"
        },
        "includeAll": true,
        "allValue": ".*",
        "hide": 0,
        "refresh": 2,
        "sort": 1,
        "multi": false
      }
    ]
  },
  "panels": [
    {
      "id": 1,
      "type": "text",
      "title": "How to use this dashboard",
      "gridPos": {
        "h": 3,
        "w": 24,
        "x": 0,
        "y": 0
      },
      "options": {
        "mode": "markdown",
        "content": "## Request-journey search\\n\\n1. **Paste a trace ID** from Langfuse (or a \`correlation_id\` / \`request_id\` from any log line) into **Trace / Correlation ID** above.\\n2. All log lines from all services sharing that ID appear in the timeline below — edge → backend, ordered by time.\\n3. Use **Service filter** to narrow to one container. Use **Level** to show only errors.\\n\\n**Where to get trace IDs:** Traefik JSON access logs include \`TraceID\` + \`SpanID\`. Click a derived-field link in the Loki datasource to jump from a Traefik log line directly to the matching Langfuse trace.\\n\\n*Langfuse remains the LLM-trace pane. This view covers the full request journey from the edge inward.*"
      },
      "datasource": null
    },
    {
      "id": 2,
      "type": "logs",
      "title": "Request Journey — all services for trace/correlation ID: $trace_id",
      "description": "All log lines sharing the given trace_id or correlation_id, sorted ascending (oldest first) to show the request journey from entry to exit.",
      "gridPos": {
        "h": 20,
        "w": 24,
        "x": 0,
        "y": 3
      },
      "datasource": {
        "type": "loki",
        "uid": "forge-loki"
      },
      "targets": [
        {
          "refId": "A",
          "datasource": {
            "type": "loki",
            "uid": "forge-loki"
          },
          "expr": "{service_name=~\\"$service\\"} |= \\"$trace_id\\"",
          "legendFormat": "",
          "queryType": "range",
          "maxLines": 500
        }
      ],
      "options": {
        "showTime": true,
        "showLabels": true,
        "showCommonLabels": false,
        "wrapLogMessage": true,
        "prettifyLogMessage": false,
        "enableLogDetails": true,
        "dedupStrategy": "none",
        "sortOrder": "Ascending"
      },
      "fieldConfig": {
        "defaults": {},
        "overrides": []
      }
    },
    {
      "id": 3,
      "type": "logs",
      "title": "Error logs — last 1h (all services, level filter: $log_level)",
      "description": "Recent error log lines across all services. Use this for triage without a known trace ID.",
      "gridPos": {
        "h": 16,
        "w": 24,
        "x": 0,
        "y": 23
      },
      "datasource": {
        "type": "loki",
        "uid": "forge-loki"
      },
      "targets": [
        {
          "refId": "A",
          "datasource": {
            "type": "loki",
            "uid": "forge-loki"
          },
          "expr": "{service_name=~\\"$service\\"} | detected_level=~\\"(?i)(error|warn)\\" | line_format \\"{{__line__}}\\"",
          "legendFormat": "",
          "queryType": "range",
          "maxLines": 200
        }
      ],
      "options": {
        "showTime": true,
        "showLabels": true,
        "showCommonLabels": false,
        "wrapLogMessage": true,
        "prettifyLogMessage": false,
        "enableLogDetails": true,
        "dedupStrategy": "signature",
        "sortOrder": "Descending"
      },
      "fieldConfig": {
        "defaults": {},
        "overrides": []
      },
      "transformations": []
    },
    {
      "id": 4,
      "type": "timeseries",
      "title": "Log Volume by Level",
      "description": "Log ingestion rate by level — useful to spot error spikes at a glance.",
      "gridPos": {
        "h": 6,
        "w": 24,
        "x": 0,
        "y": 39
      },
      "datasource": {
        "type": "loki",
        "uid": "forge-loki"
      },
      "targets": [
        {
          "refId": "A",
          "datasource": {
            "type": "loki",
            "uid": "forge-loki"
          },
          "expr": "sum(rate({service_name=~\\"$service\\"} [2m])) by (detected_level)",
          "legendFormat": "{{level}}"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "unit": "short",
          "custom": {
            "lineWidth": 1,
            "fillOpacity": 10
          }
        },
        "overrides": [
          {
            "matcher": {
              "id": "byName",
              "options": "error"
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
          },
          {
            "matcher": {
              "id": "byName",
              "options": "warn"
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
              "id": "byName",
              "options": "info"
            },
            "properties": [
              {
                "id": "color",
                "value": {
                  "mode": "fixed",
                  "fixedColor": "blue"
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
          "displayMode": "list",
          "placement": "right"
        }
      }
    }
  ],
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
      "title": "Edge Overview",
      "tooltip": "Open edge metrics dashboard",
      "type": "dashboards",
      "url": ""
    }
  ]
}`;

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
      "datasource": {
        "type": "prometheus",
        "uid": "forge-prometheus"
      },
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
      "datasource": {
        "type": "prometheus",
        "uid": "forge-prometheus"
      },
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
      "datasource": {
        "type": "prometheus",
        "uid": "forge-prometheus"
      },
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
      "datasource": {
        "type": "prometheus",
        "uid": "forge-prometheus"
      },
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
      "datasource": {
        "type": "prometheus",
        "uid": "forge-prometheus"
      },
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
      "datasource": {
        "type": "loki",
        "uid": "forge-loki"
      },
      "targets": [
        {
          "refId": "A",
          "expr": "{service_name=~\\"forge-dorinda-api-prod-web.*\\"} |= \\"mcp.dispatch\\""
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
      "id": 1,
      "type": "timeseries",
      "title": "Sweep activity (events / 15m, by type)",
      "gridPos": {
        "h": 9,
        "w": 12,
        "x": 0,
        "y": 0
      },
      "datasource": {
        "type": "loki",
        "uid": "forge-loki"
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (type) (count_over_time({service_name=~\\"forge-dorinda-api-prod-web.*\\"} | json | type=~\\".+sweep|gcal.sync.summary\\" [15m]))",
          "legendFormat": "{{type}}"
        }
      ]
    },
    {
      "id": 2,
      "type": "timeseries",
      "title": "gcal-sync owner outcomes (per 15m, by status)",
      "gridPos": {
        "h": 9,
        "w": 12,
        "x": 12,
        "y": 0
      },
      "datasource": {
        "type": "loki",
        "uid": "forge-loki"
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (status) (count_over_time({service_name=~\\"forge-dorinda-api-prod-web.*\\"} | json | type=\\"gcal.sync.owner\\" [15m]))",
          "legendFormat": "{{status}}"
        }
      ]
    },
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
      "datasource": {
        "type": "loki",
        "uid": "forge-loki"
      },
      "targets": [
        {
          "refId": "A",
          "expr": "{service_name=~\\"forge-dorinda-api-prod-web.*\\"} |= \\"gcal.sync.owner\\""
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
      "datasource": {
        "type": "loki",
        "uid": "forge-loki"
      },
      "targets": [
        {
          "refId": "A",
          "expr": "{service_name=~\\"forge-dorinda-api-prod-web.*\\"} | json | (error != \`\` and error != \`null\`) or (status != \`ok\` and status != \`\`) | line_format \`{{.type}} owner={{.owner}} status={{.status}} error={{.error}}\`"
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
      "title": "Domain counters (staged/approved/sent · sync ok/error) — appear on first event",
      "gridPos": {
        "h": 9,
        "w": 24,
        "x": 0,
        "y": 29
      },
      "datasource": {
        "type": "prometheus",
        "uid": "forge-prometheus"
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (__name__) (rate({__name__=~\\"(gcal_sync|message_staged|message_sent|approval|reminders_fired|routines_ran).*\\"}[15m])) * 900",
          "legendFormat": "{{__name__}}"
        }
      ]
    }
  ]
}`;
