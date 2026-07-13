import type { OutboundMessage, SentMessageRef } from '../../plugins/message-gmail/index';
import {
  IMPLEMENTATION as GMAIL_IMPL,
  GMAIL_SEND_SCOPE,
  getGmailSender,
} from '../../plugins/message-gmail/index';

// C25 — the CHANNEL × PROVIDER dispatch table for SendMessage. This is the extensibility seam: the
// SendMessage Capability is a stable, provider-agnostic contract; WHICH transport actually delivers a
// message is resolved here by (channel, provider). Adding SMS/push or Microsoft/Outlook is ADDITIVE —
// register another descriptor; the Capability, its resource, and its events don't change.
//
// A descriptor names the OAuth scope the C24 broker must confirm the connection holds (so a missing
// grant is a precise `insufficient_scope` before any API call), the implementation label persisted on
// the record, and the `send` that hands the composed message to the provider with a fresh access token.

export interface MessageSenderDescriptor {
  channel: string;
  provider: string;
  // The scope the underlying provider API requires; passed to the C24 broker as `requireScope`.
  requireScope: string;
  // The implementation label recorded on the EmailDelivery (e.g. 'message-gmail').
  implementation: string;
  // Deliver the composed message with a fresh provider access token (from the C24 broker).
  send(message: OutboundMessage, accessToken: string): Promise<SentMessageRef>;
}

// Registered senders keyed by `${channel}:${provider}`. Only email:google is implemented for the MVP.
const REGISTRY: Record<string, MessageSenderDescriptor> = {
  'email:google': {
    channel: 'email',
    provider: 'google',
    requireScope: GMAIL_SEND_SCOPE,
    implementation: GMAIL_IMPL,
    // Delegate to the swappable Gmail sender so tests inject a deterministic in-memory sender.
    send: (message, accessToken) => getGmailSender().send(message, accessToken),
  },
};

// Resolve the sender for a (channel, provider), or null when the combination isn't implemented yet.
export function resolveSender(channel: string, provider: string): MessageSenderDescriptor | null {
  return REGISTRY[`${channel}:${provider}`] ?? null;
}

// The channels the platform can send on (for discovery / error messages).
export function supportedChannels(): string[] {
  return [...new Set(Object.values(REGISTRY).map((d) => d.channel))].sort();
}

// The (channel, provider) pairs currently implemented (for discovery / error messages).
export function supportedRoutes(): Array<{ channel: string; provider: string }> {
  return Object.values(REGISTRY).map((d) => ({ channel: d.channel, provider: d.provider }));
}
