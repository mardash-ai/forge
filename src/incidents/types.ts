// C15 Phase 3 — operator-declared INCIDENTS: types + PURE lifecycle / retention /
// banner-precedence / JSON-shaping. NO I/O (the file-backed store that persists these
// lives in `src/storage/incident-store.ts`, and the public rendering in the status
// route).
//
// The status page (Phase 1) shows a LIVE health snapshot; Phase 2 adds a sampled
// uptime history. Phase 3 lets an operator DECLARE an incident on top — an outage the
// probes can't see (a partner API down, a data issue, planned maintenance) — with a
// status/impact and an ordered timeline of updates. Incidents are a separate FACT from
// measured health: they colour the LIVE banner (an operator-declared major/critical
// outage is real even when probes are green) but never rewrite the sampled uptime
// history (that stays a record of what was actually measured).
//
// PURE + UTC: every timestamp is an ISO string (`toISOString()`); a "day" is its UTC
// calendar date, matching the rest of the platform.

import type { OverallStatus, StatusReport } from '../shared/status';
import { BANNER } from '../shared/status';

// The lifecycle a declared incident moves through (Statuspage-style). `resolved` is
// terminal — it drops off the active banner and into the recent-history disclosure.
export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

// How bad the operator says it is. Only an UNRESOLVED `major`/`critical` incident is
// allowed to force the live banner down (see `incidentOverallFloor`).
export const INCIDENT_IMPACTS = ['none', 'minor', 'major', 'critical'] as const;
export type IncidentImpact = (typeof INCIDENT_IMPACTS)[number];

// One entry in an incident's timeline: the moment, the status it moved to, and the
// operator's note (markdown-lite / plain text — rendered escaped, never as HTML).
export interface IncidentUpdate {
  timestamp: string; // ISO-8601 (UTC)
  status: IncidentStatus;
  body: string;
}

export interface Incident {
  id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  // Component keys this incident affects — matched against the status page's component
  // names (e.g. "db", "<app> (web)"). Optional; empty ⇒ a general/app-wide incident.
  affected_components: string[];
  // The timeline, oldest → newest (chronological). Always ≥ 1 (seeded at creation).
  updates: IncidentUpdate[];
  created_at: string;
  resolved_at?: string;
}

// --- retention (bounded history) --------------------------------------------
// All UNRESOLVED incidents are always kept. Resolved incidents are kept only while
// they are both recent (resolved within the window) AND among the most-recent N — so
// the per-app store stays small no matter how long an app runs.
export const RESOLVED_HISTORY_MAX = 50;
export const RESOLVED_HISTORY_WINDOW_DAYS = 90;

// --- validation guards ------------------------------------------------------

export function isIncidentStatus(v: unknown): v is IncidentStatus {
  return typeof v === 'string' && (INCIDENT_STATUSES as readonly string[]).includes(v);
}

export function isIncidentImpact(v: unknown): v is IncidentImpact {
  return typeof v === 'string' && (INCIDENT_IMPACTS as readonly string[]).includes(v);
}

// Normalize a caller-supplied component list to a clean string[] (drops non-strings +
// blanks, trims). Absent ⇒ [].
export function normalizeComponents(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (t) out.push(t);
  }
  return out;
}

// --- lifecycle (pure) -------------------------------------------------------

export interface CreateIncidentInput {
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  affected_components?: string[];
  body?: string;
}

// Build a brand-new incident. The initial status is seeded as the first timeline entry
// (so the history is complete from t0). Creating one directly as `resolved` is allowed
// (a retro/backfill) and stamps `resolved_at` immediately.
export function createIncident(id: string, input: CreateIncidentInput, now: Date): Incident {
  const at = now.toISOString();
  const inc: Incident = {
    id,
    title: input.title,
    status: input.status,
    impact: input.impact,
    affected_components: normalizeComponents(input.affected_components),
    updates: [{ timestamp: at, status: input.status, body: input.body ?? '' }],
    created_at: at,
    ...(input.status === 'resolved' ? { resolved_at: at } : {}),
  };
  return inc;
}

// Append an update, moving the incident to `status`. Returns a NEW incident (never
// mutates the input). Moving to `resolved` stamps `resolved_at` (first time only).
export function appendUpdate(
  inc: Incident,
  update: { status: IncidentStatus; body?: string },
  now: Date,
): Incident {
  const at = now.toISOString();
  const entry: IncidentUpdate = { timestamp: at, status: update.status, body: update.body ?? '' };
  return {
    ...inc,
    status: update.status,
    updates: [...inc.updates, entry],
    ...(update.status === 'resolved' && !inc.resolved_at ? { resolved_at: at } : {}),
  };
}

// Resolve an incident: force `status: resolved`, stamp `resolved_at` (first time only),
// and append a final update. A no-op-ish idempotent resolve of an already-resolved
// incident still records the extra note but preserves the original `resolved_at`.
export function resolveIncident(inc: Incident, opts: { body?: string }, now: Date): Incident {
  const body = opts.body && opts.body.trim() ? opts.body : 'Resolved.';
  return appendUpdate(inc, { status: 'resolved', body }, now);
}

// --- retention (pure) -------------------------------------------------------

const DAY_MS = 86_400_000;

// Keep every unresolved incident; keep resolved ones only while recent AND within the
// most-recent cap. PURE: returns the retained list (order not guaranteed — callers
// order for display via `orderActive`/`orderResolved`).
export function pruneIncidents(
  incidents: Incident[],
  opts: { now: Date; maxResolved?: number; windowDays?: number } ,
): Incident[] {
  const maxResolved = opts.maxResolved ?? RESOLVED_HISTORY_MAX;
  const windowMs = (opts.windowDays ?? RESOLVED_HISTORY_WINDOW_DAYS) * DAY_MS;
  const cutoff = opts.now.getTime() - windowMs;

  const active: Incident[] = [];
  const resolved: Incident[] = [];
  for (const inc of incidents) {
    if (inc.status === 'resolved' && inc.resolved_at) resolved.push(inc);
    else active.push(inc);
  }
  // Recent-enough resolved, newest-first, capped.
  const keptResolved = resolved
    .filter((inc) => new Date(inc.resolved_at as string).getTime() >= cutoff)
    .sort((a, b) => (a.resolved_at! < b.resolved_at! ? 1 : -1))
    .slice(0, maxResolved);
  return [...active, ...keptResolved];
}

// --- display ordering (pure) ------------------------------------------------

// Unresolved incidents, newest-declared first.
export function orderActive(incidents: Incident[]): Incident[] {
  return incidents
    .filter((inc) => inc.status !== 'resolved')
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

// Resolved incidents, most-recently-resolved first.
export function orderResolved(incidents: Incident[]): Incident[] {
  return incidents
    .filter((inc) => inc.status === 'resolved')
    .sort((a, b) => ((a.resolved_at ?? a.created_at) < (b.resolved_at ?? b.created_at) ? 1 : -1));
}

// --- banner precedence (pure) -----------------------------------------------
//
// PRECEDENCE (documented): the live `overall` is `max(measured health, incident floor)`
// on this severity ladder — an operator-declared outage can only make the banner WORSE,
// never better (green probes never hide a declared outage; a declared incident never
// masks a real probe failure). Only UNRESOLVED incidents contribute; `impact` maps to a
// floor as:
//    critical → major_outage   ·   major → partial_outage
//    minor    → degraded       ·   none  → (no floor)
// So an unresolved critical forces at least Major Outage even when every probe is ok.

const SEVERITY: Record<OverallStatus, number> = {
  operational: 0,
  degraded: 1,
  partial_outage: 2,
  major_outage: 3,
};

const IMPACT_FLOOR: Record<IncidentImpact, OverallStatus | null> = {
  none: null,
  minor: 'degraded',
  major: 'partial_outage',
  critical: 'major_outage',
};

// The strongest floor any UNRESOLVED incident imposes, or null if none do.
export function incidentOverallFloor(incidents: Incident[]): OverallStatus | null {
  let floor: OverallStatus | null = null;
  for (const inc of incidents) {
    if (inc.status === 'resolved') continue;
    const f = IMPACT_FLOOR[inc.impact];
    if (f && (floor === null || SEVERITY[f] > SEVERITY[floor])) floor = f;
  }
  return floor;
}

// Elevate a health report by any active incident floor. Returns the SAME report object
// (unchanged) when no incident forces a worse state — so with no active incident the
// banner is byte-for-byte what health alone produced.
export function applyIncidentFloor(report: StatusReport, incidents: Incident[]): StatusReport {
  const floor = incidentOverallFloor(incidents);
  if (!floor || SEVERITY[floor] <= SEVERITY[report.overall]) return report;
  return { ...report, overall: floor, banner: BANNER[floor] };
}

// --- JSON shaping (pure) ----------------------------------------------------

// The `/status.json` shape for one incident. `updates` stay chronological (oldest →
// newest); `resolved_at` is `null` while active (stable shape for consumers).
export interface IncidentJson {
  id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  affected_components: string[];
  updates: IncidentUpdate[];
  created_at: string;
  resolved_at: string | null;
}

export function incidentJson(inc: Incident): IncidentJson {
  return {
    id: inc.id,
    title: inc.title,
    status: inc.status,
    impact: inc.impact,
    affected_components: inc.affected_components,
    updates: inc.updates,
    created_at: inc.created_at,
    resolved_at: inc.resolved_at ?? null,
  };
}

// The additive `/status.json` `incidents` array: active (newest-first) then recent
// resolved (most-recently-resolved first).
export function incidentsJson(incidents: Incident[]): IncidentJson[] {
  return [...orderActive(incidents), ...orderResolved(incidents)].map(incidentJson);
}
