import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { registerOAuthRoutes } from '../src/api/oauth-routes';
import { getBackends } from '../src/storage/backends';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';

// ── redirect_uri fix regression tests ─────────────────────────────────────────
//
// HISTORY OF THE BUG: The original DCR handler used Array.filter() to silently
// drop non-http(s) URIs. A client sending ["custom://whatever"] got a 201 with
// an EMPTY redirect_uris list stored — so the authorize step 400'd because the
// valid URI sent later couldn't be matched.
//
// THE FIX: detect ANY invalid URI and reject (400) the whole registration.
//
// GUARD PRINCIPLE: each RED-annotated test describes what the OLD code returned;
// if the annotation says "OLD: 201", a green test against old code would mean
// it returned 201 where we expect 400. If this test ever goes green on old code,
// the fix is not actually in place.

const APP = 'redir_test_app';
const APP_ID = 'app_redir_test';

let dir: string;
let prevDir: string | undefined;
let prevSecret: string | undefined;
let server: FastifyInstance;

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

const post = (url: string, payload: unknown) =>
  server.inject({ method: 'POST', url, payload: payload as object });
const get = (url: string, query?: Record<string, string>) => server.inject({ method: 'GET', url, query });

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevSecret = process.env.AUTH_SESSION_SECRET;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-redir-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.AUTH_SESSION_SECRET = 'test-redir-session-secret';
  await store.init();
  await seedApp();
  server = Fastify({ logger: false });
  registerOAuthRoutes(server, { defaultApp: () => APP });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  if (prevDir === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevDir;
  if (prevSecret === undefined) delete process.env.AUTH_SESSION_SECRET;
  else process.env.AUTH_SESSION_SECRET = prevSecret;
  await rm(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — The fix: non-http(s) URIs must be REJECTED, not silently dropped
// ─────────────────────────────────────────────────────────────────────────────

describe('DCR redirect_uri validation (POST /oauth/register)', () => {
  // RED against old code: old code returned 201 (silently filtered the URI out)
  it('FIXED: rejects registration with a non-http(s) redirect_uri (OLD: 201, FIXED: 400)', async () => {
    const res = await post('/oauth/register', {
      client_name: 'Bad URI Client',
      redirect_uris: ['custom://my-app/callback'],
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; error_description: string }>();
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toContain('http(s)');
  });

  // RED against old code: old code 201'd and stored ['https://example.com/cb'] (dropped 'custom://bad')
  it('FIXED: rejects when the array mixes valid and invalid URIs (400)', async () => {
    const res = await post('/oauth/register', {
      client_name: 'Mixed URI Client',
      redirect_uris: ['https://example.com/cb', 'custom://bad'],
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string; error_description: string }>();
    expect(body.error).toBe('invalid_redirect_uri');
    expect(body.error_description).toContain('custom://bad');
  });

  it('rejects when redirect_uris is an empty array (400)', async () => {
    const res = await post('/oauth/register', {
      client_name: 'Empty URI Client',
      redirect_uris: [],
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects when redirect_uris is absent (400)', async () => {
    const res = await post('/oauth/register', { client_name: 'No URI Client' });
    expect(res.statusCode).toBe(400);
  });

  // ── Positive: valid http(s) URIs succeed ────────────────────────────────────
  it('allows registration with a valid https redirect_uri (201)', async () => {
    const res = await post('/oauth/register', {
      client_name: 'Good HTTPS Client',
      redirect_uris: ['https://example.com/callback'],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ client_id: string; redirect_uris: string[] }>();
    expect(body.client_id).toMatch(/^mcpc_/);
    expect(body.redirect_uris).toEqual(['https://example.com/callback']);
  });

  it('allows registration with a valid http://127.0.0.1 redirect_uri (201)', async () => {
    const res = await post('/oauth/register', {
      client_name: 'Localhost Client',
      redirect_uris: ['http://127.0.0.1:9000/callback'],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ redirect_uris: string[] }>();
    expect(body.redirect_uris).toEqual(['http://127.0.0.1:9000/callback']);
  });

  it('stores EXACTLY what was sent — no silent modifications', async () => {
    const uris = ['https://example.com/cb1', 'https://example.com/cb2'];
    const res = await post('/oauth/register', {
      client_name: 'Multi URI Client',
      redirect_uris: uris,
    });
    expect(res.statusCode).toBe(201);
    const { client_id } = res.json<{ client_id: string }>();

    // Verify via the ACTIVE backend (FS or PG, whichever the route used) — stored list MUST equal
    // the sent list exactly. Using getBackends().mcp mirrors what the route wrote to, so the
    // check works on both the filesystem and Postgres backends.
    const activeMcp = (await getBackends()).mcp;
    const stored = await activeMcp.getClient(APP_ID, client_id);
    expect(stored?.redirect_uris).toEqual(uris);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Register→authorize round-trip guard (FS backend)
//
// This is the end-to-end guard for the original bug:
//   1. Register with http://127.0.0.1:PORT/callback  → MUST return 201
//   2. Start authorize with the same redirect_uri    → MUST NOT 400 with invalid_redirect_uri
//
// RED against old code: old code 201'd with [] stored, then authorize 400'd with
// "redirect_uri not registered" (or the consent page returned an error page).
// ─────────────────────────────────────────────────────────────────────────────

describe('register → authorize round-trip (FS backend)', () => {
  it('FIXED: http://127.0.0.1 callback registered and recognized at /authorize', async () => {
    const redirectUri = 'http://127.0.0.1:9001/callback';

    // Step 1: Register — must succeed with 201
    const regRes = await post('/oauth/register', {
      client_name: 'Loopback Client',
      redirect_uris: [redirectUri],
    });
    expect(regRes.statusCode).toBe(201);
    const { client_id } = regRes.json<{ client_id: string }>();

    // Step 2: PKCE S256 code_challenge (real base64url-encoded sha256 of 'dBjftJeZ4CVP...')
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cg';

    // Step 3: Start authorize — the redirect_uri must be recognized (NOT 400 with redirect_uri error)
    const authRes = await get('/oauth/authorize', {
      response_type: 'code',
      client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'test-state-abc',
    });

    // Acceptable: 302 (redirect to login — unauthenticated) or 200 (login page rendered).
    // NOT acceptable: 400 with invalid_redirect_uri / redirect_uri_mismatch
    if (authRes.statusCode === 400) {
      const body = authRes.json<{ error?: string }>();
      // Surface the actual error so a failure is informative
      expect(body.error).not.toBe('invalid_redirect_uri');
      expect(body.error).not.toBe('redirect_uri_mismatch');
    }
    expect([200, 302, 303]).toContain(authRes.statusCode);
  });

  it('FIXED: stored redirect_uris list matches sent list exactly (integrity check)', async () => {
    const redirectUri = 'http://127.0.0.1:9002/callback';

    const regRes = await post('/oauth/register', {
      client_name: 'Integrity Client',
      redirect_uris: [redirectUri],
    });
    expect(regRes.statusCode).toBe(201);
    const { client_id } = regRes.json<{ client_id: string }>();

    // CRITICAL: the backend list must not be empty or different from what was sent.
    // Read from the ACTIVE backend (same one the route wrote to — FS or PG depending on env).
    const activeMcp = (await getBackends()).mcp;
    const stored = await activeMcp.getClient(APP_ID, client_id);
    expect(stored?.redirect_uris).toEqual([redirectUri]);
  });

  it('authorize rejects an unregistered redirect_uri even when a valid one is stored', async () => {
    // Register with uri A; try to authorize with uri B — must be rejected
    const registeredUri = 'https://example.com/real-callback';
    const wrongUri = 'https://attacker.com/steal-code';

    const regRes = await post('/oauth/register', {
      client_name: 'Open-Redirect Guard',
      redirect_uris: [registeredUri],
    });
    expect(regRes.statusCode).toBe(201);
    const { client_id } = regRes.json<{ client_id: string }>();

    const authRes = await get('/oauth/authorize', {
      response_type: 'code',
      client_id,
      redirect_uri: wrongUri, // not registered
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cg',
      code_challenge_method: 'S256',
      state: 'state-xyz',
    });
    // Server MUST reject or render an error — NEVER redirect to wrongUri
    expect(authRes.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — PG backend guard (self-skips when PG unavailable)
// ─────────────────────────────────────────────────────────────────────────────

const HAS_PG = process.env.FORGE_MCP_BACKEND === 'postgres' && Boolean(process.env.FORGE_DB_URL);

describe.skipIf(!HAS_PG)('register → authorize round-trip (PG backend)', () => {
  let pgBackend: import('../src/storage/backends/mcp/pg').PgMcpBackend;
  let pool: import('pg').Pool;

  beforeEach(async () => {
    const { Pool } = await import('pg');
    const { PgMcpBackend, ensureMcpSchema } = await import('../src/storage/backends/mcp/pg');
    pool = new Pool({ connectionString: process.env.FORGE_DB_URL });
    await ensureMcpSchema(pool);
    pgBackend = new PgMcpBackend(pool);
    await pgBackend.__truncateAllForTests?.();
  });
  afterEach(async () => {
    await pgBackend.__truncateAllForTests?.();
    await pool.end();
  });

  it('PG: stored redirect_uris round-trip is lossless (JSONB)', async () => {
    const redirectUri = 'http://127.0.0.1:9003/callback';

    const regRes = await post('/oauth/register', {
      client_name: 'PG Loopback Client',
      redirect_uris: [redirectUri],
    });
    expect(regRes.statusCode).toBe(201);
    const { client_id } = regRes.json<{ client_id: string }>();

    // Retrieve from PG directly to confirm JSONB round-trip is lossless
    const stored = await pgBackend.getClient(APP_ID, client_id);
    expect(stored?.redirect_uris).toEqual([redirectUri]);
  });

  it('PG: authorize accepts the http://127.0.0.1 callback registered via DCR', async () => {
    const redirectUri = 'http://127.0.0.1:9004/callback';

    const regRes = await post('/oauth/register', {
      client_name: 'PG Round-trip Client',
      redirect_uris: [redirectUri],
    });
    expect(regRes.statusCode).toBe(201);
    const { client_id } = regRes.json<{ client_id: string }>();

    const authRes = await get('/oauth/authorize', {
      response_type: 'code',
      client_id,
      redirect_uri: redirectUri,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cg',
      code_challenge_method: 'S256',
      state: 'pg-state-xyz',
    });

    if (authRes.statusCode === 400) {
      const body = authRes.json<{ error?: string }>();
      expect(body.error).not.toBe('invalid_redirect_uri');
      expect(body.error).not.toBe('redirect_uri_mismatch');
    }
    expect([200, 302, 303]).toContain(authRes.statusCode);
  });
});
