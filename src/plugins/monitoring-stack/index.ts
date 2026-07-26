import { randomBytes } from 'node:crypto';
import {
  LOKI_CONFIG,
  PROMETHEUS_CONFIG,
  PROMETHEUS_RULES,
  GRAFANA_DATASOURCES,
  GRAFANA_DASHBOARD_PROVIDER,
  GRAFANA_ALERT_RULES,
  GRAFANA_CONTACT_POINTS_TEMPLATE,
  DASHBOARD_EDGE_OVERVIEW,
  DASHBOARD_LOG_EXPLORER,
  DASHBOARD_MCP_TOOL_HEALTH,
  DASHBOARD_BACKGROUND_PLANE,
} from './content';

// Plugin: monitoring-stack.
//
// Forge owns the canonical METRICS + LOGGING environment (the Grafana pane) exactly the way
// observability-stack owns the TRACING environment (the Langfuse pane, C37). One provision command
// stands up the full pipeline as its own independent compose project:
//
//   otel-collector  — the single OTLP ingest + fan-out: traces → Langfuse (Basic auth added here,
//                     from the stack .env), logs → Loki, metrics → a :8889 Prometheus scrape
//                     endpoint. Joins the external `observability` network (apps + langfuse-web
//                     live there) AND the external `proxy` network (Traefik exports to it by name).
//   loki            — log store, 30 d hard retention (compactor; delete_request_store is REQUIRED
//                     on Loki 3.x or the process crashloops at boot — baked in).
//   promtail        — ships container stdout/stderr into Loki labeled service_name=<container name>.
//                     Scope is a keep-regex over container names (default: the forge-provisioned
//                     stacks + the edge only — NOT every container on the host).
//   prometheus      — metrics store, 1 y / 20 GB retention caps.
//   grafana         — dashboards (Edge Overview · Log Explorer · MCP Tool Health · Background
//                     Plane), unified alerting (provisioned rules + email contact point), optional
//                     Traefik fronting at a public host.
//
// The compose is fully SELF-CONTAINED: every config file travels as inline `configs.content`
// (no bind mounts), so it deploys identically against a local daemon or a remote `--context`
// (compose v2.23.1+). Secrets live in the sibling .env, generated once and preserved thereafter.
// All services carry explicit memory caps so a runaway query can never starve co-hosted apps.

export const IMPLEMENTATION = 'monitoring-stack';

/** Grafana serves an unauthenticated health probe here — 200 once it is up. */
export const MONITORING_HEALTH_PATH = '/api/health';

/** The OTLP ingest endpoint consumers (apps, Traefik, the data-plane) export to — INSIDE the
 *  shared networks. Metrics/logs/traces all go HERE; never export straight to Langfuse (it
 *  silently discards everything but traces). */
export const MONITORING_OTLP_ENDPOINT = 'http://otel-collector:4318';

/** Default keep-regex for promtail's container scope: the forge-provisioned stacks + the edge.
 *  Matched against the container name AFTER the leading slash is stripped. */
export const DEFAULT_LOG_SCOPE_REGEX =
  '^(traefik|otel-collector|loki|promtail|prometheus|grafana|dorinda-.*|forge-.*)$';

// Image pins — bumped deliberately with a forge release, never `latest` (R1 discipline).
const IMAGES = {
  collector: 'otel/opentelemetry-collector-contrib:0.157.0',
  loki: 'grafana/loki:3.5',
  promtail: 'grafana/promtail:3.5',
  prometheus: 'prom/prometheus:v3.4.1',
  grafana: 'grafana/grafana:11.6',
} as const;

export interface MonitoringStackOptions {
  /** Compose project name. Default 'dorinda-grafana' (folder + project map to the public domain). */
  projectName?: string;
  /** Public hostname to front grafana via Traefik (e.g. 'grafana.dorinda.ai'). */
  publicHost?: string;
  /** Host port grafana is published on for operator/local access. Default 3200. */
  uiPort?: number;
  /** The shared EXTERNAL network where apps + langfuse-web live. Default 'observability'. */
  network?: string;
  /** The external Traefik network. Default 'proxy'. */
  proxyNetwork?: string;
  /** Traefik cert resolver (used when publicHost is set). Default 'letsencrypt'. */
  certResolver?: string;
  /** Alert contact-point email. Default 'ops@forge.local'. */
  alertEmail?: string;
  /** promtail container-name keep-regex (see DEFAULT_LOG_SCOPE_REGEX). */
  logScopeRegex?: string;
  /** Per-service memory cap. Default '512m'. */
  memLimit?: string;
  /** Loki retention (compactor-enforced). Default '720h' (30 d). */
  lokiRetention?: string;
  /** Prometheus retention time / size caps. Defaults '365d' / '20GB'. */
  promRetentionTime?: string;
  promRetentionSize?: string;
}

interface Resolved extends Required<Omit<MonitoringStackOptions, 'publicHost'>> {
  publicHost?: string;
}

function resolve(opts: MonitoringStackOptions): Resolved {
  return {
    projectName: opts.projectName ?? 'dorinda-grafana',
    publicHost: opts.publicHost,
    uiPort: opts.uiPort ?? 3200,
    network: opts.network ?? 'observability',
    proxyNetwork: opts.proxyNetwork ?? 'proxy',
    certResolver: opts.certResolver ?? 'letsencrypt',
    alertEmail: opts.alertEmail ?? 'ops@forge.local',
    logScopeRegex: opts.logScopeRegex ?? DEFAULT_LOG_SCOPE_REGEX,
    memLimit: opts.memLimit ?? '512m',
    lokiRetention: opts.lokiRetention ?? '720h',
    promRetentionTime: opts.promRetentionTime ?? '365d',
    promRetentionSize: opts.promRetentionSize ?? '20GB',
  };
}

// ── Per-file config renderers (option-substituted views over ./content) ──────

/** The collector config: OTLP in on 4318; traces→Langfuse (auth from env), logs→Loki (same
 *  project), metrics→:8889 scrape. LANGFUSE_OTLP_B64 is required at container start. */
export function renderCollectorConfig(): string {
  return `# Generated by Forge — ProvisionMonitoring (monitoring-stack). Do NOT hand-edit; reprovision.
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  # Traces → the Langfuse stack (C37) on the shared observability network. The Basic auth is
  # injected HERE so no producer (Traefik, apps) ever holds the Langfuse credential.
  otlphttp/langfuse:
    endpoint: http://langfuse-web:3000/api/public/otel
    headers:
      Authorization: "Basic \${env:LANGFUSE_OTLP_B64}"

  # Logs → Loki (same compose project; Loki 3.x native OTLP ingest).
  otlphttp/loki:
    endpoint: http://loki:3100/otlp

  # Metrics → exposed for Prometheus to scrape at :8889.
  # metric_expiration: how long a series stays on the scrape page after its last datapoint.
  # The contrib default (5m) makes low-traffic per-tool counters vanish between conversations,
  # so instant dashboard queries hit "No data" minutes after a quiet spell (0.76.0). 1h keeps
  # sparse series queryable; kept deliberately bounded so absent()-based dead-signal alerts
  # (e.g. Dead MCP Registration) still fire within the hour after a producer truly dies.
  prometheus:
    endpoint: "0.0.0.0:8889"
    metric_expiration: 1h

processors:
  batch: {}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/langfuse]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlphttp/loki]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [prometheus]
`;
}

/** promtail: discover containers over the local docker socket, keep only the scoped names, ship to
 *  Loki with LOW-CARDINALITY labels (service_name + stream; everything else stays in the JSON body). */
export function renderPromtailConfig(r: Resolved): string {
  return `# Generated by Forge — ProvisionMonitoring (monitoring-stack). Do NOT hand-edit; reprovision.
server:
  http_listen_port: 9080
  grpc_listen_port: 0

positions:
  filename: /positions/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 15s
    relabel_configs:
      # container name (strip the leading slash) → service_name, the label dashboards query by
      - source_labels: ["__meta_docker_container_name"]
        regex: "/(.*)"
        target_label: "service_name"
      # SCOPE: keep only the forge-provisioned stacks + the edge (never the whole host)
      - source_labels: ["service_name"]
        regex: "${r.logScopeRegex}"
        action: "keep"
      - source_labels: ["__meta_docker_container_log_stream"]
        target_label: "stream"
`;
}

export function renderContactPoints(r: Resolved): string {
  return GRAFANA_CONTACT_POINTS_TEMPLATE.replace(/__ALERT_EMAIL__/g, r.alertEmail);
}

// ── The compose ──────────────────────────────────────────────────────────────

/** Embed a config file under `content: |`: indent AND escape every `$` as `$$` — compose
 *  interpolates `${…}` even inside inline config content, which would eat the collector's
 *  `${env:…}` reference and Grafana's `${trace_id}`-style dashboard variables. No inlined
 *  config legitimately wants compose interpolation (secrets flow via service `environment:`). */
function embed(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .replace(/\$/g, '$$$$')
    .split('\n')
    .map((l) => (l.length ? pad + l : l))
    .join('\n');
}

/**
 * Generate the standalone monitoring compose. Deterministic, secret-free, and fully self-contained
 * (configs travel inline), so a re-generate is diff-clean and a remote `--context` deploy works
 * without any files on the target host beyond the compose + env the CLI reads locally.
 */
export function generateMonitoringCompose(opts: MonitoringStackOptions = {}): string {
  const r = resolve(opts);
  const fronted = Boolean(r.publicHost);

  const grafanaNetworks = fronted
    ? `      - monitoring\n      - ${r.proxyNetwork}`
    : `      - monitoring`;
  const traefikLabels = fronted
    ? `    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=${r.proxyNetwork}"
      - "traefik.http.routers.grafana.rule=Host(\`${r.publicHost}\`)"
      - "traefik.http.routers.grafana.entrypoints=websecure"
      - "traefik.http.routers.grafana.tls=true"
      - "traefik.http.routers.grafana.tls.certresolver=${r.certResolver}"
      - "traefik.http.services.grafana.loadbalancer.server.port=3000"\n`
    : '';
  const rootUrl = fronted ? `https://${r.publicHost}` : `http://localhost:${r.uiPort}`;
  const networksBlock = fronted
    ? `networks:
  monitoring:
  ${r.network}:
    external: true
  ${r.proxyNetwork}:
    external: true`
    : `networks:
  monitoring:
  ${r.network}:
    external: true
  ${r.proxyNetwork}:
    external: true`;

  return `# Generated by Forge — ProvisionMonitoring (monitoring-stack). Do NOT hand-edit; reprovision.
# The METRICS + LOGGING environment (the Grafana pane) — sibling of the C37 tracing environment.
# Producers export OTLP to ${MONITORING_OTLP_ENDPOINT} on the \`${r.network}\` or \`${r.proxyNetwork}\`
# network; NEVER straight to Langfuse (it discards everything but traces). Secrets live in the
# sibling .env. Every config below travels inline — no bind mounts, remote-context deployable.
name: ${r.projectName}

configs:
  collector-config:
    content: |
${embed(renderCollectorConfig(), 6)}
  loki-config:
    content: |
${embed(LOKI_CONFIG, 6)}
  promtail-config:
    content: |
${embed(renderPromtailConfig(r), 6)}
  prometheus-config:
    content: |
${embed(PROMETHEUS_CONFIG, 6)}
  prometheus-rules:
    content: |
${embed(PROMETHEUS_RULES, 6)}
  grafana-datasources:
    content: |
${embed(GRAFANA_DATASOURCES, 6)}
  grafana-dashboard-provider:
    content: |
${embed(GRAFANA_DASHBOARD_PROVIDER, 6)}
  grafana-alert-rules:
    content: |
${embed(GRAFANA_ALERT_RULES, 6)}
  grafana-contact-points:
    content: |
${embed(renderContactPoints(r), 6)}
  dash-edge-overview:
    content: |
${embed(DASHBOARD_EDGE_OVERVIEW, 6)}
  dash-log-explorer:
    content: |
${embed(DASHBOARD_LOG_EXPLORER, 6)}
  dash-mcp-tool-health:
    content: |
${embed(DASHBOARD_MCP_TOOL_HEALTH, 6)}
  dash-background-plane:
    content: |
${embed(DASHBOARD_BACKGROUND_PLANE, 6)}

services:
  # ── OTLP ingest + fan-out ──────────────────────────────────────────────────
  otel-collector:
    image: ${IMAGES.collector}
    container_name: otel-collector
    restart: unless-stopped
    mem_limit: ${r.memLimit}
    command: ["--config=/etc/otelcol-contrib/config.yaml"]
    configs:
      - source: collector-config
        target: /etc/otelcol-contrib/config.yaml
    environment:
      LANGFUSE_OTLP_B64: \${LANGFUSE_OTLP_B64:?set LANGFUSE_OTLP_B64 in the stack .env (base64 of pk:sk)}
    networks:
      - monitoring
      - ${r.network}
      - ${r.proxyNetwork}
    depends_on:
      loki: {condition: service_healthy}

  # ── Log store ──────────────────────────────────────────────────────────────
  loki:
    image: ${IMAGES.loki}
    container_name: loki
    restart: unless-stopped
    mem_limit: ${r.memLimit}
    command: -config.file=/etc/loki/loki.yml
    configs:
      - source: loki-config
        target: /etc/loki/loki.yml
    volumes:
      - loki-data:/loki
    networks:
      - monitoring
    healthcheck:
      test: ["CMD-SHELL", "wget -q --spider http://localhost:3100/ready || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

  # ── Log shipper (scoped — never the whole host) ────────────────────────────
  promtail:
    image: ${IMAGES.promtail}
    container_name: promtail
    restart: unless-stopped
    mem_limit: 256m
    command: -config.file=/etc/promtail/promtail.yml
    configs:
      - source: promtail-config
        target: /etc/promtail/promtail.yml
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - promtail-positions:/positions
    networks:
      - monitoring
    depends_on:
      loki: {condition: service_healthy}

  # ── Metrics store ──────────────────────────────────────────────────────────
  prometheus:
    image: ${IMAGES.prometheus}
    container_name: prometheus
    restart: unless-stopped
    mem_limit: ${r.memLimit}
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.retention.time=${r.promRetentionTime}
      - --storage.tsdb.retention.size=${r.promRetentionSize}
      - --storage.tsdb.path=/prometheus
      - --web.enable-lifecycle
      - --web.listen-address=0.0.0.0:9090
    configs:
      - source: prometheus-config
        target: /etc/prometheus/prometheus.yml
      - source: prometheus-rules
        target: /etc/prometheus/rules/alerts.yml
    volumes:
      - prometheus-data:/prometheus
    networks:
      - monitoring
    healthcheck:
      test: ["CMD-SHELL", "wget -q --spider http://localhost:9090/-/healthy || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s

  # ── Dashboards + alerting ──────────────────────────────────────────────────
  grafana:
    image: ${IMAGES.grafana}
    container_name: grafana
    restart: unless-stopped
    mem_limit: ${r.memLimit}
    ports:
      - "\${MONITORING_UI_PORT:-${r.uiPort}}:3000"
${traefikLabels}    configs:
      - source: grafana-datasources
        target: /etc/grafana/provisioning/datasources/datasources.yml
      - source: grafana-dashboard-provider
        target: /etc/grafana/provisioning/dashboards/dashboards.yml
      - source: grafana-alert-rules
        target: /etc/grafana/provisioning/alerting/alert_rules.yml
      - source: grafana-contact-points
        target: /etc/grafana/provisioning/alerting/contact_points.yml
      - source: dash-edge-overview
        target: /var/lib/grafana/dashboards/edge-overview.json
      - source: dash-log-explorer
        target: /var/lib/grafana/dashboards/log-explorer.json
      - source: dash-mcp-tool-health
        target: /var/lib/grafana/dashboards/mcp-tool-health.json
      - source: dash-background-plane
        target: /var/lib/grafana/dashboards/background-plane.json
    environment:
      GF_SECURITY_ADMIN_PASSWORD: \${GRAFANA_ADMIN_PASSWORD:?set GRAFANA_ADMIN_PASSWORD in the stack .env}
      GF_USERS_ALLOW_SIGN_UP: "false"
      GF_AUTH_ANONYMOUS_ENABLED: "false"
      GF_SERVER_ROOT_URL: ${rootUrl}
      GF_ALERTING_ENABLED: "false"
      GF_UNIFIED_ALERTING_ENABLED: "true"
      GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: /var/lib/grafana/dashboards/edge-overview.json
      # Alert email delivery — without SMTP, alerts log but never send.
      GF_SMTP_ENABLED: \${GRAFANA_SMTP_ENABLED:-false}
      GF_SMTP_HOST: \${GRAFANA_SMTP_HOST:-}
      GF_SMTP_USER: \${GRAFANA_SMTP_USER:-}
      GF_SMTP_PASSWORD: \${GRAFANA_SMTP_PASSWORD:-}
      GF_SMTP_FROM_ADDRESS: \${GRAFANA_SMTP_FROM:-grafana@forge.local}
    volumes:
      - grafana-data:/var/lib/grafana
    networks:
${grafanaNetworks}
    depends_on:
      loki: {condition: service_healthy}
      prometheus: {condition: service_healthy}
    healthcheck:
      test: ["CMD-SHELL", "wget -q --spider http://localhost:3000${MONITORING_HEALTH_PATH} || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s

${networksBlock}

volumes:
  loki-data:
  promtail-positions:
  prometheus-data:
  grafana-data:
`;
}

// ── Secrets + env ────────────────────────────────────────────────────────────

export interface MonitoringSecrets {
  GRAFANA_ADMIN_PASSWORD: string;
}

/** Secret vars the .env carries. LANGFUSE_OTLP_B64 is ALSO secret but cannot be generated here —
 *  it must match the C37 stack's key pair, so it is provided/preserved, never invented. */
export const MONITORING_SECRET_KEYS: ReadonlyArray<keyof MonitoringSecrets> = [
  'GRAFANA_ADMIN_PASSWORD',
];

/** Non-secret config vars the .env also carries. */
export const MONITORING_CONFIG_KEYS = [
  'MONITORING_UI_PORT',
  'GRAFANA_SMTP_ENABLED',
  'GRAFANA_SMTP_HOST',
  'GRAFANA_SMTP_USER',
  'GRAFANA_SMTP_PASSWORD',
  'GRAFANA_SMTP_FROM',
] as const;

export function generateMonitoringSecrets(): MonitoringSecrets {
  return { GRAFANA_ADMIN_PASSWORD: randomBytes(24).toString('base64url') };
}

export interface RenderMonitoringEnvOptions {
  uiPort?: number;
  /** base64("pk-lf-…:sk-lf-…") of the C37 Langfuse project key pair — the collector's trace auth. */
  langfuseOtlpB64?: string;
  smtp?: { host?: string; user?: string; password?: string; from?: string };
}

/**
 * Normalize an SMTP username that arrived percent-encoded. Operators routinely copy the user
 * out of an SMTP *URL* (`smtp://no-reply%40example.com:pass@host:587`) where `%40` is correct —
 * but `GF_SMTP_USER` is a discrete value, and Grafana sends the string verbatim, so the encoded
 * form fails auth with `535 BadCredentials` (bit prod on 2026-07-26). A literal `%` in a real
 * SMTP username is only decoded when the whole value round-trips as a valid percent-encoding.
 */
export function normalizeSmtpUser(user: string): string {
  if (!/%[0-9A-Fa-f]{2}/.test(user)) return user;
  try {
    return decodeURIComponent(user);
  } catch {
    return user;
  }
}

/** Render the real .env (mode 0600 at write). */
export function renderMonitoringEnv(secrets: MonitoringSecrets, opts: RenderMonitoringEnvOptions = {}): string {
  const smtpEnabled = Boolean(opts.smtp?.host);
  return [
    '# Generated by Forge — ProvisionMonitoring. Real secrets — gitignore this file, never commit.',
    `MONITORING_UI_PORT=${opts.uiPort ?? 3200}`,
    `GRAFANA_ADMIN_PASSWORD=${secrets.GRAFANA_ADMIN_PASSWORD}`,
    `LANGFUSE_OTLP_B64=${opts.langfuseOtlpB64 ?? ''}`,
    `GRAFANA_SMTP_ENABLED=${smtpEnabled}`,
    `GRAFANA_SMTP_HOST=${opts.smtp?.host ?? ''}`,
    `GRAFANA_SMTP_USER=${normalizeSmtpUser(opts.smtp?.user ?? '')}`,
    `GRAFANA_SMTP_PASSWORD=${opts.smtp?.password ?? ''}`,
    `GRAFANA_SMTP_FROM=${opts.smtp?.from ?? ''}`,
    '',
  ].join('\n');
}

/** Render the committable .env.example — documents every var, never a real value. */
export function renderMonitoringEnvExample(): string {
  return [
    '# ProvisionMonitoring .env — copy to .env and fill in, or let `forge provision-monitoring`',
    '# generate real values on first provision.',
    'MONITORING_UI_PORT=3200',
    'GRAFANA_ADMIN_PASSWORD=',
    '# base64 of the C37 Langfuse project "pk-lf-…:sk-lf-…" pair (the collector adds it to traces)',
    'LANGFUSE_OTLP_B64=',
    'GRAFANA_SMTP_ENABLED=false',
    'GRAFANA_SMTP_HOST=',
    'GRAFANA_SMTP_USER=',
    'GRAFANA_SMTP_PASSWORD=',
    'GRAFANA_SMTP_FROM=',
    '',
  ].join('\n');
}
