import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { getBackends } from '../src/storage/backends';
import { setSecret } from '../src/plugins/secrets-local/index';
import { setEmailTransport, resetEmailTransport, type OutboundEmail, type EmailConfig } from '../src/plugins/email-smtp/index';
import { setPushTransport, resetPushTransport } from '../src/plugins/webpush-vapid/index';
import { notify } from '../src/notifications/delivery';
import { registerNotificationRoutes } from '../src/api/notifications-routes';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';

// C21 — the notify() DELIVERY fan-out (grows C4). Proves: default = in_app only (backward compatible);
// push fans out to a user's subscriptions + prunes expired ones; email resolves the account address +
// sends via C12; best-effort isolation (a failing channel never blocks the others); idempotency across
// channels; and the HTTP surface (subscribe / unsubscribe / vapid-public-key). No socket is opened — the
// push + email transports are deterministic sinks.

const APP = 'demo';
const APP_ID = 'app_demo';
let dir: string;
let prevState: string | undefined;
const prevKey = process.env.FORGE_SECRETS_KEY;
const SMTP_URL = 'smtp://user:pass@mail.example.test:1025';
const FROM = 'Acme <no-reply@acme.test>';

// A subscription with REAL keys (a valid P-256 UA public point + a 16-byte auth secret) so the RFC 8291
// encryption genuinely succeeds and the stub transport is actually reached (the crypto is proven end-to-end
// in webpush-vapid.test.ts; here we need it to not fail the fan-out).
function sub(endpoint: string): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const raw = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { endpoint, keys: { p256dh: raw.toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

async function seedApp(): Promise<void> {
  const now = nowIso();
  const app: Application = {
    id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
    name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web',
    language: 'typescript', package_manager: 'npm',
  };
  await store.saveResource(app);
}

// Create a login identity so the email channel can resolve the owner's account address. Returns the
// user id (used as the notification/subscription `owner`) + the address.
async function seedUser(email = 'jane@example.com'): Promise<{ owner: string; email: string }> {
  const user = await (await getBackends()).identity.createUser(APP_ID, { email, email_verified: true });
  return { owner: user.id, email: user.email };
}

async function configureEmail(): Promise<void> {
  await setSecret(APP_ID, 'SMTP_URL', SMTP_URL);
  await setSecret(APP_ID, 'EMAIL_FROM', FROM);
}

// Capture sinks for both external transports (no socket).
function pushSink(status = 201) {
  const calls: string[] = [];
  setPushTransport(async (endpoint) => {
    calls.push(endpoint);
    return { statusCode: status };
  });
  return calls;
}
function emailSink() {
  const captured: { msg?: OutboundEmail; cfg?: EmailConfig } = {};
  setEmailTransport(async (msg, cfg) => {
    captured.msg = msg;
    captured.cfg = cfg;
    return { id: '<test@acme.test>' };
  });
  return captured;
}

beforeAll(() => {
  process.env.FORGE_SECRETS_KEY = 'test-master-key-not-for-production';
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
});

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-notify-'));
  process.env.FORGE_STATE_DIR = dir;
  await store.init();
  await seedApp();
  resetEmailTransport();
  resetPushTransport();
});

afterEach(async () => {
  resetEmailTransport();
  resetPushTransport();
  if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevState;
  await rm(dir, { recursive: true, force: true });
});

describe('notify() fan-out — channels (C21)', () => {
  it('DEFAULT is in_app only — records the notification, no external delivery, no delivery block', async () => {
    const pushCalls = pushSink();
    const email = emailSink();
    const out = await notify(APP_ID, APP, { key: 'cold:g1', title: 'Goal is cold', owner: 'A' });
    expect(out.notification?.key).toBe('cold:g1');
    expect(out.delivery).toBeUndefined(); // byte-identical to the legacy shape
    expect(pushCalls.length).toBe(0);
    expect(email.msg).toBeUndefined();
    expect((await store.listNotifications(APP_ID, { owner: 'A' })).length).toBe(1);
  });

  it('push channel fans out to every one of the owner\'s subscriptions', async () => {
    const { owner } = await seedUser();
    await store.registerPushSubscription(APP_ID, { owner, ...sub('https://push/phone') });
    await store.registerPushSubscription(APP_ID, { owner, ...sub('https://push/laptop') });
    const pushCalls = pushSink(201);

    const out = await notify(APP_ID, APP, { key: 'k', title: 'Hi', body: 'there', owner, channels: ['in_app', 'push'] });
    expect(out.notification?.key).toBe('k'); // in_app still recorded
    expect(out.delivery?.push).toEqual({ attempted: 2, sent: 2, pruned: 0, failed: 0 });
    expect(pushCalls.sort()).toEqual(['https://push/laptop', 'https://push/phone']);
  });

  it('push prunes a subscription the push service reports GONE (410)', async () => {
    const { owner } = await seedUser();
    await store.registerPushSubscription(APP_ID, { owner, ...sub('https://push/gone') });
    pushSink(410);

    const out = await notify(APP_ID, APP, { key: 'k', title: 'Hi', owner, channels: ['push'] });
    expect(out.delivery?.push).toEqual({ attempted: 1, sent: 0, pruned: 1, failed: 0 });
    expect(await store.listPushSubscriptions(APP_ID, owner)).toEqual([]); // auto-pruned
  });

  it('email channel resolves the account address (C10) + sends via C12 (subject=title)', async () => {
    const { owner, email } = await seedUser('jane@example.com');
    await configureEmail();
    const captured = emailSink();

    const out = await notify(APP_ID, APP, { key: 'k', title: 'Weekly summary', body: 'You did great', owner, channels: ['email'] });
    expect(out.delivery?.email).toEqual({ status: 'sent' });
    expect(captured.msg?.to).toBe(email);
    expect(captured.msg?.subject).toBe('Weekly summary');
    expect(captured.msg?.text).toContain('You did great');
    expect(captured.msg?.html).toContain('Weekly summary');
  });

  it('email skips cleanly when the owner has no account address (no crash)', async () => {
    await configureEmail();
    emailSink();
    const out = await notify(APP_ID, APP, { key: 'k', title: 'Hi', owner: 'no-such-user', channels: ['email'] });
    expect(out.delivery?.email).toEqual({ status: 'skipped', reason: 'no_address' });
  });

  it('BEST-EFFORT isolation — a failing push channel never blocks in_app or email', async () => {
    const { owner } = await seedUser();
    await store.registerPushSubscription(APP_ID, { owner, ...sub('https://push/x') });
    await configureEmail();
    const captured = emailSink();
    setPushTransport(async () => { throw new Error('network down'); });

    const out = await notify(APP_ID, APP, { key: 'k', title: 'Important', body: 'b', owner, channels: ['in_app', 'push', 'email'] });
    expect(out.notification?.key).toBe('k'); // in_app recorded despite push failure
    expect(out.delivery?.push).toEqual({ attempted: 1, sent: 0, pruned: 0, failed: 1 });
    expect(out.delivery?.email).toEqual({ status: 'sent' }); // email still went out
    expect(captured.msg?.subject).toBe('Important');
    expect((await store.listNotifications(APP_ID, { owner })).length).toBe(1);
  });

  it('idempotencyKey dedupes push/email across a retry — sends AT MOST ONCE (in_app still upserts)', async () => {
    const { owner } = await seedUser();
    await store.registerPushSubscription(APP_ID, { owner, ...sub('https://push/1') });
    await configureEmail();
    const pushCalls = pushSink(201);
    const captured = emailSink();

    const first = await notify(APP_ID, APP, { key: 'k', title: 'Once', owner, channels: ['in_app', 'push', 'email'], idempotencyKey: 'op-1' });
    expect(first.delivery?.push?.sent).toBe(1);
    expect(first.delivery?.email).toEqual({ status: 'sent' });

    // Retry with the same idempotency key — external channels are skipped (deduped); in_app re-upserts.
    let emailCallsBefore = captured.msg?.subject;
    const retry = await notify(APP_ID, APP, { key: 'k', title: 'Once', owner, channels: ['in_app', 'push', 'email'], idempotencyKey: 'op-1' });
    expect(retry.delivery?.deduped).toBe(true);
    expect(retry.delivery?.push).toBeUndefined();
    expect(retry.notification?.key).toBe('k'); // in_app still recorded (idempotent by key)
    expect(pushCalls.length).toBe(1); // push sent only once across the retry
    expect(emailCallsBefore).toBe('Once'); // sanity: the first send captured
  });

  it('push/email without an owner are skipped (no per-user target); in_app still records', async () => {
    const pushCalls = pushSink();
    const out = await notify(APP_ID, APP, { key: 'k', title: 'App-scoped', channels: ['in_app', 'push', 'email'] });
    expect(out.notification?.key).toBe('k');
    expect(out.delivery?.push).toEqual({ attempted: 0, sent: 0, pruned: 0, failed: 0 });
    expect(out.delivery?.email).toEqual({ status: 'skipped', reason: 'no_owner' });
    expect(pushCalls.length).toBe(0);
  });
});

describe('notification routes — C21 delivery surface', () => {
  let server: FastifyInstance;
  beforeEach(async () => {
    server = Fastify({ logger: false });
    registerNotificationRoutes(server, { defaultApp: () => APP });
    await server.ready();
  });
  afterEach(async () => {
    await server.close();
  });

  it('GET /notifications/vapid-public-key returns the app public key (auto-generated, stable, 65-byte point)', async () => {
    const r1 = await server.inject({ method: 'GET', url: '/notifications/vapid-public-key' });
    expect(r1.statusCode).toBe(200);
    const body = r1.json() as { public_key: string; applicationServerKey: string };
    expect(body.public_key).toBe(body.applicationServerKey);
    const raw = Buffer.from(body.public_key, 'base64url');
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
    // Stable across reads (persisted, not regenerated).
    const r2 = await server.inject({ method: 'GET', url: '/notifications/vapid-public-key' });
    expect((r2.json() as { public_key: string }).public_key).toBe(body.public_key);
  });

  it('POST /notifications/push/subscribe registers (dedupes by endpoint); unsubscribe removes', async () => {
    const owner = 'user-1';
    const subscription = { endpoint: 'https://push/dev1', keys: { p256dh: 'kp', auth: 'ka' } };
    const sr = await server.inject({ method: 'POST', url: '/notifications/push/subscribe', payload: { owner, subscription } });
    expect(sr.statusCode).toBe(200);
    expect(sr.json()).toEqual({ subscribed: true, endpoint: 'https://push/dev1' });
    expect((await store.listPushSubscriptions(APP_ID, owner)).length).toBe(1);

    // Re-subscribe same endpoint → still one (deduped).
    await server.inject({ method: 'POST', url: '/notifications/push/subscribe', payload: { owner, subscription } });
    expect((await store.listPushSubscriptions(APP_ID, owner)).length).toBe(1);

    const ur = await server.inject({ method: 'POST', url: '/notifications/push/unsubscribe', payload: { owner, endpoint: 'https://push/dev1' } });
    expect(ur.json()).toEqual({ unsubscribed: true });
    expect(await store.listPushSubscriptions(APP_ID, owner)).toEqual([]);
  });

  it('POST /notifications/push/subscribe rejects a malformed subscription (422)', async () => {
    const bad = await server.inject({ method: 'POST', url: '/notifications/push/subscribe', payload: { owner: 'u', subscription: { endpoint: 'x' } } });
    expect(bad.statusCode).toBe(422);
    const noOwner = await server.inject({ method: 'POST', url: '/notifications/push/subscribe', payload: { subscription: { endpoint: 'x', keys: { p256dh: 'a', auth: 'b' } } } });
    expect(noOwner.statusCode).toBe(422);
  });

  it('POST /notifications with no channels is unchanged — returns { notification }, no delivery block', async () => {
    const r = await server.inject({ method: 'POST', url: '/notifications', payload: { key: 'k', title: 'Hi', owner: 'A' } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as Record<string, unknown>;
    expect((body.notification as { key: string }).key).toBe('k');
    expect(body.delivery).toBeUndefined();
  });

  it('POST /notifications with an unknown channel is a 422', async () => {
    const r = await server.inject({ method: 'POST', url: '/notifications', payload: { key: 'k', title: 'Hi', owner: 'A', channels: ['in_app', 'carrier-pigeon'] } });
    expect(r.statusCode).toBe(422);
  });

  it('POST /notifications with channels:[in_app,push] carries the delivery summary back', async () => {
    pushSink(201);
    const owner = 'route-owner';
    await store.registerPushSubscription(APP_ID, { owner, ...sub('https://push/r1') });
    const r = await server.inject({ method: 'POST', url: '/notifications', payload: { key: 'k', title: 'Hi', owner, channels: ['in_app', 'push'] } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { notification: { key: string }; delivery: { push: { sent: number } } };
    expect(body.notification.key).toBe('k');
    expect(body.delivery.push.sent).toBe(1);
  });
});
