import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';

// C4 — the notification store (durable, per-app, keyed). The app derives WHICH conditions matter;
// Forge persists + tracks dismissal + clear. Uses a throwaway FORGE_STATE_DIR.
let dir: string;
let prev: string | undefined;

beforeEach(async () => {
  prev = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-notifs-'));
  process.env.FORGE_STATE_DIR = dir;
});

afterEach(async () => {
  if (prev === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prev;
  await rm(dir, { recursive: true, force: true });
});

describe('Notification store (C4)', () => {
  it('lists empty before any upsert (degrades, never throws)', async () => {
    expect(await store.listNotifications('a')).toEqual([]);
  });

  it('upserts and lists active', async () => {
    await store.upsertNotification('a', { key: 'cold:g1', title: 'Goal g1 is cold' });
    const list = await store.listNotifications('a');
    expect(list.length).toBe(1);
    expect(list[0]?.key).toBe('cold:g1');
    expect(list[0]?.dismissed).toBe(false);
    expect(list[0]?.data).toEqual({}); // defaults to {}
  });

  it('upsert by the same key is idempotent — updates in place, preserves created_at', async () => {
    const first = await store.upsertNotification('a', { key: 'k', title: 'v1' });
    const second = await store.upsertNotification('a', { key: 'k', title: 'v2', body: 'more' });
    expect((await store.listNotifications('a')).length).toBe(1); // no duplicate
    expect(second.title).toBe('v2');
    expect(second.created_at).toBe(first.created_at); // preserved across re-derivation
  });

  it('dismiss persists — hidden from the active feed, present with includeDismissed', async () => {
    await store.upsertNotification('a', { key: 'k', title: 't' });
    expect(await store.dismissNotification('a', 'k')).toBe(true);
    expect(await store.listNotifications('a')).toEqual([]);
    const all = await store.listNotifications('a', { includeDismissed: true });
    expect(all.length).toBe(1);
    expect(all[0]?.dismissed).toBe(true);
  });

  it('re-upserting a dismissed key keeps it dismissed (a still-true condition does not resurface)', async () => {
    await store.upsertNotification('a', { key: 'k', title: 't' });
    await store.dismissNotification('a', 'k');
    await store.upsertNotification('a', { key: 'k', title: 't (re-derived)' });
    expect(await store.listNotifications('a')).toEqual([]); // still dismissed
    expect((await store.listNotifications('a', { includeDismissed: true }))[0]?.dismissed).toBe(true);
  });

  it('clear removes a notification (condition no longer applies); missing keys are no-ops', async () => {
    await store.upsertNotification('a', { key: 'k', title: 't' });
    expect(await store.clearNotification('a', 'k')).toBe(true);
    expect(await store.listNotifications('a', { includeDismissed: true })).toEqual([]);
    expect(await store.clearNotification('a', 'k')).toBe(false); // already gone
    expect(await store.dismissNotification('a', 'missing')).toBe(false);
  });

  it('isolates notifications per app', async () => {
    await store.upsertNotification('a', { key: 'k', title: 'A' });
    await store.upsertNotification('b', { key: 'k', title: 'B' });
    expect((await store.listNotifications('a'))[0]?.title).toBe('A');
    expect((await store.listNotifications('b'))[0]?.title).toBe('B');
  });
});
