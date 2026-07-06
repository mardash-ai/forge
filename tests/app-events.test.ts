import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';

// C3 — the application event log (store surface). A per-app append-only log of app DOMAIN facts,
// separate from the platform ForgeEvent log. Uses a throwaway FORGE_STATE_DIR so it touches disk
// exactly like production but leaves nothing behind.
let dir: string;
let prev: string | undefined;

beforeEach(async () => {
  prev = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-appevents-'));
  process.env.FORGE_STATE_DIR = dir;
});

afterEach(async () => {
  if (prev === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prev;
  await rm(dir, { recursive: true, force: true });
});

describe('AppEvent log (C3)', () => {
  it('reads an empty feed before anything is emitted (degrades, never throws)', async () => {
    expect(await store.listAppEvents({ app_id: 'app_x' })).toEqual([]);
    expect(await store.latestAppEventTimes('app_x')).toEqual({});
  });

  it('appends and lists newest-first, filterable by subject', async () => {
    await store.appendAppEvent({ app_id: 'app_x', type: 'goal.created', subject: 'g1', data: { title: 'A' } });
    await store.appendAppEvent({ app_id: 'app_x', type: 'task.added', subject: 'g1', data: { task: 'T' } });
    await store.appendAppEvent({ app_id: 'app_x', type: 'goal.created', subject: 'g2' });

    const all = await store.listAppEvents({ app_id: 'app_x' });
    expect(all.map((e) => e.type)).toEqual(['goal.created', 'task.added', 'goal.created']); // newest-first
    expect(all[0]?.subject).toBe('g2');
    expect(all[0]?.data).toEqual({}); // data defaults to {} when omitted

    const g1 = await store.listAppEvents({ app_id: 'app_x', subject: 'g1' });
    expect(g1.map((e) => e.type)).toEqual(['task.added', 'goal.created']);
  });

  it('isolates events per app (separate logs)', async () => {
    await store.appendAppEvent({ app_id: 'a', type: 'x' });
    await store.appendAppEvent({ app_id: 'b', type: 'y' });
    expect((await store.listAppEvents({ app_id: 'a' })).map((e) => e.type)).toEqual(['x']);
    expect((await store.listAppEvents({ app_id: 'b' })).map((e) => e.type)).toEqual(['y']);
  });

  it('clamps the limit to [1, 500] and honors it', async () => {
    for (let i = 0; i < 5; i++) await store.appendAppEvent({ app_id: 'app_x', type: `t${i}`, subject: 'g' });
    expect((await store.listAppEvents({ app_id: 'app_x', limit: 2 })).length).toBe(2);
    expect((await store.listAppEvents({ app_id: 'app_x', limit: 0 })).length).toBe(1); // clamped up to 1
  });

  it('latestAppEventTimes reports the newest timestamp per subject and ignores subject-less events', async () => {
    await store.appendAppEvent({ app_id: 'app_x', type: 'a', subject: 'g1' });
    await store.appendAppEvent({ app_id: 'app_x', type: 'b', subject: 'g1' });
    await store.appendAppEvent({ app_id: 'app_x', type: 'c', subject: 'g2' });
    await store.appendAppEvent({ app_id: 'app_x', type: 'no-subject' });

    const latest = await store.latestAppEventTimes('app_x');
    expect(Object.keys(latest).sort()).toEqual(['g1', 'g2']); // no entry for the subject-less event
    const g1Feed = await store.listAppEvents({ app_id: 'app_x', subject: 'g1' });
    expect(latest['g1']).toBe(g1Feed[0]?.at); // newest g1 event's timestamp
  });
});
