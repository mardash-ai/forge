import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { uptimeDir, uptimeRawFile, uptimeRollupFile } from '../shared/paths';
import {
  computeHistory,
  pruneAndRoll,
  type HealthSnapshot,
  type HistoryReport,
  type UptimeRollup,
  RAW_WINDOW_DAYS,
  ROLLUP_WINDOW_DAYS,
  DEFAULT_WINDOW_DAYS,
} from '../shared/uptime';

// C15 Phase 2 — the durable, per-app uptime-history store.
//
// Two files per app (see paths.ts): an append-window of raw HealthSnapshots
// (`<appId>.jsonl`) and a durable per-day rollup (`<appId>.rollup.json`). The
// health sampler (C2) calls `record()` each tick; the status route calls
// `getHistory()` to render the timeline. All the counting/rollup/retention MATH is
// the pure module `shared/uptime.ts`; this class is only its file I/O.
//
// Bounded storage: `record()` folds completed days into the rollup and prunes both
// windows on every write, so raw stays ≈ RAW_WINDOW_DAYS and the rollup ≈
// ROLLUP_WINDOW_DAYS regardless of how long sampling runs.
//
// Concurrency: a per-app async mutex serializes each app's read-modify-write (and
// the paired history read), and every file is replaced atomically (temp + rename),
// so a concurrent reader never sees a half-written file and two writes never lose an
// update. Different apps never block each other.
export class UptimeStore {
  private locks = new Map<string, Promise<unknown>>();

  private withLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(appId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    // The lock tail must never reject, or a failed op would wedge the next waiter.
    this.locks.set(
      appId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async readRaw(appId: string): Promise<HealthSnapshot[]> {
    let text: string;
    try {
      text = await readFile(uptimeRawFile(appId), 'utf8');
    } catch {
      return [];
    }
    const out: HealthSnapshot[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as HealthSnapshot);
      } catch {
        // skip a corrupt line
      }
    }
    return out;
  }

  private async readRollup(appId: string): Promise<UptimeRollup> {
    try {
      const parsed = JSON.parse(await readFile(uptimeRollupFile(appId), 'utf8')) as UptimeRollup;
      return parsed && typeof parsed === 'object' && parsed.days ? parsed : { days: {} };
    } catch {
      return { days: {} };
    }
  }

  // Atomic replace: write a sibling temp file, then rename over the target.
  private async atomicWrite(file: string, body: string): Promise<void> {
    await mkdir(uptimeDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file);
  }

  // Record one sample: append it, fold completed days into the rollup, prune both
  // windows, persist. Writes the ROLLUP first, then the pruned RAW — so a crash
  // between the two never drops a day (the day is in the rollup and still in raw;
  // the next fold recomputes-and-replaces it, idempotently).
  async record(appId: string, snapshot: HealthSnapshot): Promise<void> {
    await this.withLock(appId, async () => {
      const raw = await this.readRaw(appId);
      raw.push(snapshot);
      const rollup = await this.readRollup(appId);
      const rolled = pruneAndRoll(raw, rollup, {
        now: new Date(snapshot.at),
        rawWindowDays: RAW_WINDOW_DAYS,
        rollupWindowDays: ROLLUP_WINDOW_DAYS,
      });
      await this.atomicWrite(uptimeRollupFile(appId), JSON.stringify(rolled.rollup));
      await this.atomicWrite(
        uptimeRawFile(appId),
        rolled.raw.map((s) => JSON.stringify(s)).join('\n') + (rolled.raw.length ? '\n' : ''),
      );
    });
  }

  // The windowed per-component timeline. Reads raw + rollup as a consistent pair
  // (under the lock) and merges them via the pure `computeHistory`. Never throws: an
  // app that never enabled sampling reads empty (sample_count 0 ⇒ "collecting…").
  async getHistory(appId: string, opts: { windowDays?: number; now?: Date } = {}): Promise<HistoryReport> {
    return this.withLock(appId, async () => {
      const [raw, rollup] = [await this.readRaw(appId), await this.readRollup(appId)];
      return computeHistory(raw, rollup, {
        now: opts.now ?? new Date(),
        windowDays: Math.min(opts.windowDays ?? DEFAULT_WINDOW_DAYS, ROLLUP_WINDOW_DAYS),
      });
    });
  }
}

export const uptimeStore = new UptimeStore();
