import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { EmailDelivery } from '../../resources/types';
import { resolveApp, baseResource } from '../_shared';
import { invalidInput, ForgeError } from '../../shared/errors';
import { nowIso } from '../../shared/time';
import { getFreshAccessToken } from '../../connectors/service';
import { redactRecipient } from '../../plugins/email-smtp/index';
import { sanitizeError, type OutboundMessage } from '../../plugins/message-gmail/index';
import { resolveSender, supportedRoutes } from './senders';

const emailList = z.array(z.string().email()).min(1);

const inputSchema = z.object({
  // The Application NAME. Optional: defaults to the runtime's own app (data-plane: FORGE_APP_NAME),
  // so the running app / an internal caller usually needn't pass it, like C1/C12.
  app: z.string().min(1).optional(),
  // Owner (C11) — the opaque per-user id (C10 session `userId`) whose connected account sends the message.
  // REQUIRED: an outbound message is always sent AS a specific user. Never trusted from a browser — the
  // app derives it from the session (or, for a background/approved send, passes it with the service token).
  owner: z.string().min(1).describe('Opaque per-user owner id (C10 session userId) — whose account sends'),
  // The C24 provider to send through, and the delivery channel. Defaults: Google + email (the MVP).
  provider: z.string().min(1).default('google').describe('C24 connector provider, e.g. "google"'),
  channel: z.string().min(1).default('email').describe('Delivery channel, e.g. "email"'),
  // Recipients. `to` is required (≥1); cc/bcc optional.
  to: emailList.describe('Recipient email addresses'),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).describe('Subject line'),
  body: z.string().min(1).describe('Message body'),
  content_type: z.enum(['text', 'html']).default('text').describe('Body content type'),
  // Threading (a reply): the RFC822 Message-ID being replied to (→ In-Reply-To/References) and/or the
  // provider thread id (Gmail threadId) to attach the reply to an existing conversation.
  in_reply_to: z.string().min(1).optional().describe('RFC822 Message-ID this replies to'),
  references: z.string().min(1).optional().describe('RFC822 References chain'),
  thread_ref: z.string().min(1).optional().describe('Provider thread id (Gmail threadId) to thread into'),
});
type Input = z.infer<typeof inputSchema>;

// A precise, actionable error when a (channel, provider) pair isn't implemented yet — so the consumer
// gets a change-input, not an opaque crash. SMS/push and Microsoft are additive registrations (senders.ts).
function unsupportedRoute(channel: string, provider: string): ForgeError {
  return new ForgeError({
    code: 'unsupported_channel',
    message:
      `Sending on channel "${channel}" via provider "${provider}" is not implemented. ` +
      `Supported: ${supportedRoutes().map((r) => `${r.channel}/${r.provider}`).join(', ')}.`,
    status: 400,
    retry: 'change-input',
    details: { channel, provider, supported: supportedRoutes() },
  });
}

// Build the redacted recipient stored on the record: the redacted primary `to` plus a "(+N more)" suffix
// counting the OTHER recipients (extra to + cc + bcc), so the durable record carries no full address / no
// PII while still conveying the send's shape.
function redactedTo(input: Input): string {
  const others = input.to.length - 1 + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0);
  const primary = redactRecipient(input.to[0]!);
  return others > 0 ? `${primary} (+${others} more)` : primary;
}

// SendMessage (C25) — send an outbound message AS a user through their C24-connected provider (MVP: email
// via connected Google/Gmail). It brokers a FRESH provider access token in-process (C24
// getFreshAccessToken, which auto-refreshes and enforces the required scope), composes the message, and
// hands it to the resolved channel/provider Implementation (message-gmail) so the mail genuinely lands in
// the user's account/Sent folder. Persists EVERY attempted send (success AND failure) as a durable,
// owner-scoped EmailDelivery — recipient REDACTED, no body/token retained — and emits a MessageSent/
// MessageFailed fact. Broker preconditions (not connected / missing scope / dead refresh) are surfaced as
// precise typed errors the app relays as a "reconnect" state, never a silent failure. Generic by
// construction: channel/provider dispatch (senders.ts) makes SMS/push + Microsoft additive.
export const sendMessage: Capability<Input, EmailDelivery> = {
  name: 'SendMessage',
  slug: 'send-message',
  description:
    'Send an outbound message AS a user through their connected provider (MVP: email via Google/Gmail using the C24 broker); persist the send (EmailDelivery, owner-scoped, redacted) and emit MessageSent/MessageFailed.',
  inputSchema,
  resourceType: 'EmailDelivery',
  events: ['MessageSent', 'MessageFailed'],
  longRunning: false,
  requiresDocker: false,
  plane: 'data', // the running app sends at runtime; control plane only inspects
  async execute(input, ctx) {
    const appName = input.app ?? process.env.FORGE_APP_NAME;
    if (!appName) {
      throw invalidInput('unknown app (pass `app` or set FORGE_APP_NAME).', { field: 'app' });
    }
    const app = await resolveApp(ctx.store, appName);

    // Resolve the transport for this (channel, provider). Unknown pair -> clean change-input (no send).
    const sender = resolveSender(input.channel, input.provider);
    if (!sender) throw unsupportedRoute(input.channel, input.provider);

    // Broker a FRESH access token (auto-refresh + required-scope enforcement). A precondition failure —
    // not_found (not connected), insufficient_scope (send not granted), or reconnect_required (dead
    // refresh) — PROPAGATES as a typed ForgeError so the app surfaces a precise "reconnect <provider>"
    // state. No delivery is persisted: there was no send attempt (mirrors C12's unconfigured 503).
    const token = await getFreshAccessToken({
      appId: app.id,
      owner: input.owner,
      provider: input.provider,
      requireScope: sender.requireScope,
    });

    const outbound: OutboundMessage = {
      ...(token.account_label ? { from: token.account_label } : {}),
      to: input.to,
      ...(input.cc && input.cc.length ? { cc: input.cc } : {}),
      ...(input.bcc && input.bcc.length ? { bcc: input.bcc } : {}),
      subject: input.subject,
      body: input.body,
      contentType: input.content_type,
      ...(input.in_reply_to ? { inReplyTo: input.in_reply_to } : {}),
      ...(input.references ? { references: input.references } : {}),
      ...(input.thread_ref ? { threadId: input.thread_ref } : {}),
    };

    const toRedacted = redactedTo(input);
    const common = {
      ...baseResource('EmailDelivery', app.id),
      owner: input.owner,
      type: 'EmailDelivery' as const,
      to: toRedacted,
      subject: input.subject,
      channel: input.channel,
      provider: input.provider,
      implementation: sender.implementation,
    };

    // Deliver. A provider error is REPORTED (persisted + returned as status:'failed'), never silently
    // dropped — the app can trust `status` to decide whether the message really went out.
    try {
      const ref = await sender.send(outbound, token.access_token);
      const now = nowIso();
      const delivery: EmailDelivery = {
        ...common,
        status: 'sent',
        message_id: ref.id,
        ...(ref.threadId ? { thread_id: ref.threadId } : {}),
        sent_at: now,
      };
      await ctx.store.saveResource(delivery);
      await ctx.emit({
        type: 'MessageSent',
        resource_type: 'EmailDelivery',
        resource_id: delivery.id,
        app_id: app.id,
        data: {
          owner: input.owner,
          channel: input.channel,
          provider: input.provider,
          to: toRedacted,
          subject: input.subject,
          message_id: ref.id,
          thread_id: ref.threadId ?? null,
          implementation: sender.implementation,
        },
      });
      return delivery;
    } catch (err) {
      const delivery: EmailDelivery = {
        ...common,
        status: 'failed',
        error: sanitizeError(String((err as Error)?.message ?? err)),
      };
      await ctx.store.saveResource(delivery);
      await ctx.emit({
        type: 'MessageFailed',
        resource_type: 'EmailDelivery',
        resource_id: delivery.id,
        app_id: app.id,
        data: {
          owner: input.owner,
          channel: input.channel,
          provider: input.provider,
          to: toRedacted,
          subject: input.subject,
          error: delivery.error,
          implementation: sender.implementation,
        },
      });
      return delivery;
    }
  },
};
