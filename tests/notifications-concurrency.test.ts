import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';

// P5 regression — the notification store applies each mutation as a read-modify-write of the whole
// per-app map. That RMW must be ATOMIC: concurrent upsert/dismiss/clear to DISTINCT keys must ALL
// persist (a non-atomic RMW loses updates — the later write clobbers the earlier one). These tests
// fire N mutations concurrently and assert none are lost. Uses a throwaway FORGE_STATE_DIR.
let dir: string;
let prev: string | undefined;

beforeEach(async () => {
  prev = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-notifs-conc-'));
  process.env.FORGE_STATE_DIR = dir;
});

afterEach(async () => {
  if (prev === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prev;
  await rm(dir, { recursive: true, force: true });
});

describe('Notification store — concurrency (P5)', () => {
  it('does not lose any of N concurrent upserts to distinct keys', async () => {
    const N = 50;
    const keys = Array.from({ length: N }, (_, i) => `k${i}`);

    // Fire all upserts at once — no await between them.
    await Promise.all(keys.map((key) => store.upsertNotification('a', { key, title: `t-${key}` })));

    const list = await store.listNotifications('a');
    expect(list.length).toBe(N);
    expect(new Set(list.map((n) => n.key))).toEqual(new Set(keys)); // every key persisted, none lost
  });

  it('concurrent upsert + dismiss + clear to distinct keys all take effect', async () => {
    // Seed keys that will be dismissed / cleared concurrently with fresh upserts.
    const dismissKeys = ['d0', 'd1', 'd2', 'd3', 'd4'];
    const clearKeys = ['c0', 'c1', 'c2', 'c3', 'c4'];
    await Promise.all([...dismissKeys, ...clearKeys].map((key) => store.upsertNotification('a', { key, title: key })));

    const freshKeys = Array.from({ length: 20 }, (_, i) => `u${i}`);

    // Now interleave 20 new upserts, 5 dismisses, and 5 clears — all concurrently, all distinct keys.
    await Promise.all([
      ...freshKeys.map((key) => store.upsertNotification('a', { key, title: key })),
      ...dismissKeys.map((key) => store.dismissNotification('a', key)),
      ...clearKeys.map((key) => store.clearNotification('a', key)),
    ]);

    const all = await store.listNotifications('a', { includeDismissed: true });
    const byKey = new Map(all.map((n) => [n.key, n]));

    // The 20 fresh upserts persisted, active.
    for (const key of freshKeys) {
      expect(byKey.get(key)?.dismissed).toBe(false);
    }
    // The 5 dismisses persisted (present, dismissed).
    for (const key of dismissKeys) {
      expect(byKey.get(key)?.dismissed).toBe(true);
    }
    // The 5 clears persisted (gone entirely).
    for (const key of clearKeys) {
      expect(byKey.has(key)).toBe(false);
    }

    // Total surviving = 20 fresh + 5 dismissed. The active feed shows only the 20 fresh.
    expect(all.length).toBe(freshKeys.length + dismissKeys.length);
    expect((await store.listNotifications('a')).length).toBe(freshKeys.length);
  });

  it('concurrent mutations to DIFFERENT apps stay isolated and complete', async () => {
    await Promise.all([
      store.upsertNotification('app-a', { key: 'x', title: 'A' }),
      store.upsertNotification('app-b', { key: 'x', title: 'B' }),
      store.upsertNotification('app-a', { key: 'y', title: 'A2' }),
      store.upsertNotification('app-b', { key: 'y', title: 'B2' }),
    ]);
    expect((await store.listNotifications('app-a')).length).toBe(2);
    expect((await store.listNotifications('app-b')).length).toBe(2);
  });
});
