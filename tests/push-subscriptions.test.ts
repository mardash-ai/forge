import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';

// C21 — the notification-delivery store (push subscriptions + the delivery-idempotency ledger). Filesystem
// backend, exercised through the store forwarders. Uses a throwaway FORGE_STATE_DIR.
let dir: string;
let prev: string | undefined;

const sub = (endpoint: string, p256dh = 'BPp256dhkey', auth = 'authsecret') => ({ endpoint, keys: { p256dh, auth } });

beforeEach(async () => {
  prev = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-push-'));
  process.env.FORGE_STATE_DIR = dir;
});

afterEach(async () => {
  if (prev === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prev;
  await rm(dir, { recursive: true, force: true });
});

describe('Push subscription store (C21)', () => {
  it('lists empty before any register (degrades, never throws)', async () => {
    expect(await store.listPushSubscriptions('a', 'A')).toEqual([]);
  });

  it('registers a subscription, stamps the owner + timestamps, and lists it', async () => {
    const rec = await store.registerPushSubscription('a', { owner: 'A', ...sub('https://push/1') });
    expect(rec.owner).toBe('A');
    expect(rec.endpoint).toBe('https://push/1');
    expect(rec.keys).toEqual({ p256dh: 'BPp256dhkey', auth: 'authsecret' });
    expect(rec.created_at).toBeTruthy();
    const list = await store.listPushSubscriptions('a', 'A');
    expect(list.map((s) => s.endpoint)).toEqual(['https://push/1']);
  });

  it('dedupes by endpoint — re-registering the same endpoint UPDATES in place (one row), preserves created_at', async () => {
    const first = await store.registerPushSubscription('a', { owner: 'A', ...sub('https://push/1', 'oldkey', 'oldauth') });
    const second = await store.registerPushSubscription('a', { owner: 'A', ...sub('https://push/1', 'newkey', 'newauth') });
    const list = await store.listPushSubscriptions('a', 'A');
    expect(list.length).toBe(1); // no duplicate
    expect(list[0]!.keys).toEqual({ p256dh: 'newkey', auth: 'newauth' }); // updated
    expect(second.created_at).toBe(first.created_at); // preserved across re-register
  });

  it('a person may hold MANY devices (distinct endpoints all list)', async () => {
    await store.registerPushSubscription('a', { owner: 'A', ...sub('https://push/phone') });
    await store.registerPushSubscription('a', { owner: 'A', ...sub('https://push/laptop') });
    expect((await store.listPushSubscriptions('a', 'A')).map((s) => s.endpoint).sort()).toEqual(['https://push/laptop', 'https://push/phone']);
  });

  it('scopes per owner — user A never sees user B (even the same endpoint string is per-owner via list)', async () => {
    await store.registerPushSubscription('a', { owner: 'A', ...sub('https://push/A') });
    await store.registerPushSubscription('a', { owner: 'B', ...sub('https://push/B') });
    expect((await store.listPushSubscriptions('a', 'A')).map((s) => s.endpoint)).toEqual(['https://push/A']);
    expect((await store.listPushSubscriptions('a', 'B')).map((s) => s.endpoint)).toEqual(['https://push/B']);
  });

  it('unregister removes a subscription; an owner mismatch is refused; missing is a no-op', async () => {
    await store.registerPushSubscription('a', { owner: 'A', ...sub('https://push/1') });
    expect(await store.unregisterPushSubscription('a', 'https://push/1', 'B')).toBe(false); // not B's to remove
    expect((await store.listPushSubscriptions('a', 'A')).length).toBe(1); // untouched
    expect(await store.unregisterPushSubscription('a', 'https://push/1', 'A')).toBe(true);
    expect(await store.listPushSubscriptions('a', 'A')).toEqual([]);
    expect(await store.unregisterPushSubscription('a', 'https://push/1', 'A')).toBe(false); // already gone
  });

  it('prune removes a dead endpoint regardless of owner (server-side 404/410 cleanup)', async () => {
    await store.registerPushSubscription('a', { owner: 'A', ...sub('https://push/dead') });
    expect(await store.prunePushSubscription('a', 'https://push/dead')).toBe(true);
    expect(await store.listPushSubscriptions('a', 'A')).toEqual([]);
    expect(await store.prunePushSubscription('a', 'https://push/dead')).toBe(false);
  });

  it('isolates subscriptions per app', async () => {
    await store.registerPushSubscription('a', { owner: 'A', ...sub('https://push/a') });
    await store.registerPushSubscription('b', { owner: 'A', ...sub('https://push/b') });
    expect((await store.listPushSubscriptions('a', 'A')).map((s) => s.endpoint)).toEqual(['https://push/a']);
    expect((await store.listPushSubscriptions('b', 'A')).map((s) => s.endpoint)).toEqual(['https://push/b']);
  });
});

describe('Delivery idempotency ledger (C21)', () => {
  it('claimDelivery is atomic first-writer — the first claim wins, a retry with the same key is refused', async () => {
    expect(await store.claimDelivery('a', 'A', 'idem-1')).toBe(true); // first time — deliver
    expect(await store.claimDelivery('a', 'A', 'idem-1')).toBe(false); // retry — skip
    expect(await store.claimDelivery('a', 'A', 'idem-2')).toBe(true); // a different key is independent
  });

  it('scopes the claim by (app, owner) — the same key is independent across owners + apps', async () => {
    expect(await store.claimDelivery('a', 'A', 'k')).toBe(true);
    expect(await store.claimDelivery('a', 'B', 'k')).toBe(true); // other owner, same key
    expect(await store.claimDelivery('b', 'A', 'k')).toBe(true); // other app, same key
    expect(await store.claimDelivery('a', 'A', 'k')).toBe(false); // the original is claimed
  });

  it('a concurrent double-claim yields exactly one winner', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.claimDelivery('a', 'A', 'race')));
    expect(results.filter((r) => r === true).length).toBe(1);
  });
});
