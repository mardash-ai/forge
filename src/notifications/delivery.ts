import { store } from '../storage/store';
import { getBackends } from '../storage/backends';
import { executeCapability } from '../core/runtime';
import { SYSTEM_ACTOR } from '../shared/domain';
import { sendWebPush } from '../plugins/webpush-vapid/index';
import { escapeHtml } from '../plugins/email-smtp/index';
import { vapidConfig } from './vapid';
import type { Notification } from './types';

// C21 — the notification DELIVERY fan-out (grows C4). `notify()` records the in-app notification exactly
// as before AND, when the CALLER asks for them, fans the same notification out to browser push (Web Push /
// VAPID) and email. The caller decides the channels; the platform just executes delivery. Key guarantees:
//   - Backward compatible: `channels` defaults to ['in_app'], so every existing caller is unchanged and
//     the pure-in_app response is byte-identical to the legacy one.
//   - Best-effort per channel: a failing push/email NEVER blocks in_app (which still records) or the other
//     external channel. No delivery error propagates to the caller.
//   - Idempotent across channels: an optional `idempotencyKey` is claimed ONCE (atomic first-writer) so a
//     retried notify() does not double-send push/email. in_app is already idempotent by `key`.
//   - Owner-scoped: push (per-device subscriptions) + email (the account address) are per-owner; without
//     an owner there is no external target, so those channels are skipped (in_app still records).

export type Channel = 'in_app' | 'push' | 'email';
export const CHANNELS: readonly Channel[] = ['in_app', 'push', 'email'];

export interface NotifyInput {
  key: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  subject?: string;
  // Owner (C11) — the opaque per-user id (C10 session userId). Required for push/email delivery.
  owner?: string;
  // The subset of channels to deliver to; defaults to ['in_app'].
  channels?: Channel[];
  // Optional retry-safety handle: a repeated notify() with the same key sends push/email AT MOST ONCE.
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
export interface DeliveryOutcome {
  notification?: Notification;
  delivery?: { push?: PushOutcome; email?: EmailOutcome; deduped?: boolean };
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
async function deliverPush(appId: string, owner: string, input: NotifyInput): Promise<PushOutcome> {
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

// notify() — record + fan out. `appName` is passed through so the email channel can resolve the app for
// C12 (which also defaults to FORGE_APP_NAME). Returns the in_app notification (when requested) plus a
// per-channel delivery summary (when any external channel was requested).
export async function notify(appId: string, appName: string | undefined, input: NotifyInput): Promise<DeliveryOutcome> {
  const channels = normalizeChannels(input.channels);
  const wantInApp = channels.includes('in_app');
  const wantPush = channels.includes('push');
  const wantEmail = channels.includes('email');
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
  if (!wantPush && !wantEmail) return out;

  out.delivery = {};

  // push/email are per-owner. No owner → no external target (in_app already recorded).
  if (!input.owner) {
    if (wantPush) out.delivery.push = { attempted: 0, sent: 0, pruned: 0, failed: 0 };
    if (wantEmail) out.delivery.email = { status: 'skipped', reason: 'no_owner' };
    return out;
  }

  // Idempotency: claim ONCE across both external channels. A retry with the same key skips push + email.
  if (input.idempotencyKey) {
    const claimed = await store.claimDelivery(appId, input.owner, input.idempotencyKey);
    if (!claimed) {
      out.delivery.deduped = true;
      return out;
    }
  }

  if (wantPush) out.delivery.push = await deliverPush(appId, input.owner, input);
  if (wantEmail) out.delivery.email = await deliverEmail(appId, appName, input.owner, input);
  return out;
}
