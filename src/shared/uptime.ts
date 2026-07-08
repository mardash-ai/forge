// C15 Phase 2 — uptime HISTORY: types + PURE rollup / retention / uptime-% math.
//
// The status page (Phase 1) shows a LIVE health snapshot. Phase 2 samples that
// snapshot on a cadence (the C2 health sampler) and keeps a bounded, durable
// history so `/status` can render a Statuspage-style per-component uptime timeline.
//
// This module is PURE (no I/O): it owns the snapshot shape, the raw→daily rollup,
// the retention windows, the uptime-% computation, and the windowed history report.
// The file-backed store that persists these lives in `src/storage/uptime-store.ts`.
// All time math is UTC — every timestamp is an ISO string (`toISOString()`), and a
// "day" is its UTC calendar date (`YYYY-MM-DD`), matching the rest of the platform.

import type { OverallStatus, ComponentState } from './status';

// One recorded sample: the overall status + each component's state at an instant.
// (Detail text is intentionally dropped — history keeps only the coarse state, so a
// snapshot stays tiny and storage is bounded.)
export interface SnapshotComponent {
  name: string;
  state: ComponentState;
}
export interface HealthSnapshot {
  at: string; // ISO-8601 (UTC) instant the sample was taken
  overall: OverallStatus;
  components: SnapshotComponent[];
}

// Per-(component|overall) per-day tallies. total = up + degraded + down.
export interface DayCounts {
  up: number; // component operational / overall operational
  degraded: number; // component degraded / overall degraded
  down: number; // component down|unknown / overall partial_outage|major_outage
}

// A rolled-up day: per-component counts + the overall counts for that day.
export interface RollupDay {
  components: Record<string, DayCounts>;
  overall: DayCounts;
}

// The durable rollup document: completed days keyed by their UTC date.
export interface UptimeRollup {
  days: Record<string, RollupDay>;
}

// Retention windows (bounded storage): raw samples are kept for a short window so
// today's / yesterday's timeline is exact; older days are rolled up to per-day
// counts and kept for the long window, then dropped. Defaults; a store may override.
export const RAW_WINDOW_DAYS = 2;
export const ROLLUP_WINDOW_DAYS = 90;
// The page/JSON timeline window (never longer than what retention keeps).
export const DEFAULT_WINDOW_DAYS = 90;

export type DayState = 'operational' | 'degraded' | 'down' | 'nodata';

export interface HistoryDay {
  date: string; // YYYY-MM-DD (UTC)
  state: DayState;
  up: number;
  degraded: number;
  down: number;
  total: number;
  uptime_pct: number | null; // up/total*100, 2dp; null when no samples that day
}
export interface HistoryComponent {
  name: string;
  uptime_pct: number | null; // over the whole window (sum up / sum total)
  days: HistoryDay[]; // oldest → newest, exactly window_days entries
}
export interface HistoryReport {
  window_days: number;
  overall_uptime_pct: number | null;
  sample_count: number; // raw samples that fell inside the window (0 ⇒ "collecting…")
  components: HistoryComponent[];
}

// --- primitives -------------------------------------------------------------

function zero(): DayCounts {
  return { up: 0, degraded: 0, down: 0 };
}

// The UTC calendar date of an ISO timestamp.
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

// A monotonic day index (days since the Unix epoch) for a YYYY-MM-DD string, so day
// arithmetic (windows, retention) is exact and DST-free.
export function dayIndex(day: string): number {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function dayFromIndex(idx: number): string {
  return new Date(idx * 86_400_000).toISOString().slice(0, 10);
}

// Which bucket a component state counts toward. 'unknown' (non-conforming health)
// counts as NOT-up (down bucket) — an app we cannot read is not proven operational.
export function componentBucket(state: ComponentState): keyof DayCounts {
  if (state === 'operational') return 'up';
  if (state === 'degraded') return 'degraded';
  return 'down'; // 'down' | 'unknown'
}

// Which bucket an overall status counts toward.
export function overallBucket(overall: OverallStatus): keyof DayCounts {
  if (overall === 'operational') return 'up';
  if (overall === 'degraded') return 'degraded';
  return 'down'; // 'partial_outage' | 'major_outage'
}

function addSnapshot(day: RollupDay, snap: HealthSnapshot): void {
  day.overall[overallBucket(snap.overall)]++;
  for (const c of snap.components) {
    const cc = (day.components[c.name] ??= zero());
    cc[componentBucket(c.state)]++;
  }
}

function total(c: DayCounts): number {
  return c.up + c.degraded + c.down;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Uptime % from counts (up / total). null when there were no samples.
export function uptimePct(c: DayCounts): number | null {
  const t = total(c);
  return t === 0 ? null : round2((c.up / t) * 100);
}

// A day's timeline colour. A hard-down sample paints the day 'down' (an outage
// happened); a degraded-but-never-down day is 'degraded'; a fully clean day is
// 'operational'; a day with no samples is 'nodata'. The precise % is carried
// alongside, so a brief blip shows a red tick but still a high uptime number.
export function dayState(c: DayCounts): DayState {
  if (total(c) === 0) return 'nodata';
  if (c.down > 0) return 'down';
  if (c.degraded > 0) return 'degraded';
  return 'operational';
}

// --- rollup + retention (pure) ----------------------------------------------

// Group raw snapshots into per-day rollups. Used both to fold completed days into
// the durable rollup and, in-memory, to render the exact recent (raw) days.
export function tallySnapshots(snapshots: HealthSnapshot[]): Record<string, RollupDay> {
  const days: Record<string, RollupDay> = {};
  for (const s of snapshots) {
    const day = (days[dayOf(s.at)] ??= { components: {}, overall: zero() });
    addSnapshot(day, s);
  }
  return days;
}

// Fold raw samples older than the raw window into the rollup and prune anything
// past the rollup window — the retention step that keeps storage bounded. PURE:
// returns the NEW raw list + NEW rollup; the store persists them.
//
// A day leaves the raw window only once it is COMPLETE (no more samples can land in
// it), so its fold is final. Folding RECOMPUTES the day from that day's full raw set
// and REPLACES the rollup entry (not add), so re-running after a crash between the
// two writes is idempotent (same result, never double-counted).
export function pruneAndRoll(
  raw: HealthSnapshot[],
  rollup: UptimeRollup,
  opts: { now: Date; rawWindowDays?: number; rollupWindowDays?: number },
): { raw: HealthSnapshot[]; rollup: UptimeRollup } {
  const rawWindow = opts.rawWindowDays ?? RAW_WINDOW_DAYS;
  const rollupWindow = opts.rollupWindowDays ?? ROLLUP_WINDOW_DAYS;
  const todayIdx = dayIndex(dayOf(opts.now.toISOString()));

  const keep: HealthSnapshot[] = [];
  const toFold: HealthSnapshot[] = [];
  for (const s of raw) {
    // Within the raw window (age < rawWindow days) stays raw; older folds.
    if (todayIdx - dayIndex(dayOf(s.at)) < rawWindow) keep.push(s);
    else toFold.push(s);
  }

  const days: Record<string, RollupDay> = { ...rollup.days };
  // Replace each folded day with its recomputed rollup (idempotent).
  for (const [day, rec] of Object.entries(tallySnapshots(toFold))) {
    days[day] = rec;
  }
  // Prune rollup days past the rollup window.
  for (const day of Object.keys(days)) {
    if (todayIdx - dayIndex(day) >= rollupWindow) delete days[day];
  }

  return { raw: keep, rollup: { days } };
}

// --- windowed history report (pure) -----------------------------------------

// Build the per-component timeline over the last `windowDays` days (oldest→newest).
// MERGES raw (source of truth for any day it still holds samples for — the exact
// recent days, and any not-yet-folded day) OVER the durable rollup (older days), so
// a day is counted exactly once and the raw/rollup seam is seamless.
export function computeHistory(
  raw: HealthSnapshot[],
  rollup: UptimeRollup,
  opts: { now: Date; windowDays?: number },
): HistoryReport {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const todayIdx = dayIndex(dayOf(opts.now.toISOString()));
  const oldestIdx = todayIdx - (windowDays - 1);

  const rawDays = tallySnapshots(raw);
  // Effective record for a day: raw wins when present, else the rollup.
  const effective = (day: string): RollupDay | undefined => rawDays[day] ?? rollup.days[day];

  // The window's day strings, oldest → newest.
  const dayStrings: string[] = [];
  for (let idx = oldestIdx; idx <= todayIdx; idx++) dayStrings.push(dayFromIndex(idx));

  // Component names seen anywhere in the window, in first-appearance order
  // (oldest→newest) so the ordering is deterministic.
  const names: string[] = [];
  const seen = new Set<string>();
  for (const day of dayStrings) {
    const rec = effective(day);
    if (!rec) continue;
    for (const name of Object.keys(rec.components)) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }

  const components: HistoryComponent[] = names.map((name) => {
    const totals = zero();
    const days: HistoryDay[] = dayStrings.map((date) => {
      const counts = effective(date)?.components[name] ?? zero();
      totals.up += counts.up;
      totals.degraded += counts.degraded;
      totals.down += counts.down;
      return {
        date,
        state: dayState(counts),
        up: counts.up,
        degraded: counts.degraded,
        down: counts.down,
        total: total(counts),
        uptime_pct: uptimePct(counts),
      };
    });
    return { name, uptime_pct: uptimePct(totals), days };
  });

  // Overall uptime across the window (from the per-day overall counts).
  const overallTotals = zero();
  let sampleCount = 0;
  for (const day of dayStrings) {
    const rec = effective(day);
    if (!rec) continue;
    overallTotals.up += rec.overall.up;
    overallTotals.degraded += rec.overall.degraded;
    overallTotals.down += rec.overall.down;
    sampleCount += total(rec.overall);
  }

  return {
    window_days: windowDays,
    overall_uptime_pct: uptimePct(overallTotals),
    sample_count: sampleCount,
    components,
  };
}
