import { describe, it, expect } from 'vitest';
import {
  parseDuration,
  toCanonical,
  parseSchedule,
  nextRun,
  isDue,
  advanceJob,
  MAX_RETRIES,
} from '../src/plugins/scheduler-node/schedule';
import type { ScheduledJob } from '../src/resources/types';
import { ForgeError } from '../src/shared/errors';

const NOW = new Date('2026-07-06T12:30:00.000Z');

describe('duration + canonical parsing', () => {
  it('parses durations and rejects junk', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(() => parseDuration('5x')).toThrow(ForgeError);
    expect(() => parseDuration('500ms')).toThrow(ForgeError);
  });

  it('requires exactly one of every/cron/at', () => {
    expect(toCanonical({ every: '1h' })).toBe('every:1h');
    expect(toCanonical({ cron: '0 0 * * *' })).toBe('cron:0 0 * * *');
    expect(() => toCanonical({})).toThrow(ForgeError);
    expect(() => toCanonical({ every: '1h', cron: '0 0 * * *' })).toThrow(ForgeError);
  });

  it('rejects a malformed cron', () => {
    expect(() => toCanonical({ cron: '0 0 * *' })).toThrow(ForgeError); // 4 fields
    expect(() => toCanonical({ cron: '99 0 * * *' })).toThrow(ForgeError); // minute out of range
  });
});

describe('nextRun', () => {
  it('interval fires one period from `after`', () => {
    expect(nextRun(parseSchedule('every:1h'), NOW)?.toISOString()).toBe('2026-07-06T13:30:00.000Z');
  });

  it('cron "0 0 * * *" fires at the next UTC midnight', () => {
    expect(nextRun(parseSchedule('cron:0 0 * * *'), NOW)?.toISOString()).toBe('2026-07-07T00:00:00.000Z');
  });

  it('cron "*/15 * * * *" fires at the next quarter hour', () => {
    expect(nextRun(parseSchedule('cron:*/15 * * * *'), NOW)?.toISOString()).toBe('2026-07-06T12:45:00.000Z');
  });

  it('one-shot fires at its instant, or never once past', () => {
    expect(nextRun(parseSchedule('once:2026-07-06T18:00:00.000Z'), NOW)?.toISOString()).toBe('2026-07-06T18:00:00.000Z');
    expect(nextRun(parseSchedule('once:2026-07-06T06:00:00.000Z'), NOW)).toBeNull();
  });

  it('isDue compares the fire time to now', () => {
    expect(isDue('2026-07-06T12:29:00.000Z', NOW)).toBe(true);
    expect(isDue('2026-07-06T12:31:00.000Z', NOW)).toBe(false);
  });
});

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'job_1',
    type: 'ScheduledJob',
    app_id: 'app_1',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    name: 'habits',
    schedule: 'every:1h',
    target: { method: 'POST', path: '/api/cron/habits' },
    enabled: true,
    next_run_at: NOW.toISOString(),
    last_status: 'never',
    run_count: 0,
    fail_count: 0,
    ...overrides,
  };
}

describe('advanceJob — retry policy + scheduling', () => {
  it('success advances to the next fire and clears failures', () => {
    const d = advanceJob(job(), true, NOW);
    expect(d.last_status).toBe('succeeded');
    expect(d.fail_count).toBe(0);
    expect(d.run_count).toBe(1);
    expect(d.next_run_at).toBe('2026-07-06T13:30:00.000Z');
    expect(d.enabled).toBe(true);
  });

  it('a failure below the retry cap backs off soon', () => {
    const d = advanceJob(job({ fail_count: 0 }), false, NOW);
    expect(d.last_status).toBe('failed');
    expect(d.fail_count).toBe(1);
    expect(d.next_run_at).toBe('2026-07-06T12:31:00.000Z'); // now + 60s backoff
  });

  it('exhausting retries skips to the next scheduled fire and resets the counter', () => {
    const d = advanceJob(job({ fail_count: MAX_RETRIES - 1 }), false, NOW);
    expect(d.fail_count).toBe(0);
    expect(d.next_run_at).toBe('2026-07-06T13:30:00.000Z');
    expect(d.enabled).toBe(true);
  });

  it('a one-shot disables itself after it fires', () => {
    const d = advanceJob(job({ schedule: 'once:2026-07-06T12:30:00.000Z' }), true, NOW);
    expect(d.enabled).toBe(false);
  });
});
