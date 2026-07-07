import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { readSecrets } from '../secrets-local/index';

// Plugin: email-smtp.
//
// The first Implementation of Forge's transactional-email delivery (capability C12) — a real
// technology boundary (an email transport) that a future email-api / email-ses Implementation can
// replace WITHOUT touching the SendEmail Capability contract. It does exactly three provider-specific
// things: resolve the transport credential + from address (from the C5 vault), compose a MIME message,
// and speak SMTP to hand the message off. Provider-agnostic: any SMTP relay (SES / Postmark / Sendgrid
// / Mailgun / a local Postfix) is one `SMTP_URL` away — nothing here hardcodes a provider account.
//
// Dependency-clean by design (like model-anthropic): the transport is Node's built-in net/tls, so both
// the control-plane and the slim data-plane image stay free of an SMTP SDK.

export const IMPLEMENTATION = 'email-smtp';

// The C5 secret names this Implementation reads. `SMTP_URL` carries the whole transport
// (smtp[s]://user:pass@host:port); `EMAIL_FROM` is the From header/address (may include a display
// name, e.g. "Acme <no-reply@acme.com>"). "Either absent -> detectable -> 503" is the (3) contract.
export const SMTP_URL_SECRET = 'SMTP_URL';
export const FROM_SECRET = 'EMAIL_FROM';

// Built-in templates C10 (identity/auth) composes with. C12 only RENDERS + DELIVERS them; C10 owns the
// token/link generation and passes the finished link in `data.url` — the link is NOT C12's concern.
export const TEMPLATES = ['verify-email', 'reset-password'] as const;
export type TemplateName = (typeof TEMPLATES)[number];

const CRLF = '\r\n';
const SMTP_TIMEOUT_MS = 15_000;

export interface EmailConfig {
  smtpUrl: string;
  from: string;
}

// The composed message a transport delivers. Carries no credentials — the transport is handed the
// EmailConfig separately, so a transport swap can't accidentally leak creds through the message.
export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

// --- Configuration resolution (C5) -----------------------------------------------------------------

// Resolve one secret for an app: prefer the C5 encrypted vault (the documented path — Forge injects
// the value from its vault into the runtime), then fall back to the Forge process env (an operator may
// inject it into the data-plane container directly), mirroring model-anthropic.resolveModelKey.
async function resolveSecret(appId: string, name: string): Promise<string | null> {
  try {
    const secrets = await readSecrets(appId);
    const fromVault = secrets[name];
    if (fromVault && fromVault.trim()) return fromVault.trim();
  } catch {
    // Vault unreadable (no master key, corrupt file) -> treat as absent, never fatal.
  }
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return null;
}

// Resolve the full email configuration for an app. When any required piece is ABSENT the result is
// `{ ok: false, missing }` — that is what makes the capability's absence DETECTABLE, so the consuming
// auth flow (C10) can degrade to a 503 and never crash. It never returns or logs the credential itself.
export async function resolveEmailConfig(
  appId: string,
): Promise<{ ok: true; config: EmailConfig } | { ok: false; missing: string[] }> {
  const smtpUrl = await resolveSecret(appId, SMTP_URL_SECRET);
  const from = await resolveSecret(appId, FROM_SECRET);
  const missing: string[] = [];
  if (!smtpUrl) missing.push(SMTP_URL_SECRET);
  if (!from) missing.push(FROM_SECRET);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, config: { smtpUrl: smtpUrl!, from: from! } };
}

// --- Observability helpers (no PII / no secrets) ---------------------------------------------------

// Redact a recipient for durable storage + events: keep the first local-part char + the domain, mask
// the rest (e.g. "jane@example.com" -> "j***@example.com"). Never store/emit the full address.
export function redactRecipient(to: string): string {
  const at = to.indexOf('@');
  if (at <= 0) return '***';
  const local = to.slice(0, at);
  const domain = to.slice(at + 1);
  const head = local[0] ?? '*';
  return `${head}***@${domain}`;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Scrub any email address out of a free-form error string before it is persisted/emitted, so a
// provider error that echoes the recipient (e.g. "550 <jane@example.com> unknown") never leaks PII.
export function sanitizeError(message: string): string {
  return message.replace(EMAIL_RE, (m) => redactRecipient(m));
}

// --- Templates -------------------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlLayout(inner: string): string {
  return (
    `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9;` +
    `font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
    `<table role="presentation" width="480" cellpadding="0" cellspacing="0" ` +
    `style="background:#ffffff;border-radius:12px;padding:32px;">` +
    `<tr><td style="font-size:15px;line-height:1.5;">${inner}</td></tr></table></td></tr></table>` +
    `</body></html>`
  );
}

function htmlButton(url: string, label: string): string {
  return (
    `<p style="margin:24px 0;"><a href="${url}" ` +
    `style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;` +
    `padding:12px 20px;border-radius:8px;font-weight:600;">${label}</a></p>`
  );
}

// Render one of the built-in templates to a composed { subject, html, text }. `data.url` (the link C10
// generated) is required by both current templates and is validated upstream in the Capability schema.
export function renderTemplate(
  name: TemplateName,
  data: Record<string, unknown>,
): { subject: string; html: string; text: string } {
  const url = String(data.url ?? '');
  const eurl = escapeHtml(url);
  const product = typeof data.product === 'string' && data.product ? data.product : 'your account';
  const eproduct = escapeHtml(product);
  const who = typeof data.name === 'string' && data.name ? data.name : '';
  const greetText = who ? `Hi ${who},\n\n` : '';
  const greetHtml = who ? `<p>Hi ${escapeHtml(who)},</p>` : '';
  const paste = `<p style="color:#6b7280;font-size:13px;">Or paste this link into your browser:<br>` +
    `<a href="${eurl}" style="color:#2563eb;word-break:break-all;">${eurl}</a></p>`;

  if (name === 'verify-email') {
    return {
      subject: 'Verify your email address',
      text:
        `${greetText}Confirm your email address to finish setting up ${product}.\n\n` +
        `Verify your email:\n${url}\n\n` +
        `If you didn't create this account, you can safely ignore this email.`,
      html: htmlLayout(
        `${greetHtml}<p>Confirm your email address to finish setting up ${eproduct}.</p>` +
          htmlButton(eurl, 'Verify email') +
          paste +
          `<p style="color:#6b7280;font-size:13px;">If you didn't create this account, you can safely ignore this email.</p>`,
      ),
    };
  }
  // reset-password
  return {
    subject: 'Reset your password',
    text:
      `${greetText}We received a request to reset your ${product} password.\n\n` +
      `Reset your password:\n${url}\n\n` +
      `If you didn't request this, you can safely ignore this email — your password won't change.`,
    html: htmlLayout(
      `${greetHtml}<p>We received a request to reset your ${eproduct} password.</p>` +
        htmlButton(eurl, 'Reset password') +
        paste +
        `<p style="color:#6b7280;font-size:13px;">If you didn't request this, you can safely ignore this email — your password won't change.</p>`,
    ),
  };
}

// --- MIME composition (pure, unit-testable) --------------------------------------------------------

// The bare address for the SMTP envelope, stripping any display name: "Acme <a@b.com>" -> "a@b.com".
export function extractAddress(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return (m && m[1] ? m[1] : header).trim();
}

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

// Serialize a message to RFC 5322 / MIME. Both bodies present -> multipart/alternative (text first,
// html last, so a client shows the richest it understands). Bodies are base64 so no raw CRLF can slip
// into the SMTP DATA stream; the transport still dot-stuffs at the wire level.
export function buildMimeMessage(opts: {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
  messageId: string;
  date?: Date;
}): string {
  const headers: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeaderValue(opts.subject)}`,
    `Date: ${(opts.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${opts.messageId}`,
    'MIME-Version: 1.0',
  ];

  const parts: Array<{ type: string; body: string }> = [];
  if (opts.text) parts.push({ type: 'text/plain; charset=UTF-8', body: opts.text });
  if (opts.html) parts.push({ type: 'text/html; charset=UTF-8', body: opts.html });
  if (parts.length === 0) parts.push({ type: 'text/plain; charset=UTF-8', body: '' });

  if (parts.length === 1) {
    const only = parts[0]!;
    headers.push(`Content-Type: ${only.type}`, 'Content-Transfer-Encoding: base64');
    return headers.join(CRLF) + CRLF + CRLF + base64Wrapped(only.body);
  }

  const boundary = `=_forge_${randomUUID().replace(/-/g, '')}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const body: string[] = [];
  for (const p of parts) {
    body.push(`--${boundary}`, `Content-Type: ${p.type}`, 'Content-Transfer-Encoding: base64', '', base64Wrapped(p.body));
  }
  body.push(`--${boundary}--`);
  return headers.join(CRLF) + CRLF + CRLF + body.join(CRLF);
}

// --- SMTP transport --------------------------------------------------------------------------------

export function parseSmtpUrl(raw: string): {
  secure: boolean;
  host: string;
  port: number;
  user?: string;
  pass?: string;
} {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('SMTP_URL is not a valid URL');
  }
  const scheme = u.protocol.replace(':', '');
  if (scheme !== 'smtp' && scheme !== 'smtps') {
    throw new Error(`SMTP_URL scheme must be smtp: or smtps: (got ${scheme}:)`);
  }
  const secure = scheme === 'smtps';
  if (!u.hostname) throw new Error('SMTP_URL is missing a host');
  return {
    secure,
    host: u.hostname,
    port: u.port ? Number(u.port) : secure ? 465 : 587,
    user: u.username ? decodeURIComponent(u.username) : undefined,
    pass: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

interface SmtpResponse {
  code: number;
  text: string;
}

// A tiny SMTP response reader over a socket: accumulates lines and delivers one logical response at a
// time, correctly joining multiline replies (`250-...` continuations, final `250 ...`).
class SmtpConn {
  private buffer = '';
  private lines: string[] = [];
  private queue: SmtpResponse[] = [];
  private waiter: ((r: SmtpResponse) => void) | null = null;
  private failed: Error | null = null;
  private failWaiter: ((e: Error) => void) | null = null;

  constructor(private socket: net.Socket) {
    socket.setEncoding('utf8');
    this.onData = this.onData.bind(this);
    this.onError = this.onError.bind(this);
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  private onClose = () => this.onError(new Error('SMTP connection closed by server'));

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.lines.push(line);
      const m = line.match(/^(\d{3})([ -])/);
      if (m && m[2] === ' ') {
        const code = Number(m[1]);
        const text = this.lines.map((l) => l.slice(4)).join(' ');
        this.lines = [];
        const resp = { code, text };
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          w(resp);
        } else {
          this.queue.push(resp);
        }
      }
    }
  }

  private onError(err: Error): void {
    if (this.failed) return;
    this.failed = err;
    if (this.failWaiter) this.failWaiter(err);
  }

  read(): Promise<SmtpResponse> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiter = resolve;
      this.failWaiter = reject;
    });
  }

  async command(line: string, expected: number[], label: string): Promise<SmtpResponse> {
    this.socket.write(line + CRLF);
    return this.expect(expected, label);
  }

  async expect(expected: number[], label: string): Promise<SmtpResponse> {
    const resp = await this.read();
    if (!expected.includes(resp.code)) {
      throw new Error(`SMTP ${label} failed: ${resp.code} ${resp.text}`.trim());
    }
    return resp;
  }

  // Stop consuming the raw socket (before a STARTTLS upgrade hands it to the TLS layer).
  detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }
}

function connectPlain(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(SMTP_TIMEOUT_MS, () => socket.destroy(new Error('SMTP timeout')));
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function connectTls(opts: tls.ConnectionOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(opts, () => resolve(socket));
    socket.setTimeout(SMTP_TIMEOUT_MS, () => socket.destroy(new Error('SMTP timeout')));
    socket.once('error', reject);
  });
}

// The transport contract: deliver a composed message given the resolved config, returning a message id.
// Swappable so tests inject a deterministic sink (no socket / no creds) and a future Implementation can
// slot in — the Capability calls getEmailTransport(), never a hard import.
export type EmailTransport = (msg: OutboundEmail, config: EmailConfig) => Promise<{ id: string }>;

// The real transport: open SMTP (implicit TLS for smtps://, optional STARTTLS upgrade for smtp://),
// AUTH LOGIN if the URL carries credentials, then MAIL FROM / RCPT TO / DATA. Any non-2xx/3xx SMTP
// reply throws — a delivery FAILURE the Capability records, never a silent drop. Errors carry the
// server's reply (never our sent credentials or the message body).
export const sendViaSmtp: EmailTransport = async (msg, config) => {
  const { secure, host, port, user, pass } = parseSmtpUrl(config.smtpUrl);
  const fromAddr = extractAddress(msg.from);
  const toAddr = extractAddress(msg.to);
  const domain = fromAddr.split('@')[1] ?? 'localhost';
  const messageId = `<${randomUUID()}@${domain}>`;
  const raw = buildMimeMessage({ from: msg.from, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, messageId });
  const ehloName = host || 'localhost';

  let socket: net.Socket = secure
    ? await connectTls({ host, port, servername: host })
    : await connectPlain(host, port);
  let conn = new SmtpConn(socket);

  try {
    await conn.expect([220], 'greeting');
    let ehlo = await conn.command(`EHLO ${ehloName}`, [250], 'EHLO');

    // Opportunistic STARTTLS for a plaintext connection that advertises it.
    if (!secure && /\bSTARTTLS\b/i.test(ehlo.text)) {
      await conn.command('STARTTLS', [220], 'STARTTLS');
      conn.detach();
      const tlsSocket = await connectTls({ socket, host, servername: host });
      socket = tlsSocket;
      conn = new SmtpConn(tlsSocket);
      ehlo = await conn.command(`EHLO ${ehloName}`, [250], 'EHLO(tls)');
    }

    if (user) {
      await conn.command('AUTH LOGIN', [334], 'AUTH');
      await conn.command(Buffer.from(user, 'utf8').toString('base64'), [334], 'AUTH user');
      await conn.command(Buffer.from(pass ?? '', 'utf8').toString('base64'), [235], 'AUTH pass');
    }

    await conn.command(`MAIL FROM:<${fromAddr}>`, [250], 'MAIL FROM');
    await conn.command(`RCPT TO:<${toAddr}>`, [250, 251], 'RCPT TO');
    await conn.command('DATA', [354], 'DATA');
    // Dot-stuff (RFC 5321 §4.5.2) then terminate with <CRLF>.<CRLF>.
    const stuffed = raw.replace(/\r\n\./g, '\r\n..');
    await conn.command(stuffed + CRLF + '.', [250], 'message body');
    try {
      await conn.command('QUIT', [221], 'QUIT');
    } catch {
      // A server that drops the connection on QUIT is fine — the message was already accepted (250).
    }
    return { id: messageId };
  } finally {
    socket.destroy();
  }
};

let transport: EmailTransport = sendViaSmtp;
export function setEmailTransport(fn: EmailTransport): void {
  transport = fn;
}
export function resetEmailTransport(): void {
  transport = sendViaSmtp;
}
export function getEmailTransport(): EmailTransport {
  return transport;
}
