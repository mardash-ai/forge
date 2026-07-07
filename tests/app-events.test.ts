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

// C11 — owner-scoping (per-user ownership). The same per-app log now partitions by (app, owner):
// an emit carries an opaque `owner` (C10's session userId); a read scoped to an owner returns ONLY
// that owner's events. Cross-owner reads MUST come back empty — user A can never read user B.
describe('AppEvent owner-scoping (C11)', () => {
  it("user A's events are NOT visible to user B's owner-scoped query (A cannot read B)", async () => {
    await store.appendAppEvent({ app_id: 'app', type: 'goal.created', subject: 'g1', owner: 'A' });
    await store.appendAppEvent({ app_id: 'app', type: 'goal.created', subject: 'g2', owner: 'B' });

    const aFeed = await store.listAppEvents({ app_id: 'app', owner: 'A' });
    const bFeed = await store.listAppEvents({ app_id: 'app', owner: 'B' });
    expect(aFeed.map((e) => e.subject)).toEqual(['g1']); // only A's
    expect(bFeed.map((e) => e.subject)).toEqual(['g2']); // only B's
    // The cross-owner read is EMPTY, never the other user's data.
    expect((await store.listAppEvents({ app_id: 'app', owner: 'A' })).some((e) => e.owner === 'B')).toBe(false);
  });

  it('a query with an owner returns only that owner’s records; a subject filter composes with it', async () => {
    await store.appendAppEvent({ app_id: 'app', type: 't', subject: 'g1', owner: 'A' });
    await store.appendAppEvent({ app_id: 'app', type: 't', subject: 'g1', owner: 'B' });
    await store.appendAppEvent({ app_id: 'app', type: 't', subject: 'g1', owner: 'A' });

    const aG1 = await store.listAppEvents({ app_id: 'app', owner: 'A', subject: 'g1' });
    expect(aG1.length).toBe(2); // A's two g1 events, not B's
    expect(aG1.every((e) => e.owner === 'A')).toBe(true);
  });

  it('backward compat: no owner on emit = legacy/app-scoped — an owner-less query sees ALL, an owner query excludes legacy', async () => {
    await store.appendAppEvent({ app_id: 'app', type: 'legacy' }); // pre-C11, no owner
    await store.appendAppEvent({ app_id: 'app', type: 'owned', owner: 'A' });

    // App-scope (no owner passed) — a C10-less app / pre-C11 read is unchanged: sees everything.
    expect((await store.listAppEvents({ app_id: 'app' })).map((e) => e.type).sort()).toEqual(['legacy', 'owned']);
    // Owner-scoped — a legacy (owner-less) event is not attributed to A until migrated.
    expect((await store.listAppEvents({ app_id: 'app', owner: 'A' })).map((e) => e.type)).toEqual(['owned']);
  });

  it('latestAppEventTimes is owner-scoped — one user’s activity never resets another user’s clock', async () => {
    await store.appendAppEvent({ app_id: 'app', type: 'a', subject: 'shared', owner: 'A' });
    await store.appendAppEvent({ app_id: 'app', type: 'b', subject: 'shared', owner: 'B' });
    const aLatest = await store.latestAppEventTimes('app', 'A');
    const aFeed = await store.listAppEvents({ app_id: 'app', owner: 'A', subject: 'shared' });
    expect(aLatest['shared']).toBe(aFeed[0]?.at); // A's own newest, not B's
  });

  it('assignAppEventOwner migrates legacy events to an owner (one-time cutover), idempotently', async () => {
    await store.appendAppEvent({ app_id: 'app', type: 'legacy1' });
    await store.appendAppEvent({ app_id: 'app', type: 'legacy2' });
    await store.appendAppEvent({ app_id: 'app', type: 'already', owner: 'A' });

    expect(await store.assignAppEventOwner('app', 'A')).toBe(2); // only the two legacy events
    expect((await store.listAppEvents({ app_id: 'app', owner: 'A' })).map((e) => e.type).sort()).toEqual(['already', 'legacy1', 'legacy2']);
    expect(await store.assignAppEventOwner('app', 'A')).toBe(0); // nothing left to claim (idempotent)
  });
});
