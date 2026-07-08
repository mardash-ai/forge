import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveApp } from './app-resolver';
import { resolveThemeForApp } from './theme-context';
import {
  DEFAULT_THEME,
  escapeHtml,
  themeMetaHead,
  themeCustomStyleTag,
  themeTitle,
  themeLogoImg,
  type Theme,
} from '../shared/theme';
import {
  resolveAppBase,
  resolveReadinessPath,
  probeHealth,
  type HealthProbeResult,
} from '../shared/health-probe';

// C15 — the PUBLIC per-app status page (Phase 1), modeled on a Statuspage-style
// dashboard and rendered through the C16 theme.
//
//   GET /status        -> a themed HTML dashboard (public, no auth)
//   GET /status.json   -> the same aggregation as JSON (agents/humans, same contract)
//
// Served by the platform on BOTH planes (dev control plane, prod data-plane sidecar),
// exactly like /auth/* — the app proxies /status same-origin; there is NO app page
// code. The overall banner + per-component rows aggregate the app's live C6 health
// (fetched via the shared probe) plus the serving platform plane. No persisted state
// (Phase 1 shows a live snapshot; uptime history is Phase 2 — see the release notes).

export type OverallStatus = 'operational' | 'degraded' | 'partial_outage' | 'major_outage';
export type ComponentState = 'operational' | 'degraded' | 'down' | 'unknown';

export interface StatusComponent {
  name: string;
  state: ComponentState;
  detail?: string;
}

export interface StatusReport {
  overall: OverallStatus;
  banner: string;
  components: StatusComponent[];
  checked_at: string;
}

const BANNER: Record<OverallStatus, string> = {
  operational: 'All Systems Operational',
  degraded: 'Degraded Performance',
  partial_outage: 'Partial Outage',
  major_outage: 'Major Outage',
};

// Aggregate a live health probe (+ the serving plane) into an overall status and
// per-component rows. PURE + exported so the banner logic is unit-tested directly.
//   - unreachable app                       -> Major Outage (web down)
//   - reachable but non-conforming health   -> Degraded (web status unknown)
//   - C6 status 'ok'                         -> Operational
//   - C6 status 'degraded'                   -> Degraded
//   - C6 status 'unavailable', all checks down -> Major Outage
//   - C6 status 'unavailable', some down     -> Partial Outage
export function computeStatus(
  probe: HealthProbeResult,
  opts: { appName: string; planeLabel: string; now?: Date },
): StatusReport {
  const now = opts.now ?? new Date();
  const web = `${opts.appName} (web)`;
  let overall: OverallStatus;
  const components: StatusComponent[] = [];

  if (!probe.reachable) {
    overall = 'major_outage';
    components.push({ name: web, state: 'down', detail: 'health endpoint unreachable' });
  } else if (!probe.conforms || !probe.health) {
    overall = 'degraded';
    components.push({ name: web, state: 'unknown', detail: 'health endpoint did not return the standard schema' });
  } else {
    const h = probe.health;
    components.push({ name: web, state: 'operational' });
    for (const c of h.checks) {
      components.push({
        name: c.name,
        state: c.status === 'ok' ? 'operational' : 'down',
        ...(c.detail ? { detail: c.detail } : {}),
      });
    }
    if (h.status === 'ok') {
      overall = 'operational';
    } else if (h.status === 'degraded') {
      overall = 'degraded';
    } else {
      const down = h.checks.filter((c) => c.status === 'unavailable').length;
      overall = down > 0 && down === h.checks.length ? 'major_outage' : 'partial_outage';
    }
  }

  // The serving platform plane is, by definition, operational — it just answered.
  components.push({ name: opts.planeLabel, state: 'operational' });

  return { overall, banner: BANNER[overall], components, checked_at: now.toISOString() };
}

// ---------------------------------------------------------------------------
// Rendering (themed, self-contained, responsive, light/dark via tokens)
// ---------------------------------------------------------------------------

const STATE_META: Record<ComponentState, { label: string; token: string }> = {
  operational: { label: 'Operational', token: '--forge-color-success' },
  degraded: { label: 'Degraded', token: '--forge-color-warning' },
  down: { label: 'Outage', token: '--forge-color-danger' },
  unknown: { label: 'Unknown', token: '--forge-color-text-muted' },
};

const OVERALL_TOKEN: Record<OverallStatus, string> = {
  operational: '--forge-color-success',
  degraded: '--forge-color-warning',
  partial_outage: '--forge-color-warning',
  major_outage: '--forge-color-danger',
};

const STATUS_CSS = `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--forge-color-bg);color:var(--forge-color-text);font:15px/1.6 var(--forge-font);-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:40px 20px}
.head{display:flex;align-items:center;gap:14px;margin-bottom:28px}
.head .forge-brand-logo{height:36px;width:auto;max-width:180px}
.head h1{font-size:19px;font-weight:650;margin:0}
.head .sub{color:var(--forge-color-text-muted);font-size:13px;margin-top:2px}
.banner{display:flex;align-items:center;gap:12px;padding:20px 22px;border-radius:var(--forge-radius-lg);margin-bottom:26px;border:1px solid color-mix(in srgb, var(--_ov) 40%, var(--forge-color-border));background:color-mix(in srgb, var(--_ov) 12%, var(--forge-color-surface));color:var(--forge-color-text)}
.banner .dot{width:14px;height:14px;border-radius:50%;background:var(--_ov);flex:none;box-shadow:0 0 0 4px color-mix(in srgb, var(--_ov) 22%, transparent)}
.banner .txt{font-size:18px;font-weight:650}
.card{background:var(--forge-color-surface);border:1px solid var(--forge-color-border);border-radius:var(--forge-radius-lg);overflow:hidden}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 20px;border-top:1px solid var(--forge-color-border)}
.row:first-child{border-top:0}
.row .name{font-weight:550}
.row .detail{color:var(--forge-color-text-muted);font-size:12.5px;margin-top:2px}
.pill{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--_st);white-space:nowrap}
.pill .dot{width:9px;height:9px;border-radius:50%;background:var(--_st);flex:none}
.foot{margin-top:22px;color:var(--forge-color-text-muted);font-size:12.5px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
.foot a{color:var(--forge-color-primary);text-decoration:none}
`;

function statusPageHtml(theme: Theme, appName: string, report: StatusReport): string {
  const heading = theme.name ?? appName;
  const logo = themeLogoImg(theme, 'forge-brand-logo');
  const ovToken = OVERALL_TOKEN[report.overall];

  const rows = report.components
    .map((c) => {
      const meta = STATE_META[c.state];
      const detail = c.detail ? `<div class="detail">${escapeHtml(c.detail)}</div>` : '';
      return (
        `<div class="row"><div><div class="name">${escapeHtml(c.name)}</div>${detail}</div>` +
        `<span class="pill" style="--_st:var(${meta.token})"><span class="dot"></span>${meta.label}</span></div>`
      );
    })
    .join('');

  const checked = escapeHtml(report.checked_at);
  return (
    `<!doctype html><html lang="en"><head>${themeMetaHead(theme, themeTitle(theme, 'Status'))}` +
    `<style id="forge-base">${STATUS_CSS}</style></head><body>${themeCustomStyleTag(theme)}` +
    `<div class="wrap">` +
    `<div class="head">${logo}<div><h1>${escapeHtml(heading)} Status</h1><div class="sub">Live service status</div></div></div>` +
    `<div class="banner" style="--_ov:var(${ovToken})"><span class="dot"></span><span class="txt">${escapeHtml(report.banner)}</span></div>` +
    `<div class="card">${rows}</div>` +
    `<div class="foot"><span>Last checked ${checked}</span><span>Status by Forge</span></div>` +
    `</div></body></html>`
  );
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Best-effort manifest read (dev control plane has the app repo; the prod sidecar
// relies on env instead and simply gets `{}`). Only used for the health base/path.
async function loadManifest(repoPath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path.join(repoPath, 'forge.app.json'), 'utf8'));
  } catch {
    return {};
  }
}

export function registerStatusRoutes(
  app: FastifyInstance,
  opts: { defaultApp?: () => string | undefined; planeLabel?: string } = {},
): void {
  const planeLabel = opts.planeLabel ?? 'Forge platform';

  async function build(reqApp: { id: string; name: string; repoPath: string }): Promise<{ theme: Theme; report: StatusReport }> {
    const [theme, manifest] = await Promise.all([
      resolveThemeForApp(reqApp.id),
      loadManifest(reqApp.repoPath),
    ]);
    const url = `${resolveAppBase(manifest)}${resolveReadinessPath(manifest)}`;
    const probe = await probeHealth(url);
    const report = computeStatus(probe, { appName: reqApp.name, planeLabel });
    return { theme, report };
  }

  app.get('/status', async (req, reply: FastifyReply) => {
    const resolved = await resolveApp(req, opts.defaultApp);
    if (!resolved) return unknownAppHtml(reply);
    const { theme, report } = await build(resolved);
    reply
      .code(200)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(statusPageHtml(theme, resolved.name, report));
  });

  app.get('/status.json', async (req, reply: FastifyReply) => {
    const resolved = await resolveApp(req, opts.defaultApp);
    if (!resolved) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'unknown app (pass `app` or set FORGE_APP_NAME).', retry: 'change-input' } });
    }
    const { report } = await build(resolved);
    return reply.code(200).header('cache-control', 'no-store').send({ app: resolved.name, ...report });
  });
}

function unknownAppHtml(reply: FastifyReply) {
  const html =
    `<!doctype html><html lang="en"><head>${themeMetaHead(DEFAULT_THEME, 'Status')}` +
    `<style id="forge-base">${STATUS_CSS}</style></head><body><div class="wrap">` +
    `<div class="head"><div><h1>Status</h1><div class="sub">Unknown app</div></div></div>` +
    `<div class="banner" style="--_ov:var(--forge-color-text-muted)"><span class="dot"></span>` +
    `<span class="txt">Unknown app</span></div>` +
    `<div class="foot"><span>Pass ?app=&lt;name&gt; or set FORGE_APP_NAME.</span><span>Status by Forge</span></div>` +
    `</div></body></html>`;
  return reply.code(404).type('text/html; charset=utf-8').send(html);
}
