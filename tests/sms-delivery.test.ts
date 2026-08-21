import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { store } from '../src/storage/store';
import { getBackends } from '../src/storage/backends';
import { setSecret } from '../src/plugins/secrets-local/index';
import {
  setSmsTransport,
  resetSmsTransport,
  appendOptOut,
  twiml,
  twimlEmpty,
  HELP_REPLY,
  type SmsResult,
} from '../src/plugins/twilio-sms/index';
import { notify, normalizeChannels, CHANNELS } from '../src/notifications/delivery';
import { registerSmsRoutes } from '../src/api/sms-routes';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';

// C21 SMS channel + transport — unit tests. Covers:
//   1. Channel registry: SMS is in CHANNELS; normalizeChannels recognises it.
//   2. Plugin: appendOptOut idempotency, twiml escaping, HELP_REPLY exact string.
//   3. sendSms flag gate: inert when SMS_DELIVERY_ENABLED != "true".
//   4. notify() SMS fan-out: skips unverified/opted-out users; calls transport for eligible users.
//   5. Phone verification routes: send-code mints OTP; verify-code stamps phone_verified_at + sms_consent_at.
//   6. Inbound webhook: STOP opts out; START re-enables only with prior consent; HELP returns exact string;
//      unknown number does NOT create opt-in.

const APP = 'sms-test';
const APP_ID = 'app_sms_test';

let dir: string;
const prevKey = process.env.FORGE_SECRETS_KEY;
const prevSmsEnabled = process.env.SMS_DELIVERY_ENABLED;
const prevStateDir = process.env.FORGE_STATE_DIR;

beforeAll(() => {
  process.env.FORGE_SECRETS_KEY = 'test-master-key-not-for-production';
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
  if (prevSmsEnabled === undefined) delete process.env.SMS_DELIVERY_ENABLED;
  else process.env.SMS_DELIVERY_ENABLED = prevSmsEnabled;
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'forge-sms-'));
  process.env.FORGE_STATE_DIR = dir;
  await store.init();
  const now = nowIso();
  const app: Application = {
    id: APP_ID,
    type: 'Application',
    app_id: APP_ID,
    created_at: now,
    updated_at: now,
    name: APP,
    repo_path: '/app',
    platform: 'web',
    framework: 'nextjs',
    template: 'nextjs-web',
    language: 'typescript',
    package_manager: 'npm',
  };
  await store.saveResource(app);
  resetSmsTransport();
  delete process.env.SMS_DELIVERY_ENABLED;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
});

afterEach(async () => {
  resetSmsTransport();
  if (prevStateDir === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevStateDir;
  await rm(dir, { recursive: true, force: true });
});

// ── 1. Channel registry ────────────────────────────────────────────────────────────────────────

describe('Channel registry', () => {
  it('CHANNELS includes sms', () => {
    expect(CHANNELS).toContain('sms');
  });

  it('normalizeChannels accepts sms alongside existing channels', () => {
    expect(normalizeChannels(['in_app', 'sms'])).toEqual(['in_app', 'sms']);
    expect(normalizeChannels(['sms'])).toEqual(['sms']);
    expect(normalizeChannels(['in_app', 'push', 'email', 'sms'])).toEqual([
      'in_app',
      'push',
      'email',
      'sms',
    ]);
  });

  it('normalizeChannels still defaults to [in_app] when empty', () => {
    expect(normalizeChannels([])).toEqual(['in_app']);
    expect(normalizeChannels()).toEqual(['in_app']);
  });

  it('normalizeChannels drops unknown channels (backward-compatible)', () => {
    expect(normalizeChannels(['in_app', 'carrier-pigeon'])).toEqual(['in_app']);
  });
});

// ── 2. Plugin helpers ──────────────────────────────────────────────────────────────────────────

describe('twilio-sms plugin helpers', () => {
  it('appendOptOut appends the suffix exactly once', () => {
    const body = 'Hello there';
    const out = appendOptOut(body);
    expect(out).toBe('Hello there\nReply STOP to opt out');
    // Idempotent — calling again does not double-append.
    expect(appendOptOut(out)).toBe(out);
  });

  it('twiml wraps text and escapes HTML entities', () => {
    const xml = twiml('Hello & <World>');
    expect(xml).toContain('<Message>Hello &amp; &lt;World&gt;</Message>');
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<Response>');
  });

  it('twimlEmpty produces a self-closing Response tag', () => {
    expect(twimlEmpty()).toContain('<Response/>');
  });

  it('HELP_REPLY matches the carrier-registered exact string', () => {
    expect(HELP_REPLY).toBe(
      "Dorinda: You're receiving the notifications you set up at dorinda.ai. For help visit https://dorinda.ai/sms or email legal@dorinda.ai. Reply STOP to cancel at any time. Msg & data rates may apply.",
    );
  });
});

// ── 3. sendSms flag gate ───────────────────────────────────────────────────────────────────────

describe('sendSms feature flag', () => {
  it('is INERT when SMS_DELIVERY_ENABLED is absent — transport never called', async () => {
    const { sendSms } = await import('../src/plugins/twilio-sms/index');
    let called = false;
    setSmsTransport(async () => {
      called = true;
      return { ok: true };
    });
    delete process.env.SMS_DELIVERY_ENABLED;
    const result = await sendSms('+15551234567', 'test', {
      accountSid: 'AC123',
      authToken: 'tok',
      fromNumber: '+15550000001',
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.status).toBe('inert');
  });

  it('calls the transport when SMS_DELIVERY_ENABLED=true', async () => {
    const { sendSms } = await import('../src/plugins/twilio-sms/index');
    process.env.SMS_DELIVERY_ENABLED = 'true';
    const captured: { to: string; body: string }[] = [];
    setSmsTransport(async (to, _from, body) => {
      captured.push({ to, body });
      return { ok: true, sid: 'SM123', status: 'queued' };
    });
    const result = await sendSms('+15551234567', 'Hello', {
      accountSid: 'AC123',
      authToken: 'tok',
      fromNumber: '+15550000001',
    });
    expect(result.ok).toBe(true);
    expect(captured.length).toBe(1);
    // Opt-out suffix must be appended automatically.
    expect(captured[0]!.body).toContain('Reply STOP to opt out');
  });
});

// ── 4. notify() SMS fan-out ────────────────────────────────────────────────────────────────────

describe('notify() SMS fan-out', () => {
  async function seedUser(phone?: string, verified = false, optedOut = false) {
    const { identity } = await getBackends();
    const user = await identity.createUser(APP_ID, {
      email: `sms-test-${Math.random()}@example.com`,
      email_verified: true,
    });
    if (phone) {
      await identity.updateUser(APP_ID, user.id, {
        phone,
        ...(verified ? { phone_verified_at: nowIso(), sms_consent_at: nowIso() } : {}),
        ...(optedOut ? { sms_opt_out: true } : {}),
      });
    }
    return user;
  }

  it('skips SMS when user has no phone on file', async () => {
    const user = await seedUser();
    const out = await notify(APP_ID, APP, {
      key: 'k',
      title: 'Hi',
      owner: user.id,
      channels: ['sms'],
    });
    expect(out.delivery?.sms).toEqual({ status: 'skipped', reason: 'no_phone' });
  });

  it('skips SMS when phone is set but not verified', async () => {
    const user = await seedUser('+15551234567', false);
    const out = await notify(APP_ID, APP, {
      key: 'k',
      title: 'Hi',
      owner: user.id,
      channels: ['sms'],
    });
    expect(out.delivery?.sms).toEqual({ status: 'skipped', reason: 'not_verified' });
  });

  it('skips SMS when user has opted out (STOP received)', async () => {
    const { identity } = await getBackends();
    const user = await seedUser('+15551234567', true, true);
    void identity; // avoid unused warning
    const out = await notify(APP_ID, APP, {
      key: 'k',
      title: 'Hi',
      owner: user.id,
      channels: ['sms'],
    });
    expect(out.delivery?.sms).toEqual({ status: 'skipped', reason: 'opted_out' });
  });

  it('skips SMS when Twilio credentials are not configured', async () => {
    const user = await seedUser('+15551234567', true);
    // No TWILIO_* env or secrets → not_configured
    const out = await notify(APP_ID, APP, {
      key: 'k',
      title: 'Hi',
      owner: user.id,
      channels: ['sms'],
    });
    expect(out.delivery?.sms).toEqual({ status: 'skipped', reason: 'not_configured' });
  });

  it('delivers SMS (inert) when credentials configured but flag off', async () => {
    const user = await seedUser('+15551234567', true);
    // Wire credentials
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_FROM_NUMBER = '+15550000001';
    // SMS_DELIVERY_ENABLED not set → inert
    const out = await notify(APP_ID, APP, {
      key: 'k',
      title: 'Alert',
      body: 'You have a new notification',
      owner: user.id,
      channels: ['sms'],
    });
    expect(out.delivery?.sms).toEqual({ status: 'inert' });
  });

  it('delivers SMS (sent) when credentials + flag are both set', async () => {
    const user = await seedUser('+15551234567', true);
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_FROM_NUMBER = '+15550000001';
    process.env.SMS_DELIVERY_ENABLED = 'true';
    const captured: string[] = [];
    setSmsTransport(async (_to, _from, body) => {
      captured.push(body);
      return { ok: true, sid: 'SM1', status: 'queued' };
    });
    const out = await notify(APP_ID, APP, {
      key: 'k',
      title: 'Alert',
      body: 'You have a new notification',
      owner: user.id,
      channels: ['in_app', 'sms'],
    });
    expect(out.notification?.key).toBe('k'); // in_app still recorded
    expect(out.delivery?.sms).toEqual({ status: 'sent' });
    expect(captured[0]).toContain('Alert');
    expect(captured[0]).toContain('Reply STOP to opt out');
  });

  it('SMS channel skips cleanly when no owner (no_owner reason)', async () => {
    const out = await notify(APP_ID, APP, {
      key: 'k',
      title: 'App',
      channels: ['in_app', 'sms'],
    });
    expect(out.delivery?.sms).toEqual({ status: 'skipped', reason: 'no_owner' });
  });

  it('existing push/email channels still work after registry refactor', async () => {
    // Regression: the channel registry must preserve push + email behaviour unchanged.
    const { identity } = await getBackends();
    const user = await identity.createUser(APP_ID, {
      email: 'registry-check@example.com',
      email_verified: true,
    });
    const out = await notify(APP_ID, APP, {
      key: 'k2',
      title: 'Hi',
      owner: user.id,
      channels: ['in_app', 'push'],
    });
    // push: no subscriptions → attempted=0 but the channel key exists (registry ran)
    expect(out.delivery?.push).toEqual({ attempted: 0, sent: 0, pruned: 0, failed: 0 });
    expect(out.notification?.key).toBe('k2');
  });
});

// ── 5. Phone verification routes ───────────────────────────────────────────────────────────────

describe('phone verification routes', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    server = Fastify({ logger: false });
    registerSmsRoutes(server, { defaultApp: () => APP_ID });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  it('send-code: 422 on invalid phone', async () => {
    const { identity } = await getBackends();
    const user = await identity.createUser(APP_ID, { email: 'v1@example.com', email_verified: true });
    const r = await server.inject({
      method: 'POST',
      url: '/auth/phone/send-code',
      payload: { userId: user.id, phone: 'not-a-phone' },
    });
    expect(r.statusCode).toBe(422);
  });

  it('send-code: 503 when SMS is not configured', async () => {
    const { identity } = await getBackends();
    const user = await identity.createUser(APP_ID, { email: 'v2@example.com', email_verified: true });
    const r = await server.inject({
      method: 'POST',
      url: '/auth/phone/send-code',
      payload: { userId: user.id, phone: '+15551234567' },
    });
    expect(r.statusCode).toBe(503);
  });

  it('send-code then verify-code stamps phone_verified_at and sms_consent_at', async () => {
    const { identity } = await getBackends();
    const user = await identity.createUser(APP_ID, { email: 'v3@example.com', email_verified: true });

    // Wire SMS config + enable delivery so the transport is actually called (allows OTP capture).
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.TWILIO_FROM_NUMBER = '+15550000001';
    process.env.SMS_DELIVERY_ENABLED = 'true';

    // Capture the OTP from the transport (stub — no real HTTP).
    let capturedBody = '';
    setSmsTransport(async (_to, _from, body) => {
      capturedBody = body;
      return { ok: true, sid: 'SM1', status: 'queued' };
    });

    // send-code
    const send = await server.inject({
      method: 'POST',
      url: '/auth/phone/send-code',
      payload: { userId: user.id, phone: '+15551234567', appId: APP_ID },
    });
    expect(send.statusCode).toBe(200);
    expect((send.json() as { sent: boolean }).sent).toBe(true);

    // Extract the 6-digit code from the SMS body
    const match = capturedBody.match(/\b(\d{6})\b/);
    expect(match).toBeTruthy();
    const code = match![1]!;

    // verify-code with wrong code → mismatch
    const wrong = await server.inject({
      method: 'POST',
      url: '/auth/phone/verify-code',
      payload: { userId: user.id, code: code === '000000' ? '111111' : '000000', appId: APP_ID },
    });
    expect(wrong.statusCode).toBe(400);
    expect((wrong.json() as { error: { code: string } }).error.code).toBe('code_mismatch');

    // verify-code with correct code → stamps timestamps
    const verify = await server.inject({
      method: 'POST',
      url: '/auth/phone/verify-code',
      payload: { userId: user.id, code, appId: APP_ID },
    });
    expect(verify.statusCode).toBe(200);
    const body = verify.json() as { verified: boolean; phone_verified_at: string; sms_consent_at: string };
    expect(body.verified).toBe(true);
    expect(typeof body.phone_verified_at).toBe('string');
    expect(typeof body.sms_consent_at).toBe('string');

    // Confirm the user record is updated
    const updated = await identity.getUser(APP_ID, user.id);
    expect(updated?.phone).toBe('+15551234567');
    expect(updated?.phone_verified_at).toBeTruthy();
    expect(updated?.sms_consent_at).toBeTruthy();
    expect(updated?.sms_opt_out).toBeFalsy();
  });

  it('verify-code: 400 on expired/unknown code', async () => {
    const { identity } = await getBackends();
    const user = await identity.createUser(APP_ID, { email: 'v4@example.com', email_verified: true });
    const r = await server.inject({
      method: 'POST',
      url: '/auth/phone/verify-code',
      payload: { userId: user.id, code: '123456', appId: APP_ID },
    });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: { code: string } }).error.code).toBe('code_invalid');
  });
});

// ── 6. Inbound webhook keyword handling ────────────────────────────────────────────────────────

describe('inbound Twilio webhook keyword handling', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    server = Fastify({ logger: false });
    // Register with content-type parsing for form data
    await server.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          const params = new URLSearchParams(body as string);
          const obj: Record<string, string> = {};
          params.forEach((v, k) => {
            obj[k] = v;
          });
          done(null, obj);
        } catch (e) {
          done(e as Error);
        }
      },
    );
    registerSmsRoutes(server, { defaultApp: () => APP_ID });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  async function seedVerifiedUser(phone: string) {
    const { identity } = await getBackends();
    const user = await identity.createUser(APP_ID, {
      email: `wh-${Math.random()}@example.com`,
      email_verified: true,
    });
    await identity.updateUser(APP_ID, user.id, {
      phone,
      phone_verified_at: nowIso(),
      sms_consent_at: nowIso(),
    });
    return user;
  }

  function webhookPayload(from: string, body: string) {
    return {
      method: 'POST' as const,
      url: '/hooks/sms/twilio',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `From=${encodeURIComponent(from)}&Body=${encodeURIComponent(body)}`,
    };
  }

  it('STOP sets sms_opt_out=true and returns empty TwiML (carrier handles the reply)', async () => {
    const user = await seedVerifiedUser('+15551111111');
    const r = await server.inject(webhookPayload('+15551111111', 'STOP'));
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/xml');
    // Empty TwiML — carrier's STOP reply fires, not ours.
    expect(r.payload).toContain('<Response/>');

    const { identity } = await getBackends();
    const updated = await identity.getUser(APP_ID, user.id);
    expect(updated?.sms_opt_out).toBe(true);
    expect(updated?.sms_opt_out_at).toBeTruthy();
  });

  it('STOP from unknown number: empty TwiML, no user record created', async () => {
    const r = await server.inject(webhookPayload('+15559999999', 'STOP'));
    expect(r.statusCode).toBe(200);
    expect(r.payload).toContain('<Response/>');
    // No user created for the unknown number.
    const { identity } = await getBackends();
    const found = await identity.findByPhone(APP_ID, '+15559999999');
    expect(found).toBeNull();
  });

  it('START re-enables a previously opted-out user (with prior consent)', async () => {
    const user = await seedVerifiedUser('+15552222222');
    // Opt them out first
    const { identity } = await getBackends();
    await identity.updateUser(APP_ID, user.id, { sms_opt_out: true, sms_opt_out_at: nowIso() });

    const r = await server.inject(webhookPayload('+15552222222', 'START'));
    expect(r.statusCode).toBe(200);
    expect(r.payload).toContain('<Response/>');

    const updated = await identity.getUser(APP_ID, user.id);
    expect(updated?.sms_opt_out).toBeFalsy();
  });

  it('YES keyword re-enables (same as START)', async () => {
    const user = await seedVerifiedUser('+15553333333');
    const { identity } = await getBackends();
    await identity.updateUser(APP_ID, user.id, { sms_opt_out: true, sms_opt_out_at: nowIso() });

    const r = await server.inject(webhookPayload('+15553333333', 'YES'));
    expect(r.statusCode).toBe(200);

    const updated = await identity.getUser(APP_ID, user.id);
    expect(updated?.sms_opt_out).toBeFalsy();
  });

  it('UNSTOP keyword re-enables (same as START)', async () => {
    const user = await seedVerifiedUser('+15554444444');
    const { identity } = await getBackends();
    await identity.updateUser(APP_ID, user.id, { sms_opt_out: true, sms_opt_out_at: nowIso() });

    const r = await server.inject(webhookPayload('+15554444444', 'UNSTOP'));
    expect(r.statusCode).toBe(200);

    const updated = await identity.getUser(APP_ID, user.id);
    expect(updated?.sms_opt_out).toBeFalsy();
  });

  it('START from a number with NO prior sms_consent_at does NOT create an opt-in', async () => {
    // A user who has a phone but never completed verification (no sms_consent_at).
    const { identity } = await getBackends();
    const user = await identity.createUser(APP_ID, {
      email: 'no-consent@example.com',
      email_verified: true,
    });
    await identity.updateUser(APP_ID, user.id, { phone: '+15555555555' });
    // sms_consent_at is absent; sms_opt_out is absent.

    const r = await server.inject(webhookPayload('+15555555555', 'START'));
    expect(r.statusCode).toBe(200);

    // sms_opt_out must remain absent/false — no opt-in created.
    const updated = await identity.getUser(APP_ID, user.id);
    expect(updated?.sms_consent_at).toBeUndefined();
    expect(updated?.sms_opt_out).toBeFalsy();
  });

  it('START from an unknown number (never in-app): does NOT create an opt-in', async () => {
    const r = await server.inject(webhookPayload('+15556666666', 'START'));
    expect(r.statusCode).toBe(200);

    // No user record for this number.
    const { identity } = await getBackends();
    const found = await identity.findByPhone(APP_ID, '+15556666666');
    expect(found).toBeNull();
  });

  it('HELP returns the exact carrier-registered copy', async () => {
    const r = await server.inject(webhookPayload('+15557777777', 'HELP'));
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/xml');
    expect(r.payload).toContain(
      "Dorinda: You're receiving the notifications you set up at dorinda.ai. For help visit https://dorinda.ai/sms or email legal@dorinda.ai. Reply STOP to cancel at any time. Msg &amp; data rates may apply.",
    );
  });

  it('case-insensitive: stop / Stop / STOP all opt out', async () => {
    for (const kw of ['stop', 'Stop', 'STOP']) {
      const user = await seedVerifiedUser(`+1555888${Math.floor(Math.random() * 1000).toString().padStart(4, '0')}`);
      const phone = user.phone!;
      // Re-read to get the phone we set
      const { identity } = await getBackends();
      const stored = await identity.getUser(APP_ID, user.id);
      const r = await server.inject(webhookPayload(stored?.phone ?? phone, kw));
      expect(r.statusCode).toBe(200);
      const reloaded = await identity.getUser(APP_ID, user.id);
      expect(reloaded?.sms_opt_out).toBe(true);
    }
  });

  it('unknown keyword returns empty TwiML (no action)', async () => {
    const r = await server.inject(webhookPayload('+15558888888', 'Hello there'));
    expect(r.statusCode).toBe(200);
    expect(r.payload).toContain('<Response/>');
  });
});
