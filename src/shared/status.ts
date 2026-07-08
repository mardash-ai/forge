// C15 — the PURE status aggregation shared by the public status page (the
// `/status` + `/status.json` routes in `src/api/status-routes.ts`) AND the Phase-2
// health sampler (`src/plugins/scheduler-node/health-sampler.ts`). Extracted here so
// there is ONE definition of "what the app's health says" — the sampler records the
// SAME overall/per-component states the live page renders (no second health rollup).
//
// PURE: a HealthProbeResult in, a StatusReport out. No I/O, no store coupling.

import type { HealthProbeResult } from './health-probe';

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

export const BANNER: Record<OverallStatus, string> = {
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
