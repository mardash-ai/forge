import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { getBackends } from '../src/storage/backends';
import { executeCapability } from '../src/core/runtime';
import { SYSTEM_ACTOR } from '../src/shared/domain';
import { sealValue } from '../src/plugins/secrets-local/index';
import { setSecret } from '../src/plugins/secrets-local/index';
import {
  setGraphMailSender,
  resetGraphMailSender,
  buildGraphSendBody,
  sanitizeError,
  MSGRAPH_SEND_SCOPE,
  type GraphMailSender,
} from '../src/plugins/message-microsoft/index';
import type { OutboundMessage } from '../src/plugins/message-gmail/index';
import { resolveSender, supportedRoutes } from '../src/capabilities/send-message/senders';
import { completeConnect, unionScopes } from '../src/connectors/service';
import {
  setOutboundOAuthClient,
  resetOutboundOAuthClient,
  accountLabelFrom,
  type OutboundOAuthClient,
  type TokenSet,
} from '../src/connectors/oauth-client';
import { providerDescriptor } from '../src/connectors/providers';
import type { Application, EmailDelivery } from '../src/resources/types';
import type { Connection } from '../src/connectors/types';
import { nowIso } from '../src/shared/time';

// C25 / message-microsoft — Microsoft Graph sendMail plugin + connector-registry fixes.
// Exercises:
//   (a) message-microsoft plugin: buildGraphSendBody, error sanitization, and end-to-end send via the C25
//       Capability using a stub Graph sender (no network);
//   (b) email:microsoft registration in the senders dispatch table;
//   (c) account_label_claim fallback: 'preferred_username' is used when 'email' is absent (personal MSA);
//   (d) scope-narrowing guard: a partial re-consent callback CANNOT narrow a connection's stored scope list
//       (union/superset preserved), and the test verifies it WOULD have narrowed before the fix.

const APP = 'demo';
const APP_ID = 'app_demo';
const OWNER = 'user_alice';

let dir: string;
let prevDir: string | undefined;
let prevKey: string | undefined;
let prevAppName: string | undefined;
let sent: Array<{ message: OutboundMessage; token: string }>;

const seedApp = async (): Promise<void> => {
  const now = nowIso();
  await store.saveResource({
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
  } as Application);
};

// Seed a Microsoft connection directly into the (encrypted) connections vault.
async function seedMicrosoftConnection(
  opts: { scopes?: string[]; expiresInSec?: number } = {},
): Promise<void> {
  const now = new Date();
  const conn: Connection = {
    owner: OWNER,
    provider: 'microsoft',
    access_sealed: await sealValue('ms-access-token-live'),
    refresh_sealed: await sealValue('ms-refresh-token'),
    access_expires_at: new Date(now.getTime() + (opts.expiresInSec ?? 3600) * 1000).toISOString(),
    scopes: opts.scopes ?? [
      'openid',
      'email',
      'offline_access',
      'Mail.Read',
      'Mail.Send',
      'Calendars.ReadWrite',
    ],
    status: 'connected',
    account_label: 'alice@outlook.test',
    connected_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  await (await getBackends()).connections.putConnection(APP_ID, conn);
}

// The capability input for a minimal Microsoft send.
const send = (over: Record<string, unknown> = {}) =>
  executeCapability(
    'send-message',
    {
      app: APP,
      owner: OWNER,
      provider: 'microsoft',
      to: ['bob@example.test'],
      subject: 'Hello',
      body: 'Hi there',
      ...over,
    },
    SYSTEM_ACTOR,
  );

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevKey = process.env.FORGE_SECRETS_KEY;
  prevAppName = process.env.FORGE_APP_NAME;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-msg-microsoft-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_SECRETS_KEY = 'msg-microsoft-test-master-key';
  process.env.FORGE_APP_NAME = APP;
  await store.init();
  await seedApp();
  await setSecret(APP_ID, 'MICROSOFT_CONNECT_CLIENT_ID', 'ms-connect-client');
  await setSecret(APP_ID, 'MICROSOFT_CONNECT_CLIENT_SECRET', 'ms-connect-secret');

  sent = [];
  const stub: GraphMailSender = {
    async send(message, token) {
      sent.push({ message, token });
      return { id: 'ms-synth-id-001' };
    },
  };
  setGraphMailSender(stub);
});

afterEach(async () => {
  resetGraphMailSender();
  resetOutboundOAuthClient();
  const conns = (await getBackends()).connections;
  if (conns.__truncateAllForTests) await conns.__truncateAllForTests();
  if (prevDir === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevDir;
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
  if (prevAppName === undefined) delete process.env.FORGE_APP_NAME;
  else process.env.FORGE_APP_NAME = prevAppName;
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) message-microsoft plugin — pure helpers
// ---------------------------------------------------------------------------

describe('message-microsoft plugin — buildGraphSendBody', () => {
  it('builds a well-formed Graph sendMail body for a plain text message', () => {
    const msg: OutboundMessage = {
      from: 'alice@outlook.test',
      to: ['bob@example.test'],
      subject: 'Hello',
      body: 'Hi there',
      contentType: 'text',
    };
    const body = buildGraphSendBody(msg);
    expect(body.message.subject).toBe('Hello');
    expect(body.message.body.contentType).toBe('Text');
    expect(body.message.body.content).toBe('Hi there');
    expect(body.message.toRecipients).toHaveLength(1);
    expect(body.message.toRecipients[0]!.emailAddress.address).toBe('bob@example.test');
    expect(body.message.ccRecipients).toBeUndefined();
    expect(body.message.internetMessageHeaders).toBeUndefined();
  });

  it('builds an HTML message with cc/bcc and threading headers', () => {
    const msg: OutboundMessage = {
      to: ['bob@example.test'],
      cc: ['carol@example.test'],
      bcc: ['dave@example.test'],
      subject: 'Reply',
      body: '<b>Hi</b>',
      contentType: 'html',
      inReplyTo: '<orig-1@mail.test>',
      references: '<root@mail.test> <orig-1@mail.test>',
      threadId: 'ms-conv-id-abc',
    };
    const body = buildGraphSendBody(msg);
    expect(body.message.body.contentType).toBe('HTML');
    expect(body.message.ccRecipients).toHaveLength(1);
    expect(body.message.bccRecipients).toHaveLength(1);
    expect(body.message.conversationId).toBe('ms-conv-id-abc');
    const headers = body.message.internetMessageHeaders!;
    expect(headers.find((h) => h.name === 'In-Reply-To')?.value).toBe('<orig-1@mail.test>');
    expect(headers.find((h) => h.name === 'References')?.value).toBe(
      '<root@mail.test> <orig-1@mail.test>',
    );
  });

  it('defaults References to In-Reply-To when references is omitted', () => {
    const body = buildGraphSendBody({
      to: ['a@b.test'],
      subject: 's',
      body: 'b',
      inReplyTo: '<orig@mail.test>',
    });
    const headers = body.message.internetMessageHeaders!;
    expect(headers.find((h) => h.name === 'References')?.value).toBe('<orig@mail.test>');
  });

  it('parses a display-name address correctly', () => {
    const body = buildGraphSendBody({
      to: ['Alice Smith <alice@example.test>'],
      subject: 's',
      body: 'b',
    });
    expect(body.message.toRecipients[0]!.emailAddress.name).toBe('Alice Smith');
    expect(body.message.toRecipients[0]!.emailAddress.address).toBe('alice@example.test');
  });
});

describe('message-microsoft plugin — sanitizeError', () => {
  it('redacts email addresses and Bearer tokens from error messages', () => {
    const raw =
      'graph mail send failed: 400 invalid recipient bob@example.test (Bearer abc.def.ghi)';
    const scrubbed = sanitizeError(raw);
    expect(scrubbed).not.toContain('bob@example.test');
    expect(scrubbed).not.toContain('abc.def.ghi');
    expect(scrubbed).toContain('b***@example.test');
    expect(scrubbed).toContain('Bearer ***');
  });
});

// ---------------------------------------------------------------------------
// (b) sender dispatch table — email:microsoft registered alongside email:google
// ---------------------------------------------------------------------------

describe('senders dispatch table — email:microsoft registration', () => {
  it('resolveSender finds email:microsoft', () => {
    const d = resolveSender('email', 'microsoft');
    expect(d).not.toBeNull();
    expect(d!.provider).toBe('microsoft');
    expect(d!.channel).toBe('email');
    expect(d!.requireScope).toBe(MSGRAPH_SEND_SCOPE);
    expect(d!.implementation).toBe('message-microsoft');
  });

  it('supportedRoutes includes both email:google and email:microsoft', () => {
    const routes = supportedRoutes();
    const providers = routes.map((r) => `${r.channel}:${r.provider}`);
    expect(providers).toContain('email:google');
    expect(providers).toContain('email:microsoft');
  });

  it('resolveSender returns null for unknown routes', () => {
    expect(resolveSender('sms', 'microsoft')).toBeNull();
    expect(resolveSender('email', 'unknown')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (c) C25 SendMessage end-to-end via email:microsoft (stub sender, no network)
// ---------------------------------------------------------------------------

describe('C25 SendMessage — email:microsoft (happy path)', () => {
  it('brokers the fresh token, delegates to Graph sender, persists an owner-scoped EmailDelivery', async () => {
    await seedMicrosoftConnection();
    const { resource } = await send({ subject: 'Ship it', body: 'The build is green.' });
    const d = resource as EmailDelivery;

    expect(d.type).toBe('EmailDelivery');
    expect(d.status).toBe('sent');
    expect(d.owner).toBe(OWNER);
    expect(d.channel).toBe('email');
    expect(d.provider).toBe('microsoft');
    expect(d.implementation).toBe('message-microsoft');
    expect(d.message_id).toBe('ms-synth-id-001');
    // Recipient is REDACTED at rest; no body / no token persisted.
    expect(d.to).toBe('b***@example.test');
    const json = JSON.stringify(d);
    expect(json).not.toContain('The build is green.');
    expect(json).not.toContain('ms-access-token-live');

    // The stub received the FRESH broker token + the composed message.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.token).toBe('ms-access-token-live');
    expect(sent[0]!.message.to).toEqual(['bob@example.test']);
    expect(sent[0]!.message.subject).toBe('Ship it');
    // from = connected account_label (alice@outlook.test)
    expect(sent[0]!.message.from).toBe('alice@outlook.test');
  });

  it('persists the record and emits a MessageSent fact', async () => {
    await seedMicrosoftConnection();
    const { resource } = await send();
    const d = resource as EmailDelivery;

    const found = await store.findResourceById(d.id);
    expect(found).not.toBeNull();
    const events = await store.listEvents({ resource_id: d.id });
    expect(events.map((e) => e.type)).toContain('MessageSent');
  });

  it('not connected → not_found', async () => {
    await expect(send()).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(sent).toHaveLength(0);
  });

  it('connected without Mail.Send → insufficient_scope (reconnect)', async () => {
    await seedMicrosoftConnection({ scopes: ['openid', 'email', 'offline_access', 'Mail.Read'] });
    await expect(send()).rejects.toMatchObject({ code: 'insufficient_scope', status: 403 });
    expect(sent).toHaveLength(0);
  });

  it('a Graph send failure is persisted as status:failed with a scrubbed error', async () => {
    await seedMicrosoftConnection();
    setGraphMailSender({
      async send() {
        throw new Error('graph mail send failed: 400 invalid recipient bob@example.test');
      },
    });
    const { resource } = await send();
    const d = resource as EmailDelivery;
    expect(d.status).toBe('failed');
    expect(d.error).toContain('graph mail send failed');
    expect(d.error).not.toContain('bob@example.test');
    const events = await store.listEvents({ resource_id: d.id });
    expect(events.map((e) => e.type)).toContain('MessageFailed');
  });
});

// ---------------------------------------------------------------------------
// (c) account_label_claims fallback — personal MSA accounts lack 'email'
// ---------------------------------------------------------------------------

// Build a minimal id_token JWT (payload-only; no sig verification — same approach as the platform).
function makeIdToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
}

describe('connector — account_label_claims fallback (Microsoft personal-account MSA)', () => {
  // Test accountLabelFrom DIRECTLY (exported for this purpose) with a Microsoft-scoped provider
  // descriptor — this verifies the claim-resolution logic without requiring a full network round-trip.

  const msDescriptor = providerDescriptor('microsoft')!;

  it('uses the email claim when present (work/school account)', () => {
    const idToken = makeIdToken({ sub: 'user-sub', email: 'work@contoso.test', preferred_username: 'work@contoso.test' });
    expect(accountLabelFrom(msDescriptor, idToken)).toBe('work@contoso.test');
  });

  it('falls back to preferred_username when email claim is absent (personal MSA)', () => {
    // Personal Microsoft accounts often lack `email` in the OIDC id_token; they always have
    // `preferred_username` (the live.com / hotmail.com / outlook.com UPN).
    const idToken = makeIdToken({ sub: 'personal-sub', preferred_username: 'personal@outlook.com' });
    expect(accountLabelFrom(msDescriptor, idToken)).toBe('personal@outlook.com');
  });

  it('returns undefined when NEITHER email NOR preferred_username is in the id_token', () => {
    const idToken = makeIdToken({ sub: 'anon-sub' }); // no email, no preferred_username
    expect(accountLabelFrom(msDescriptor, idToken)).toBeUndefined();
  });

  it('returns undefined when there is no id_token', () => {
    expect(accountLabelFrom(msDescriptor, undefined)).toBeUndefined();
  });

  it('Google descriptor (email only) still resolves correctly', () => {
    const googleDescriptor = providerDescriptor('google')!;
    const idToken = makeIdToken({ email: 'alice@gmail.test' });
    expect(accountLabelFrom(googleDescriptor, idToken)).toBe('alice@gmail.test');
    // Google descriptor has no preferred_username fallback — that's intentional.
    const noEmail = makeIdToken({ preferred_username: 'alice' });
    expect(accountLabelFrom(googleDescriptor, noEmail)).toBeUndefined();
  });

  it('completeConnect stores the account_label derived from the token response (end-to-end)', async () => {
    // Drive completeConnect with a stub that sets account_label on the returned TokenSet
    // (mirroring what the real httpOAuthClient does after parsing the id_token).
    const stubClient: OutboundOAuthClient = {
      authorizeUrl: (o) => `${o.provider.authorization_endpoint}?state=${o.state}`,
      exchangeCode: async () => ({
        access_token: 'ms-access',
        refresh_token: 'ms-refresh',
        expires_in: 3600,
        scope: 'openid offline_access Mail.Send',
        account_label: 'personal@outlook.com', // httpOAuthClient derives this from preferred_username
      } as TokenSet),
      refresh: async () => ({ access_token: 'ms-access-v2', expires_in: 3600 }),
      revoke: async () => {},
    };
    setOutboundOAuthClient(stubClient);
    const reqState = 'state-personal-acct-e2e';
    const b = await getBackends();
    await b.connections.putRequest(APP_ID, {
      state: reqState,
      owner: OWNER,
      provider: 'microsoft',
      code_verifier: 'verifier',
      redirect_uri: 'https://app.example/connect/microsoft/callback',
      scopes: ['openid', 'offline_access', 'Mail.Send'],
      created_at: nowIso(),
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    const result = await completeConnect({
      appId: APP_ID,
      provider: 'microsoft',
      state: reqState,
      code: 'auth-code-456',
    });
    expect(result.connection.account_label).toBe('personal@outlook.com');
  });
});

// ---------------------------------------------------------------------------
// (d) Scope-narrowing guard — partial re-consent MUST NOT narrow stored scopes
// ---------------------------------------------------------------------------

describe('connector — scope-narrowing guard (Microsoft re-consent safety)', () => {
  it('unionScopes returns the set union, never a subset', () => {
    expect(unionScopes(['A', 'B', 'C'], ['A', 'B'])).toEqual(['A', 'B', 'C']);
    expect(unionScopes(['A', 'B'], ['B', 'C'])).toEqual(['A', 'B', 'C']);
    expect(unionScopes([], ['Mail.Send'])).toEqual(['Mail.Send']);
    expect(unionScopes(['Mail.Send'], [])).toEqual(['Mail.Send']);
  });

  it('a partial re-consent cannot narrow the stored scope list (union preserved)', async () => {
    // The user initially connects with full scopes.
    const fullScopes = ['Calendars.ReadWrite', 'Mail.Read', 'Mail.Send', 'email', 'offline_access', 'openid'];
    await seedMicrosoftConnection({ scopes: fullScopes });

    // Simulate a re-consent where the user (or provider) only grants a SUBSET — the hazard for Microsoft
    // because there is no `include_granted_scopes` equivalent.
    const narrowedScopes = 'openid email offline_access Mail.Read'; // Mail.Send + Calendars.ReadWrite GONE

    const stubClient: OutboundOAuthClient = {
      authorizeUrl: (o) => `${o.provider.authorization_endpoint}?state=${o.state}`,
      exchangeCode: async () => ({
        access_token: 'ms-access-v2',
        refresh_token: 'ms-refresh-v2',
        expires_in: 3600,
        scope: narrowedScopes,
      }),
      refresh: async () => ({ access_token: 'ms-access-v3', expires_in: 3600 }),
      revoke: async () => {},
    };
    setOutboundOAuthClient(stubClient);

    const reqState = 'state-partial-reconsent';
    const b = await getBackends();
    await b.connections.putRequest(APP_ID, {
      state: reqState,
      owner: OWNER,
      provider: 'microsoft',
      code_verifier: 'verifier',
      redirect_uri: 'https://app.example/connect/microsoft/callback',
      scopes: fullScopes,
      created_at: nowIso(),
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    const result = await completeConnect({
      appId: APP_ID,
      provider: 'microsoft',
      state: reqState,
      code: 'auth-code-reconsent',
    });

    // After the fix: stored scopes are the UNION — Mail.Send and Calendars.ReadWrite must survive.
    expect(result.connection.scopes).toContain('Mail.Send');
    expect(result.connection.scopes).toContain('Calendars.ReadWrite');
    expect(result.connection.scopes).toContain('Mail.Read');
    expect(result.connection.scopes).toContain('openid');
    expect(result.connection.scopes).toContain('email');
    // The new scopes from the callback are also present.
    expect(result.connection.scopes).toContain('offline_access');
  });

  it('DEMONSTRATES PRE-FIX BEHAVIOR: a plain overwrite would narrow the scope list', () => {
    // This test captures what the pre-fix code did — a raw overwrite with the callback's granted scopes —
    // so that a regression in the union logic causes this test to FAIL (restoring the dangerous overwrite).
    // It does NOT call the real completeConnect; it directly simulates the pre-fix overwrite.
    const previouslyStored = [
      'Calendars.ReadWrite',
      'Mail.Read',
      'Mail.Send',
      'email',
      'offline_access',
      'openid',
    ];
    const callbackGranted = ['email', 'offline_access', 'openid', 'Mail.Read']; // no Mail.Send, no Calendars

    // PRE-FIX: would have stored only callbackGranted
    const preFix = callbackGranted; // this is what `scopes: grantedScopes` (without union) used to do
    expect(preFix).not.toContain('Mail.Send');
    expect(preFix).not.toContain('Calendars.ReadWrite');

    // POST-FIX (what unionScopes now guarantees): no narrowing
    const postFix = unionScopes(previouslyStored, callbackGranted);
    expect(postFix).toContain('Mail.Send');
    expect(postFix).toContain('Calendars.ReadWrite');
    expect(postFix).toContain('Mail.Read');
  });
});
