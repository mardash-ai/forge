import { store } from '../storage/store';
import { getBackends } from '../storage/backends';
import { executeCapability } from '../core/runtime';
import { SYSTEM_ACTOR } from '../shared/domain';
import { sendWebPush } from '../plugins/webpush-vapid/index';
import { escapeHtml } from '../plugins/email-smtp/index';
import { sendSms, type SmsConfig } from '../plugins/twilio-sms/index';
import { readSecrets } from '../plugins/secrets-local/index';
import { vapidConfig } from './vapid';
import type { Notification } from './types';

// C21 — the notification DELIVERY fan-out (grows C4). `notify()` records the in-app notification exactly
// as before AND, when the CALLER asks for them, fans the same notification out to browser push (Web Push /
// VAPID), email, and SMS (Twilio). The caller decides the channels; the platform just executes delivery.
// Key guarantees:
//   - Backward compatible: `channels` defaults to ['in_app'], so every existing caller is unchanged and
//     the pure-in_app response is byte-identical to the legacy one.
//   - Best-effort per channel: a failing push/email/sms NEVER blocks in_app or the other channels.
//   - Idempotent across channels: an optional `idempotencyKey` is claimed ONCE (atomic first-writer) so a
//     retried notify() does not double-send push/email/sms. in_app is already idempotent by `key`.
//   - Owner-scoped: push/email/sms are per-owner; without an owner there is no external target (in_app
//     still records).
//   - Channel registry: adding a new channel means adding one entry to CHANNEL_REGISTRY; the notify()
//     control flow never changes.

export type Channel = 'in_app' | 'push' | 'email' | 'sms';
export const CHANNELS: readonly Channel[] = ['in_app', 'push', 'email', 'sms'];

export interface NotifyInput {
  key: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  subject?: string;
  // Owner (C11) — the opaque per-user id (C10 session userId). Required for push/email/sms delivery.
  owner?: string;
  // The subset of channels to deliver to; defaults to ['in_app'].
  channels?: Channel[];
  // Optional retry-safety handle: a repeated notify() with the same key sends push/email/sms AT MOST ONCE.
  idempotencyKey?: string;
}

export interface PushOutcome {
  attempted: number;
  sent: number;
  pruned: number; // expired subscriptions (404/410) removed
  failed: number;
}
export interface EmailOutcome {
  status: 'sent' | 'failed' | 'skipped';
  reason?: string;
}
export interface SmsOutcome {
  status: 'sent' | 'failed' | 'skipped' | 'inert';
  reason?: string;
}
export interface DeliveryOutcome {
  notification?: Notification;
  delivery?: { push?: PushOutcome; email?: EmailOutcome; sms?: SmsOutcome; deduped?: boolean };
}

// Normalize + validate the requested channels: dedupe, keep only known channels, default to ['in_app']
// when absent/empty. An unknown channel is a caller error (surfaced by the route's schema); here we simply
// drop anything unrecognized so the service stays robust when called directly.
export function normalizeChannels(channels?: string[]): Channel[] {
  if (!channels || channels.length === 0) return ['in_app'];
  const known = channels.filter((c): c is Channel => (CHANNELS as readonly string[]).includes(c));
  const deduped = [...new Set(known)];
  return deduped.length > 0 ? deduped : ['in_app'];
}

// The JSON payload delivered to the browser (the service worker reads it to render the notification +
// deep-link). Compact + only what the client needs.
function pushPayload(input: NotifyInput): string {
  return JSON.stringify({
    key: input.key,
    title: input.title,
    ...(input.body ? { body: input.body } : {}),
    ...(input.data ? { data: input.data } : {}),
  });
}

// A best-effort deep link for the email button: `data.url` when the caller provided one.
function deepLink(data?: Record<string, unknown>): string | undefined {
  const url = data?.url;
  return typeof url === 'string' && url.length > 0 ? url : undefined;
}

// A simple branded HTML body for the email channel (mirrors the C12 template look — no C16 theme
// coupling, which is app-CSS, not email). Escapes all interpolated values (no injection).
function renderNotificationHtml(title: string, body?: string, url?: string): string {
  const t = escapeHtml(title);
  const b = body ? `<p style="margin:0 0 8px;color:#374151;">${escapeHtml(body)}</p>` : '';
  const button = url
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#111827;` +
      `color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">View</a></p>`
    : '';
  return (
    `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;` +
    `font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
    `<table role="presentation" width="480" cellpadding="0" cellspacing="0" ` +
    `style="background:#ffffff;border-radius:12px;padding:32px;">` +
    `<tr><td style="font-size:15px;line-height:1.5;">` +
    `<p style="margin:0 0 12px;font-size:18px;font-weight:700;">${t}</p>${b}${button}` +
    `</td></tr></table></td></tr></table></body></html>`
  );
}

// Push fan-out — best-effort, never throws. Sends the payload to every one of the owner's subscriptions,
// prunes any the push service reports GONE (404/410), and tallies the outcome.
async function deliverPush(
  appId: string,
  _appName: string | undefined,
  owner: string,
  input: NotifyInput,
): Promise<PushOutcome> {
  const outcome: PushOutcome = { attempted: 0, sent: 0, pruned: 0, failed: 0 };
  try {
    const subs = await store.listPushSubscriptions(appId, owner);
    if (subs.length === 0) return outcome;
    const cfg = await vapidConfig(appId);
    const payload = pushPayload(input);
    for (const sub of subs) {
      outcome.attempted++;
      const res = await sendWebPush({ endpoint: sub.endpoint, keys: sub.keys }, payload, cfg);
      if (res.ok) {
        outcome.sent++;
      } else if (res.expired) {
        outcome.pruned++;
        await store.prunePushSubscription(appId, sub.endpoint).catch(() => undefined);
      } else {
        outcome.failed++;
      }
    }
  } catch {
    // A config/lookup failure must not block in_app or email — swallow (the tally reflects what ran).
  }
  return outcome;
}

// Email fan-out — best-effort, never throws. Resolves the owner's ACCOUNT email (C10 identity) and sends
// via C12 SendEmail (subject = title, body = a simple branded template). A missing address is a clean skip.
async function deliverEmail(
  appId: string,
  appName: string | undefined,
  owner: string,
  input: NotifyInput,
): Promise<EmailOutcome> {
  try {
    const { identity } = await getBackends();
    const user = await identity.getUser(appId, owner);
    const to = user?.email;
    if (!to) return { status: 'skipped', reason: 'no_address' };
    const html = renderNotificationHtml(input.title, input.body, deepLink(input.data));
    const text = input.body ? `${input.title}\n\n${input.body}` : input.title;
    await executeCapability(
      'send-email',
      { ...(appName ? { app: appName } : {}), to, subject: input.title, text, html },
      SYSTEM_ACTOR,
    );
    return { status: 'sent' };
  } catch (e) {
    return { status: 'failed', reason: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

// Resolve the Twilio SMS config for an app from the C5 vault (same resolution order as auth-identity /
// email-smtp). Returns null when any required secret is absent → caller skips delivery cleanly.
async function resolveSmsConfig(appId: string): Promise<SmsConfig | null> {
  try {
    const secrets = await readSecrets(appId);
    const accountSid = secrets.TWILIO_ACCOUNT_SID?.trim() || process.env.TWILIO_ACCOUNT_SID?.trim() || '';
    const authToken = secrets.TWILIO_AUTH_TOKEN?.trim() || process.env.TWILIO_AUTH_TOKEN?.trim() || '';
    const fromNumber = secrets.TWILIO_FROM_NUMBER?.trim() || process.env.TWILIO_FROM_NUMBER?.trim() || '';
    if (!accountSid || !authToken || !fromNumber) return null;
    return { accountSid, authToken, fromNumber };
  } catch {
    return null;
  }
}

// SMS fan-out — best-effort, never throws. Guards: phone must be verified + opted in; config must exist.
// The transport is inert when SMS_DELIVERY_ENABLED is not "true" (returns status='inert').
async function deliverSms(
  appId: string,
  _appName: string | undefined,
  owner: string,
  input: NotifyInput,
): Promise<SmsOutcome> {
  try {
    const { identity } = await getBackends();
    const user = await identity.getUser(appId, owner);
    if (!user?.phone) return { status: 'skipped', reason: 'no_phone' };
    if (!user.phone_verified_at) return { status: 'skipped', reason: 'not_verified' };
    if (user.sms_opt_out) return { status: 'skipped', reason: 'opted_out' };
    const cfg = await resolveSmsConfig(appId);
    if (!cfg) return { status: 'skipped', reason: 'not_configured' };
    const body = input.body ? `${input.title}: ${input.body}` : input.title;
    const result = await sendSms(user.phone, body, cfg);
    if (!result.ok) return { status: 'failed', reason: result.error?.slice(0, 200) };
    // 'inert' means the flag is off — surface as a distinct status so callers can log it without alarming.
    if (result.status === 'inert') return { status: 'inert' };
    return { status: 'sent' };
  } catch (e) {
    return { status: 'failed', reason: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

// --- Channel registry -------------------------------------------------------------------------
// Each external channel maps to: a deliver function (appId, appName, owner, input) → Outcome, and
// a noOwnerOutcome() to return when the caller requested the channel but didn't provide an owner.
// Adding a new channel: add one entry here. The notify() control flow never changes.

type AnyOutcome = PushOutcome | EmailOutcome | SmsOutcome;
type Deliverer = (
  appId: string,
  appName: string | undefined,
  owner: string,
  input: NotifyInput,
) => Promise<AnyOutcome>;

interface ChannelEntry {
  deliver: Deliverer;
  noOwnerOutcome(): AnyOutcome;
}

type ExternalChannel = Exclude<Channel, 'in_app'>;

const CHANNEL_REGISTRY: Record<ExternalChannel, ChannelEntry> = {
  push: {
    deliver: deliverPush,
    noOwnerOutcome: (): PushOutcome => ({ attempted: 0, sent: 0, pruned: 0, failed: 0 }),
  },
  email: {
    deliver: deliverEmail,
    noOwnerOutcome: (): EmailOutcome => ({ status: 'skipped', reason: 'no_owner' }),
  },
  sms: {
    deliver: deliverSms,
    noOwnerOutcome: (): SmsOutcome => ({ status: 'skipped', reason: 'no_owner' }),
  },
};

// notify() — record + fan out. `appName` is passed through so the email channel can resolve the app for
// C12 (which also defaults to FORGE_APP_NAME). Returns the in_app notification (when requested) plus a
// per-channel delivery summary (when any external channel was requested).
export async function notify(
  appId: string,
  appName: string | undefined,
  input: NotifyInput,
): Promise<DeliveryOutcome> {
  const channels = normalizeChannels(input.channels);
  const wantInApp = channels.includes('in_app');
  const externalChannels = channels.filter((c): c is ExternalChannel => c !== 'in_app');
  const out: DeliveryOutcome = {};

  // in_app — the durable store (idempotent by key). This is the primary path; its errors are real.
  if (wantInApp) {
    out.notification = await store.upsertNotification(appId, {
      key: input.key,
      title: input.title,
      body: input.body,
      data: input.data,
      subject: input.subject,
      owner: input.owner,
    });
  }

  // Pure in_app — return the legacy-identical shape (no `delivery` block).
  if (externalChannels.length === 0) return out;

  out.delivery = {};

  // External channels are per-owner. No owner → no external target (in_app already recorded).
  if (!input.owner) {
    for (const ch of externalChannels) {
      (out.delivery as Record<string, AnyOutcome>)[ch] = CHANNEL_REGISTRY[ch].noOwnerOutcome();
    }
    return out;
  }

  // Idempotency: claim ONCE across all external channels. A retry with the same key skips all sends.
  if (input.idempotencyKey) {
    const claimed = await store.claimDelivery(appId, input.owner, input.idempotencyKey);
    if (!claimed) {
      out.delivery.deduped = true;
      return out;
    }
  }

  // Fan out to each requested external channel via the registry — best-effort, never throws.
  for (const ch of externalChannels) {
    (out.delivery as Record<string, AnyOutcome>)[ch] = await CHANNEL_REGISTRY[ch].deliver(
      appId,
      appName,
      input.owner,
      input,
    );
  }
  return out;
}
