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
import { resolveAppBase, resolveReadinessPath, probeHealth } from '../shared/health-probe';
import {
  computeStatus,
  type OverallStatus,
  type ComponentState,
  type StatusComponent,
  type StatusReport,
} from '../shared/status';
import { uptimeStore } from '../storage/uptime-store';
import {
  DEFAULT_WINDOW_DAYS,
  type HistoryReport,
  type HistoryComponent,
  type DayState,
} from '../shared/uptime';
import { incidentStore } from '../storage/incident-store';
import {
  type Incident,
  type IncidentImpact,
  applyIncidentFloor,
  orderActive,
  orderResolved,
  incidentsJson,
} from '../incidents/types';

// C15 — the PUBLIC per-app status page, modeled on a Statuspage-style dashboard and
// rendered through the C16 theme.
//
//   GET /status        -> a themed HTML dashboard (public, no auth)
//   GET /status.json   -> the same aggregation as JSON (agents/humans, same contract)
//
// Served by the platform on BOTH planes (dev control plane, prod data-plane sidecar),
// exactly like /auth/* — the app proxies /status same-origin; there is NO app page
// code. The overall banner + per-component rows aggregate the app's live C6 health
// (fetched via the shared probe) plus the serving platform plane.
//
// Phase 2 (uptime history): when the C2 health sampler is enabled, each live
// component also gets a Statuspage-style uptime timeline (per-day bar + uptime %)
// from the durable uptime store, and `/status.json` gains an additive `uptime`
// section. The live banner/components are unchanged; an app that never enabled
// sampling reads an empty history and renders exactly the Phase-1 page.
//
// Phase 3 (incidents): operator-declared incidents (see `incident-routes.ts` for the
// write surface) render here — an Active Incidents section above the component rows and
// a resolved-history disclosure — and `/status.json` gains an additive `incidents`
// array. An unresolved major/critical incident FLOORS the live banner (an operator-
// declared outage is real even when probes are green). An app with NO incidents renders
// byte-for-byte the Phase-2 page.

// The status aggregation now lives in `src/shared/status.ts` (shared with the health
// sampler). Re-exported here so existing importers keep importing it from this route.
export { computeStatus };
export type { OverallStatus, ComponentState, StatusComponent, StatusReport };

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

// Per-day timeline tick colour (Phase 2), from the C16 theme tokens.
const TICK_TOKEN: Record<DayState, string> = {
  operational: '--forge-color-success',
  degraded: '--forge-color-warning',
  down: '--forge-color-danger',
  nodata: '--forge-color-border',
};

// Incident accent colour by impact (Phase 3), from the C16 theme tokens.
const IMPACT_TOKEN: Record<IncidentImpact, string> = {
  none: '--forge-color-text-muted',
  minor: '--forge-color-warning',
  major: '--forge-color-danger',
  critical: '--forge-color-danger',
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
.row{padding:15px 20px;border-top:1px solid var(--forge-color-border)}
.row:first-child{border-top:0}
.rowhead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.row .name{font-weight:550}
.row .detail{color:var(--forge-color-text-muted);font-size:12.5px;margin-top:2px}
.pill{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--_st);white-space:nowrap}
.pill .dot{width:9px;height:9px;border-radius:50%;background:var(--_st);flex:none}
.tl{display:flex;gap:1px;height:30px;margin-top:12px}
.tick{flex:1 1 0;min-width:0;border-radius:2px;background:var(--_tk)}
.tlmeta{display:flex;justify-content:space-between;align-items:center;margin-top:6px;color:var(--forge-color-text-muted);font-size:11.5px}
.tlpct{font-weight:600;color:var(--forge-color-text)}
.foot{margin-top:22px;color:var(--forge-color-text-muted);font-size:12.5px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
.foot a{color:var(--forge-color-primary);text-decoration:none}
`;

// A component's uptime timeline (Phase 2): a row of per-day ticks (themed by day
// state) + the windowed uptime %. Rendered under a live component row only when that
// component has sampled history.
function timelineHtml(c: HistoryComponent): string {
  const ticks = c.days
    .map((d) => {
      const pct = d.uptime_pct === null ? 'no data' : `${d.uptime_pct}% up`;
      const title = escapeHtml(`${d.date} — ${pct}`);
      return `<span class="tick" style="--_tk:var(${TICK_TOKEN[d.state]})" title="${title}"></span>`;
    })
    .join('');
  const pct = c.uptime_pct === null ? '—' : `${c.uptime_pct}%`;
  return (
    `<div class="tl">${ticks}</div>` +
    `<div class="tlmeta"><span>${c.days.length} days ago</span>` +
    `<span class="tlpct">${escapeHtml(pct)} uptime</span><span>Today</span></div>`
  );
}

// Incident CSS (Phase 3). Emitted as an ADDITIONAL, SEPARATE <style> block only when
// an incident is present — so the base page (no incidents) stays byte-for-byte the
// Phase-2 output. Token-driven (C16), so incidents inherit the app's theme + dark mode.
const INCIDENT_CSS = `
.incidents{margin:0 0 26px}
.sectlabel{font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--forge-color-text-muted);margin:0 0 10px}
.inc{background:var(--forge-color-surface);border:1px solid var(--forge-color-border);border-left:4px solid var(--_ic);border-radius:var(--forge-radius-lg);padding:16px 18px;margin-bottom:14px}
.inc:last-child{margin-bottom:0}
.inc .ihead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.inc .ititle{font-weight:650;font-size:15.5px}
.inc .ipill{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:650;text-transform:capitalize;color:var(--_ic);white-space:nowrap}
.inc .ipill .dot{width:9px;height:9px;border-radius:50%;background:var(--_ic);flex:none}
.inc .imeta{color:var(--forge-color-text-muted);font-size:12.5px;margin-top:4px}
.inc .iupd{margin-top:12px;padding-top:12px;border-top:1px solid var(--forge-color-border);display:flex;flex-direction:column;gap:11px}
.inc .u .ustatus{font-weight:600;text-transform:capitalize;color:var(--forge-color-text)}
.inc .u .ubody{color:var(--forge-color-text);margin-top:1px}
.inc .u .utime{color:var(--forge-color-text-muted);font-size:11.5px;margin-top:2px}
details.history{margin:18px 0 0}
details.history>summary{cursor:pointer;color:var(--forge-color-text-muted);font-size:13px;font-weight:600;list-style:revert}
details.history[open]>summary{margin-bottom:12px}
`;

// Capitalize the first letter (status/impact labels — the value is a fixed enum token).
function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// One incident card: title + current-status pill + impact/affected meta + the update
// timeline (newest-first). All operator-supplied text is HTML-escaped (no injection).
function incidentHtml(inc: Incident): string {
  const icToken = IMPACT_TOKEN[inc.impact];
  const comps = inc.affected_components.length
    ? `<div class="imeta">Affected: ${inc.affected_components.map(escapeHtml).join(', ')}</div>`
    : '';
  const resolved = inc.resolved_at ? ` · Resolved ${escapeHtml(inc.resolved_at)}` : '';
  const updates = [...inc.updates]
    .reverse()
    .map((u) => {
      const body = u.body ? `<div class="ubody">${escapeHtml(u.body)}</div>` : '';
      return (
        `<div class="u"><span class="ustatus">${escapeHtml(cap(u.status))}</span>${body}` +
        `<div class="utime">${escapeHtml(u.timestamp)}</div></div>`
      );
    })
    .join('');
  return (
    `<div class="inc" style="--_ic:var(${icToken})">` +
    `<div class="ihead"><span class="ititle">${escapeHtml(inc.title)}</span>` +
    `<span class="ipill"><span class="dot"></span>${escapeHtml(cap(inc.status))}</span></div>` +
    `<div class="imeta">Impact: ${escapeHtml(cap(inc.impact))}${resolved}</div>` +
    comps +
    `<div class="iupd">${updates}</div>` +
    `</div>`
  );
}

// The Active Incidents section (above the component rows) — only when something is
// unresolved; otherwise ''. `active` is already ordered newest-first.
function activeIncidentsHtml(active: Incident[]): string {
  if (!active.length) return '';
  return `<div class="incidents"><div class="sectlabel">Active Incidents</div>${active.map(incidentHtml).join('')}</div>`;
}

// The recent-history disclosure of resolved incidents — only when some exist; else ''.
// `resolved` is already ordered most-recently-resolved first.
function historyIncidentsHtml(resolved: Incident[]): string {
  if (!resolved.length) return '';
  return (
    `<details class="history"><summary>Past incidents (${resolved.length})</summary>` +
    resolved.map(incidentHtml).join('') +
    `</details>`
  );
}

// Exported for tests: proves the incidents param, when empty, changes nothing (the
// no-incident page is byte-for-byte the Phase-2 render).
export function statusPageHtml(
  theme: Theme,
  appName: string,
  report: StatusReport,
  history: HistoryReport,
  incidents: Incident[] = [],
): string {
  const heading = theme.name ?? appName;
  const logo = themeLogoImg(theme, 'forge-brand-logo');
  const ovToken = OVERALL_TOKEN[report.overall];

  // Phase 3 (incidents). All three pieces are '' when there are NO incidents at all, so
  // the page is byte-for-byte the Phase-2 output for an app that has never declared one.
  const active = orderActive(incidents);
  const resolved = orderResolved(incidents);
  const hasIncidents = incidents.length > 0;
  const incidentStyle = hasIncidents ? `<style id="forge-incidents">${INCIDENT_CSS}</style>` : '';
  const activeHtml = activeIncidentsHtml(active);
  const historyHtml = historyIncidentsHtml(resolved);

  const byName = new Map(history.components.map((c) => [c.name, c]));
  const hasHistory = history.sample_count > 0;
  const rows = report.components
    .map((c) => {
      const meta = STATE_META[c.state];
      const detail = c.detail ? `<div class="detail">${escapeHtml(c.detail)}</div>` : '';
      const head =
        `<div class="rowhead"><div><div class="name">${escapeHtml(c.name)}</div>${detail}</div>` +
        `<span class="pill" style="--_st:var(${meta.token})"><span class="dot"></span>${meta.label}</span></div>`;
      const hist = hasHistory ? byName.get(c.name) : undefined;
      return `<div class="row">${head}${hist ? timelineHtml(hist) : ''}</div>`;
    })
    .join('');

  const checked = escapeHtml(report.checked_at);
  return (
    `<!doctype html><html lang="en"><head>${themeMetaHead(theme, themeTitle(theme, 'Status'))}` +
    `<style id="forge-base">${STATUS_CSS}</style>${incidentStyle}</head><body>${themeCustomStyleTag(theme)}` +
    `<div class="wrap">` +
    `<div class="head">${logo}<div><h1>${escapeHtml(heading)} Status</h1><div class="sub">Live service status</div></div></div>` +
    `<div class="banner" style="--_ov:var(${ovToken})"><span class="dot"></span><span class="txt">${escapeHtml(report.banner)}</span></div>` +
    activeHtml +
    `<div class="card">${rows}</div>` +
    historyHtml +
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

  async function build(
    reqApp: { id: string; name: string; repoPath: string },
  ): Promise<{ theme: Theme; report: StatusReport; history: HistoryReport; incidents: Incident[] }> {
    const [theme, manifest, history, incidents] = await Promise.all([
      resolveThemeForApp(reqApp.id),
      loadManifest(reqApp.repoPath),
      // Always safe: an app that never enabled sampling reads an empty history.
      uptimeStore.getHistory(reqApp.id, { windowDays: DEFAULT_WINDOW_DAYS }),
      // Always safe: an app that never declared an incident reads an empty list.
      incidentStore.list(reqApp.id),
    ]);
    const url = `${resolveAppBase(manifest)}${resolveReadinessPath(manifest)}`;
    const probe = await probeHealth(url);
    // Measured health first, then let an unresolved major/critical incident floor the
    // banner (an operator-declared outage is real even when probes are green). Resolved
    // incidents never affect the banner — the app recovers as soon as one is resolved.
    const report = applyIncidentFloor(computeStatus(probe, { appName: reqApp.name, planeLabel }), incidents);
    return { theme, report, history, incidents };
  }

  app.get('/status', async (req, reply: FastifyReply) => {
    const resolved = await resolveApp(req, opts.defaultApp);
    if (!resolved) return unknownAppHtml(reply);
    const { theme, report, history, incidents } = await build(resolved);
    reply
      .code(200)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(statusPageHtml(theme, resolved.name, report, history, incidents));
  });

  app.get('/status.json', async (req, reply: FastifyReply) => {
    const resolved = await resolveApp(req, opts.defaultApp);
    if (!resolved) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'unknown app (pass `app` or set FORGE_APP_NAME).', retry: 'change-input' } });
    }
    const { report, history, incidents } = await build(resolved);
    // Additive: the Phase-1 fields (overall/banner/components/checked_at) are
    // unchanged (`overall`/`banner` already reflect any active-incident floor);
    // `uptime` is the Phase-2 history section and `incidents` the Phase-3 array
    // (active newest-first, then recent-resolved).
    return reply
      .code(200)
      .header('cache-control', 'no-store')
      .send({ app: resolved.name, ...report, uptime: uptimeJson(report, history), incidents: incidentsJson(incidents) });
  });
}

// The additive `/status.json` uptime section. Per component: window, overall + per-
// component uptime %, and the per-day buckets ({date, state, uptime_pct}). Components
// are ordered to match the live report (web → checks → plane), with any history-only
// component (e.g. a check since removed, still within the window) appended.
function uptimeJson(report: StatusReport, history: HistoryReport) {
  const byName = new Map(history.components.map((c) => [c.name, c]));
  const shape = (c: HistoryComponent) => ({
    name: c.name,
    uptime_pct: c.uptime_pct,
    days: c.days.map((d) => ({ date: d.date, state: d.state, uptime_pct: d.uptime_pct })),
  });
  const emitted = new Set<string>();
  const components: ReturnType<typeof shape>[] = [];
  for (const c of report.components) {
    const h = byName.get(c.name);
    if (h) {
      components.push(shape(h));
      emitted.add(c.name);
    }
  }
  for (const c of history.components) {
    if (!emitted.has(c.name)) components.push(shape(c));
  }
  return {
    window_days: history.window_days,
    sampling: history.sample_count > 0,
    overall_uptime_pct: history.overall_uptime_pct,
    components,
  };
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
