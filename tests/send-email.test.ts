import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { executeCapability } from '../src/core/runtime';
import { ForgeError } from '../src/shared/errors';
import { SYSTEM_ACTOR } from '../src/shared/domain';
import { setSecret } from '../src/plugins/secrets-local/index';
import {
  setEmailTransport,
  resetEmailTransport,
  resolveEmailConfig,
  renderTemplate,
  redactRecipient,
  sanitizeError,
  parseSmtpUrl,
  extractAddress,
  buildMimeMessage,
  type OutboundEmail,
  type EmailConfig,
} from '../src/plugins/email-smtp/index';
import type { Application, EmailDelivery } from '../src/resources/types';
import { nowIso } from '../src/shared/time';

// C12 — transactional email delivery. Uses a throwaway FORGE_STATE_DIR + a pinned FORGE_SECRETS_KEY,
// and injects a deterministic capture SINK transport so nothing here opens a socket or sends real email.
const prevKey = process.env.FORGE_SECRETS_KEY;
const prevSmtp = process.env.SMTP_URL;
const prevFrom = process.env.EMAIL_FROM;
const prevAppName = process.env.FORGE_APP_NAME;
let dir: string;
let prevState: string | undefined;

const SMTP_URL = 'smtp://user:s3cr3t-pass@mail.example.test:1025';
const FROM = 'Acme <no-reply@acme.test>';

beforeAll(() => {
  process.env.FORGE_SECRETS_KEY = 'test-master-key-not-for-production';
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
});

async function seedApp(name: string): Promise<Application> {
  const now = nowIso();
  const app: Application = {
    id: `app_${name}`,
    type: 'Application',
    app_id: `app_${name}`,
    created_at: now,
    updated_at: now,
    name,
    repo_path: '/app',
    platform: 'web',
    framework: 'nextjs',
    template: 'nextjs-web',
    language: 'typescript',
    package_manager: 'npm',
  };
  await store.saveResource(app);
  return app;
}

async function configure(app: Application): Promise<void> {
  await setSecret(app.id, 'SMTP_URL', SMTP_URL);
  await setSecret(app.id, 'EMAIL_FROM', FROM);
}

// A capture sink: records the composed message + the config it was handed, returns a fixed id.
function sink() {
  const captured: { msg?: OutboundEmail; cfg?: EmailConfig } = {};
  setEmailTransport(async (msg, cfg) => {
    captured.msg = msg;
    captured.cfg = cfg;
    return { id: '<test-message-id@acme.test>' };
  });
  return captured;
}

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-email-'));
  process.env.FORGE_STATE_DIR = dir;
  // Absent by default so the "detectable absence" test is honest; tests opt in via configure().
  delete process.env.SMTP_URL;
  delete process.env.EMAIL_FROM;
  delete process.env.FORGE_APP_NAME;
  await store.init();
  resetEmailTransport();
});

afterEach(async () => {
  resetEmailTransport();
  if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevState;
  if (prevSmtp === undefined) delete process.env.SMTP_URL;
  else process.env.SMTP_URL = prevSmtp;
  if (prevFrom === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = prevFrom;
  if (prevAppName === undefined) delete process.env.FORGE_APP_NAME;
  else process.env.FORGE_APP_NAME = prevAppName;
  await rm(dir, { recursive: true, force: true });
});

describe('SendEmail capability (C12)', () => {
  it('composes an inline email + delivers it to the sink, persists a sent EmailDelivery', async () => {
    const app = await seedApp('demo');
    await configure(app);
    const captured = sink();

    const { capability, resource } = await executeCapability(
      'send-email',
      { app: 'demo', to: 'jane.roe@example.com', subject: 'Hello', text: 'Plain body', html: '<p>Rich body</p>' },
      SYSTEM_ACTOR,
    );
    const delivery = resource as EmailDelivery;

    // Composed correctly + from address comes from EMAIL_FROM (C5); full recipient reaches the transport.
    expect(captured.msg?.from).toBe(FROM);
    expect(captured.msg?.to).toBe('jane.roe@example.com');
    expect(captured.msg?.subject).toBe('Hello');
    expect(captured.msg?.text).toBe('Plain body');
    expect(captured.msg?.html).toBe('<p>Rich body</p>');
    // The transport is handed the creds (so the real path could send) — but they are NOT persisted.
    expect(captured.cfg?.smtpUrl).toBe(SMTP_URL);

    expect(capability).toBe('SendEmail');
    expect(delivery.type).toBe('EmailDelivery');
    expect(delivery.status).toBe('sent');
    expect(delivery.message_id).toBe('<test-message-id@acme.test>');
    // (4) Observability: redacted recipient + subject only; NO body, NO creds at rest.
    expect(delivery.to).toBe('j***@example.com');
    expect(delivery).not.toHaveProperty('html');
    expect(delivery).not.toHaveProperty('text');
    const persistedJson = JSON.stringify(delivery);
    expect(persistedJson).not.toContain('jane.roe@example.com'); // full recipient never stored
    expect(persistedJson).not.toContain('Plain body'); // body never stored
    expect(persistedJson).not.toContain('Rich body');
    expect(persistedJson).not.toContain('s3cr3t-pass'); // credential never stored

    // Durable + inspectable: survives re-read from disk.
    const reread = (await store.getResource('EmailDelivery', delivery.id)) as EmailDelivery | null;
    expect(reread?.status).toBe('sent');

    // The emitted fact carries redacted recipient + subject, never creds/body.
    const events = await store.listEvents({ app_id: app.id });
    const sent = events.find((e) => e.type === 'EmailSent');
    expect(sent).toBeTruthy();
    expect(sent!.data.to).toBe('j***@example.com');
    expect(sent!.data.subject).toBe('Hello');
    const eventJson = JSON.stringify(sent);
    expect(eventJson).not.toContain('jane.roe@example.com');
    expect(eventJson).not.toContain('s3cr3t-pass');
    expect(eventJson).not.toContain('Rich body');
  });

  it('renders the verify-email template from the link it is handed (C10 owns the link)', async () => {
    const app = await seedApp('demo');
    await configure(app);
    const captured = sink();

    const { resource } = await executeCapability(
      'send-email',
      { app: 'demo', to: 'user@example.com', template: 'verify-email', data: { url: 'https://acme.test/verify?token=abc123', product: 'Acme' } },
      SYSTEM_ACTOR,
    );
    const delivery = resource as EmailDelivery;

    expect(captured.msg?.subject).toBe('Verify your email address');
    expect(captured.msg?.text).toContain('https://acme.test/verify?token=abc123');
    expect(captured.msg?.text).toContain('Acme');
    expect(captured.msg?.html).toContain('https://acme.test/verify?token=abc123');
    expect(delivery.status).toBe('sent');
    expect(delivery.subject).toBe('Verify your email address');
    expect(delivery.template).toBe('verify-email');
  });

  it('renders the reset-password template', async () => {
    const app = await seedApp('demo');
    await configure(app);
    const captured = sink();
    await executeCapability(
      'send-email',
      { app: 'demo', to: 'user@example.com', template: 'reset-password', data: { url: 'https://acme.test/reset?token=xyz' } },
      SYSTEM_ACTOR,
    );
    expect(captured.msg?.subject).toBe('Reset your password');
    expect(captured.msg?.html).toContain('https://acme.test/reset?token=xyz');
  });

  it('absent email config is detectable → 503 dependency_unavailable, no crash, no delivery persisted', async () => {
    const app = await seedApp('demo'); // no SMTP_URL / EMAIL_FROM set
    let invoked = false;
    setEmailTransport(async () => {
      invoked = true;
      return { id: 'x' };
    });

    await expect(
      executeCapability('send-email', { app: 'demo', to: 'user@example.com', subject: 'Hi', text: 'body' }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: 'dependency_unavailable', status: 503 });
    await expect(
      executeCapability('send-email', { app: 'demo', to: 'user@example.com', subject: 'Hi', text: 'body' }, SYSTEM_ACTOR),
    ).rejects.toBeInstanceOf(ForgeError);

    // Degradation, not a crash: threw a typed ForgeError, never invoked the transport, persisted nothing.
    expect(invoked).toBe(false);
    expect((await store.listResources({ type: 'EmailDelivery', app_id: app.id })).length).toBe(0);
  });

  it('partial config (SMTP_URL but no EMAIL_FROM) is still detectably unconfigured, naming what is missing', async () => {
    const app = await seedApp('demo');
    await setSecret(app.id, 'SMTP_URL', SMTP_URL); // EMAIL_FROM intentionally missing
    await expect(
      executeCapability('send-email', { app: 'demo', to: 'user@example.com', subject: 'Hi', text: 'body' }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: 'dependency_unavailable', details: { missing: ['EMAIL_FROM'] } });
  });

  it('a transport/provider error is REPORTED (persisted failed EmailDelivery), not silently dropped', async () => {
    const app = await seedApp('demo');
    await configure(app);
    setEmailTransport(async () => {
      throw new Error('550 <bob@example.com> mailbox unavailable');
    });

    const { resource } = await executeCapability(
      'send-email',
      { app: 'demo', to: 'bob@example.com', subject: 'Hi', text: 'body' },
      SYSTEM_ACTOR,
    );
    const delivery = resource as EmailDelivery;
    expect(delivery.status).toBe('failed');
    expect(delivery.message_id).toBeUndefined();
    // The error is retained but scrubbed of the recipient address (no PII leak into the stored error).
    expect(delivery.error).toContain('550');
    expect(delivery.error).not.toContain('bob@example.com');
    expect(delivery.error).toContain('b***@example.com');

    const reread = (await store.getResource('EmailDelivery', delivery.id)) as EmailDelivery | null;
    expect(reread?.status).toBe('failed');
    const events = await store.listEvents({ app_id: app.id });
    expect(events.some((e) => e.type === 'EmailFailed')).toBe(true);
  });

  it('rejects input with neither a template nor subject+body (422), and a template missing its url (422)', async () => {
    const app = await seedApp('demo');
    await configure(app);
    await expect(
      executeCapability('send-email', { app: 'demo', to: 'user@example.com', text: 'orphan body, no subject' }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: 'invalid_input', status: 422 });
    await expect(
      executeCapability('send-email', { app: 'demo', to: 'user@example.com', template: 'verify-email', data: {} }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: 'invalid_input', status: 422 });
  });

  it('defaults the app to FORGE_APP_NAME so an internal caller needn\'t pass it', async () => {
    const app = await seedApp('sidecar-app');
    await configure(app);
    process.env.FORGE_APP_NAME = 'sidecar-app';
    sink();
    const { resource } = await executeCapability(
      'send-email',
      { to: 'user@example.com', subject: 'Hi', text: 'body' },
      SYSTEM_ACTOR,
    );
    expect((resource as EmailDelivery).status).toBe('sent');
    expect((resource as EmailDelivery).app_id).toBe(app.id);
  });
});

describe('email-smtp plugin', () => {
  it('resolveEmailConfig prefers the C5 vault, then env, and reports what is missing', async () => {
    const app = await seedApp('demo');
    expect(await resolveEmailConfig(app.id)).toEqual({ ok: false, missing: ['SMTP_URL', 'EMAIL_FROM'] });

    process.env.SMTP_URL = 'smtp://env-host:25';
    process.env.EMAIL_FROM = 'env <e@env.test>';
    expect(await resolveEmailConfig(app.id)).toEqual({ ok: true, config: { smtpUrl: 'smtp://env-host:25', from: 'env <e@env.test>' } });

    await setSecret(app.id, 'SMTP_URL', SMTP_URL);
    await setSecret(app.id, 'EMAIL_FROM', FROM);
    const resolved = await resolveEmailConfig(app.id);
    expect(resolved).toEqual({ ok: true, config: { smtpUrl: SMTP_URL, from: FROM } }); // vault wins over env
  });

  it('redactRecipient keeps only the first char + domain', () => {
    expect(redactRecipient('jane.roe@example.com')).toBe('j***@example.com');
    expect(redactRecipient('a@b.co')).toBe('a***@b.co');
    expect(redactRecipient('not-an-email')).toBe('***');
  });

  it('sanitizeError scrubs any email address out of a provider error', () => {
    expect(sanitizeError('550 <bob@example.com> rejected')).toBe('550 <b***@example.com> rejected');
    expect(sanitizeError('timeout')).toBe('timeout');
  });

  it('renderTemplate escapes HTML in interpolated data (no injection)', () => {
    const out = renderTemplate('verify-email', { url: 'https://x/y?a=1&b=2', product: '<script>evil</script>' });
    expect(out.html).not.toContain('<script>evil</script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('a=1&amp;b=2');
    expect(out.text).toContain('https://x/y?a=1&b=2'); // text keeps the raw url
  });

  it('parseSmtpUrl handles smtp/smtps, ports, and credentials', () => {
    expect(parseSmtpUrl('smtp://u:p@h:2525')).toEqual({ secure: false, host: 'h', port: 2525, user: 'u', pass: 'p' });
    expect(parseSmtpUrl('smtps://h')).toEqual({ secure: true, host: 'h', port: 465, user: undefined, pass: undefined });
    expect(parseSmtpUrl('smtp://h')).toMatchObject({ secure: false, port: 587 });
    expect(() => parseSmtpUrl('http://h')).toThrow(/scheme/);
  });

  it('extractAddress strips a display name for the envelope', () => {
    expect(extractAddress('Acme <no-reply@acme.test>')).toBe('no-reply@acme.test');
    expect(extractAddress('bare@acme.test')).toBe('bare@acme.test');
  });

  it('buildMimeMessage emits multipart/alternative with base64 parts and required headers', () => {
    const raw = buildMimeMessage({
      from: 'Acme <a@acme.test>',
      to: 'b@x.test',
      subject: 'Hi',
      text: 'plain',
      html: '<p>rich</p>',
      messageId: '<id@acme.test>',
      date: new Date('2026-07-07T00:00:00Z'),
    });
    expect(raw).toContain('From: Acme <a@acme.test>');
    expect(raw).toContain('To: b@x.test');
    expect(raw).toContain('Subject: Hi');
    expect(raw).toContain('Message-ID: <id@acme.test>');
    expect(raw).toContain('MIME-Version: 1.0');
    expect(raw).toContain('multipart/alternative; boundary=');
    expect(raw).toContain('Content-Transfer-Encoding: base64');
    expect(raw).toContain(Buffer.from('plain', 'utf8').toString('base64'));
    expect(raw).toContain(Buffer.from('<p>rich</p>', 'utf8').toString('base64'));
    // Lines are CRLF-terminated.
    expect(raw).toContain('\r\n');
  });

  it('buildMimeMessage emits a single part when only one body is present', () => {
    const raw = buildMimeMessage({ from: 'a@x.test', to: 'b@x.test', subject: 'S', text: 'only', messageId: '<m@x>' });
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(raw).not.toContain('multipart/alternative');
  });
});
