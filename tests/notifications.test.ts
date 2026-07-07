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

// C11 — owner-scoping. Notifications now partition by (app, owner, key): two users can hold the
// SAME app key as DISTINCT notifications, mutations act only on the caller's own, and a list scoped
// to an owner returns ONLY that owner's — user A can never read/affect user B.
describe('Notification owner-scoping (C11)', () => {
  it('two owners may hold the same key as distinct records; each lists only their own (A cannot read B)', async () => {
    await store.upsertNotification('app', { key: 'cold:g1', title: "A's", owner: 'A' });
    await store.upsertNotification('app', { key: 'cold:g1', title: "B's", owner: 'B' });

    const aList = await store.listNotifications('app', { owner: 'A' });
    const bList = await store.listNotifications('app', { owner: 'B' });
    expect(aList.map((n) => n.title)).toEqual(["A's"]); // only A's, despite the shared key
    expect(bList.map((n) => n.title)).toEqual(["B's"]);
    expect(aList[0]?.key).toBe('cold:g1'); // the app key is unchanged (owner namespacing is internal)
    expect(aList[0]?.owner).toBe('A');
  });

  it("dismiss + clear act only on the caller's own record — the other owner's is untouched", async () => {
    await store.upsertNotification('app', { key: 'k', title: 'A', owner: 'A' });
    await store.upsertNotification('app', { key: 'k', title: 'B', owner: 'B' });

    expect(await store.dismissNotification('app', 'k', 'A')).toBe(true);
    expect(await store.listNotifications('app', { owner: 'A' })).toEqual([]); // A's is hidden
    expect((await store.listNotifications('app', { owner: 'B' })).length).toBe(1); // B's untouched

    expect(await store.clearNotification('app', 'k', 'A')).toBe(true);
    expect(await store.listNotifications('app', { owner: 'A', includeDismissed: true })).toEqual([]); // gone
    expect((await store.listNotifications('app', { owner: 'B', includeDismissed: true })).length).toBe(1); // still B's
  });

  it("re-upsert preserves the per-owner dismissed flag independently", async () => {
    await store.upsertNotification('app', { key: 'k', title: 't', owner: 'A' });
    await store.dismissNotification('app', 'k', 'A');
    await store.upsertNotification('app', { key: 'k', title: 't (re-derived)', owner: 'A' }); // still true for A
    await store.upsertNotification('app', { key: 'k', title: 'fresh', owner: 'B' }); // new for B
    expect(await store.listNotifications('app', { owner: 'A' })).toEqual([]); // stays dismissed for A
    expect((await store.listNotifications('app', { owner: 'B' }))[0]?.dismissed).toBe(false); // B's is active
  });

  it('backward compat: an owner-less upsert is app-scoped/legacy — app-scope list sees all, owner list excludes legacy', async () => {
    await store.upsertNotification('app', { key: 'legacy', title: 'legacy' }); // pre-C11, no owner
    await store.upsertNotification('app', { key: 'owned', title: 'owned', owner: 'A' });

    // App-scope (no owner passed) — unchanged pre-C11 behavior: sees everything.
    expect((await store.listNotifications('app')).map((n) => n.key).sort()).toEqual(['legacy', 'owned']);
    // Owner-scoped — the legacy notification is not attributed to A until migrated.
    expect((await store.listNotifications('app', { owner: 'A' })).map((n) => n.key)).toEqual(['owned']);
  });

  it('assignNotificationOwner migrates legacy notifications to an owner (re-keys + stamps), idempotently', async () => {
    await store.upsertNotification('app', { key: 'cold:g1', title: 't1' }); // legacy
    await store.upsertNotification('app', { key: 'cold:g2', title: 't2' }); // legacy
    await store.upsertNotification('app', { key: 'owned', title: 'o', owner: 'A' });

    expect(await store.assignNotificationOwner('app', 'A')).toBe(2);
    const aKeys = (await store.listNotifications('app', { owner: 'A' })).map((n) => n.key).sort();
    expect(aKeys).toEqual(['cold:g1', 'cold:g2', 'owned']); // legacy now attributed to A
    expect(await store.assignNotificationOwner('app', 'A')).toBe(0); // idempotent
  });
});
