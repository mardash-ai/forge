import { invalidInput } from '../../shared/errors';
import type { ScheduledJob } from '../../resources/types';

// Pure scheduling logic for the scheduler-node Implementation — no I/O, so it is
// unit-testable. A schedule is stored as a self-describing canonical string:
//   "every:<dur>"  recurring interval  (30s, 5m, 1h, 24h, 7d)
//   "cron:<expr>"  recurring 5-field cron, evaluated in UTC (m h dom mon dow)
//   "once:<iso>"   one-shot at an instant
// All time math is UTC, matching how the rest of the platform treats dates.

export type Schedule =
  | { kind: 'interval'; ms: number }
  | { kind: 'cron'; fields: CronFields }
  | { kind: 'once'; at: string };

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(s.trim());
  if (!m) throw invalidInput(`Invalid interval "${s}". Use e.g. 30s, 5m, 1h, 24h, 7d.`, { every: s });
  const ms = Number(m[1]) * UNIT_MS[m[2]!]!;
  if (ms < 1000) throw invalidInput('Interval must be at least 1s.', { every: s });
  return ms;
}

// --- cron ------------------------------------------------------------------

interface CronField {
  has(v: number): boolean;
  restricted: boolean;
}
export interface CronFields {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

function parseField(spec: string, min: number, max: number, label: string): CronField {
  if (spec === '*') return { has: () => true, restricted: false };
  const allowed = new Set<number>();
  for (const part of spec.split(',')) {
    const pieces = part.split('/');
    const range = pieces[0] ?? '*';
    const stepStr = pieces[1];
    const step = stepStr === undefined ? 1 : Number(stepStr);
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const rp = range.split('-');
      lo = Number(rp[0]);
      hi = rp[1] === undefined ? lo : Number(rp[1]);
    }
    if (
      !Number.isInteger(lo) || !Number.isInteger(hi) || !Number.isInteger(step) ||
      step < 1 || lo < min || hi > max || lo > hi
    ) {
      throw invalidInput(`Invalid cron ${label} field "${spec}".`, { field: label, value: spec });
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return { has: (v) => allowed.has(v), restricted: true };
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw invalidInput(`Cron must have 5 fields (m h dom mon dow); got "${expr}".`, { cron: expr });
  }
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  return {
    minute: parseField(m, 0, 59, 'minute'),
    hour: parseField(h, 0, 23, 'hour'),
    dom: parseField(dom, 1, 31, 'day-of-month'),
    month: parseField(mon, 1, 12, 'month'),
    dow: parseField(dow, 0, 6, 'day-of-week'),
  };
}

// Next UTC minute strictly after `after` that matches the cron fields. Standard
// rule: when both day-of-month and day-of-week are restricted, a day matches if
// EITHER does; otherwise both must. Bounded search (~366 days) so a never-matching
// expression returns null instead of looping forever.
function nextCron(fields: CronFields, after: Date): Date | null {
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const cap = 366 * 24 * 60 + 60;
  for (let i = 0; i < cap; i++, t += 60_000) {
    const d = new Date(t);
    const dayOk =
      fields.dom.restricted && fields.dow.restricted
        ? fields.dom.has(d.getUTCDate()) || fields.dow.has(d.getUTCDay())
        : fields.dom.has(d.getUTCDate()) && fields.dow.has(d.getUTCDay());
    if (
      fields.minute.has(d.getUTCMinutes()) &&
      fields.hour.has(d.getUTCHours()) &&
      fields.month.has(d.getUTCMonth() + 1) &&
      dayOk
    ) {
      return d;
    }
  }
  return null;
}

// --- public API ------------------------------------------------------------

// Validate the flags and return the canonical string to persist. Exactly one of
// every / cron / at must be given.
export function toCanonical(input: { every?: string; cron?: string; at?: string }): string {
  const provided = [
    input.every ? 'every' : null,
    input.cron ? 'cron' : null,
    input.at ? 'at' : null,
  ].filter(Boolean);
  if (provided.length !== 1) {
    throw invalidInput('Provide exactly one of --every, --cron, or --at.', { provided });
  }
  if (input.every) {
    parseDuration(input.every);
    return `every:${input.every.trim()}`;
  }
  if (input.cron) {
    parseCron(input.cron);
    return `cron:${input.cron.trim()}`;
  }
  const at = new Date(input.at as string);
  if (Number.isNaN(at.getTime())) throw invalidInput('--at must be an ISO timestamp.', { at: input.at });
  return `once:${at.toISOString()}`;
}

export function parseSchedule(canonical: string): Schedule {
  const i = canonical.indexOf(':');
  const kind = canonical.slice(0, i);
  const rest = canonical.slice(i + 1);
  if (kind === 'every') return { kind: 'interval', ms: parseDuration(rest) };
  if (kind === 'cron') return { kind: 'cron', fields: parseCron(rest) };
  if (kind === 'once') return { kind: 'once', at: rest };
  throw invalidInput(`Unrecognized schedule "${canonical}".`, { schedule: canonical });
}

// The next fire time strictly after `after`, or null if the schedule is exhausted
// (a one-shot already past). Used both to seed a new job and to advance after a run.
export function nextRun(sched: Schedule, after: Date): Date | null {
  if (sched.kind === 'interval') return new Date(after.getTime() + sched.ms);
  if (sched.kind === 'once') {
    const at = new Date(sched.at);
    return at > after ? at : null;
  }
  return nextCron(sched.fields, after);
}

// A job is due when it's enabled and its next fire time has arrived.
export function isDue(nextRunAtISO: string, now: Date): boolean {
  return new Date(nextRunAtISO).getTime() <= now.getTime();
}

// Retry policy: on failure, retry after a short backoff up to MAX_RETRIES, then
// give up on this occurrence and advance to the next scheduled fire.
export const MAX_RETRIES = 3;
export const RETRY_BACKOFF_MS = 60_000;

// Advance a job after an invocation attempt (pure — the ticker persists the
// result). Recomputes next_run_at, last_status, and the counters; disables a
// one-shot once its instant has passed.
export function advanceJob(job: ScheduledJob, success: boolean, now: Date): ScheduledJob {
  const sched = parseSchedule(job.schedule);
  const base = { ...job, last_run_at: now.toISOString(), run_count: job.run_count + 1 };

  if (!success) {
    const failCount = job.fail_count + 1;
    if (failCount < MAX_RETRIES) {
      // retry soon without advancing the schedule
      return {
        ...base,
        last_status: 'failed',
        fail_count: failCount,
        next_run_at: new Date(now.getTime() + RETRY_BACKOFF_MS).toISOString(),
      };
    }
    // retries exhausted — skip to the next scheduled fire
    const next = nextRun(sched, now);
    return {
      ...base,
      last_status: 'failed',
      fail_count: 0,
      enabled: next !== null,
      ...(next ? { next_run_at: next.toISOString() } : {}),
    };
  }

  const next = nextRun(sched, now);
  return {
    ...base,
    last_status: 'succeeded',
    fail_count: 0,
    enabled: next !== null,
    ...(next ? { next_run_at: next.toISOString() } : {}),
  };
}
