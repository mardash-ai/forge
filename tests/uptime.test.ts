import { describe, it, expect } from 'vitest';
import {
  tallySnapshots,
  pruneAndRoll,
  computeHistory,
  dayState,
  uptimePct,
  componentBucket,
  overallBucket,
  dayIndex,
  dayFromIndex,
  type HealthSnapshot,
  type UptimeRollup,
} from '../src/shared/uptime';
import type { OverallStatus, ComponentState } from '../src/shared/status';

// C15 Phase 2 — the PURE uptime math: rollup, retention windows, uptime-% and the
// windowed history report. Unit-tested directly (no I/O), like the scheduler math.

function snap(at: string, overall: OverallStatus, comps: Array<[string, ComponentState]>): HealthSnapshot {
  return { at, overall, components: comps.map(([name, state]) => ({ name, state })) };
}

describe('bucket mapping + day classification', () => {
  it('maps component states to up/degraded/down (unknown counts as down)', () => {
    expect(componentBucket('operational')).toBe('up');
    expect(componentBucket('degraded')).toBe('degraded');
    expect(componentBucket('down')).toBe('down');
    expect(componentBucket('unknown')).toBe('down');
  });

  it('maps overall status to up/degraded/down', () => {
    expect(overallBucket('operational')).toBe('up');
    expect(overallBucket('degraded')).toBe('degraded');
    expect(overallBucket('partial_outage')).toBe('down');
    expect(overallBucket('major_outage')).toBe('down');
  });

  it('classifies a day by its worst sample, but reports the precise %', () => {
    expect(dayState({ up: 0, degraded: 0, down: 0 })).toBe('nodata');
    expect(dayState({ up: 10, degraded: 0, down: 0 })).toBe('operational');
    expect(dayState({ up: 10, degraded: 3, down: 0 })).toBe('degraded');
    expect(dayState({ up: 287, degraded: 0, down: 1 })).toBe('down'); // one blip → red tick
    expect(uptimePct({ up: 287, degraded: 0, down: 1 })).toBeCloseTo(99.65, 2); // …but ~99.65%
    expect(uptimePct({ up: 0, degraded: 0, down: 0 })).toBeNull();
    expect(uptimePct({ up: 3, degraded: 0, down: 1 })).toBe(75);
  });

  it('day index round-trips a UTC date', () => {
    expect(dayFromIndex(dayIndex('2026-07-08'))).toBe('2026-07-08');
    expect(dayIndex('2026-07-08') - dayIndex('2026-07-06')).toBe(2);
  });
});

describe('tallySnapshots', () => {
  it('groups samples by UTC day and counts per component + overall', () => {
    const days = tallySnapshots([
      snap('2026-07-08T00:00:00Z', 'operational', [['web', 'operational'], ['db', 'operational']]),
      snap('2026-07-08T06:00:00Z', 'partial_outage', [['web', 'operational'], ['db', 'down']]),
      snap('2026-07-07T06:00:00Z', 'operational', [['web', 'operational']]),
    ]);
    expect(days['2026-07-08']!.overall).toEqual({ up: 1, degraded: 0, down: 1 });
    expect(days['2026-07-08']!.components.web).toEqual({ up: 2, degraded: 0, down: 0 });
    expect(days['2026-07-08']!.components.db).toEqual({ up: 1, degraded: 0, down: 1 });
    expect(days['2026-07-07']!.components.web).toEqual({ up: 1, degraded: 0, down: 0 });
  });
});

describe('pruneAndRoll — retention (raw window + daily rollup)', () => {
  const now = new Date('2026-07-08T12:00:00.000Z');
  const raw: HealthSnapshot[] = [
    snap('2026-07-08T00:00:00Z', 'operational', [['web', 'operational']]), // today  (keep)
    snap('2026-07-07T00:00:00Z', 'operational', [['web', 'operational']]), // -1d    (keep)
    snap('2026-07-05T00:00:00Z', 'major_outage', [['web', 'down']]), //        -3d    (fold)
    snap('2026-07-05T06:00:00Z', 'operational', [['web', 'operational']]), // -3d    (fold)
  ];
  // A rollup day well past the 90-day window that must be pruned.
  const rollup: UptimeRollup = {
    days: { '2026-01-01': { components: { web: { up: 1, degraded: 0, down: 0 } }, overall: { up: 1, degraded: 0, down: 0 } } },
  };

  it('folds samples older than the raw window into the rollup and keeps recent raw', () => {
    const out = pruneAndRoll(raw, rollup, { now });
    // Only today + yesterday remain raw.
    expect(out.raw.map((s) => s.at.slice(0, 10)).sort()).toEqual(['2026-07-07', '2026-07-08']);
    // The 3-day-old day is folded (both its samples).
    expect(out.rollup.days['2026-07-05']!.components.web).toEqual({ up: 1, degraded: 0, down: 1 });
    expect(out.rollup.days['2026-07-05']!.overall).toEqual({ up: 1, degraded: 0, down: 1 });
  });

  it('prunes rollup days older than the rollup window', () => {
    const out = pruneAndRoll(raw, rollup, { now });
    expect(out.rollup.days['2026-01-01']).toBeUndefined();
  });

  it('is idempotent — re-running yields the same raw + rollup', () => {
    const first = pruneAndRoll(raw, rollup, { now });
    const second = pruneAndRoll(first.raw, first.rollup, { now });
    expect(second.raw).toEqual(first.raw);
    expect(second.rollup).toEqual(first.rollup);
  });

  it('honors custom windows', () => {
    const out = pruneAndRoll(raw, { days: {} }, { now, rawWindowDays: 1, rollupWindowDays: 90 });
    // rawWindow 1 → only today stays raw; -1d folds too.
    expect(out.raw.map((s) => s.at.slice(0, 10))).toEqual(['2026-07-08']);
    expect(out.rollup.days['2026-07-07']).toBeDefined();
  });
});

describe('computeHistory — windowed per-component timeline', () => {
  const now = new Date('2026-07-08T12:00:00.000Z');

  it('merges recent raw over the durable rollup across the window', () => {
    const raw: HealthSnapshot[] = [
      snap('2026-07-08T00:00:00Z', 'operational', [['web', 'operational']]),
      snap('2026-07-07T00:00:00Z', 'operational', [['web', 'operational']]),
    ];
    const rollup: UptimeRollup = {
      days: {
        '2026-07-05': { components: { web: { up: 1, degraded: 0, down: 1 } }, overall: { up: 1, degraded: 0, down: 1 } },
      },
    };
    const h = computeHistory(raw, rollup, { now, windowDays: 5 });
    expect(h.window_days).toBe(5);
    const web = h.components.find((c) => c.name === 'web')!;
    // Oldest→newest: 07-04(nodata) 07-05(down) 07-06(nodata) 07-07(op) 07-08(op)
    expect(web.days.map((d) => d.date)).toEqual(['2026-07-04', '2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08']);
    expect(web.days.map((d) => d.state)).toEqual(['nodata', 'down', 'nodata', 'operational', 'operational']);
    // uptime over the window: up 3 / total 4 = 75%
    expect(web.uptime_pct).toBe(75);
    expect(h.overall_uptime_pct).toBe(75);
    expect(h.sample_count).toBe(4);
  });

  it('raw wins over rollup for a day present in both (no double count)', () => {
    const raw = [snap('2026-07-07T00:00:00Z', 'operational', [['web', 'operational']])];
    const rollup: UptimeRollup = {
      days: { '2026-07-07': { components: { web: { up: 0, degraded: 0, down: 5 } }, overall: { up: 0, degraded: 0, down: 5 } } },
    };
    const h = computeHistory(raw, rollup, { now, windowDays: 3 });
    const day = h.components.find((c) => c.name === 'web')!.days.find((d) => d.date === '2026-07-07')!;
    expect(day.state).toBe('operational'); // raw wins
    expect(day.total).toBe(1);
  });

  it('empty history reads as collecting (sample_count 0, no components)', () => {
    const h = computeHistory([], { days: {} }, { now, windowDays: 90 });
    expect(h.sample_count).toBe(0);
    expect(h.components).toEqual([]);
    expect(h.overall_uptime_pct).toBeNull();
  });
});
