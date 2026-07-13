import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { getBackends } from '../src/storage/backends';
import { executeCapability } from '../src/core/runtime';
import { registerConnectRoutes } from '../src/api/connect-routes';
import { SYSTEM_ACTOR } from '../src/shared/domain';
import { setSecret, sealValue } from '../src/plugins/secrets-local/index';
import * as authStore from '../src/plugins/auth-identity/store';
import { signSessionToken } from '../src/shared/session';
import {
  setGmailSender,
  resetGmailSender,
  buildGmailMime,
  toBase64Url,
  GMAIL_SEND_SCOPE,
  type GmailSender,
  type OutboundMessage,
} from '../src/plugins/message-gmail/index';
import type { Application, EmailDelivery } from '../src/resources/types';
import type { Connection } from '../src/connectors/types';
import { nowIso } from '../src/shared/time';

// C25 — SendMessage: send an outbound message AS a connected user (MVP: email via Google/Gmail). Exercised
// end-to-end with a STUB Gmail sender (no network) over the real C24 broker (a seeded, encrypted-at-rest
// connection) — so the broker→compose→send→persist path, the redaction/no-token-at-rest guarantees, the
// channel/provider dispatch, and every broker precondition (not connected / insufficient scope / reconnect)
// are validated without a socket.
const APP = 'demo';
const APP_ID = 'app_demo';
const OWNER = 'user_alice';
const SESSION_SECRET = 'send-message-test-session-secret';
const SERVICE_TOKEN = 'svc-token-abc';

let dir: string;
let prevDir: string | undefined;
let prevKey: string | undefined;
let prevAppName: string | undefined;
let sent: Array<{ message: OutboundMessage; token: string }>;

const seedApp = async (): Promise<void> => {
  const now = nowIso();
  await store.saveResource({
    id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
    name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web', language: 'typescript', package_manager: 'npm',
  } as Application);
};

// Seed a Google connection directly into the (encrypted) connections vault — tokens SEALED at rest, exactly
// as the real connect flow would store them.
async function seedConnection(opts: { owner?: string; scopes?: string[]; expiresInSec?: number; withRefresh?: boolean } = {}): Promise<void> {
  const owner = opts.owner ?? OWNER;
  const now = new Date();
  const conn: Connection = {
    owner,
    provider: 'google',
    access_sealed: await sealValue('access-token-live'),
    ...(opts.withRefresh === false ? {} : { refresh_sealed: await sealValue('refresh-token') }),
    access_expires_at: new Date(now.getTime() + (opts.expiresInSec ?? 3600) * 1000).toISOString(),
    scopes: opts.scopes ?? ['openid', 'email', GMAIL_SEND_SCOPE],
    status: 'connected',
    account_label: 'alice@gmail.test',
    connected_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  await (await getBackends()).connections.putConnection(APP_ID, conn);
}

// A C10 session cookie for a fresh user (the session-authenticated send path).
async function signIn(email = 'alice@demo.test'): Promise<{ userId: string; cookie: string }> {
  const user = await authStore.createUser(APP_ID, { email, email_verified: true });
  const session = await authStore.createSession(APP_ID, user.id, 3600);
  const token = signSessionToken({ userId: user.id, email: user.email, sessionId: session.id }, SESSION_SECRET);
  return { userId: user.id, cookie: `forge_session=${token}` };
}

// The capability input for a minimal send (app + owner explicit so we never depend on FORGE_APP_NAME).
const send = (over: Record<string, unknown> = {}) =>
  executeCapability('send-message', { app: APP, owner: OWNER, to: ['bob@example.test'], subject: 'Hello', body: 'Hi there', ...over }, SYSTEM_ACTOR);

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevKey = process.env.FORGE_SECRETS_KEY;
  prevAppName = process.env.FORGE_APP_NAME;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-send-message-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_SECRETS_KEY = 'send-message-test-master-key';
  process.env.FORGE_APP_NAME = APP;
  await store.init();
  await seedApp();
  await setSecret(APP_ID, 'AUTH_SESSION_SECRET', SESSION_SECRET);
  await setSecret(APP_ID, 'AUTH_SERVICE_TOKEN', SERVICE_TOKEN);
  await setSecret(APP_ID, 'GOOGLE_CONNECT_CLIENT_ID', 'google-connect-client');
  await setSecret(APP_ID, 'GOOGLE_CONNECT_CLIENT_SECRET', 'google-connect-secret');

  sent = [];
  const stub: GmailSender = {
    async send(message, token) {
      sent.push({ message, token });
      return { id: 'gmail-msg-1', threadId: 'thread-1' };
    },
  };
  setGmailSender(stub);
});

afterEach(async () => {
  resetGmailSender();
  const conns = (await getBackends()).connections;
  if (conns.__truncateAllForTests) await conns.__truncateAllForTests();
  if (prevDir === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prevDir;
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY; else process.env.FORGE_SECRETS_KEY = prevKey;
  if (prevAppName === undefined) delete process.env.FORGE_APP_NAME; else process.env.FORGE_APP_NAME = prevAppName;
  await rm(dir, { recursive: true, force: true });
});

describe('C25 — SendMessage: Gmail send (happy path)', () => {
  it('brokers a fresh token, sends via Gmail, and persists an owner-scoped sent record', async () => {
    await seedConnection();
    const { resource } = await send({ subject: 'Ship it', body: 'The build is green.' });
    const d = resource as EmailDelivery;

    expect(d.type).toBe('EmailDelivery');
    expect(d.status).toBe('sent');
    expect(d.owner).toBe(OWNER);
    expect(d.channel).toBe('email');
    expect(d.provider).toBe('google');
    expect(d.implementation).toBe('message-gmail');
    expect(d.message_id).toBe('gmail-msg-1');
    expect(d.thread_id).toBe('thread-1');
    expect(typeof d.sent_at).toBe('string');
    // Recipient is REDACTED at rest; no body / no token persisted.
    expect(d.to).toBe('b***@example.test');
    const json = JSON.stringify(d);
    expect(json).not.toContain('The build is green.');
    expect(json).not.toContain('access-token-live');

    // The stub received the FRESH broker token + the composed message (From = connected account label).
    expect(sent).toHaveLength(1);
    expect(sent[0]!.token).toBe('access-token-live');
    expect(sent[0]!.message.to).toEqual(['bob@example.test']);
    expect(sent[0]!.message.subject).toBe('Ship it');
    expect(sent[0]!.message.from).toBe('alice@gmail.test');
  });

  it('persists the record and emits a MessageSent fact', async () => {
    await seedConnection();
    const { resource } = await send();
    const d = resource as EmailDelivery;

    const found = await store.findResourceById(d.id);
    expect(found).not.toBeNull();
    const events = await store.listEvents({ resource_id: d.id });
    expect(events.map((e) => e.type)).toContain('MessageSent');
  });

  it('threads a reply (In-Reply-To + provider threadId) and passes cc/bcc + a multi-recipient redaction', async () => {
    await seedConnection();
    const { resource } = await send({
      to: ['bob@example.test', 'carol@example.test'],
      cc: ['dave@example.test'],
      in_reply_to: '<orig-123@mail.test>',
      thread_ref: 'gmail-thread-77',
    });
    const d = resource as EmailDelivery;
    expect(d.to).toBe('b***@example.test (+2 more)');
    expect(sent[0]!.message.cc).toEqual(['dave@example.test']);
    expect(sent[0]!.message.inReplyTo).toBe('<orig-123@mail.test>');
    expect(sent[0]!.message.threadId).toBe('gmail-thread-77');
  });

  it('scopes persisted sends by owner — user A never sees user B', async () => {
    await seedConnection({ owner: OWNER });
    await seedConnection({ owner: 'user_bob' });
    await send({ owner: OWNER });
    await send({ owner: 'user_bob' });
    const mine = await store.listResources({ type: 'EmailDelivery', owner: OWNER });
    const theirs = await store.listResources({ type: 'EmailDelivery', owner: 'user_bob' });
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect((mine[0] as EmailDelivery).owner).toBe(OWNER);
  });
});

describe('C25 — SendMessage: broker preconditions surface precise, actionable errors', () => {
  it('not connected → not_found (the app relays "connect Google")', async () => {
    await expect(send()).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(sent).toHaveLength(0);
  });

  it('connected without gmail.send → insufficient_scope (reconnect + grant send)', async () => {
    await seedConnection({ scopes: ['openid', 'email'] });
    await expect(send()).rejects.toMatchObject({ code: 'insufficient_scope', status: 403 });
    expect(sent).toHaveLength(0);
  });

  it('expired with no refresh token → reconnect_required', async () => {
    await seedConnection({ expiresInSec: -120, withRefresh: false });
    await expect(send()).rejects.toMatchObject({ code: 'reconnect_required', status: 409 });
    expect(sent).toHaveLength(0);
  });

  it('unsupported channel/provider → unsupported_channel (no broker call, no send)', async () => {
    await seedConnection();
    await expect(send({ channel: 'sms' })).rejects.toMatchObject({ code: 'unsupported_channel' });
    expect(sent).toHaveLength(0);
  });
});

describe('C25 — SendMessage: a provider rejection is RECORDED, never silently dropped', () => {
  it('persists status:failed with a scrubbed error and emits MessageFailed', async () => {
    await seedConnection();
    setGmailSender({
      async send() {
        // A Gmail error that echoes the recipient — must be scrubbed of PII when persisted.
        throw new Error('gmail send failed: 400 invalid recipient bob@example.test');
      },
    });
    const { resource } = await send();
    const d = resource as EmailDelivery;
    expect(d.status).toBe('failed');
    expect(d.error).toContain('gmail send failed');
    expect(d.error).not.toContain('bob@example.test');
    const events = await store.listEvents({ resource_id: d.id });
    expect(events.map((e) => e.type)).toContain('MessageFailed');
  });
});

describe('C25 — buildGmailMime (pure MIME composition)', () => {
  it('composes headers, recipients, threading, and a base64url-round-trippable body', () => {
    const msg: OutboundMessage = {
      from: 'alice@gmail.test',
      to: ['a@x.test', 'b@y.test'],
      cc: ['c@z.test'],
      bcc: ['d@w.test'],
      subject: 'Héllo',
      body: 'Hello world',
      contentType: 'text',
      inReplyTo: '<orig-1@mail.test>',
    };
    const mime = buildGmailMime(msg);
    expect(mime).toContain('From: alice@gmail.test');
    expect(mime).toContain('To: a@x.test, b@y.test');
    expect(mime).toContain('Cc: c@z.test');
    expect(mime).toContain('Bcc: d@w.test');
    expect(mime).toContain('In-Reply-To: <orig-1@mail.test>');
    expect(mime).toContain('References: <orig-1@mail.test>'); // defaults to In-Reply-To
    expect(mime).toContain('MIME-Version: 1.0');
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?/); // non-ASCII subject is RFC 2047 encoded

    const html = buildGmailMime({ to: ['a@x.test'], subject: 's', body: '<b>hi</b>', contentType: 'html' });
    expect(html).toContain('Content-Type: text/html; charset=UTF-8');

    const raw = toBase64Url('hello');
    expect(Buffer.from(raw, 'base64url').toString('utf8')).toBe('hello');
  });
});

describe('C25 — POST /connect/:provider/send (authenticated route)', () => {
  let server: FastifyInstance;
  beforeEach(async () => {
    server = Fastify({ logger: false });
    registerConnectRoutes(server, { defaultApp: () => APP });
    await server.ready();
  });
  afterEach(async () => {
    await server.close();
  });

  it('service token + owner → 200 sent', async () => {
    await seedConnection();
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/send',
      headers: { 'x-forge-service-token': SERVICE_TOKEN, 'content-type': 'application/json' },
      payload: { owner: OWNER, to: ['bob@example.test'], subject: 'Hi', body: 'Hello' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().message.status).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('no auth → 401', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/send',
      headers: { 'content-type': 'application/json' },
      payload: { owner: OWNER, to: ['bob@example.test'], subject: 'Hi', body: 'Hello' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('service token WITHOUT owner → 422', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/send',
      headers: { 'x-forge-service-token': SERVICE_TOKEN, 'content-type': 'application/json' },
      payload: { to: ['bob@example.test'], subject: 'Hi', body: 'Hello' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('session cookie → 200 sent, owner from the session', async () => {
    const { userId, cookie } = await signIn();
    await seedConnection({ owner: userId });
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/send',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { to: ['bob@example.test'], subject: 'Hi', body: 'Hello' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().message.owner).toBe(userId);
  });

  it('service token + owner but not connected → 404 (relayable "reconnect")', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/connect/google/send',
      headers: { 'x-forge-service-token': SERVICE_TOKEN, 'content-type': 'application/json' },
      payload: { owner: OWNER, to: ['bob@example.test'], subject: 'Hi', body: 'Hello' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});
