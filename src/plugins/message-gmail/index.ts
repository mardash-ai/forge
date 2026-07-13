// Plugin: message-gmail.
//
// The first Implementation of Forge's OUTBOUND SEND-AS-A-USER delivery (capability C25 SendMessage) — a
// real technology boundary (the Gmail REST API) that a future message-graph (Microsoft/Outlook) or an
// SMS/push Implementation can sit ALONGSIDE without touching the SendMessage Capability contract. It does
// exactly two provider-specific things: compose an RFC 5322 / MIME message and hand it to Gmail's
// `users.messages.send` endpoint AS the user, authenticated with a FRESH access token the C24 broker
// mints (this plugin never touches the vault or a raw refresh token — it is handed a bearer token).
//
// Dependency-clean by design (like model-anthropic / email-smtp / connectors): the transport is Node's
// built-in `fetch` + `crypto`, so both the control-plane and the slim data-plane image stay free of a
// Google SDK. Swappable for tests via getGmailSender()/setGmailSender()/resetGmailSender(), exactly like
// email-smtp's transport — so nothing here opens a socket in the test suite.

export const IMPLEMENTATION = 'message-gmail';

// The OAuth scope Gmail's send endpoint requires. The C24 broker enforces the connection actually holds
// it (else `insufficient_scope`), so a user who connected Google without granting send is caught with a
// precise "reconnect and grant send" error before any API call.
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const GMAIL_SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const GMAIL_TIMEOUT_MS = 20_000;
const CRLF = '\r\n';

// The composed message a sender delivers. Carries NO credential — the sender is handed the bearer token
// separately (like email-smtp keeps the EmailConfig out of the OutboundEmail), so a sender swap can't
// leak a token through the message. `from` is optional: Gmail always sends from the authenticated account,
// so it is only a display refinement.
export interface OutboundMessage {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  // The message body. `contentType` selects the MIME type; default text/plain.
  body: string;
  contentType?: 'text' | 'html';
  // Threading: the RFC822 Message-ID being replied to (→ In-Reply-To / References headers) and/or the
  // provider thread id (Gmail threadId) to attach the reply to an existing conversation.
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

// What a send returns: the provider's message id + the thread it landed in.
export interface SentMessageRef {
  id: string;
  threadId?: string;
}

// The swappable sender (the genuine Gmail technology boundary). Tests inject a deterministic in-memory
// sender, exactly like email-smtp's transport / C24's OutboundOAuthClient — no network in the suite.
export interface GmailSender {
  send(message: OutboundMessage, accessToken: string): Promise<SentMessageRef>;
}

// --- MIME composition (pure, unit-testable) --------------------------------------------------------

// The bare address for a header, stripping any display name: "Acme <a@b.com>" -> "a@b.com".
export function extractAddress(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return (m && m[1] ? m[1] : header).trim();
}

// RFC 2047 encode a header value only when it carries non-ASCII, so a Unicode subject/display name is
// transmitted safely.
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function base64Wrapped(body: string): string {
  const b64 = Buffer.from(body, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

// Serialize an OutboundMessage to an RFC 5322 / MIME string. Single-part (text OR html) — the body is
// base64 so no raw control char can corrupt the message. Threading headers (In-Reply-To / References)
// are included when present so Gmail attaches the reply to the right conversation.
export function buildGmailMime(msg: OutboundMessage): string {
  const headers: string[] = [];
  if (msg.from) headers.push(`From: ${msg.from}`);
  headers.push(`To: ${msg.to.join(', ')}`);
  if (msg.cc && msg.cc.length) headers.push(`Cc: ${msg.cc.join(', ')}`);
  if (msg.bcc && msg.bcc.length) headers.push(`Bcc: ${msg.bcc.join(', ')}`);
  headers.push(`Subject: ${encodeHeaderValue(msg.subject)}`);
  if (msg.inReplyTo) headers.push(`In-Reply-To: ${msg.inReplyTo}`);
  // Default References to In-Reply-To when the caller didn't supply an explicit chain (RFC 5322 guidance).
  const references = msg.references ?? msg.inReplyTo;
  if (references) headers.push(`References: ${references}`);
  headers.push('MIME-Version: 1.0');
  const mime = msg.contentType === 'html' ? 'text/html; charset=UTF-8' : 'text/plain; charset=UTF-8';
  headers.push(`Content-Type: ${mime}`, 'Content-Transfer-Encoding: base64');
  return headers.join(CRLF) + CRLF + CRLF + base64Wrapped(msg.body);
}

// base64url (RFC 4648 §5, no padding) — Gmail's `raw` field wants the whole MIME message URL-safe encoded.
export function toBase64Url(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url');
}

// Scrub any email address out of a provider error before it is persisted/emitted, so a Gmail 4xx that
// echoes a recipient never leaks PII (mirrors email-smtp.sanitizeError). Also drops any bearer token that
// somehow appears in a message.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export function sanitizeError(message: string): string {
  return message
    .replace(EMAIL_RE, (m) => {
      const at = m.indexOf('@');
      return at > 0 ? `${m[0]}***@${m.slice(at + 1)}` : '***';
    })
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
}

// --- The real Gmail HTTP sender --------------------------------------------------------------------

export const httpGmailSender: GmailSender = {
  async send(message, accessToken) {
    const raw = toBase64Url(buildGmailMime(message));
    const body: Record<string, unknown> = { raw };
    if (message.threadId) body.threadId = message.threadId;
    let res: Response;
    try {
      res = await fetch(GMAIL_SEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`gmail send request failed: ${sanitizeError(String((e as Error)?.message ?? e))}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Surface a compact, scrubbed provider error — the Capability persists it as status:'failed'.
      throw new Error(`gmail send failed: ${res.status}${detail ? ` ${sanitizeError(detail.slice(0, 300))}` : ''}`);
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string; threadId?: string };
    if (!json.id) throw new Error('gmail send response missing message id');
    return { id: json.id, ...(json.threadId ? { threadId: json.threadId } : {}) };
  },
};

// --- installable sender (swappable for tests) ------------------------------------------------------
let sender: GmailSender = httpGmailSender;
export function getGmailSender(): GmailSender {
  return sender;
}
export function setGmailSender(s: GmailSender): void {
  sender = s;
}
export function resetGmailSender(): void {
  sender = httpGmailSender;
}
