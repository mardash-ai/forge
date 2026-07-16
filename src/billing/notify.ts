import { notify, type NotifyInput } from '../notifications/delivery';
import type { SubscriptionRecord, SubscriptionStatus } from './types';

// C33 + C21 — billing state-change NOTIFICATIONS. A subscription's status transition (→ past_due, →
// canceled, recovered → active) is only observable INSIDE the platform's Stripe webhook reconciliation
// (the consumer proxies /hooks/* RAW and never parses the event), so the notification MUST originate here.
// This module is the pure transition → notification mapping (`billingTransitionNotification`) plus a
// best-effort fan-out (`notifyBillingTransition`) that hands the notification to the platform notify()
// delivery layer. Payment-failure / cancellation is a MUST-DELIVER, critical transactional alert — the
// default channels are ['in_app','email','push'] (email is the reliable channel; in_app always records;
// push is a no-op when the owner has no browser subscription). NO consumer adoption is needed: the in_app
// notification surfaces via the existing GET /notifications feed the app already renders, and the email
// sends via C12 to the C10 account email — so a status change reaches the user with zero app/web change.

// The path (on the app's public origin) a billing notification deep-links to. Pinned by the C33 contract.
const BILLING_PATH = '/billing';

// Resolve the deep-link target from the app public URL the platform already holds (FORGE_AUTH_PUBLIC_URL —
// the app's public origin, e.g. https://app.example.com; the same base C10 verify/reset emails link off).
// When it is unset (e.g. local dev) we fall back to the bare path: in_app still deep-links correctly (the
// app resolves it against its own origin); an email button just points at the path — degraded, never a crash.
export function billingDeepLink(publicBase: string | undefined = process.env.FORGE_AUTH_PUBLIC_URL): string {
  const base = (publicBase ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}${BILLING_PATH}` : BILLING_PATH;
}

// The default delivery channels for a billing alert. A failed-payment / cancellation notice is a critical
// transactional alert that should NOT be silently suppressible (same spirit as security emails), so email
// is included by default rather than gated on a per-category preference. in_app always records; push is
// delivered only when the owner has a registered browser subscription (otherwise a clean no-op). Fine-grained
// per-user channel control for this is a future refinement — flagged, not built here.
export const BILLING_NOTIFY_CHANNELS = ['in_app', 'email', 'push'] as const;

// A monotonic-ish marker that changes per BILLING PERIOD, so a re-failure in a later period is a NEW
// transition (fires again) while a redelivery within the same period is deduped. current_period_end is the
// natural period boundary; updated_at is the fallback when Stripe reported no period end.
function periodMarker(record: SubscriptionRecord): string {
  return record.current_period_end ?? record.updated_at;
}

// The stripe subscription id disambiguates the idempotency key across subscriptions; fall back to the
// subscriber when (defensively) absent.
function subscriptionRef(record: SubscriptionRecord): string {
  return record.provider_refs.stripe_subscription_id ?? record.subscriber;
}

// The PURE transition → notification mapping. Returns the notify() input for a NOTIFIABLE state change,
// or null when the transition is not one users should be alerted about. Only fires on an ACTUAL state
// change (previousStatus !== the new status) for the payment-health transitions:
//   • → past_due   (payment failed / in grace): "your payment didn't go through", deep-link /billing
//   • → canceled                               : "your subscription was canceled", deep-link /billing
//   • past_due → active (recovery)             : "you're all set — your payment went through"
// A normal activation (none/trialing → active), a trial start, an unchanged status, etc. return null.
// Wording is app-NEUTRAL (the platform serves any app and does not know a consumer's brand); the consumer
// brands via its own surfaces. `data.status` carries the new status so the app can style the inbox card.
export function billingTransitionNotification(
  previousStatus: SubscriptionStatus,
  record: SubscriptionRecord,
  publicBase?: string,
): NotifyInput | null {
  const to = record.status;
  if (to === previousStatus) return null; // not a state change — never notify (idempotent by construction)

  const owner = record.subscriber;
  if (!owner) return null; // no subscriber to notify

  const url = billingDeepLink(publicBase);
  const ref = subscriptionRef(record);
  const marker = periodMarker(record);
  const channels = [...BILLING_NOTIFY_CHANNELS];
  // The app never sees Stripe ids (zero-bleed), so we don't stamp one as the notification `subject`; the
  // inbox card renders from title/body/data. `data.status` lets the app style the card by the new status.
  const common = {
    owner,
    channels,
    data: { url, status: to },
  } as const;

  if (to === 'past_due') {
    return {
      ...common,
      key: 'billing.subscription.past_due',
      title: "Your payment didn't go through",
      body: 'Update your payment method to keep your subscription active.',
      idempotencyKey: `billing:${ref}:past_due:${marker}`,
    };
  }

  if (to === 'canceled') {
    return {
      ...common,
      key: 'billing.subscription.canceled',
      title: 'Your subscription was canceled',
      body: 'Reactivate any time to restore your plan.',
      idempotencyKey: `billing:${ref}:canceled:${marker}`,
    };
  }

  // Recovery — only a past_due → active bounce-back (not a fresh activation from none/trialing/incomplete).
  if (to === 'active' && previousStatus === 'past_due') {
    return {
      ...common,
      key: 'billing.subscription.active',
      title: "You're all set — your payment went through",
      body: 'Your subscription is active again. Thanks!',
      idempotencyKey: `billing:${ref}:recovered:${marker}`,
    };
  }

  return null;
}

// Best-effort fan-out: build the notification for the transition and hand it to notify(). NEVER throws —
// a notification failure must not fail (and pointlessly retry) the Stripe webhook / reconcile sweep. The
// in_app record is idempotent by `key`; push/email are deduped by `idempotencyKey`, so the SAME transition
// detected by both the webhook AND the self-heal sweep notifies at most once.
export async function notifyBillingTransition(
  appId: string,
  appName: string | undefined,
  previousStatus: SubscriptionStatus,
  record: SubscriptionRecord,
): Promise<void> {
  try {
    const input = billingTransitionNotification(previousStatus, record);
    if (!input) return;
    await notify(appId, appName, input);
  } catch {
    // Swallow — billing reconciliation correctness must never hinge on notification delivery.
  }
}
