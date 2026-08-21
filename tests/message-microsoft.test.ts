// tests/message-microsoft.test.ts
//
// Covers: (1) message-microsoft plugin unit tests (buildGraphSendBody, sanitizeError),
// (2) send-message senders.ts dispatch to email:microsoft, (3) accountLabelFrom
// preferred_username fallback for personal MSA accounts, (4) unionScopes, and critically
// (5) the scope-narrowing guard in completeConnect — a partial Microsoft re-consent
// CANNOT narrow the stored scope set (Microsoft has no include_granted_scopes equivalent).
// Also verifies the C25 send-message capability end-to-end via the Microsoft Graph path.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { SYSTEM_ACTOR } from '../src/shared/domain';
import { executeCapability } from '../src/core/runtime';
import { nowIso } from '../src/shared/time';
import type { Application, EmailDelivery } from '../src/resources/types';

// Plugin under test
import {
  buildGraphSendBody,
  sanitizeError,
  setGraphMailSender,
  resetGraphMailSender,
  MSGRAPH_SEND_SCOPE,
} from '../src/plugins/message-microsoft/index';
import type { GraphMailSender } from '../src/plugins/message-microsoft/index';

// Senders dispatch
import { resolveSender, supportedRoutes } from '../src/capabilities/send-message/senders';

// OAuth client (for accountLabelFrom + swappable client)
import {
  accountLabelFrom,
  setOutboundOAuthClient,
  resetOutboundOAuthClient,
} from '../src/connectors/oauth-client';
import type { OutboundOAuthClient } from '../src/connectors/oauth-client';
import { providerDescriptor } from '../src/connectors/providers';

// Service layer (scope-narrowing test)
import { completeConnect, unionScopes, startConnect } from '../src/connectors/service';
import { getBackends } from '../src/storage/backends';

// Secrets (to seal tokens when seeding a Connection directly)
import { sealValue } from '../src/plugins/secrets-local/index';

// ─── Global setup ──────────────────────────────────────────────────────────────

const SECRETS_KEY = 'test-master-key-microsoft-suite-32bytes!!';
let prevSecretsKey: string | undefined;

beforeAll(() => {
  prevSecretsKey = process.env.FORGE_SECRETS_KEY;
  process.env.FORGE_SECRETS_KEY = SECRETS_KEY;
});

afterAll(() => {
  if (prevSecretsKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevSecretsKey;
});

// ─── Helper: craft a minimal unsigned JWT (no sig verification needed) ─────────

function fakeIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

// ─── 1. buildGraphSendBody unit tests ─────────────────────────────────────────

describe('buildGraphSendBody', () => {
  it('builds a plain-text message with a single recipient', () => {
    const result = buildGraphSendBody({
      to: ['alice@example.com'],
      subject: 'Hello',
      body: 'World',
    });
    expect(result.message.subject).toBe('Hello');
    expect(result.message.body.contentType).toBe('Text');
    expect(result.message.body.content).toBe('World');
    expect(result.message.toRecipients).toEqual([{ emailAddress: { address: 'alice@example.com' } }]);
    expect(result.message.ccRecipients).toBeUndefined();
    expect(result.message.bccRecipients).toBeUndefined();
    expect(result.message.internetMessageHeaders).toBeUndefined();
  });

  it('sets contentType HTML when content_type is html', () => {
    const result = buildGraphSendBody({
      to: ['alice@example.com'],
      subject: 'Hi',
      body: '<p>Hello</p>',
      contentType: 'html',
    });
    expect(result.message.body.contentType).toBe('HTML');
    expect(result.message.body.content).toBe('<p>Hello</p>');
  });

  it('includes ccRecipients and bccRecipients when set', () => {
    const result = buildGraphSendBody({
      to: ['alice@example.com'],
      cc: ['bob@example.com'],
      bcc: ['carol@example.com'],
      subject: 'Test',
      body: 'Body',
    });
    expect(result.message.ccRecipients).toEqual([{ emailAddress: { address: 'bob@example.com' } }]);
    expect(result.message.bccRecipients).toEqual([{ emailAddress: { address: 'carol@example.com' } }]);
  });

  it('parses display name from "Name <addr>" format', () => {
    const result = buildGraphSendBody({
      to: ['Alice Smith <alice@example.com>'],
      subject: 'Test',
      body: 'Body',
    });
    expect(result.message.toRecipients[0]).toEqual({
      emailAddress: { name: 'Alice Smith', address: 'alice@example.com' },
    });
  });

  it('threads a reply via conversationId (maps threadId → conversationId)', () => {
    const result = buildGraphSendBody({
      to: ['alice@example.com'],
      subject: 'Re: Test',
      body: 'Reply',
      threadId: 'thread-abc-123',
    });
    expect(result.message.conversationId).toBe('thread-abc-123');
  });

  it('adds In-Reply-To and References headers when inReplyTo is set', () => {
    const result = buildGraphSendBody({
      to: ['alice@example.com'],
      subject: 'Re: Test',
      body: 'Reply',
      inReplyTo: '<msg123@example.com>',
    });
    const headers = result.message.internetMessageHeaders ?? [];
    expect(headers).toContainEqual({ name: 'In-Reply-To', value: '<msg123@example.com>' });
    // References defaults to inReplyTo when not supplied (RFC 5322 guidance)
    expect(headers).toContainEqual({ name: 'References', value: '<msg123@example.com>' });
  });

  it('uses the explicit references chain when supplied', () => {
    const result = buildGraphSendBody({
      to: ['alice@example.com'],
      subject: 'Re: Chain',
      body: 'Reply',
      inReplyTo: '<msg2@example.com>',
      references: '<msg1@example.com> <msg2@example.com>',
    });
    const headers = result.message.internetMessageHeaders ?? [];
    expect(headers).toContainEqual({ name: 'References', value: '<msg1@example.com> <msg2@example.com>' });
    expect(headers).toContainEqual({ name: 'In-Reply-To', value: '<msg2@example.com>' });
  });
});

// ─── 2. sanitizeError unit tests ──────────────────────────────────────────────

describe('sanitizeError', () => {
  it('redacts an email address in an error message', () => {
    const result = sanitizeError('mailbox full for user@example.com');
    expect(result).not.toContain('user@example.com');
    expect(result).toContain('u***@example.com');
  });

  it('redacts a Bearer token', () => {
    const result = sanitizeError('graph mail send failed: Bearer eyJfoo.bar.baz returned 401');
    expect(result).not.toContain('eyJfoo.bar.baz');
    expect(result).toContain('Bearer ***');
  });

  it('leaves safe error text unchanged', () => {
    const msg = 'graph mail send failed: 429 TooManyRequests';
    expect(sanitizeError(msg)).toBe(msg);
  });
});

// ─── 3. Senders dispatch ──────────────────────────────────────────────────────

describe('send-message senders dispatch (email:microsoft)', () => {
  it('resolveSender("email","microsoft") returns a complete descriptor', () => {
    const d = resolveSender('email', 'microsoft');
    expect(d).not.toBeNull();
    expect(d!.channel).toBe('email');
    expect(d!.provider).toBe('microsoft');
    expect(d!.implementation).toBe('message-microsoft');
    expect(d!.requireScope).toBe(MSGRAPH_SEND_SCOPE); // 'Mail.Send'
    expect(typeof d!.send).toBe('function');
  });

  it('supportedRoutes() includes both email:google and email:microsoft', () => {
    const routes = supportedRoutes();
    expect(routes).toContainEqual({ channel: 'email', provider: 'google' });
    expect(routes).toContainEqual({ channel: 'email', provider: 'microsoft' });
  });

  it('resolveSender returns null for an unknown channel:provider pair', () => {
    expect(resolveSender('sms', 'unknown')).toBeNull();
    expect(resolveSender('email', 'twilio')).toBeNull();
  });
});

// ─── 4. accountLabelFrom — preferred_username fallback ────────────────────────

describe('accountLabelFrom — Microsoft preferred_username fallback', () => {
  const msDesc = providerDescriptor('microsoft')!;
  const googleDesc = providerDescriptor('google')!;

  it('uses the email claim for a work/school Microsoft account (both claims present → email wins)', () => {
    const token = fakeIdToken({ email: 'user@company.onmicrosoft.com', preferred_username: 'alias@company' });
    expect(accountLabelFrom(msDesc, token)).toBe('user@company.onmicrosoft.com');
  });

  it('falls back to preferred_username for a personal MSA account (email claim absent)', () => {
    const token = fakeIdToken({ preferred_username: 'user@outlook.com' }); // no email claim
    expect(accountLabelFrom(msDesc, token)).toBe('user@outlook.com');
  });

  it('returns undefined when neither email nor preferred_username is present', () => {
    const token = fakeIdToken({ sub: 'some-opaque-sub', name: 'John' });
    expect(accountLabelFrom(msDesc, token)).toBeUndefined();
  });

  it('Google descriptor has only email in its claim chain — preferred_username is not a fallback', () => {
    // Google account_label_claims = ['email']; preferred_username is not in the list.
    const token = fakeIdToken({ preferred_username: 'guser' }); // no email claim
    expect(accountLabelFrom(googleDesc, token)).toBeUndefined();
  });

  it('returns undefined for a malformed token string', () => {
    expect(accountLabelFrom(msDesc, 'not-a-jwt')).toBeUndefined();
    expect(accountLabelFrom(msDesc, undefined)).toBeUndefined();
  });
});

// ─── 5. unionScopes ───────────────────────────────────────────────────────────

describe('unionScopes', () => {
  it('returns the set-union of two disjoint lists', () => {
    const result = unionScopes(['A', 'B'], ['C']);
    expect(result).toContain('A');
    expect(result).toContain('B');
    expect(result).toContain('C');
    expect(result).toHaveLength(3);
  });

  it('preserves the wider existing set when incoming is a strict subset', () => {
    const existing = ['Mail.Read', 'Mail.Send', 'Calendars.ReadWrite', 'openid'];
    const incoming = ['Mail.Read', 'openid']; // Mail.Send + Calendars.ReadWrite dropped
    const result = unionScopes(existing, incoming);
    expect(result).toContain('Mail.Send'); // preserved — never lost
    expect(result).toContain('Calendars.ReadWrite'); // preserved
    expect(result).toContain('Mail.Read'); // still present
  });

  it('handles empty existing gracefully', () => {
    expect(unionScopes([], ['openid', 'email'])).toEqual(['email', 'openid']);
  });

  it('handles empty incoming gracefully (returns a sorted copy of existing)', () => {
    expect(unionScopes(['email', 'openid'], [])).toEqual(['email', 'openid']);
  });

  it('deduplicates overlapping entries', () => {
    const result = unionScopes(['openid', 'email'], ['openid', 'Mail.Send']);
    expect(result.filter((s) => s === 'openid').length).toBe(1); // no duplicate
  });

  it('result is sorted for deterministic storage', () => {
    const result = unionScopes(['Mail.Send', 'openid'], ['Mail.Read', 'email']);
    expect(result).toEqual([...result].sort());
  });
});

// ─── 6. Scope-narrowing guard — partial Microsoft re-consent cannot narrow stored scopes ──

// This is the KEY acceptance criterion. Microsoft has no `include_granted_scopes` equivalent,
// so the `completeConnect` implementation must take the UNION of the existing and incoming scope
// sets instead of overwriting — otherwise a user clicking "allow" for only Mail.Read on a
// second consent silently revokes Mail.Send, breaking the C25 send path.

describe('scope-narrowing guard — completeConnect must preserve the superset', () => {
  let dir: string;
  let prevState: string | undefined;
  let prevMsId: string | undefined;
  let prevMsSecret: string | undefined;

  const APP_ID = 'app_ms_scope_guard_test';
  const OWNER = 'user-scope-guard';

  // Full scopes the user grants on first connect (all six default scopes)
  const FULL_SCOPE_STR = 'Calendars.ReadWrite Mail.Read Mail.Send email offline_access openid';
  // Partial re-consent: only Mail.Read granted (Mail.Send + Calendars.ReadWrite dropped by the user)
  const NARROW_SCOPE_STR = 'Mail.Read email offline_access openid';

  beforeEach(async () => {
    prevState = process.env.FORGE_STATE_DIR;
    prevMsId = process.env.MICROSOFT_CONNECT_CLIENT_ID;
    prevMsSecret = process.env.MICROSOFT_CONNECT_CLIENT_SECRET;

    dir = await mkdtemp(path.join(tmpdir(), 'forge-ms-scope-guard-'));
    process.env.FORGE_STATE_DIR = dir;
    // Provide fake OAuth client credentials so resolveProvider succeeds (env fallback path).
    process.env.MICROSOFT_CONNECT_CLIENT_ID = 'fake-ms-client-id';
    process.env.MICROSOFT_CONNECT_CLIENT_SECRET = 'fake-ms-client-secret';

    await store.init();
  });

  afterEach(async () => {
    resetOutboundOAuthClient();
    if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
    else process.env.FORGE_STATE_DIR = prevState;
    if (prevMsId === undefined) delete process.env.MICROSOFT_CONNECT_CLIENT_ID;
    else process.env.MICROSOFT_CONNECT_CLIENT_ID = prevMsId;
    if (prevMsSecret === undefined) delete process.env.MICROSOFT_CONNECT_CLIENT_SECRET;
    else process.env.MICROSOFT_CONNECT_CLIENT_SECRET = prevMsSecret;
    await rm(dir, { recursive: true, force: true });
  });

  it('partial re-consent cannot narrow the stored scope list — Mail.Send is preserved', async () => {
    let exchangeCall = 0;

    // A mock OAuth client: the first exchange returns full scopes, the second returns only a subset.
    const mockClient: OutboundOAuthClient = {
      authorizeUrl({ state }) {
        return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=${state}`;
      },
      async exchangeCode() {
        exchangeCall++;
        return {
          access_token: `access-tok-${exchangeCall}`,
          refresh_token: `refresh-tok-${exchangeCall}`,
          expires_in: 3600,
          // First consent: full scope grant. Second: partial re-consent (user unchecked Mail.Send).
          scope: exchangeCall === 1 ? FULL_SCOPE_STR : NARROW_SCOPE_STR,
        };
      },
      async refresh() {
        return { access_token: 'refreshed', expires_in: 3600 };
      },
      async revoke() {},
    };
    setOutboundOAuthClient(mockClient);

    // ── Step 1: initial connect — full scope grant ─────────────────────────────
    const { state: state1 } = await startConnect({
      appId: APP_ID,
      owner: OWNER,
      provider: 'microsoft',
      redirectUri: 'https://app.test/connect/microsoft/callback',
    });
    const result1 = await completeConnect({
      appId: APP_ID,
      provider: 'microsoft',
      state: state1,
      code: 'auth-code-1',
    });

    // Confirm first connect stored the full scope set
    expect(result1.connection.scopes).toContain('Mail.Send');
    expect(result1.connection.scopes).toContain('Calendars.ReadWrite');
    expect(result1.connection.scopes).toContain('Mail.Read');

    // ── Step 2: partial re-consent — user grants only Mail.Read ───────────────
    const { state: state2 } = await startConnect({
      appId: APP_ID,
      owner: OWNER,
      provider: 'microsoft',
      redirectUri: 'https://app.test/connect/microsoft/callback',
    });
    const result2 = await completeConnect({
      appId: APP_ID,
      provider: 'microsoft',
      state: state2,
      code: 'auth-code-2', // second exchange returns NARROW_SCOPE_STR
    });

    // THE GUARD: the stored scope list MUST be the SUPERSET — not the narrower incoming set.
    // Mail.Send and Calendars.ReadWrite were in the first grant and must still be stored.
    expect(result2.connection.scopes).toContain('Mail.Send'); // preserved from grant 1
    expect(result2.connection.scopes).toContain('Calendars.ReadWrite'); // preserved from grant 1
    expect(result2.connection.scopes).toContain('Mail.Read'); // present in both grants
    expect(result2.connection.scopes).toContain('openid'); // present in both grants

    // Sanity check: the narrower grant string alone would have lost Mail.Send
    const naiveOverwrite = NARROW_SCOPE_STR.split(' ');
    expect(naiveOverwrite).not.toContain('Mail.Send'); // proves the guard is non-trivial
    expect(naiveOverwrite).not.toContain('Calendars.ReadWrite');
  });
});

// ─── 7. C25 send-message via email:microsoft ──────────────────────────────────

describe('C25 send-message capability via email:microsoft', () => {
  let dir: string;
  let prevState: string | undefined;

  const APP_NAME = 'ms-send-test';
  const APP_ID = `app_${APP_NAME}`;
  const OWNER = 'user-ms-send-owner';

  async function seedApp(): Promise<Application> {
    const now = nowIso();
    const app: Application = {
      id: APP_ID,
      type: 'Application',
      app_id: APP_ID,
      created_at: now,
      updated_at: now,
      name: APP_NAME,
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

  // Write a Connection with a valid (unexpired) access token directly into the connections
  // backend — skipping the full OAuth round-trip so we test only the broker + send path.
  async function seedMicrosoftConnection(
    opts: {
      scopes?: string[];
      expiresInSeconds?: number;
      accountLabel?: string;
    } = {},
  ): Promise<void> {
    const scopes = opts.scopes ?? [
      'Calendars.ReadWrite',
      'Mail.Read',
      'Mail.Send',
      'email',
      'offline_access',
      'openid',
    ];
    const now = nowIso();
    const expiresAt = new Date(Date.now() + (opts.expiresInSeconds ?? 3600) * 1000).toISOString();
    const backend = await getBackends();
    await backend.connections.putConnection(APP_ID, {
      owner: OWNER,
      provider: 'microsoft',
      access_sealed: await sealValue('fake-ms-access-token'),
      refresh_sealed: await sealValue('fake-ms-refresh-token'),
      access_expires_at: expiresAt,
      scopes,
      status: 'connected',
      ...(opts.accountLabel ? { account_label: opts.accountLabel } : {}),
      connected_at: now,
      updated_at: now,
    });
  }

  beforeEach(async () => {
    prevState = process.env.FORGE_STATE_DIR;
    dir = await mkdtemp(path.join(tmpdir(), 'forge-ms-c25-'));
    process.env.FORGE_STATE_DIR = dir;
    await store.init();
  });

  afterEach(async () => {
    resetGraphMailSender();
    if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
    else process.env.FORGE_STATE_DIR = prevState;
    await rm(dir, { recursive: true, force: true });
  });

  it('happy path: brokers a fresh token → calls Graph sender → persists sent EmailDelivery', async () => {
    await seedApp();
    await seedMicrosoftConnection({ accountLabel: 'user@outlook.com' });

    // Capture what the stub receives to verify the broker handed the right token
    let capturedToken: string | undefined;
    const stub: GraphMailSender = {
      async send(_message, accessToken) {
        capturedToken = accessToken;
        return { id: 'graph-msg-id-001' };
      },
    };
    setGraphMailSender(stub);

    const { capability, resource } = await executeCapability(
      'send-message',
      {
        app: APP_NAME,
        owner: OWNER,
        provider: 'microsoft',
        channel: 'email',
        to: ['recipient@example.com'],
        subject: 'Test Graph send',
        body: 'Hello from Microsoft Graph',
      },
      SYSTEM_ACTOR,
    );
    const delivery = resource as EmailDelivery;

    // Broker handed the stub the unsealed access token (the real one, not ciphertext)
    expect(capturedToken).toBe('fake-ms-access-token');

    expect(capability).toBe('SendMessage');
    expect(delivery.type).toBe('EmailDelivery');
    expect(delivery.status).toBe('sent');
    expect(delivery.message_id).toBe('graph-msg-id-001');
    expect(delivery.channel).toBe('email');
    expect(delivery.provider).toBe('microsoft');
    expect(delivery.implementation).toBe('message-microsoft');
    expect(delivery.owner).toBe(OWNER);
    expect(delivery.subject).toBe('Test Graph send');

    // Recipient is REDACTED at rest — no PII stored
    expect(delivery.to).toBe('r***@example.com');
    expect(delivery.to).not.toContain('recipient@example.com');

    // No body or token persisted
    const json = JSON.stringify(delivery);
    expect(json).not.toContain('Hello from Microsoft Graph');
    expect(json).not.toContain('fake-ms-access-token');

    // Survives a re-read from disk
    const reread = await store.getResource('EmailDelivery', delivery.id);
    expect((reread as EmailDelivery)?.status).toBe('sent');
  });

  it('emits a MessageSent event with redacted recipient and correct fields', async () => {
    await seedApp();
    await seedMicrosoftConnection();

    setGraphMailSender({
      async send() {
        return { id: 'graph-msg-id-002' };
      },
    });

    await executeCapability(
      'send-message',
      {
        app: APP_NAME,
        owner: OWNER,
        provider: 'microsoft',
        channel: 'email',
        to: ['alice@example.com'],
        subject: 'Event emission test',
        body: 'Body content',
      },
      SYSTEM_ACTOR,
    );

    const events = await store.listEvents({ app_id: APP_ID });
    const sent = events.find((e) => e.type === 'MessageSent');
    expect(sent).toBeTruthy();
    expect(sent!.data.provider).toBe('microsoft');
    expect(sent!.data.channel).toBe('email');
    expect(sent!.data.implementation).toBe('message-microsoft');
    expect(sent!.data.message_id).toBe('graph-msg-id-002');
    expect(sent!.data.to).toBe('a***@example.com'); // redacted
    expect(sent!.data.subject).toBe('Event emission test');

    // No full recipient address or body in the event
    const eventJson = JSON.stringify(sent);
    expect(eventJson).not.toContain('alice@example.com');
    expect(eventJson).not.toContain('Body content');
  });

  it('provider error: persists a failed EmailDelivery + emits MessageFailed without throwing', async () => {
    await seedApp();
    await seedMicrosoftConnection();

    setGraphMailSender({
      async send() {
        throw new Error('graph mail send failed: 429 TooManyRequests');
      },
    });

    const { resource } = await executeCapability(
      'send-message',
      {
        app: APP_NAME,
        owner: OWNER,
        provider: 'microsoft',
        channel: 'email',
        to: ['bob@example.com'],
        subject: 'Rate limited send',
        body: 'Body',
      },
      SYSTEM_ACTOR,
    );
    const delivery = resource as EmailDelivery;

    expect(delivery.status).toBe('failed');
    expect(delivery.error).toContain('429');
    expect(delivery.message_id).toBeUndefined();
    expect(delivery.channel).toBe('email');
    expect(delivery.provider).toBe('microsoft');

    const events = await store.listEvents({ app_id: APP_ID });
    const failed = events.find((e) => e.type === 'MessageFailed');
    expect(failed).toBeTruthy();
    expect(failed!.data.provider).toBe('microsoft');
    expect(failed!.data.error).toContain('429');
  });

  it('broker not-connected: throws not_found — no EmailDelivery is persisted', async () => {
    await seedApp();
    // Deliberately NO connection seeded for this owner

    setGraphMailSender({
      async send() {
        // Should never be reached
        return { id: 'should-not-be-called' };
      },
    });

    await expect(
      executeCapability(
        'send-message',
        {
          app: APP_NAME,
          owner: OWNER,
          provider: 'microsoft',
          channel: 'email',
          to: ['carol@example.com'],
          subject: 'No connection',
          body: 'Body',
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });

    // A precondition failure before any send attempt must leave no delivery record
    const resources = await store.listResources({ type: 'EmailDelivery', app_id: APP_ID });
    expect(resources).toHaveLength(0);
  });

  it('broker insufficient_scope: throws before send — no EmailDelivery persisted', async () => {
    await seedApp();
    // Seed a connection WITHOUT Mail.Send scope
    await seedMicrosoftConnection({ scopes: ['openid', 'email', 'offline_access', 'Mail.Read'] });

    setGraphMailSender({
      async send() {
        return { id: 'should-not-be-called' };
      },
    });

    await expect(
      executeCapability(
        'send-message',
        {
          app: APP_NAME,
          owner: OWNER,
          provider: 'microsoft',
          channel: 'email',
          to: ['dave@example.com'],
          subject: 'Scope missing',
          body: 'Body',
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'insufficient_scope', status: 403 });

    const resources = await store.listResources({ type: 'EmailDelivery', app_id: APP_ID });
    expect(resources).toHaveLength(0);
  });
});
