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
  renderGrafanaDatasources,
  GRAFANA_ALERT_RULES,
  DASHBOARD_TOOL_DRILLDOWN,
  renderUserExperienceDashboard,
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
    expect(inline.length).toBe(configNames.length);
    expect(configNames.length).toBe(14); // 15 with appDb (user-experience dashboard); log-explorer retired 2026-09-05; +1 for the HTTP RED dashboard, 2026-07-31
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

  it('prometheus exporter keeps sparse series 1h (contrib default 5m blanks quiet per-tool panels — 0.76.0)', () => {
    const cfg = renderCollectorConfig();
    const promExporter = cfg.slice(cfg.indexOf('prometheus:'), cfg.indexOf('processors:'));
    expect(promExporter).toContain('metric_expiration: 1h');
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
      projectName: 'dorinda-monitoring',
      publicHost: undefined,
      uiPort: 3200,
      network: 'observability',
      proxyNetwork: 'proxy',
      certResolver: 'letsencrypt',
      alertEmail: 'ops@forge.local',
      logScopeRegex: DEFAULT_LOG_SCOPE_REGEX,
      memLimit: '512m',
      lokiRetention: '720h',
      promRetentionTime: '365d',
      promRetentionSize: '20GB',
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
    const GRAFANA_DATASOURCES = renderGrafanaDatasources({ gcpProject: 'dorinda-prod' });
    expect(GRAFANA_DATASOURCES).toContain('uid: forge-prometheus');
    // logs are Cloud Logging — the box-era Loki datasource is retired (2026-09-05)
    expect(GRAFANA_DATASOURCES).toContain('uid: cloud-logging');
    expect(GRAFANA_DATASOURCES).not.toContain('uid: forge-loki');
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

  it('alert rules are metric-based only — the box-era Loki rules are retired (2026-09-05)', () => {
    // Production has no Loki; estate alerting deliberately lives in Cloud Monitoring. The one
    // provisioned Grafana rule is the Prometheus-gauge Dead-MCP-Registration check.
    expect(GRAFANA_ALERT_RULES).not.toContain('loki');
    expect(GRAFANA_ALERT_RULES).not.toContain('{job=~');
    // registration lines only log at boot — the alert is gauge-based, not absent-line-based
    // Was `min(mcp_tools_registered) or on() vector(0)` with instant:true. That assertion pinned
    // the BUG in place: an instant query cannot see a gauge emitted once at registration (5-minute
    // staleness), so it fell through to vector(0) and the rule fired permanently without ever
    // evaluating its real condition. A test that locks in the broken form is worse than no test —
    // it makes the fix look like the regression.
    expect(GRAFANA_ALERT_RULES).toContain('max_over_time(mcp_tools_registered[6h]) or on() vector(0)');
    expect(GRAFANA_ALERT_RULES).not.toContain('absent_over_time');
  });

  it('logs panels ride Cloud Logging with real filters (op/type live in jsonPayload)', () => {
    // Every logs-type panel queries the cloud-logging datasource via Cloud Logging filter
    // syntax; LogQL is gone with the Loki datasource. The filters below were validated live
    // against production (dorinda-metrics forge-user-experience, 2026-08-27).
    expect(compose).toContain('jsonPayload.op=');
    expect(compose).toContain('resource.labels.service_name=');
    expect(compose).not.toContain('count_over_time');
    expect(compose).not.toContain('|= ');
  });

  it('ships the Tool Drilldown dashboard by default; both drilldown dashboards parse as valid JSON (0.77.0)', () => {
    expect(compose).toContain('dash-tool-drilldown');
    const tool = JSON.parse(DASHBOARD_TOOL_DRILLDOWN);
    expect(tool.uid).toBe('forge-tool-drilldown');
    expect(JSON.stringify(tool)).toContain('label_values');
    const user = JSON.parse(renderUserExperienceDashboard({ appId: 'dorinda-api' }));
    expect(user.uid).toBe('forge-user-experience');
    // the email picker queries the identity table scoped to the app, via the RO datasource
    const pickerQ = JSON.stringify(user.templating);
    expect(pickerQ).toContain('forge_identity_users');
    expect(pickerQ).toContain("app_id = 'dorinda-api'");
    expect(pickerQ).toContain('forge-appdb');
  });

  it('cloud datasources use gce workload-identity auth (no key material to rotate)', () => {
    const ds = renderGrafanaDatasources({ gcpProject: 'dorinda-prod' });
    expect(ds).toContain('authenticationType: gce');
    expect(ds).toContain('defaultProject: dorinda-prod');
    // no appDb → no postgres datasource declared
    expect(ds).not.toContain('grafana-postgresql-datasource');
  });

  it('MCP per-tool panels select ONE family via the app label the transport sets (0.76.0)', () => {
    // Transport (data-plane) and consumer apps both emit into the mcp_tool_* metric names.
    // Unscoped `sum by (tool)` would double-count every call once the label schemas unified;
    // the `app=~".+"` matcher pins the panels to the transport family, which sees each logical
    // call exactly once — including failures (unknown_tool, app_unreachable) that never reach
    // the app tier.
    for (const family of [
      'mcp_tool_calls(_total)?',
      'mcp_tool_errors(_total)?',
      'mcp_tool_duration_ms(_milliseconds)?_bucket',
    ]) {
      const q = compose.split('\n').filter((l) => l.includes(family));
      expect(q.length).toBeGreaterThanOrEqual(1);
      for (const line of q) expect(line).toContain('app=~');
    }
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
    const env = renderMonitoringEnv(s, {
      langfuseOtlpB64: 'AbCd',
      smtp: { host: 'smtp.x:587', user: 'u', password: 'p', from: 'f@x' },
    });
    expect(env).toContain(`GRAFANA_ADMIN_PASSWORD=${s.GRAFANA_ADMIN_PASSWORD}`);
    expect(env).toContain('LANGFUSE_OTLP_B64=AbCd');
    expect(env).toContain('GRAFANA_SMTP_ENABLED=true');
  });

  it('percent-decodes an SMTP user copied out of an SMTP URL (%40 → @ — the 535 BadCredentials trap)', () => {
    const s = generateMonitoringSecrets();
    const env = renderMonitoringEnv(s, {
      smtp: {
        host: 'smtp.gmail.com:587',
        user: 'no-reply%40dorinda.ai',
        password: 'p',
        from: 'no-reply@dorinda.ai',
      },
    });
    expect(env).toContain('GRAFANA_SMTP_USER=no-reply@dorinda.ai');
    // A plain user (no valid percent-escape) passes through untouched — even with a literal %.
    const plain = renderMonitoringEnv(s, {
      smtp: { host: 'h:587', user: 'user@x.com', password: 'p', from: 'f@x' },
    });
    expect(plain).toContain('GRAFANA_SMTP_USER=user@x.com');
    const oddPct = renderMonitoringEnv(s, {
      smtp: { host: 'h:587', user: 'we%rd', password: 'p', from: 'f@x' },
    });
    expect(oddPct).toContain('GRAFANA_SMTP_USER=we%rd');
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

describe('generateMonitoringCompose — appDb (User Experience dashboard)', () => {
  const appDb = {
    network: 'forge-dorinda-api-prod_internal',
    host: 'forge-dorinda-api-prod-postgres-1',
    database: 'forge_platform',
  };
  const compose = generateMonitoringCompose({ appDb });

  it('adds BOTH RO postgres datasources, joins the app network, and ships the user dashboard', () => {
    expect(compose).toContain('uid: forge-appdb');
    expect(compose).toContain('uid: dorinda-appdb');
    expect(compose).toContain('url: forge-dorinda-api-prod-postgres-1:5432');
    // each database has its OWN dedicated SELECT-only role
    expect(compose).toContain('user: grafana_ro');
    expect(compose).toContain('database: forge_platform');
    expect(compose).toContain('user: grafana_dorinda_ro');
    expect(compose).toContain('database: dorinda_api');
    expect(compose).toContain('dash-user-experience');
    // grafana (and only via declaration) joins the external app network
    const g = compose.slice(compose.indexOf('  grafana:'));
    expect(g).toContain('- forge-dorinda-api-prod_internal');
    expect(compose).toMatch(/forge-dorinda-api-prod_internal:\n    external: true/);
    // the passwords flow .env -> grafana container env -> Grafana provisioning $VAR expansion;
    // embed() $-doubles the config content so compose passes the literal through to Grafana
    expect(compose).toContain('password: $$GRAFANA_PG_RO_PASSWORD');
    expect(compose).toContain('password: $$GRAFANA_DORINDA_PG_RO_PASSWORD');
    // wired defined-but-empty (BUILDING_A_CAPABILITY §1) — absence detectable, never a crash
    expect(g).toContain('GRAFANA_PG_RO_PASSWORD: ${GRAFANA_PG_RO_PASSWORD:-}');
    expect(g).toContain('GRAFANA_DORINDA_PG_RO_PASSWORD: ${GRAFANA_DORINDA_PG_RO_PASSWORD:-}');
  });

  it('env render carries BOTH RO password lines (and example documents them)', () => {
    const env = renderMonitoringEnv(generateMonitoringSecrets(), {
      appDbPassword: 'x-ro-pass',
      dorindaDbPassword: 'y-ro-pass',
    });
    expect(env).toContain('GRAFANA_PG_RO_PASSWORD=x-ro-pass');
    expect(env).toContain('GRAFANA_DORINDA_PG_RO_PASSWORD=y-ro-pass');
    expect(renderMonitoringEnvExample()).toContain('GRAFANA_PG_RO_PASSWORD=');
    expect(renderMonitoringEnvExample()).toContain('GRAFANA_DORINDA_PG_RO_PASSWORD=');
  });
});

import { DASHBOARD_BACKGROUND_PLANE, DASHBOARD_SERVICE_HTTP } from '../src/plugins/monitoring-stack/content';

describe('Background Plane — a metric nobody displays does not exist (acceptance F-5/F-11)', () => {
  it('covers account-lifecycle counters, not only the sync/message ones', () => {
    // The purge emitted `account.purged` and STILL could not be seen in either UI, because no panel
    // queried it. Emitting a metric that no pane displays fails the standing bar exactly as hard as
    // not emitting it: the operator cannot answer "was an account purged today?" either way.
    const dash = DASHBOARD_BACKGROUND_PLANE;
    expect(dash).toContain('account_purged');
    expect(dash).toContain('account_created');
    // and it must not have lost the counters it already covered
    for (const m of [
      'gcal_sync',
      'message_staged',
      'message_sent',
      'approval',
      'reminders_fired',
      'routines_ran',
    ]) {
      expect(dash).toContain(m);
    }
  });
});

describe('Service Health (HTTP) dashboard — closes the non-MCP blind spot (acceptance F-8)', () => {
  it('queries Cloud Monitoring for the RED metrics every HTTP surface emits', () => {
    // Before this, Grafana had NO panel for any HTTP surface: its datasources were Managed
    // Prometheus (MCP tool metrics) and Cloud Logging. Signup, verification, login, trial start and
    // every admin operation were invisible in Grafana BY CONSTRUCTION, so "is it visible in both
    // UIs?" could only ever answer "console yes, Grafana no" for most of the product's traffic.
    const d = DASHBOARD_SERVICE_HTTP;
    expect(d).toContain('run.googleapis.com/request_count');
    expect(d).toContain('run.googleapis.com/request_latencies');
    expect(d).toContain('"5xx"');
    expect(d).toContain('stackdriver');
  });

  it('substitutes the CLOUD project, not the compose project', () => {
    // These are different things. Pointing the dashboard at the compose project name would query a
    // GCP project that does not exist and render four empty panels — indistinguishable, on screen,
    // from a service receiving no traffic at all.
    const out = generateMonitoringCompose({ projectName: 'dorinda-grafana', gcpProject: 'dorinda-prod' });
    expect(out).toContain('"projectName": "dorinda-prod"');
    // the compose project name must not leak into the dashboard's GCP project field
    expect(out).not.toContain('"projectName": "dorinda-grafana"');
  });
});

describe('Service Health units — an unlabeled axis invites a wrong conclusion', () => {
  it('declares ms on latency, so 350ms is not drawn as "5.83 mins"', () => {
    // Observed live on the first render: Cloud Run reports request_latencies in milliseconds, and
    // with no unit declared Grafana guessed seconds — a perfectly healthy p95 appeared as nearly six
    // minutes. A misleading panel is worse than an empty one: empty prompts a question, wrong
    // prompts an action.
    const d = DASHBOARD_SERVICE_HTTP;
    const latency = d.slice(d.indexOf('Latency p95'));
    expect(latency.slice(0, 400)).toContain('"unit": "ms"');
  });
});

describe('Dead MCP Registration alert — must not fire on a sparse gauge (acceptance F-2)', () => {
  it('queries over a range, never an instant, so a once-at-boot gauge is visible', () => {
    // The rule fired permanently as DatasourceNoData and had NEVER evaluated its real condition:
    // an instant query cannot see a gauge emitted once at registration, because Prometheus marks a
    // sample stale after 5 minutes. It then fell through `or vector(0)` and compared 0 < 31.
    // A permanently-firing alert is one you mute, and a muted alert equals no alert — on the single
    // rule that tells you the tool surface came up short after a deploy.
    expect(GRAFANA_ALERT_RULES).toContain('max_over_time(mcp_tools_registered[6h])');
    expect(GRAFANA_ALERT_RULES).not.toContain("expr: 'min(mcp_tools_registered) or on() vector(0)'");
  });
});
