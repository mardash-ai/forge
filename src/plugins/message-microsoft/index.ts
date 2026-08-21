// Plugin: message-microsoft.
//
// The second Implementation of Forge's OUTBOUND SEND-AS-A-USER delivery (capability C25 SendMessage) — a
// real technology boundary (the Microsoft Graph REST API) that sits alongside message-gmail without touching
// the SendMessage Capability contract. It does exactly two provider-specific things: compose a Graph
// sendMail request body and POST it to `https://graph.microsoft.com/v1.0/me/sendMail` AS the user,
// authenticated with a FRESH access token the C24 broker mints (this plugin never touches the vault or a
// raw refresh token — it is handed a bearer token).
//
// Dependency-clean by design (like model-anthropic / email-smtp / message-gmail): the transport is Node's
// built-in `fetch` + `crypto`, so both the control-plane and the slim data-plane image stay free of a
// Microsoft SDK. Swappable for tests via getGraphMailSender()/setGraphMailSender()/resetGraphMailSender(),
// exactly like message-gmail's sender — so nothing here opens a socket in the test suite.
//
// Microsoft Graph `POST /me/sendMail` returns 202 Accepted with an EMPTY body — there is no immediate
// message ID in the response. We generate a synthetic local ID (crypto.randomUUID()) so the EmailDelivery
// record always has a non-null `message_id`; the actual message lands in the user's Sent folder.

import { randomUUID } from 'node:crypto';
import type { OutboundMessage, SentMessageRef } from '../message-gmail/index';

export const IMPLEMENTATION = 'message-microsoft';

// The OAuth scope Microsoft Graph's sendMail endpoint requires. Microsoft v2.0 returns short-form scope
// strings in the token response (e.g. `Mail.Send`), so the scope string stored on the connection is the
// short form — match it here. The C24 broker enforces the connection holds it (else `insufficient_scope`).
export const MSGRAPH_SEND_SCOPE = 'Mail.Send';

const GRAPH_SEND_ENDPOINT = 'https://graph.microsoft.com/v1.0/me/sendMail';
const GRAPH_TIMEOUT_MS = 20_000;

// Shape the Graph API expects for a single email address.
interface GraphEmailAddress {
  emailAddress: { address: string; name?: string };
}

// The Graph sendMail request body. `saveToSentItems` is true by default; we leave it as the default
// (truthy), matching the behavior a user expects when sending mail through their account.
interface GraphSendMailBody {
  message: {
    subject: string;
    body: { contentType: 'Text' | 'HTML'; content: string };
    toRecipients: GraphEmailAddress[];
    ccRecipients?: GraphEmailAddress[];
    bccRecipients?: GraphEmailAddress[];
    conversationId?: string;
    internetMessageHeaders?: Array<{ name: string; value: string }>;
  };
}

// Convert a plain address string (possibly "Display Name <addr@host>") to a Graph EmailAddress object.
function toGraphAddress(raw: string): GraphEmailAddress {
  const m = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (m && m[1] && m[2]) {
    return { emailAddress: { name: m[1].trim(), address: m[2].trim() } };
  }
  return { emailAddress: { address: raw.trim() } };
}

// Build the Graph sendMail request body from an OutboundMessage.
export function buildGraphSendBody(msg: OutboundMessage): GraphSendMailBody {
  const internetMessageHeaders: Array<{ name: string; value: string }> = [];
  if (msg.inReplyTo) internetMessageHeaders.push({ name: 'In-Reply-To', value: msg.inReplyTo });
  // Default References to In-Reply-To when the caller didn't supply an explicit chain (RFC 5322 guidance).
  const references = msg.references ?? msg.inReplyTo;
  if (references) internetMessageHeaders.push({ name: 'References', value: references });

  return {
    message: {
      subject: msg.subject,
      body: {
        contentType: msg.contentType === 'html' ? 'HTML' : 'Text',
        content: msg.body,
      },
      toRecipients: msg.to.map(toGraphAddress),
      ...(msg.cc && msg.cc.length ? { ccRecipients: msg.cc.map(toGraphAddress) } : {}),
      ...(msg.bcc && msg.bcc.length ? { bccRecipients: msg.bcc.map(toGraphAddress) } : {}),
      // `threadId` on the OutboundMessage maps to Graph's `conversationId` — threads the reply
      // into an existing conversation exactly like Gmail's `threadId` field.
      ...(msg.threadId ? { conversationId: msg.threadId } : {}),
      ...(internetMessageHeaders.length ? { internetMessageHeaders } : {}),
    },
  };
}

// Scrub any email address out of a Graph error before it is persisted/emitted (mirrors email-smtp /
// message-gmail sanitizeError). Also drops any bearer token that somehow appears in a message.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export function sanitizeError(message: string): string {
  return message
    .replace(EMAIL_RE, (m) => {
      const at = m.indexOf('@');
      return at > 0 ? `${m[0]}***@${m.slice(at + 1)}` : '***';
    })
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
}

// The swappable sender interface (the genuine Graph technology boundary). Tests inject a deterministic
// in-memory sender, exactly like message-gmail's GmailSender / C24's OutboundOAuthClient.
export interface GraphMailSender {
  send(message: OutboundMessage, accessToken: string): Promise<SentMessageRef>;
}

// The real Microsoft Graph HTTP sender. POST /me/sendMail returns 202 with an EMPTY body; we synthesize
// a local message ID so the EmailDelivery record always has a non-null `message_id`.
export const httpGraphMailSender: GraphMailSender = {
  async send(message, accessToken) {
    const body = buildGraphSendBody(message);
    let res: Response;
    try {
      res = await fetch(GRAPH_SEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`graph mail send request failed: ${sanitizeError(String((e as Error)?.message ?? e))}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Surface a compact, scrubbed provider error — the Capability persists it as status:'failed'.
      throw new Error(
        `graph mail send failed: ${res.status}${detail ? ` ${sanitizeError(detail.slice(0, 300))}` : ''}`,
      );
    }
    // 202 Accepted, empty body — synthesize a stable local ID for the persisted EmailDelivery record.
    return { id: randomUUID() };
  },
};

// --- installable sender (swappable for tests) ------------------------------------------------------
let sender: GraphMailSender = httpGraphMailSender;
export function getGraphMailSender(): GraphMailSender {
  return sender;
}
export function setGraphMailSender(s: GraphMailSender): void {
  sender = s;
}
export function resetGraphMailSender(): void {
  sender = httpGraphMailSender;
}
