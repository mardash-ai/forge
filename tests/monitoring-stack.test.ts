import { describe, it, expect } from 'vitest';
import {
  generateMonitoringCompose,
  generateMonitoringSecrets,
  renderMonitoringEnv,
  renderMonitoringEnvExample,
  renderCollectorConfig,
  renderPromtailConfig,
  DEFAULT_LOG_SCOPE_REGEX,
  MONITORING_OTLP_ENDPOINT,
} from '../src/plugins/monitoring-stack/index';
import {
  LOKI_CONFIG,
  GRAFANA_DATASOURCES,
  GRAFANA_ALERT_RULES,
} from '../src/plugins/monitoring-stack/content';

// ProvisionMonitoring — the metrics+logging sibling of C37. Pure string generation; the point is
// that every fix discovered standing the box stack up by hand is BAKED IN (Loki 3.x
// delete_request_store, memory caps, scoped promtail, collector fan-out, retention caps), so a
// fresh provision comes up green instead of crashlooping.

function serviceBlock(compose: string, name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !/^  \S/.test(lines[end]!)) end++;
  return lines.slice(start, end).join('\n');
}

describe('generateMonitoringCompose — defaults', () => {
  const compose = generateMonitoringCompose();

  it('declares all five services', () => {
    for (const svc of ['otel-collector', 'loki', 'promtail', 'prometheus', 'grafana']) {
      expect(compose).toContain(`\n  ${svc}:\n`);
    }
  });

  it('is deterministic and secret-free (regenerate = diff-clean; secrets only via ${} env refs)', () => {
    expect(generateMonitoringCompose()).toBe(compose);
    expect(compose).not.toMatch(/pk-lf-|sk-lf-|password: [A-Za-z0-9]/i);
  });

  it('travels every config INLINE (remote --context deployable: no bind-mounted config files)', () => {
    // every top-level config entry inlines its content — 13 configs, 13 `content: |` blocks
    const lines = compose.split('\n');
    const configsStart = lines.indexOf('configs:');
    const servicesStart = lines.indexOf('services:');
    const configNames = lines.slice(configsStart, servicesStart).filter((l) => /^  [a-z-]+:$/.test(l));
    // exactly 4-space indent = a top-level config's own content key (deeper = embedded in a payload)
    const inline = lines.filter((l) => /^    content: \|$/.test(l));
    expect(inline.length).toBe(13);
    expect(configNames.length).toBe(13);
    expect(compose).not.toMatch(/^\s+file:/m);
    // the ONLY host bind is promtail's read-only docker socket
    const binds = compose.split('\n').filter((l) => l.includes(':/') && l.trim().startsWith('- /'));
    expect(binds).toEqual(['      - /var/run/docker.sock:/var/run/docker.sock:ro']);
  });

  it('pins every image (no :latest — R1 discipline)', () => {
    for (const line of compose.split('\n').filter((l) => l.includes('image:'))) {
      expect(line).not.toContain(':latest');
      expect(line).toMatch(/:[\dv]/);
    }
  });

  it('bakes in the Loki 3.x retention fix (delete_request_store) — without it the store crashloops', () => {
    expect(LOKI_CONFIG).toContain('retention_enabled: true');
    expect(LOKI_CONFIG).toContain('delete_request_store: filesystem');
    expect(compose).toContain('delete_request_store: filesystem');
  });

  it('caps memory on every service (a runaway query must never starve co-hosted apps)', () => {
    for (const svc of ['otel-collector', 'loki', 'prometheus', 'grafana']) {
      expect(serviceBlock(compose, svc)).toContain('mem_limit: 512m');
    }
    expect(serviceBlock(compose, 'promtail')).toContain('mem_limit: 256m');
  });

  it('caps Prometheus retention by time AND size', () => {
    const prom = serviceBlock(compose, 'prometheus');
    expect(prom).toContain('--storage.tsdb.retention.time=365d');
    expect(prom).toContain('--storage.tsdb.retention.size=20GB');
  });

  it('collector fans out: traces→Langfuse (auth HERE, from env), logs→Loki, metrics→:8889 scrape', () => {
    const cfg = renderCollectorConfig();
    expect(cfg).toContain('endpoint: http://langfuse-web:3000/api/public/otel');
    expect(cfg).toContain('Authorization: "Basic ${env:LANGFUSE_OTLP_B64}"');
    expect(cfg).toContain('endpoint: http://loki:3100/otlp');
    expect(cfg).toContain('endpoint: "0.0.0.0:8889"');
    for (const p of ['traces:', 'logs:', 'metrics:']) expect(cfg).toContain(p);
    // the compose fails loudly when the Langfuse auth is missing
    expect(serviceBlock(compose, 'otel-collector')).toContain('LANGFUSE_OTLP_B64:?');
  });

  it('collector joins the shared observability + proxy networks (producers reach it by name)', () => {
    const c = serviceBlock(compose, 'otel-collector');
    expect(c).toContain('- observability');
    expect(c).toContain('- proxy');
    expect(compose).toMatch(/observability:\n    external: true/);
    expect(compose).toMatch(/proxy:\n    external: true/);
  });

  it('promtail is SCOPED to the forge stacks + edge and strips the docker name slash', () => {
    const cfg = renderPromtailConfig({
      projectName: 'dorinda-monitoring', publicHost: undefined, uiPort: 3200,
      network: 'observability', proxyNetwork: 'proxy', certResolver: 'letsencrypt',
      alertEmail: 'ops@forge.local', logScopeRegex: DEFAULT_LOG_SCOPE_REGEX,
      memLimit: '512m', lokiRetention: '720h', promRetentionTime: '365d', promRetentionSize: '20GB',
    } as never);
    expect(cfg).toContain('regex: "/(.*)"');
    expect(cfg).toContain(`regex: "${DEFAULT_LOG_SCOPE_REGEX}"`);
    expect(cfg).toContain('action: "keep"');
    // the scope regex admits the forge stacks + edge, and nothing else
    const re = new RegExp(DEFAULT_LOG_SCOPE_REGEX);
    for (const yes of ['traefik', 'dorinda-web-prod-web-1', 'forge-dorinda-api-prod-data-plane-1', 'loki']) {
      expect(re.test(yes), `${yes} should be shipped`).toBe(true);
    }
    for (const no of ['trendintel', 'immigrantally-immigrantally-1', 'mark-mark-1', 'whoami']) {
      expect(re.test(no), `${no} must NOT be shipped`).toBe(false);
    }
  });

  it('grafana locks down auth and defaults SMTP off (alerts log but do not send until wired)', () => {
    const g = serviceBlock(compose, 'grafana');
    expect(g).toContain('GF_USERS_ALLOW_SIGN_UP: "false"');
    expect(g).toContain('GF_AUTH_ANONYMOUS_ENABLED: "false"');
    expect(g).toContain('GRAFANA_ADMIN_PASSWORD:?');
    expect(g).toContain('GF_SMTP_ENABLED: ${GRAFANA_SMTP_ENABLED:-false}');
    expect(g).not.toContain('traefik.enable'); // not fronted by default
  });

  it('datasource uids are forge-neutral and consistent between datasources and alert rules', () => {
    expect(GRAFANA_DATASOURCES).toContain('uid: forge-loki');
    expect(GRAFANA_DATASOURCES).toContain('uid: forge-prometheus');
    expect(GRAFANA_ALERT_RULES).not.toContain('proxygen');
    expect(compose).not.toContain('-proxygen');
  });

  it('queries only metrics Traefik OTLP actually emits (router-level series DO NOT exist — 0.75.1)', () => {
    // the live box's Prometheus has traefik_entrypoint_* / traefik_service_* families ONLY;
    // traefik_router_* was an assumption that made every Edge Overview panel show "No data".
    expect(compose).not.toContain('traefik_router_');
    expect(compose).toContain('traefik_entrypoint_requests_total');
    expect(compose).toContain('traefik_entrypoint_request_duration_seconds_bucket');
    // TLS expiry metric carries the _milliseconds unit suffix and is in ms
    expect(compose).toContain('traefik_tls_certs_not_after_milliseconds / 1000');
  });

  it('alert rules select labels that exist and semantics that can actually fire (0.75.1)', () => {
    // promtail sets service_name + stream ONLY — a {job=~".+"} selector matches nothing, ever
    expect(GRAFANA_ALERT_RULES).not.toContain('{job=~');
    expect(GRAFANA_ALERT_RULES).toContain('service_name=');
    // registration lines only log at boot — the alert is gauge-based, not absent-line-based
    expect(GRAFANA_ALERT_RULES).toContain('min(mcp_tools_registered) or on() vector(0)');
    expect(GRAFANA_ALERT_RULES).not.toContain('absent_over_time');
  });

  it('log-level panels use the detected_level Loki metadata, never a literal "ALL" filter (0.75.1)', () => {
    expect(compose).toContain('detected_level');
    expect(compose).not.toContain('|= "$log_level"');
  });
});

describe('generateMonitoringCompose — fronted at a public host', () => {
  const compose = generateMonitoringCompose({ publicHost: 'grafana.dorinda.ai' });

  it('adds the Traefik labels + HTTPS root URL on grafana only', () => {
    const g = serviceBlock(compose, 'grafana');
    expect(g).toContain('traefik.http.routers.grafana.rule=Host(`grafana.dorinda.ai`)');
    expect(g).toContain('traefik.docker.network=proxy');
    expect(g).toContain('GF_SERVER_ROOT_URL: https://grafana.dorinda.ai');
    expect(serviceBlock(compose, 'loki')).not.toContain('traefik.enable');
  });
});

describe('secrets + env rendering', () => {
  it('generates a strong admin password and renders it into the env (0600 written by the capability)', () => {
    const s = generateMonitoringSecrets();
    expect(s.GRAFANA_ADMIN_PASSWORD.length).toBeGreaterThanOrEqual(24);
    const env = renderMonitoringEnv(s, { langfuseOtlpB64: 'AbCd', smtp: { host: 'smtp.x:587', user: 'u', password: 'p', from: 'f@x' } });
    expect(env).toContain(`GRAFANA_ADMIN_PASSWORD=${s.GRAFANA_ADMIN_PASSWORD}`);
    expect(env).toContain('LANGFUSE_OTLP_B64=AbCd');
    expect(env).toContain('GRAFANA_SMTP_ENABLED=true');
  });

  it('env example documents every var and never a real value', () => {
    const ex = renderMonitoringEnvExample();
    for (const k of ['GRAFANA_ADMIN_PASSWORD=', 'LANGFUSE_OTLP_B64=', 'GRAFANA_SMTP_HOST=']) {
      expect(ex).toContain(`\n${k}\n`);
    }
  });

  it('exports the consumer-facing OTLP endpoint contract', () => {
    expect(MONITORING_OTLP_ENDPOINT).toBe('http://otel-collector:4318');
  });
});
