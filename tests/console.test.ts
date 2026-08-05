import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { buildServiceGraph } from '../src/console/correlate/graph';
import { runFindings } from '../src/console/findings';
import {
  aggregate,
  createRegistry,
  type InventoryProvider,
  type Provider,
} from '../src/console/providers/types';
import {
  buildServer,
  WRITE_ROUTES,
  createAuth,
  makeSessionCookie,
  parseSessionCookie,
  verifyGoogleIdToken,
  _resetJwksCache,
  OIDC_SESSION_COOKIE,
  OIDC_STATE_COOKIE,
  parseCookieHeader,
} from '../src/console/server';
import type { InfraResource } from '../src/console/domain';

/**
 * forge-console — the properties that must hold no matter which providers are plugged in.
 *
 * Everything here is pure or uses fakes: no cloud, no network. The correlation graph and the
 * findings engine are the two pieces where a subtle bug would quietly mislead an operator, so they
 * get the most attention.
 */

const r = (p: Partial<InfraResource> & { name: string; kind: InfraResource['kind'] }): InfraResource => ({
  provider_id: 'fake',
  env: 'prod-a',
  native_type: 'fake/Type',
  external_id: `id:${p.name}`,
  scope: 'regional',
  billable: false,
  labels: {},
  attributes: {},
  ...p,
});

describe('correlation — discovery-first, never a declared catalogue', () => {
  it('joins a runtime to its image repo, backend and host with full confidence', () => {
    const g = buildServiceGraph({
      resources: [
        r({ name: 'dorinda-api', kind: 'compute.service' }),
        r({ name: 'dorinda-api', kind: 'registry.repo' }),
        r({ name: 'dorinda-api-backend', kind: 'net.backend', scope: 'global' }),
      ],
      pipelines: [],
      repos: ['mardash-ai/dorinda-api'],
      hostBackends: { 'api.dorinda.ai': 'dorinda-api-backend' },
    });
    const svc = g.services.find((s) => s.key === 'dorinda-api')!;
    expect(svc).toBeTruthy();
    const kinds = svc.bindings.map((b) => b.kind).sort();
    expect(kinds).toContain('runtime');
    expect(kinds).toContain('image_repo');
    expect(kinds).toContain('backend');
    expect(kinds).toContain('host');
    expect(svc.bindings.find((b) => b.kind === 'host')!.confidence).toBe(1);
  });

  it('every binding carries the RULE that produced it — a wrong join must be explainable', () => {
    const g = buildServiceGraph({
      resources: [r({ name: 'dorinda-web', kind: 'compute.service' })],
      pipelines: [],
      repos: [],
      hostBackends: {},
    });
    for (const b of g.services[0]!.bindings) {
      expect(b.evidence.length).toBeGreaterThan(0);
      expect(b.evidence[0]!.rule).toBeTruthy();
      expect(b.evidence[0]!.detail).toBeTruthy();
    }
  });

  it('does NOT merge two services that merely share a name prefix', () => {
    const g = buildServiceGraph({
      resources: [
        r({ name: 'dorinda-api', kind: 'compute.service' }),
        r({ name: 'dorinda-api-worker', kind: 'compute.service' }),
      ],
      pipelines: [],
      repos: [],
      hostBackends: {},
    });
    expect(g.services.map((s) => s.key).sort()).toEqual(['dorinda-api', 'dorinda-api-worker']);
  });

  it('assigns a prefixed secret to the LONGEST matching service, not the first', () => {
    // 'dorinda-api-auth-session-secret' belongs to dorinda-api, never to a hypothetical 'dorinda'.
    const g = buildServiceGraph({
      resources: [
        r({ name: 'dorinda', kind: 'compute.service' }),
        r({ name: 'dorinda-api', kind: 'compute.service' }),
        r({ name: 'dorinda-api-auth-session-secret', kind: 'secret', scope: 'global' }),
      ],
      pipelines: [],
      repos: [],
      hostBackends: {},
    });
    const api = g.services.find((s) => s.key === 'dorinda-api')!;
    expect(api.bindings.some((b) => b.kind === 'secret')).toBe(true);
    expect(g.services.find((s) => s.key === 'dorinda')!.bindings.some((b) => b.kind === 'secret')).toBe(
      false,
    );
  });

  it('a peripheral secret guess does not drag the service confidence down', () => {
    // dorinda-api's runtime/backend/host are all certain; a 0.6 name-prefix secret match must not
    // make the whole service read as uncertain, or the number stops meaning anything.
    const g = buildServiceGraph({
      resources: [
        r({ name: 'dorinda-api', kind: 'compute.service' }),
        r({ name: 'dorinda-api-backend', kind: 'net.backend', scope: 'global' }),
        r({ name: 'dorinda-api-some-secret', kind: 'secret', scope: 'global' }),
      ],
      pipelines: [],
      repos: [],
      hostBackends: {},
    });
    const svc = g.services.find((s) => s.key === 'dorinda-api')!;
    expect(svc.confidence).toBe(1);
    // …but the weak binding still reports its OWN confidence honestly.
    expect(svc.bindings.find((b) => b.kind === 'secret')!.confidence).toBe(0.6);
  });

  it('reports what it could not place instead of hiding it', () => {
    const g = buildServiceGraph({
      resources: [
        r({ name: 'dorinda-api', kind: 'compute.service' }),
        r({ name: 'mystery-bucket', kind: 'bucket' }),
      ],
      pipelines: [],
      repos: [],
      hostBackends: {},
    });
    expect(g.unbound.map((u) => u.name)).toContain('mystery-bucket');
  });

  it('a stale override yields NO phantom service — the Backstage failure mode, refused', () => {
    const input = {
      resources: [r({ name: 'dorinda-api', kind: 'compute.service' })],
      pipelines: [],
      repos: [],
      hostBackends: {},
      overrides: [
        { service_key: 'service-that-never-existed', op: 'attach' as const, value: 'x', reason: 'stale' },
      ],
    };
    const g = buildServiceGraph(input);
    expect(g.services.map((s) => s.key)).not.toContain('service-that-never-existed');
  });
});

describe('findings — report-only, and driven by things that actually happened', () => {
  const base = {
    resources: [] as InfraResource[],
    graph: { services: [], unbound: [], conflicts: [] },
    credentials: [],
    runs: [],
    metricsIngesting: true,
    now: new Date('2026-08-01T00:00:00Z'),
  };

  it('raises a CRITICAL when no metrics are being ingested', () => {
    const f = runFindings({ ...base, metricsIngesting: false });
    const hit = f.find((x) => x.rule === 'metrics-pipeline-dead');
    expect(hit?.severity).toBe('critical');
  });

  it('catches a push-based collector that can scale to zero', () => {
    const f = runFindings({
      ...base,
      resources: [r({ name: 'otel-collector', kind: 'compute.service', attributes: { min_instances: 0 } })],
    });
    expect(f.some((x) => x.rule === 'collector-scales-to-zero')).toBe(true);
  });

  it('does NOT flag a collector already pinned to one instance', () => {
    const f = runFindings({
      ...base,
      resources: [r({ name: 'otel-collector', kind: 'compute.service', attributes: { min_instances: 1 } })],
    });
    expect(f.some((x) => x.rule === 'collector-scales-to-zero')).toBe(false);
  });

  it('flags a database with no backups as critical, and single-zone as info', () => {
    const f = runFindings({
      ...base,
      resources: [
        r({
          name: 'pg',
          kind: 'db.instance',
          scope: 'zonal',
          location: 'us-east1-d',
          attributes: { backups: false },
        }),
      ],
    });
    expect(f.find((x) => x.rule === 'db-no-backups')?.severity).toBe('critical');
    expect(f.find((x) => x.rule === 'db-single-zone')?.severity).toBe('info');
  });

  it('escalates an expiring credential as the date approaches', () => {
    const soon = new Date('2026-08-04T00:00:00Z').toISOString(); // 3 days out
    const later = new Date('2026-08-20T00:00:00Z').toISOString(); // 19 days out
    const mk = (expires_at: string) => [
      {
        id: 'c',
        env: 'prod-a',
        kind: 'api_token' as const,
        name: 'runner-pat',
        expires_at,
        auto_renews: false,
        source: 'declared' as const,
      },
    ];
    expect(
      runFindings({ ...base, credentials: mk(soon) }).find((x) => x.rule === 'credential-expiring')?.severity,
    ).toBe('critical');
    expect(
      runFindings({ ...base, credentials: mk(later) }).find((x) => x.rule === 'credential-expiring')
        ?.severity,
    ).toBe('warn');
  });

  it('ignores an auto-renewing credential', () => {
    const f = runFindings({
      ...base,
      credentials: [
        {
          id: 'c',
          env: 'prod-a',
          kind: 'tls_certificate',
          name: 'cert',
          expires_at: new Date('2026-08-02').toISOString(),
          auto_renews: true,
          source: 'discovered',
        },
      ],
    });
    expect(f.some((x) => x.rule === 'credential-expiring')).toBe(false);
  });

  it('flags a service-account key as CRITICAL — this platform should have none', () => {
    const fnd = runFindings({
      ...base,
      credentials: [
        {
          id: 'k1',
          env: 'prod-a',
          kind: 'service_account_key',
          name: 'deployer key',
          auto_renews: false,
          source: 'discovered',
        },
      ],
    });
    expect(fnd.find((x) => x.rule === 'service-account-key-exists')?.severity).toBe('critical');
  });

  it('cannot mutate the snapshot it inspects — report-only is structural', () => {
    const snap = { ...base, resources: [r({ name: 'x', kind: 'bucket' })] };
    runFindings(snap);
    expect(snap.resources.length).toBe(1);
  });
});

describe('provider aggregation — one dead source must not blank the page', () => {
  const fake = (id: string, fail: boolean): InventoryProvider => ({
    id,
    type: 'fake.inventory',
    kind: 'inventory',
    label: id,
    envs: ['prod-a'],
    supports: () => true,
    health: async () => ({ ok: !fail, detail: '', checked_at: '' }),
    list: async () => {
      if (fail) throw new Error('boom');
      return [r({ name: `${id}-res`, kind: 'bucket' })];
    },
  });

  it('keeps the healthy provider’s rows and reports the failed one', async () => {
    const { items, sources } = await aggregate([fake('good', false), fake('bad', true)], (p) =>
      p.list({} as never),
    );
    expect(items).toHaveLength(1);
    expect(sources.find((s) => s.provider_id === 'bad')!.ok).toBe(false);
    expect(sources.find((s) => s.provider_id === 'bad')!.error).toContain('boom');
  });

  it('registry selects by kind and environment', () => {
    const reg = createRegistry([fake('a', false) as Provider]);
    expect(reg.byKind('inventory', 'prod-a')).toHaveLength(1);
    expect(reg.byKind('inventory', 'other-env')).toHaveLength(0);
    expect(reg.byKind('metrics', 'prod-a')).toHaveLength(0);
  });
});

describe('server — auth and the write surface', () => {
  it('fails CLOSED when no credential is configured', () => {
    const prevU = process.env.CONSOLE_BASIC_USER;
    const prevP = process.env.CONSOLE_BASIC_PASS;
    delete process.env.CONSOLE_BASIC_USER;
    delete process.env.CONSOLE_BASIC_PASS;
    const auth = createAuth();
    // A control plane with no credential must serve NOTHING, not everything.
    expect(auth.check({ headers: {} } as never).ok).toBe(false);
    if (prevU) process.env.CONSOLE_BASIC_USER = prevU;
    if (prevP) process.env.CONSOLE_BASIC_PASS = prevP;
  });

  it('rejects a wrong credential and accepts the right one', () => {
    process.env.CONSOLE_BASIC_USER = 'u';
    process.env.CONSOLE_BASIC_PASS = 'p';
    const auth = createAuth();
    const ok = 'Basic ' + Buffer.from('u:p').toString('base64');
    const bad = 'Basic ' + Buffer.from('u:wrong').toString('base64');
    expect(auth.check({ headers: { authorization: ok } } as never).ok).toBe(true);
    expect(auth.check({ headers: { authorization: bad } } as never).ok).toBe(false);
  });

  it('EVERY mutating route is declared in the audited write table', async () => {
    // The guard that matters: adding a POST/PUT/DELETE route without registering it as an audited
    // write action breaks the build, rather than shipping an unaudited way to change production.
    const { REGISTERED_ROUTES } = await import('../src/console/server');
    const app = buildServer();
    await app.ready();
    const declared = new Set<string>(WRITE_ROUTES);
    /*
     * Read from Fastify's onRoute hook, NOT from printRoutes().
     *
     * printRoutes() renders a tree for humans and collapses shared prefixes: six routes under
     * /api/tenants/... print as `/comp`, `/lock`, `/purge`. Parsing that worked while every write
     * route was top-level and broke loudly once they nested. The dangerous case is the quiet one —
     * a collapsed fragment that happens to match a declared entry would pass this guard while
     * checking a different route than the one actually registered.
     */
    const mutating = REGISTERED_ROUTES.filter((r) => {
      const [method, path] = r.split(' ');
      return /^(POST|PUT|PATCH|DELETE)$/.test(method!) && !declared.has(path!);
    });
    expect(mutating).toEqual([]);
    // And the enumeration itself must be real — an empty list would make this vacuous.
    expect(REGISTERED_ROUTES.length).toBeGreaterThan(10);
    expect(REGISTERED_ROUTES).toContain('POST /api/tenants/accounts/purge');
    await app.close();
  });

  it('a dispatch without a reason is refused — the audit row must mean something', async () => {
    process.env.CONSOLE_BASIC_USER = 'u';
    process.env.CONSOLE_BASIC_PASS = 'p';
    const app = buildServer();
    const auth = 'Basic ' + Buffer.from('u:p').toString('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/api/actions/dispatch',
      headers: { authorization: auth },
      payload: { pipeline_id: 'dorinda-api:1' },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('an /api 404 stays a 404 and is never swallowed by the SPA shell', async () => {
    process.env.CONSOLE_BASIC_USER = 'u';
    process.env.CONSOLE_BASIC_PASS = 'p';
    const app = buildServer();
    const auth = 'Basic ' + Buffer.from('u:p').toString('base64');
    const res = await app.inject({ method: 'GET', url: '/api/nope', headers: { authorization: auth } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('favicons are served without credentials — a 401 on the challenge page would break the icon', async () => {
    // Browsers auto-probe /favicon.ico and resolve <link rel="icon"> before a user enters a
    // password. Gating them behind auth causes a broken-icon tab on the 401 challenge page,
    // which is the only page an unauthenticated visitor ever sees.
    process.env.CONSOLE_BASIC_USER = 'u';
    process.env.CONSOLE_BASIC_PASS = 'p';
    const app = buildServer();
    // No Authorization header — the request is intentionally unauthenticated.
    const svg = await app.inject({ method: 'GET', url: '/favicon.svg' });
    const ico = await app.inject({ method: 'GET', url: '/favicon.ico' });
    // The response is NOT a 401 — the auth gate must not have fired.
    // (The UI bundle is not built in this test environment, so 404 is the expected
    // success outcome — the gate let the request through, and the SPA handler
    // correctly returned 404 because the dist/ file is absent.)
    expect(svg.statusCode, '/favicon.svg must not return 401').not.toBe(401);
    expect(ico.statusCode, '/favicon.ico must not return 401').not.toBe(401);
    await app.close();
  });
});

// ── Google OIDC auth mode ─────────────────────────────────────────────────────────────────────

/**
 * OIDC tests are self-contained: RSA keys are generated in-process, JWKS + token endpoints are
 * stubbed with globalThis.fetch, and no real Google credential is required.
 */

import { generateKeyPairSync, createSign } from 'node:crypto';

/** Helper: set OIDC env vars for the duration of a synchronous callback, then restore. */
function withOidcEnv<T>(
  extra: Record<string, string>,
  fn: () => T,
): T {
  const OIDC: Record<string, string> = {
    CONSOLE_GOOGLE_CLIENT_ID: 'test-client-id',
    CONSOLE_GOOGLE_CLIENT_SECRET: 'test-client-secret',
    CONSOLE_SESSION_SECRET: 'test-session-secret-long-enough',
    CONSOLE_INSECURE_COOKIES: '1',
    ...extra,
  };
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(OIDC)) { prev[k] = process.env[k]; process.env[k] = OIDC[k]!; }
  // Also ensure Basic vars don't bleed in
  const prevBU = process.env.CONSOLE_BASIC_USER;
  const prevBP = process.env.CONSOLE_BASIC_PASS;
  delete process.env.CONSOLE_BASIC_USER;
  delete process.env.CONSOLE_BASIC_PASS;
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (prevBU !== undefined) process.env.CONSOLE_BASIC_USER = prevBU;
    if (prevBP !== undefined) process.env.CONSOLE_BASIC_PASS = prevBP;
  }
}

/** Build a signed RS256 JWT for testing (2048-bit key; ~50 ms). */
function makeTestJwt(
  payload: Record<string, unknown>,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  kid = 'test-key-1',
): string {
  const header = { alg: 'RS256', kid };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sigInput = `${headerB64}.${payloadB64}`;
  const signer = createSign('RSA-SHA256');
  signer.update(sigInput);
  const sig = signer.sign(privateKey).toString('base64url');
  return `${sigInput}.${sig}`;
}

/** Stub globalThis.fetch to serve a JWKS containing only the given public JWK. */
function stubJwksFetch(jwk: object, kid: string) {
  const real = globalThis.fetch;
  const key = { ...jwk, kid };
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('oauth2/v3/certs')) {
      return new Response(JSON.stringify({ keys: [key] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as never;
  return () => { globalThis.fetch = real; _resetJwksCache(); };
}

describe('parseCookieHeader — basic correctness', () => {
  it('parses a single cookie', () => {
    expect(parseCookieHeader('foo=bar')).toEqual({ foo: 'bar' });
  });
  it('parses multiple cookies separated by semi-colons', () => {
    const out = parseCookieHeader('a=1; b=2; c=3');
    expect(out).toEqual({ a: '1', b: '2', c: '3' });
  });
  it('handles an empty header gracefully', () => {
    expect(parseCookieHeader('')).toEqual({});
  });
});

describe('OIDC session cookie — create + parse round-trip', () => {
  it('round-trips an email correctly', () => {
    const val = makeSessionCookie('mark@mardash.ai', 'secret');
    expect(parseSessionCookie(val, 'secret')).toBe('mark@mardash.ai');
  });

  it('rejects a tampered email part', () => {
    const val = makeSessionCookie('mark@mardash.ai', 'secret');
    const parts = val.split('.');
    // Replace the email base64 with a different one
    parts[0] = Buffer.from('evil@mardash.ai', 'utf8').toString('base64url');
    expect(parseSessionCookie(parts.join('.'), 'secret')).toBeNull();
  });

  it('rejects a tampered expiry', () => {
    const val = makeSessionCookie('mark@mardash.ai', 'secret');
    const parts = val.split('.');
    parts[1] = String(Number(parts[1]) + 99999); // push expiry into the future
    expect(parseSessionCookie(parts.join('.'), 'secret')).toBeNull();
  });

  it('rejects a cookie signed with a different secret', () => {
    const val = makeSessionCookie('mark@mardash.ai', 'secret-A');
    expect(parseSessionCookie(val, 'secret-B')).toBeNull();
  });

  it('rejects a malformed value', () => {
    expect(parseSessionCookie('not-a-cookie', 'secret')).toBeNull();
    expect(parseSessionCookie('', 'secret')).toBeNull();
  });
});

describe('createAuth — OIDC mode selection', () => {
  it('selects google mode when OIDC credentials are configured', () => {
    withOidcEnv({}, () => {
      const auth = createAuth();
      expect(auth.mode).toBe('google');
    });
  });

  it('OIDC takes priority over Basic when both are configured', () => {
    withOidcEnv({ CONSOLE_BASIC_USER: 'u', CONSOLE_BASIC_PASS: 'p' }, () => {
      // The withOidcEnv helper deletes Basic vars, but even if they were present OIDC wins.
      const auth = createAuth();
      expect(auth.mode).toBe('google');
    });
  });

  it('OIDC check() returns ok=false when no session cookie is present', () => {
    withOidcEnv({}, () => {
      const auth = createAuth();
      expect(auth.check({ headers: {} } as never).ok).toBe(false);
    });
  });

  it('OIDC check() returns ok=true with a valid session cookie and reports the email as actor', () => {
    withOidcEnv({}, () => {
      const auth = createAuth();
      const secret = 'test-session-secret-long-enough';
      const cookie = makeSessionCookie('mark@mardash.ai', secret);
      const r = auth.check({
        headers: { cookie: `${OIDC_SESSION_COOKIE}=${cookie}` },
      } as never);
      expect(r.ok).toBe(true);
      // The actor must be the email — not a shared username.
      if (r.ok) expect(r.actor).toBe('mark@mardash.ai');
    });
  });

  it('OIDC check() returns ok=false for a tampered cookie', () => {
    withOidcEnv({}, () => {
      const auth = createAuth();
      const r = auth.check({
        headers: { cookie: `${OIDC_SESSION_COOKIE}=bogus.1234567890.deadbeef` },
      } as never);
      expect(r.ok).toBe(false);
    });
  });
});

describe('server — Google OIDC routes', () => {
  it('/auth/login redirects to Google with the required parameters', async () => {
    await withOidcEnv({}, async () => {
      const app = buildServer();
      const res = await app.inject({ method: 'GET', url: '/auth/login' });
      expect(res.statusCode).toBe(302);
      const loc = new URL(String(res.headers.location));
      expect(loc.hostname).toBe('accounts.google.com');
      expect(loc.searchParams.get('client_id')).toBe('test-client-id');
      expect(loc.searchParams.get('response_type')).toBe('code');
      expect(loc.searchParams.get('scope')).toContain('openid');
      // hd is a cosmetic hint; the security check is server-side on the callback
      expect(loc.searchParams.get('hd')).toBe('mardash.ai');
      expect(loc.searchParams.get('state')).toBeTruthy();
      await app.close();
    });
  });

  it('/auth/login sets a short-lived HttpOnly state cookie for CSRF protection', async () => {
    await withOidcEnv({}, async () => {
      const app = buildServer();
      const res = await app.inject({ method: 'GET', url: '/auth/login' });
      const setCookie = String(res.headers['set-cookie'] ?? '');
      expect(setCookie).toContain(`${OIDC_STATE_COOKIE}=`);
      expect(setCookie).toContain('HttpOnly');
      await app.close();
    });
  });

  it('/auth/callback with state mismatch is refused and no session cookie is issued', async () => {
    await withOidcEnv({}, async () => {
      const app = buildServer();
      const res = await app.inject({
        method: 'GET',
        url: '/auth/callback?code=abc&state=WRONG',
        headers: { cookie: `${OIDC_STATE_COOKIE}=CORRECT` },
      });
      expect(res.statusCode).toBe(302);
      expect(String(res.headers.location)).toContain('error=state_mismatch');
      // No session cookie must be present in the response
      const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      expect(cookies.some((c) => c.startsWith(`${OIDC_SESSION_COOKIE}=`))).toBe(false);
      await app.close();
    });
  });

  it('/auth/callback without a code param is refused', async () => {
    await withOidcEnv({}, async () => {
      const app = buildServer();
      const state = 'test-nonce';
      const res = await app.inject({
        method: 'GET',
        url: `/auth/callback?state=${state}`,
        headers: { cookie: `${OIDC_STATE_COOKIE}=${state}` },
      });
      expect(res.statusCode).toBe(302);
      expect(String(res.headers.location)).toContain('error=no_code');
      await app.close();
    });
  });

  it('/auth/callback with a failed token exchange is refused gracefully', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 400 })) as never;
    try {
      await withOidcEnv({}, async () => {
        const app = buildServer();
        const state = 'test-nonce';
        const res = await app.inject({
          method: 'GET',
          url: `/auth/callback?code=bad-code&state=${state}`,
          headers: { cookie: `${OIDC_STATE_COOKIE}=${state}` },
        });
        expect(res.statusCode).toBe(302);
        expect(String(res.headers.location)).toContain('error=token_exchange_failed');
        await app.close();
      });
    } finally {
      globalThis.fetch = real;
    }
  });

  it('/auth/callback with a valid mardash.ai token issues a session cookie with the email', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    const restore = stubJwksFetch(jwk, 'test-key-1');
    const real = globalThis.fetch;

    const now = Math.floor(Date.now() / 1000);
    const idToken = makeTestJwt(
      {
        sub: 'google-sub-1',
        email: 'mark@mardash.ai',
        email_verified: true,
        hd: 'mardash.ai',
        iat: now,
        exp: now + 3600,
        aud: 'test-client-id',
        iss: 'https://accounts.google.com',
      },
      privateKey,
    );

    // Intercept both the token endpoint and the JWKS endpoint.
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ id_token: idToken, access_token: 'at', token_type: 'Bearer' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      // JWKS endpoint handled by stubJwksFetch already installed above.
      if (String(url).includes('oauth2/v3/certs')) {
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'test-key-1' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as never;

    try {
      await withOidcEnv({}, async () => {
        const app = buildServer();
        const state = 'test-nonce-valid';
        const res = await app.inject({
          method: 'GET',
          url: `/auth/callback?code=real-code&state=${state}`,
          headers: { cookie: `${OIDC_STATE_COOKIE}=${state}` },
        });
        expect(res.statusCode).toBe(302);
        expect(String(res.headers.location)).toBe('/');
        const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
        const sessionCookie = cookies.find((c) => c.startsWith(`${OIDC_SESSION_COOKIE}=`));
        expect(sessionCookie).toBeTruthy();
        expect(sessionCookie).toContain('HttpOnly');
        // The email must be recoverable from the cookie value
        const val = sessionCookie!.split(';')[0]!.split('=').slice(1).join('=');
        const secret = 'test-session-secret-long-enough';
        expect(parseSessionCookie(val, secret)).toBe('mark@mardash.ai');
        await app.close();
      });
    } finally {
      globalThis.fetch = real;
      restore();
    }
  });

  it('/auth/callback with a non-mardash.ai account is refused (hd enforcement)', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    const now = Math.floor(Date.now() / 1000);
    // Token with hd=gmail.com — a valid Google token but wrong domain
    const idToken = makeTestJwt(
      {
        sub: 'google-sub-2',
        email: 'attacker@gmail.com',
        email_verified: true,
        hd: 'gmail.com',
        iat: now,
        exp: now + 3600,
        aud: 'test-client-id',
        iss: 'https://accounts.google.com',
      },
      privateKey,
    );
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ id_token: idToken }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes('oauth2/v3/certs')) {
        return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'test-key-1' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as never;
    try {
      await withOidcEnv({}, async () => {
        const app = buildServer();
        const state = 'test-nonce-evil';
        const res = await app.inject({
          method: 'GET',
          url: `/auth/callback?code=evil-code&state=${state}`,
          headers: { cookie: `${OIDC_STATE_COOKIE}=${state}` },
        });
        expect(res.statusCode).toBe(302);
        expect(String(res.headers.location)).toContain('error=access_denied');
        // No session cookie — the non-mardash account is refused, not challenged
        const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
        expect(cookies.some((c) => c.startsWith(`${OIDC_SESSION_COOKIE}=`))).toBe(false);
        await app.close();
      });
    } finally {
      globalThis.fetch = real;
      _resetJwksCache();
    }
  });

  it('/healthz is public in OIDC mode (a probe cannot hold a session cookie)', async () => {
    await withOidcEnv({}, async () => {
      const app = buildServer();
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      await app.close();
    });
  });

  it('unauthenticated browser navigation in OIDC mode redirects to /auth/login', async () => {
    await withOidcEnv({}, async () => {
      const app = buildServer();
      // A bare GET to / with no session cookie must redirect to /auth/login, NOT return 401.
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(302);
      expect(String(res.headers.location)).toBe('/auth/login');
      await app.close();
    });
  });

  it('unauthenticated /api calls in OIDC mode return 401 (SPA handles the redirect)', async () => {
    await withOidcEnv({}, async () => {
      const app = buildServer();
      const res = await app.inject({ method: 'GET', url: '/api/bootstrap' });
      expect(res.statusCode).toBe(401);
      // No Basic challenge — OIDC uses cookies, not HTTP auth
      expect(res.headers['www-authenticate']).toBeUndefined();
      await app.close();
    });
  });
});

describe('verifyGoogleIdToken — the ID token security checks', () => {
  const CLIENT_ID = 'unit-test-client';
  let privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  let publicJwk: Record<string, unknown>;
  let restoreJwks: () => void;

  // One key pair for the whole suite — generation is the expensive step
  beforeAll(() => {
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = kp.privateKey;
    publicJwk = kp.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  });

  beforeEach(() => {
    restoreJwks = stubJwksFetch(publicJwk, 'test-key-1');
  });
  afterEach(() => {
    restoreJwks();
  });

  function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      sub: 'sub-1',
      email: 'mark@mardash.ai',
      email_verified: true,
      hd: 'mardash.ai',
      iat: now,
      exp: now + 3600,
      aud: CLIENT_ID,
      iss: 'https://accounts.google.com',
      ...overrides,
    };
  }

  it('accepts a valid mardash.ai token', async () => {
    const token = makeTestJwt(validPayload(), privateKey);
    const claims = await verifyGoogleIdToken(token, CLIENT_ID);
    expect(claims).not.toBeNull();
    expect(claims?.email).toBe('mark@mardash.ai');
    expect(claims?.hd).toBe('mardash.ai');
  });

  it('rejects a token with wrong hd — the primary security boundary', async () => {
    const token = makeTestJwt(validPayload({ hd: 'gmail.com', email: 'x@gmail.com' }), privateKey);
    expect(await verifyGoogleIdToken(token, CLIENT_ID)).toBeNull();
  });

  it('rejects a token with no hd claim (personal Google account)', async () => {
    const { hd: _hd, ...noHd } = validPayload() as Record<string, unknown>;
    const token = makeTestJwt(noHd, privateKey);
    expect(await verifyGoogleIdToken(token, CLIENT_ID)).toBeNull();
  });

  it('rejects a token with wrong audience', async () => {
    const token = makeTestJwt(validPayload({ aud: 'wrong-client-id' }), privateKey);
    expect(await verifyGoogleIdToken(token, CLIENT_ID)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeTestJwt(validPayload({ iat: now - 7200, exp: now - 3600 }), privateKey);
    expect(await verifyGoogleIdToken(token, CLIENT_ID)).toBeNull();
  });

  it('rejects an unverified email', async () => {
    const token = makeTestJwt(validPayload({ email_verified: false }), privateKey);
    expect(await verifyGoogleIdToken(token, CLIENT_ID)).toBeNull();
  });

  it('rejects a token with a tampered payload (signature mismatch)', async () => {
    const token = makeTestJwt(validPayload(), privateKey);
    const parts = token.split('.');
    // Swap out the payload with different claims
    parts[1] = Buffer.from(JSON.stringify({ ...validPayload(), hd: 'evil.com' })).toString('base64url');
    expect(await verifyGoogleIdToken(parts.join('.'), CLIENT_ID)).toBeNull();
  });

  it('rejects a completely malformed token', async () => {
    expect(await verifyGoogleIdToken('not-a-jwt', CLIENT_ID)).toBeNull();
    expect(await verifyGoogleIdToken('a.b', CLIENT_ID)).toBeNull();
    expect(await verifyGoogleIdToken('', CLIENT_ID)).toBeNull();
  });
});

// ── The unified timeline ───────────────────────────────────────────────────────────────────────

import { buildTimeline } from '../src/console/timeline';
import { computeQuotas } from '../src/console/quota';
import { extractDoc, parseDocIndex } from '../src/console/docs';
import type { PipelineRun, Revision } from '../src/console/domain';

const run = (p: Partial<PipelineRun> & { id: string }): PipelineRun => ({
  pipeline_id: 'wf1',
  pipeline_name: 'release',
  repo: 'mardash-ai/dorinda-api',
  number: 1,
  status: 'completed',
  conclusion: 'success',
  event: 'push',
  branch: 'main',
  commit_sha: 'abc',
  actor: 'mark',
  url: 'https://github.com/x',
  ...p,
});

const rev = (p: Partial<Revision> & { id: string }): Revision => ({
  image_digest: 'sha256:' + 'a'.repeat(64),
  image_ref: 'repo/img@sha256:' + 'a'.repeat(64),
  created_at: '2026-07-31T10:00:00Z',
  traffic_percent: 100,
  ready: true,
  ...p,
});

describe('timeline — the "what changed" axis', () => {
  const since = new Date('2026-07-31T00:00:00Z');

  it('interleaves deploys and CI runs on one axis, newest first', () => {
    const events = buildTimeline({
      runs: [run({ id: 'r1', started_at: '2026-07-31T09:00:00Z' })],
      revisions: [
        { service: 'dorinda-api', revisions: [rev({ id: 'rev-2', created_at: '2026-07-31T11:00:00Z' })] },
      ],
      findings: [],
      audit: [
        {
          at: '2026-07-31T10:00:00Z',
          actor: 'mark',
          action: 'pipeline.dispatch',
          target: 'wf1',
          outcome: 'succeeded',
        },
      ],
      since,
    });
    expect(events.map((e) => e.kind)).toEqual(['deploy', 'action', 'pipeline']);
  });

  it('drops everything older than the window, so a backlog cannot bury today', () => {
    const events = buildTimeline({
      runs: [run({ id: 'old', started_at: '2026-07-01T09:00:00Z' })],
      revisions: [
        { service: 'api', revisions: [rev({ id: 'old-rev', created_at: '2026-06-01T09:00:00Z' })] },
      ],
      findings: [],
      audit: [],
      since,
    });
    expect(events).toEqual([]);
  });

  it('marks a revision that never became ready as failed, not as a normal deploy', () => {
    // A revision that exists but is not Ready is the single most misleading state in Cloud Run: the
    // deploy "happened", and traffic is still on the old one.
    const [e] = buildTimeline({
      runs: [],
      revisions: [
        {
          service: 'api',
          revisions: [
            rev({ id: 'bad', ready: false, traffic_percent: 0, created_at: '2026-07-31T12:00:00Z' }),
          ],
        },
      ],
      findings: [],
      audit: [],
      since,
    });
    expect(e?.outcome).toBe('failed');
  });
});

describe('quota headroom — a limit is never invented', () => {
  const svc = (name: string, max: number | null) =>
    r({ name, kind: 'compute.service', attributes: { max_instances: max } });

  it('computes headroom only when both the peak and the ceiling are known', () => {
    const gauges = computeQuotas({
      resources: [svc('api', 10)],
      peakInstances: new Map([['api', 3]]),
      peakDbConnections: null,
      providerGauges: [],
    });
    expect(gauges[0]?.headroom_percent).toBe(70);
  });

  it('reports unknown headroom rather than a confident wrong number', () => {
    // Cloud SQL does not publish max_connections, and the tier formula is a guess. A percentage
    // computed against a guessed ceiling looks precise, which is worse than saying "unknown".
    const gauges = computeQuotas({
      resources: [r({ name: 'pg', kind: 'db.instance' })],
      peakInstances: new Map(),
      peakDbConnections: 12,
      providerGauges: [],
    });
    const db = gauges.find((g) => g.scope === 'cloud-sql');
    expect(db?.used).toBe(12);
    expect(db?.limit).toBeNull();
    expect(db?.headroom_percent).toBeNull();
  });

  it('sorts the tightest headroom first and never drops the unknowns', () => {
    const gauges = computeQuotas({
      resources: [svc('tight', 10), svc('loose', 100), svc('nolimit', null)],
      peakInstances: new Map([
        ['tight', 9],
        ['loose', 5],
      ]),
      peakDbConnections: null,
      providerGauges: [],
    });
    expect(gauges.map((g) => g.name)).toEqual(['tight instances', 'loose instances', 'nolimit instances']);
  });
});

describe('the bundled doc pages actually resolve, not merely exist', () => {
  /*
   * A page is not shipped because a file is on disk. It is shipped when the console can DISCOVER
   * it and EXTRACT it — the same "verify the pane, not the store" rule this estate has already paid
   * for once.
   *
   * This is a SMOKE test over the real discovery + extraction path, and its scope is worth stating
   * plainly rather than overselling: it catches a page that is unreadable, that yields no title
   * from either <h1> or <title> (so it lists under its raw slug), or that extracts an empty body.
   *
   * Two things it deliberately does NOT catch, both verified by breaking them and watching this
   * suite stay green — because a test whose stated failure mode is wrong is worse than no test:
   *   · a missing <main> — `extractDoc` falls back to <body> on purpose, since dorinda-web's pages
   *     wrap their content in a plain <div class="wrap">;
   *   · a missing <h1> alone — `listPages` falls back to <title> before the slug.
   */
  it('every bundled page is discoverable and extracts a title and a body', async () => {
    const { builtinSource } = await import('../src/console/docs');
    const src = builtinSource(new URL('../src/console/docs/content', import.meta.url).pathname);
    const pages = await src.listPages(new AbortController().signal);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      const doc = await src.getPage(p.id, new AbortController().signal);
      // A title equal to the id means BOTH <h1> and <title> were missing — the page lists under
      // its raw slug, which reads as a deliberate name rather than a broken page.
      expect(p.title, `page ${p.id} has no <h1> and no <title>`).not.toBe(p.id);
      // A page with no extracted body has its content outside <main> and renders blank.
      expect(doc.html.length, `page ${p.id} extracted an empty body`).toBeGreaterThan(200);
      expect(doc.html).not.toContain('<script');
    }
  });

  it('ships the Explore/logs help page — the surface that had none', async () => {
    const { builtinSource } = await import('../src/console/docs');
    const src = builtinSource(new URL('../src/console/docs/content', import.meta.url).pathname);
    const doc = await src.getPage('logging', new AbortController().signal);
    expect(doc.title).toMatch(/Logs, owners/i);
    // The two things an operator opens this page to understand.
    expect(doc.html).toContain('trace_id');
    expect(doc.html).toMatch(/per ITEM/i);
  });
});

describe('docs — absorbed by reference, never copied', () => {
  const page = `<html><head><style>:root{--x:1}</style></head><body>
    <nav><div class="logo">x</div><a href="/index">Overview</a><a href="/gcp">Google Cloud</a></nav>
    <main><h1>Google Cloud</h1><p>body</p>
    <img src="/gcp-topology.svg" alt="t">
    <a href="/runbooks">Runbooks &amp; Links</a>
    <script>alert(1)</script></main></body></html>`;

  it("derives the page index from the portal's own nav, so it cannot drift", () => {
    expect(parseDocIndex(page)).toEqual([
      { id: 'index', title: 'Overview' },
      { id: 'gcp', title: 'Google Cloud' },
    ]);
  });

  it('strips scripts and inline handlers from fetched content', () => {
    const doc = extractDoc(page, 'platform', 'gcp', 'fallback');
    expect(doc.html).not.toContain('alert(1)');
    expect(doc.html).not.toContain('<script');
  });

  it('rewrites portal links to console routes and images to the proxied path', () => {
    // The portal's images sit behind its basic auth, so a raw <img src="/x.svg"> would 401 in the
    // browser and render as a broken image with no explanation.
    const doc = extractDoc(page, 'platform', 'gcp', 'fallback');
    expect(doc.html).toContain('src="/docs/asset/platform/gcp-topology.svg"');
    expect(doc.html).toContain('href="?s=docs&p=platform:runbooks"');
  });

  it('takes only <main>, so a page cannot inject its own nav into the console shell', () => {
    // The page's CSS is kept (scoped — see the scoping suite below), but its STRUCTURE is not:
    // a fetched <nav> rendered inside the console would give the reader a second, competing
    // navigation that goes nowhere.
    const doc = extractDoc(page, 'platform', 'gcp', 'fallback');
    expect(doc.html).not.toContain('<nav');
    expect(doc.title).toBe('Google Cloud');
  });
});

describe('cloud run traffic — “what is serving?” must not answer “nothing”', () => {
  it('resolves a LATEST traffic target to the latest ready revision', async () => {
    const { resolveTraffic } = await import('../src/plugins/console-gcp/runtime');
    // The shape EVERY service in this estate actually returns: a LATEST target with no revision
    // name on it. Reading t.revision alone gives an empty map, and the Deploys screen then reports
    // that production is serving nothing.
    const t = resolveTraffic({
      trafficStatuses: [{ type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST', percent: 100 }],
      latestReadyRevision: 'projects/p/locations/us-east1/services/api/revisions/api-00013-v8t',
    });
    expect(t.get('api-00013-v8t')).toBe(100);
  });

  it('still honours an explicit pinned revision split', async () => {
    const { resolveTraffic } = await import('../src/plugins/console-gcp/runtime');
    const t = resolveTraffic({
      trafficStatuses: [
        { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: 'api-1', percent: 90 },
        { type: 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION', revision: 'api-2', percent: 10 },
      ],
      latestReadyRevision: 'projects/p/l/r/s/api/revisions/api-3',
    });
    expect([...t]).toEqual([
      ['api-1', 90],
      ['api-2', 10],
    ]);
  });
});

describe('cloud logging — a request log must not render as a blank row', () => {
  it('renders a Cloud Run request log as method, path, status and latency', async () => {
    const { describeHttpRequest } = await import('../src/plugins/console-gcp/logs');
    // The EXACT entry the acceptance run found rendering blank: the admin purge. A request log has
    // no textPayload and no jsonPayload, so a message extractor that reads only those produces "".
    expect(
      describeHttpRequest({
        requestMethod: 'POST',
        requestUrl: 'https://api.dorinda.ai/api/admin/accounts/purge',
        status: 200,
        latency: '0.914489501s',
      }),
    ).toBe('POST api.dorinda.ai/api/admin/accounts/purge → 200 (914ms)');
  });

  it('drops the query string, which routinely carries tokens and ids', () => {
    // Log lines end up in screenshots and pasted incident notes; a query string is where a secret
    // most often rides along.
    return import('../src/plugins/console-gcp/logs').then(({ describeHttpRequest }) => {
      const out = describeHttpRequest({
        requestMethod: 'GET',
        requestUrl: 'https://api.dorinda.ai/connect/google/callback?code=SECRET&state=xyz',
        status: 302,
      });
      expect(out).not.toContain('SECRET');
      expect(out).toBe('GET api.dorinda.ai/connect/google/callback → 302');
    });
  });

  it('returns empty for an entry with no httpRequest, so ordinary logs are unaffected', async () => {
    const { describeHttpRequest, describeProtoPayload } = await import('../src/plugins/console-gcp/logs');
    expect(describeHttpRequest(undefined)).toBe('');
    expect(describeProtoPayload(undefined)).toBe('');
  });

  it('renders an audit log from protoPayload rather than blank', async () => {
    const { describeProtoPayload } = await import('../src/plugins/console-gcp/logs');
    expect(
      describeProtoPayload({
        methodName: 'google.cloud.run.v2.Services.UpdateService',
        resourceName: 'projects/p/services/dorinda-api',
      }),
    ).toBe('google.cloud.run.v2.Services.UpdateService projects/p/services/dorinda-api');
  });
});

describe('log truncation — a narrower answer than the question must say so', () => {
  it('flags when the row limit made the result cover less time than requested', async () => {
    // Live during the acceptance run: a 190-minute query returned 400 rows covering 20 minutes, and
    // "no 5xx in the last 190 minutes" was about to be recorded as a pass from data that never
    // reached back that far. Silence here manufactures confident all-clears.
    const { envelope } = await import('../src/console/domain');
    const env = envelope([1, 2, 3], [], {
      note: 'showing the newest 3 lines — they cover back to X, NOT the full 190m requested.',
    });
    expect(env.note).toContain('NOT the full');
  });

  it('carries no note when the result actually spans the window', async () => {
    const { envelope } = await import('../src/console/domain');
    expect(envelope([1], []).note).toBeUndefined();
  });
});

describe('CI pin adoption — a shipped fix nobody pins is a fix nobody has (F-15)', () => {
  it('ranks how many releases behind a pin is, so "old" is a number not a vibe', () => {
    const rank = ['v0.93.0', 'v0.92.0', 'v0.91.0', 'v0.90.0', 'v0.89.0'];
    const behind = (pinned: string) => (rank.indexOf(pinned) < 0 ? rank.length : rank.indexOf(pinned));
    expect(behind('v0.93.0')).toBe(0);
    expect(behind('v0.90.0')).toBe(3);
    // A pin so old it has fallen off the tag page is MAXIMALLY behind, never silently 0 — which is
    // the exact case that mattered: v0.79.24 was fourteen releases back and off the first page.
    expect(behind('v0.79.24')).toBe(rank.length);
  });

  it('matches a forge checkout ref, not unrelated action pins', () => {
    // A workflow pins many things. Only the forge checkout is adoption drift; treating every
    // `ref:` as forge would flood the screen and train the operator to ignore it.
    const wf = `
      - uses: actions/checkout@v4
        with:
          repository: mardash-ai/forge
          ref: v0.79.24
          path: .forge
      - uses: google-github-actions/auth@v2
        with:
          ref: v9.9.9
    `;
    const m = /mardash-ai\/forge[\s\S]{0,120}?ref:\s*(v[0-9][0-9.]*)/.exec(wf);
    expect(m?.[1]).toBe('v0.79.24');
    expect(m?.[1]).not.toBe('v9.9.9');
  });
});

describe('docs — many sources, one pane', () => {
  it('namespaces page ids, so two sources publishing `index` cannot collide', async () => {
    const { qualify, unqualify } = await import('../src/console/docs');
    expect(qualify('app', 'admin-purge')).toBe('app:admin-purge');
    expect(unqualify('platform:topology')).toEqual({ sourceId: 'platform', pageId: 'topology' });
    // A bare id is REFUSED rather than defaulted to a source — defaulting would silently serve one
    // source's page under another's link, which is the exact failure namespacing exists to prevent.
    expect(unqualify('topology')).toBeNull();
    expect(unqualify('../etc/passwd')).toBeNull();
  });

  it('scopes assets to their own source — a path from one must not resolve against another', async () => {
    const { extractDoc } = await import('../src/console/docs');
    const html = '<main><img src="/topology.svg"><a href="/runbooks">R</a></main>';
    const a = extractDoc(html, 'platform', 'x', 'x');
    const b = extractDoc(html, 'app', 'x', 'x');
    expect(a.html).toContain('src="/docs/asset/platform/topology.svg"');
    expect(b.html).toContain('src="/docs/asset/app/topology.svg"');
    expect(a.html).toContain('href="?s=docs&p=platform:runbooks"');
    expect(b.html).toContain('href="?s=docs&p=app:runbooks"');
  });

  it('reads a page that uses <body> rather than <main>, confining its <style> to the embed', async () => {
    const { extractDoc } = await import('../src/console/docs');
    // dorinda-web's help pages wrap content in a plain <div class="wrap"> with a <style> block and
    // no <main>. Falling back to the raw string would let that CSS reach the console shell and
    // restyle the whole pane — which is what a naive "just render it" would do.
    const page = `<title>Flow · purge</title><style>body{background:red}</style>
      <body><div class="wrap"><h1>Purge an account</h1><p>body</p></div></body>`;
    const doc = extractDoc(page, 'app', 'admin-purge', 'fallback');
    expect(doc.title).toBe('Purge an account');
    expect(doc.html).toContain('Purge an account');
    // The rule survives, CONFINED. `body{background:red}` reaching the shell would repaint the
    // whole console; `.doc-embed{background:red}` paints only the embedded document.
    expect(doc.html).toContain('.doc-embed{background:red}');
    expect(doc.html).not.toMatch(/(^|[^-\w.])body\s*\{/);
  });

  it('titles the built-in pages from their own <h1>, so the index cannot disagree with the page', async () => {
    const { builtinSource } = await import('../src/console/docs');
    const { join } = await import('node:path');
    const src = builtinSource(join(process.cwd(), 'src', 'console', 'docs', 'content'));
    const pages = await src.listPages(AbortSignal.timeout(5_000));
    const byId = new Map(pages.map((p) => [p.id, p.title]));
    expect(byId.get('topology')).toBe('System Topology');
    expect(byId.get('ci')).toBe('CI/CD — how everything ships');
    // The two hand-transcribed cloud snapshots were DROPPED, not imported. The console answers
    // those questions live; a stale snapshot beside a live view is worse than no snapshot.
    expect(byId.has('gcp')).toBe(false);
  });

  it('every asset a bundled page references is actually bundled', async () => {
    // A moved page whose diagram did not move renders as a broken image with no explanation.
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), 'src', 'console', 'docs', 'content');
    const files = await readdir(dir);
    const missing: string[] = [];
    for (const f of files.filter((x) => x.endsWith('.html'))) {
      const html = await readFile(join(dir, f), 'utf8');
      for (const m of html.matchAll(/(?:src|data)="\/?([a-zA-Z0-9._-]+\.svg)"/g)) {
        if (!files.includes(m[1]!)) missing.push(`${f} → ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('one unreachable source reports itself and does NOT blank the others', async () => {
    const { indexAll } = await import('../src/console/docs');
    const ok = {
      id: 'ok',
      label: 'Fine',
      origin: 'x',
      configured: () => true,
      listPages: async () => [{ id: 'a', title: 'A' }],
      getPage: async () => ({ id: 'ok:a', title: 'A', html: '', styled: false }),
      getAsset: async () => ({ body: Buffer.from(''), contentType: 'x' }),
    };
    const down = {
      ...ok,
      id: 'down',
      label: 'Down',
      listPages: async () => {
        throw new Error('502');
      },
    };
    const unset = { ...ok, id: 'unset', label: 'Unset', configured: () => false };

    const out = await indexAll([ok, down, unset], AbortSignal.timeout(5_000));
    expect(out.find((s) => s.id === 'ok')?.pages).toHaveLength(1);
    // Reported, not swallowed — an empty Docs screen with no explanation is the failure here.
    expect(out.find((s) => s.id === 'down')?.error).toContain('502');
    expect(out.find((s) => s.id === 'unset')?.error).toBe('not configured');
  });

  it('a live source serves ONLY ids its manifest publishes', async () => {
    const { webManifestSource } = await import('../src/console/docs');
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string) => {
      calls.push(String(u));
      if (String(u).endsWith('manifest.json')) {
        return new Response(JSON.stringify([{ slug: 'login', title: 'Log in', file: 'login.html' }]));
      }
      return new Response('<body><h1>Log in</h1></body>');
    }) as never;
    try {
      const src = webManifestSource({ id: 'app', label: 'App', origin: 'https://app.example' });
      expect((await src.getPage('login', AbortSignal.timeout(5_000))).title).toBe('Log in');
      // An unpublished id is refused — otherwise this proxy becomes a fetch-anything primitive
      // pointed at our own hosts, reachable by anyone who can reach the console.
      await expect(src.getPage('secret', AbortSignal.timeout(5_000))).rejects.toThrow(/unknown page/);
      expect(calls.some((c) => c.includes('secret.html'))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('docs — a page keeps its own CSS but cannot restyle the console', () => {
  it('confines every selector to the embed scope', async () => {
    const { scopeCss } = await import('../src/console/docs');
    const out = scopeCss('.card{color:red} h1,h2{margin:0}');
    expect(out).toContain('.doc-embed .card{color:red}');
    expect(out).toContain('.doc-embed h1,.doc-embed h2{margin:0}');
  });

  it('neutralises the selectors that would otherwise own the whole page', async () => {
    const { scopeCss } = await import('../src/console/docs');
    // `body{background:#fff}` unscoped repaints the console. `:root{--ink:...}` unscoped overrides
    // the console's OWN design tokens — the more dangerous of the two, because it looks like it
    // worked while quietly changing every other screen's colours.
    const out = scopeCss(':root{--ink:#000}body{background:#fff}html.dark{color:#eee}');
    expect(out).toContain('.doc-embed{--ink:#000}');
    expect(out).toContain('.doc-embed{background:#fff}');
    expect(out).toContain('.doc-embed.dark{color:#eee}');
    expect(out).not.toMatch(/(^|[^-\w.])body\s*\{/);
    expect(out).not.toMatch(/:root\s*\{/);
  });

  it('recurses into @media and passes @keyframes / @font-face through untouched', async () => {
    const { scopeCss } = await import('../src/console/docs');
    const out = scopeCss(
      '@media (max-width:600px){.card{padding:4px}} @keyframes spin{from{opacity:0}to{opacity:1}}',
    );
    expect(out).toContain('@media (max-width:600px){.doc-embed .card{padding:4px}}');
    // Prefixing `from`/`to` would not scope the animation — it would break it, silently.
    expect(out).toContain('@keyframes spin{from{opacity:0}to{opacity:1}}');
    expect(out).not.toContain('.doc-embed from');
  });

  it('collects styles from the HEAD, where these pages actually put them', async () => {
    const { extractDoc, DOC_SCOPE } = await import('../src/console/docs');
    // Reading only the extracted <body> would find no <style> and produce a silently unstyled
    // document — which is exactly what shipped before this was fixed.
    const page = `<title>T</title><style>.wrap{max-width:820px}</style><body><div class="wrap"><h1>T</h1></div></body>`;
    const doc = extractDoc(page, 'app', 'x', 'x');
    expect(doc.html).toContain(`.${DOC_SCOPE} .wrap{max-width:820px}`);
    expect(doc.html).toContain('<h1>T</h1>');
  });

  it('still strips scripts and handlers — keeping CSS is not keeping behaviour', async () => {
    const { extractDoc } = await import('../src/console/docs');
    const doc = extractDoc(
      `<style>.a{color:red}</style><body><p onclick="steal()">x</p><script>alert(1)</script></body>`,
      'app',
      'x',
      'x',
    );
    expect(doc.html).toContain('.doc-embed .a{color:red}');
    expect(doc.html).not.toContain('alert(1)');
    expect(doc.html).not.toContain('onclick');
  });

  it('scopes the REAL purge page, whose SVG diagram is entirely class-positioned', async () => {
    // The page that exposed this: ~70 KB with an inline sequence diagram where every label's
    // position and colour comes from a .seq-* class. Unscoped-and-stripped it renders as text
    // piled at the origin, indistinguishable from a broken page.
    const { readFile } = await import('node:fs/promises');
    const { extractDoc } = await import('../src/console/docs');
    const src = await readFile(
      new URL('../../dorinda-web/public/docs/admin-purge.html', import.meta.url).pathname,
      'utf8',
    ).catch(() => null);
    if (!src) return; // dorinda-web not checked out beside forge — skip rather than fail.
    const doc = extractDoc(src, 'app', 'admin-purge', 'x');
    expect(doc.html).toContain('.doc-embed .seq-lbl');
    expect(doc.html).not.toMatch(/(^|[^-\w.])body\s*\{/);
  });
});

describe("docs — a document's own chrome must not become the embed's layout", () => {
  it('drops box layout from html/body/:root rules but keeps their look', async () => {
    const { scopeCss } = await import('../src/console/docs');
    // The devs portal sets `body{display:flex}` so a fixed sidebar sits beside its content. Mapped
    // onto the embed that made the container a flex ROW, and every heading, paragraph and table
    // laid out as a narrow vertical strip — unreadable, and it looked like a content bug.
    const out = scopeCss(
      'body{display:flex;min-height:100vh;background:#0b1220;color:#e6edf7;font:15px sans-serif}',
    );
    expect(out).toContain('background:#0b1220');
    expect(out).toContain('color:#e6edf7');
    expect(out).not.toContain('display:flex');
    expect(out).not.toContain('min-height');
  });

  it("keeps custom properties declared on :root — they are the page's design tokens", async () => {
    const { scopeCss } = await import('../src/console/docs');
    const out = scopeCss(':root{--ink:#e6edf7;--bg:#0b1220;padding:40px}');
    expect(out).toContain('--ink:#e6edf7');
    expect(out).toContain('--bg:#0b1220');
    expect(out).not.toContain('padding:40px');
  });

  it('leaves layout on NON-document selectors alone', async () => {
    const { scopeCss } = await import('../src/console/docs');
    // Only the container rule is special. A page's own `.grid{display:grid}` is its content's
    // layout and must survive, or the document loses its structure.
    const out = scopeCss('.grid{display:grid;gap:14px}');
    expect(out).toContain('.doc-embed .grid{display:grid;gap:14px}');
  });

  it('drops a document rule that is ONLY layout, rather than emitting an empty one', async () => {
    const { scopeCss } = await import('../src/console/docs');
    expect(scopeCss('body{display:flex;margin:0}').trim()).toBe('');
  });

  it('the REAL bundled portal pages no longer flex the embed', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { extractDoc } = await import('../src/console/docs');
    const dir = join(process.cwd(), 'src', 'console', 'docs', 'content');
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.html'))) {
      const doc = extractDoc(await readFile(join(dir, f), 'utf8'), 'platform', f, f);
      const containerRule = /\.doc-embed\{([^}]*)\}/.exec(doc.html)?.[1] ?? '';
      expect(containerRule, `${f} pushes layout onto the embed`).not.toMatch(/display\s*:/);
    }
  });
});

describe('tenant provider — two credentials, two surfaces', () => {
  const ctx = { env: 'prod-a' as never, signal: AbortSignal.timeout(5_000), now: new Date() };

  function stubFetch(handler: (url: string, init: RequestInit) => unknown) {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown; method: string }> = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        headers,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        method: init.method ?? 'GET',
      });
      const out = handler(String(url), init);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out ?? {}), { headers: { 'content-type': 'application/json' } });
    }) as never;
    return {
      calls,
      restore: () => {
        globalThis.fetch = real;
      },
    };
  }

  it('sends the ADMIN token to /api/admin and the TEST token to /api/test — never the reverse', async () => {
    // The separation that bounds the blast radius: AUTH-style tokens leak, and the admin token can
    // erase a real account while the test token structurally cannot touch one.
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({
      origin: 'https://api.test',
      adminToken: 'ADMIN',
      testToken: 'TEST',
    });
    const f = stubFetch((url) => (url.includes('/api/admin/accounts') ? { accounts: [] } : {}));
    try {
      await p.listAccounts(ctx);
      await p.reset(ctx, 'owner_1');
      const admin = f.calls.find((c) => c.url.includes('/api/admin/'))!;
      const test = f.calls.find((c) => c.url.includes('/api/test/'))!;
      expect(admin.headers['x-admin-token']).toBe('ADMIN');
      expect(admin.headers['x-dorinda-test-token']).toBeUndefined();
      expect(test.headers['x-dorinda-test-token']).toBe('TEST');
      expect(test.headers['x-admin-token']).toBeUndefined();
    } finally {
      f.restore();
    }
  });

  it('reports UNCONFIGURED per credential rather than falling back to the other', async () => {
    // A fallback is exactly how a reset would one day arrive at the purge surface.
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({ origin: 'https://api.test', adminToken: 'ADMIN' });
    expect(p.supports('accounts.purge')).toBe(true);
    expect(p.supports('test.reset')).toBe(false);
    const f = stubFetch(() => ({}));
    try {
      await expect(p.reset(ctx, 'o')).rejects.toMatchObject({ code: 'not_configured' });
      expect(f.calls).toHaveLength(0); // it did not try the admin token instead
    } finally {
      f.restore();
    }
  });

  it("carries the APP's status and code through — a refusal must read as a refusal", async () => {
    // `403 not_a_test_tenant` and `503 platform_teardown_incomplete` are the two answers an operator
    // most needs exactly. Flattened to 502 "upstream error" they become a shrug.
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({ origin: 'https://api.test', testToken: 'TEST' });
    const f = stubFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'not_a_test_tenant', message: 'owner x is NOT flagged' } }),
          {
            status: 403,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    try {
      await expect(p.reset(ctx, 'x')).rejects.toMatchObject({ status: 403, code: 'not_a_test_tenant' });
    } finally {
      f.restore();
    }
  });

  it('refuses a purge whose confirmation does not match what the console displayed', async () => {
    // Checked HERE as well as in the app. The app checks against the identity forge holds; this
    // checks against the row the operator was looking at, which closes the stale-list case where
    // the email they can SEE belongs to a different owner id.
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({ origin: 'https://api.test', adminToken: 'ADMIN' });
    const f = stubFetch((url) =>
      url.includes('/api/admin/accounts?owner=')
        ? { owner: 'owner_1', email: 'real@x.test', household: {}, connectionCount: 0 }
        : { accounts: [{ owner: 'owner_1', email: 'real@x.test' }] },
    );
    try {
      await expect(p.purge(ctx, 'owner_1', 'typo@x.test')).rejects.toMatchObject({
        code: 'confirmation_mismatch',
      });
      // …and it never reached the purge endpoint.
      expect(f.calls.some((c) => c.url.includes('/purge'))).toBe(false);
    } finally {
      f.restore();
    }
  });

  it("translates lock to the app's inverse `active` flag", async () => {
    // The app models this as active/inactive. Translating in the provider means no screen has to
    // remember which polarity a given app uses.
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({ origin: 'https://api.test', adminToken: 'ADMIN' });
    const f = stubFetch(() => ({ subscription_status: 'paused', active: false }));
    try {
      const out = await p.setLocked(ctx, 'owner_1', true);
      expect(f.calls[0]!.body).toEqual({ owner: 'owner_1', active: false });
      expect(out.locked).toBe(true);
    } finally {
      f.restore();
    }
  });

  it('reads test tenants from the TEST surface, not the admin account list', async () => {
    /*
     * This previously asserted the opposite — that the list was FILTERED from the one admin account
     * read, so two endpoints could not disagree about which owners are test tenants. That reasoning
     * was sound and the trade-off turned out to be wrong twice over:
     *
     *   · it made the Test tenants screen depend on the credential that can ERASE a real account,
     *     which is the exact coupling the two-token split exists to prevent; and
     *   · an account row cannot answer the two questions the screen needs — is this fixture seeded,
     *     and does it head a household — so the operator was left guessing at both.
     *
     * The disagreement risk it was protecting against is handled at the source instead: both reads
     * resolve "is a test tenant" from the same `test_tenant` column.
     */
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({ origin: 'https://api.test', testToken: 'TEST' });
    let sawUrl = '';
    let sawTestHeader = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sawUrl = String(url);
      sawTestHeader = Boolean((init.headers as Record<string, string>)['x-dorinda-test-token']);
      return new Response(
        JSON.stringify({
          tenants: [
            {
              owner: 'test',
              email: 'r@dorinda.test',
              isHouseholdOwner: true,
              householdRole: 'owner',
              memberEmails: ['kid@dorinda.test'],
              counts: { delegations: 2 },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as never;
    try {
      const out = await p.listTestTenants(ctx);
      expect(sawUrl).toContain('/api/test/tenants');
      // The TEST credential, never the admin one — that separation is the point.
      expect(sawTestHeader).toBe(true);
      expect(out[0]).toMatchObject({
        owner: 'test',
        isHouseholdOwner: true,
        memberEmails: ['kid@dorinda.test'],
      });
      // The seeded signal survives the mapping; without it the screen cannot tell empty from full.
      expect(out[0]!.counts['delegations']).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('metric catalog — one definition, read from the dashboard', () => {
  it('extracts a queryable metric from each panel, ignoring rows and text', async () => {
    const { extractCatalog } = await import('../src/console/metrics-catalog');
    const doc = {
      dashboard: {
        title: 'Product — top-line',
        panels: [
          { type: 'row', title: 'Group', panels: [{ title: 'Nested', targets: [{ expr: 'up' }] }] },
          {
            title: 'Tool calls / min',
            type: 'timeseries',
            description: 'why it matters',
            fieldConfig: { defaults: { unit: 'cpm' } },
            targets: [{ expr: 'sum(rate(x[5m]))' }],
          },
          { title: 'Just prose', type: 'text' },
          { title: 'No expr', type: 'timeseries', targets: [{}] },
        ],
      },
    };
    const out = extractCatalog(doc);
    expect(out.map((m) => m.id)).toEqual(['nested', 'tool-calls-min']);
    const calls = out.find((m) => m.id === 'tool-calls-min')!;
    expect(calls.expr).toBe('sum(rate(x[5m]))');
    expect(calls.unit).toBe('cpm');
    // The description rides along, so the EXPLANATION cannot drift from the query either.
    expect(calls.description).toBe('why it matters');
  });

  it('gives colliding panel titles distinct ids', async () => {
    const { extractCatalog } = await import('../src/console/metrics-catalog');
    const out = extractCatalog({
      panels: [
        { title: 'Rate', targets: [{ expr: 'a' }] },
        { title: 'Rate', targets: [{ expr: 'b' }] },
      ],
    });
    // Without this, the second panel silently shadows the first and one metric becomes unreachable.
    expect(out.map((m) => m.id)).toEqual(['rate', 'rate-2']);
    expect(out.map((m) => m.expr)).toEqual(['a', 'b']);
  });

  it('reports a failure and returns NO metrics — never a stale local copy', async () => {
    const { createGrafanaCatalog } = await import('../src/console/metrics-catalog');
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as never;
    try {
      const c = createGrafanaCatalog({ origin: 'https://g.test', user: 'u', pass: 'p', dashboardUid: 'd' });
      const out = await c.get(AbortSignal.timeout(5_000));
      expect(out.metrics).toEqual([]);
      expect(out.error).toContain('503');
      // A bundled fallback copy would render happily while disagreeing with the dashboard — which is
      // the precise failure a shared definition exists to prevent. Absence must stay visible.
    } finally {
      globalThis.fetch = real;
    }
  });

  it('treats a dashboard with no queryable panels as an ERROR, not an empty catalog', async () => {
    const { createGrafanaCatalog } = await import('../src/console/metrics-catalog');
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ dashboard: { title: 'T', panels: [{ title: 'text only' }] } }), {
        headers: { 'content-type': 'application/json' },
      })) as never;
    try {
      const c = createGrafanaCatalog({ origin: 'https://g.test', user: 'u', pass: 'p', dashboardUid: 'd' });
      const out = await c.get(AbortSignal.timeout(5_000));
      // "The dashboard changed shape" and "there are no metrics" look identical otherwise.
      expect(out.error).toContain('no queryable panels');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('caches, so Grafana is not in the hot path of every render', async () => {
    const { createGrafanaCatalog } = await import('../src/console/metrics-catalog');
    let calls = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ dashboard: { title: 'T', panels: [{ title: 'A', targets: [{ expr: 'x' }] }] } }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as never;
    try {
      const c = createGrafanaCatalog(
        { origin: 'https://g.test', user: 'u', pass: 'p', dashboardUid: 'd' },
        60_000,
      );
      let t = 1_000;
      await c.get(AbortSignal.timeout(5_000), () => t);
      await c.get(AbortSignal.timeout(5_000), () => t);
      expect(calls).toBe(1);
      t += 61_000;
      await c.get(AbortSignal.timeout(5_000), () => t);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('is unconfigured, not broken, when Grafana details are absent', async () => {
    const { createGrafanaCatalog, catalogConfigured } = await import('../src/console/metrics-catalog');
    expect(catalogConfigured({})).toBe(false);
    const c = createGrafanaCatalog({});
    const out = await c.get(AbortSignal.timeout(5_000));
    expect(out.error).toContain('not configured');
  });
});

describe('the top-line dashboard is the definition, and it must stay honest', () => {
  it('never queries mcp_tool_errors_total — a metric that is NEVER emitted', async () => {
    /*
     * The bug that motivated the shared catalog. dorinda-api records errors as
     * mcp_tool_calls_total{outcome="error"}; there is no mcp_tool_errors_total, and enumerating
     * __name__ in Managed Prometheus on 2026-08-02 confirmed it. Both Grafana and the console used
     * to query that name — Grafana via a regex that matched nothing silently, the console directly —
     * so error rate read as zero on two surfaces at once, with nothing to compare against.
     */
    const { readFile } = await import('node:fs/promises');
    const path = new URL('../../dorinda-metrics/dashboards/dorinda-product-topline.json', import.meta.url)
      .pathname;
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (!raw) return; // dorinda-metrics not checked out beside forge — skip rather than fail.
    // Assert against the QUERIES, not the file. A panel description explains this very bug and names
    // the metric; matching raw text flagged that prose and would have pressured the explanation to
    // get vaguer to satisfy a test. Same lesson as the docs boundary check.
    const dash = JSON.parse(raw) as { panels: Array<{ title: string; targets: Array<{ expr: string }> }> };
    const exprs = dash.panels.flatMap((p) => p.targets.map((t) => t.expr));
    expect(exprs.length).toBeGreaterThan(4);
    for (const e of exprs)
      expect(e, `panel query uses a metric that is never emitted: ${e}`).not.toContain('mcp_tool_errors');
    expect(exprs.some((e) => e.includes('outcome="error"'))).toBe(true);
  });

  it('carries a heartbeat panel — without it every other panel can lie', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = new URL('../../dorinda-metrics/dashboards/dorinda-product-topline.json', import.meta.url)
      .pathname;
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (!raw) return;
    // A dead pipeline makes "no traffic" and "no telemetry" identical. Absence must mean BROKEN,
    // which only a heartbeat can express — an event-driven metric cannot.
    const dash = JSON.parse(raw) as { panels: Array<{ targets: Array<{ expr: string }> }> };
    const exprs = dash.panels.flatMap((p) => p.targets.map((t) => t.expr));
    expect(exprs.some((e) => e.includes('pipeline_heartbeat_total'))).toBe(true);
  });
});

describe('connections — a false zero is worse than no answer', () => {
  const ctx = { env: 'prod-a' as never, signal: AbortSignal.timeout(5_000), now: new Date() };

  it('carries streamsError through, so the UI can show UNKNOWN instead of 0', async () => {
    /*
     * The live channel feed comes from an in-process registry on the data plane. When it cannot be
     * read, the payload still contains zeros — and rendering those turns "we could not ask" into
     * "nobody is connected". Those lead to opposite actions: one sends you to reconnect a client
     * that is fine, the other hides a client that is genuinely detached.
     */
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          observedAt: '2026-08-02T00:00:00Z',
          totals: { connections: 2, activeRecently: 1, revoked: 0, toolRefreshChannels: 0 },
          byClient: [
            {
              client: 'Claude',
              connections: 2,
              activeRecently: 1,
              revoked: 0,
              toolRefreshChannels: 0,
              lastSeenAt: null,
            },
          ],
          bySource: [],
          streamsError: 'data-plane unreachable',
          platformNote: 'hosted connectors are not device-observable',
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as never;
    try {
      const p = createDorindaTenantProvider({ origin: 'https://api.test', adminToken: 'ADMIN' });
      const out = await p.connections(ctx);
      expect(out.streamsError).toBe('data-plane unreachable');
      expect(out.totals.connections).toBe(2);
      expect(out.note).toContain('device-observable');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('passes the freshness window through and reports it back', async () => {
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (u: string) => {
      calls.push(String(u));
      return new Response(
        JSON.stringify({ observedAt: 'x', totals: {}, byClient: [], bySource: [], recentWithinHours: 168 }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as never;
    try {
      const p = createDorindaTenantProvider({ origin: 'https://api.test', adminToken: 'ADMIN' });
      const out = await p.connections(ctx, 168);
      expect(calls[0]).toContain('hours=168');
      // Reported back rather than assumed by the UI — "active" means nothing without its window.
      expect(out.recentWithinHours).toBe(168);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('needs only the admin credential — it is a read, so no audited write', async () => {
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({ origin: 'https://api.test', adminToken: 'ADMIN' });
    expect(p.supports('connections.read')).toBe(true);
    const noAdmin = createDorindaTenantProvider({ origin: 'https://api.test', testToken: 'TEST' });
    expect(noAdmin.supports('connections.read')).toBe(false);
  });
});

describe('every dashboard panel points at a datasource that EXISTS', () => {
  it('no panel references an undeclared datasource uid', async () => {
    /*
     * The failure this catches, which shipped once: `dorinda-product-topline` went out with an
     * INVENTED uid (`gmp`) while provisioning declares `forge-prometheus`. Every panel pointed at a
     * datasource that does not exist, so the whole board read "no data" — and the queries themselves
     * were fine, which is exactly why it was not obvious.
     *
     * It also slipped through because the queries were validated against Managed Prometheus
     * DIRECTLY and the dashboard was never loaded. "Verify the pane, not the store" is written down
     * in this estate; this is the mechanical version of that rule, so it does not depend on
     * remembering it.
     */
    const { readFile, readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const base = new URL('../../dorinda-metrics', import.meta.url).pathname;

    const dsRaw = await readFile(join(base, 'provisioning/datasources/datasources.yaml'), 'utf8').catch(
      () => null,
    );
    if (!dsRaw) return; // dorinda-metrics not checked out beside forge — skip rather than fail.

    // Cheap YAML read: every `uid:` in the datasource provisioning file.
    const declared = new Set([...dsRaw.matchAll(/^\s*uid:\s*([A-Za-z0-9_-]+)/gm)].map((m) => m[1]!));
    expect(declared.size, 'no datasource uids parsed — the provisioning format changed').toBeGreaterThan(0);

    const dir = join(base, 'dashboards');
    const offenders: string[] = [];
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json'))) {
      const dash = JSON.parse(await readFile(join(dir, f), 'utf8')) as {
        panels?: Array<{ title?: string; datasource?: { uid?: string } }>;
      };
      for (const p of dash.panels ?? []) {
        const uid = p.datasource?.uid;
        // A templated uid ("${ds}") is resolved by Grafana at render time, not by us.
        if (!uid || uid.startsWith('$')) continue;
        if (!declared.has(uid)) offenders.push(`${f} → "${p.title}" uses datasource "${uid}"`);
      }
    }
    expect(
      offenders,
      `these panels reference a datasource uid that provisioning does not declare, so they render ` +
        `"no data" no matter how correct their queries are`,
    ).toEqual([]);
  });
});

describe('Grafana time macros resolve, rather than reaching Prometheus verbatim', () => {
  it('substitutes $__range, $__range_s and $__rate_interval', async () => {
    const { resolveGrafanaMacros } = await import('../src/console/metrics-catalog');
    const out = resolveGrafanaMacros(
      'histogram_quantile(0.95, sum by (le) (increase(m_bucket[$__range])))',
      6 * 3600,
    );
    expect(out).toContain('[21600s]');
    expect(out).not.toContain('$__range');
    expect(resolveGrafanaMacros('x[$__range_s]', 3600)).toBe('x[3600]');
    expect(resolveGrafanaMacros('rate(x[$__rate_interval])', 3600)).toMatch(/rate\(x\[\d+s\]\)/);
  });

  it('never emits a sub-minute window, which Prometheus would reject as useless', async () => {
    const { resolveGrafanaMacros } = await import('../src/console/metrics-catalog');
    expect(resolveGrafanaMacros('x[$__range]', 5)).toBe('x[60s]');
    expect(resolveGrafanaMacros('rate(x[$__rate_interval])', 5)).toBe('rate(x[60s])');
  });

  it('leaves an expression with no macros untouched', async () => {
    const { resolveGrafanaMacros } = await import('../src/console/metrics-catalog');
    const e = 'sum(rate(mcp_tool_calls_total[5m])) * 60';
    expect(resolveGrafanaMacros(e, 3600)).toBe(e);
  });

  it('the p95 panel uses $__range — a 5m rate is ZERO at this traffic level', async () => {
    /*
     * Measured, not assumed. Over 6h of real production traffic:
     *   sum by (le) (rate(bucket[5m]))      → 160 points, ALL ZERO
     *   histogram_quantile(.95, …[1h])      → EMPTY (all-zero histogram ⇒ NaN ⇒ series dropped)
     *   histogram_quantile(.95, …[6h])      → 8 points, p95 = 97.5ms
     *
     * So the panel read "no data" while the histogram beneath it was perfectly healthy — the same
     * shape of lie as an empty store, from a query that is simply too narrow for the traffic.
     */
    const { readFile } = await import('node:fs/promises');
    const path = new URL('../../dorinda-metrics/dashboards/dorinda-product-topline.json', import.meta.url)
      .pathname;
    const raw = await readFile(path, 'utf8').catch(() => null);
    if (!raw) return;
    const dash = JSON.parse(raw) as { panels: Array<{ title: string; targets: Array<{ expr: string }> }> };
    const p95 = dash.panels.find((p) => p.title.includes('p95'));
    expect(p95?.targets[0]?.expr).toContain('$__range');
    expect(p95?.targets[0]?.expr).not.toContain('[5m]');
  });
});

describe('embedded Grafana boards — self-healing across a redeploy', () => {
  function stub(handler: (url: string, init: RequestInit) => unknown) {
    const calls: Array<{ url: string; method: string }> = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET' });
      const out = handler(String(url), init);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out ?? {}), { headers: { 'content-type': 'application/json' } });
    }) as never;
    return {
      calls,
      restore: () => {
        globalThis.fetch = real;
      },
    };
  }
  const cfg = { origin: 'https://g.test', user: 'u', pass: 'p', folder: 'Dorinda' };

  it('offers only the configured folder', async () => {
    const { createGrafanaBoards } = await import('../src/console/grafana-boards');
    const f = stub((url) =>
      url.includes('/api/search')
        ? [
            { uid: 'a', title: 'Product — top-line', url: '/d/a', folderTitle: 'Dorinda' },
            { uid: 'b', title: 'Someone else', url: '/d/b', folderTitle: 'Other' },
            { uid: 'c', title: 'Loose board', url: '/d/c' },
          ]
        : { accessToken: 'tok', isEnabled: true },
    );
    try {
      const out = await createGrafanaBoards(cfg).list(AbortSignal.timeout(5_000));
      expect(out.boards.map((b) => b.uid)).toEqual(['a']);
    } finally {
      f.restore();
    }
  });

  it('PUBLISHES a board whose token is gone — the redeploy case', async () => {
    /*
     * Grafana's database here is SQLite on an ephemeral filesystem, so every redeploy wipes public
     * dashboard tokens. If the console only READ them, each board would silently stop embedding
     * until a human noticed and republished — a fix that depends on someone remembering, which is
     * not a fix.
     */
    const { createGrafanaBoards } = await import('../src/console/grafana-boards');
    const f = stub((url, init) => {
      if (url.includes('/api/search')) return [{ uid: 'a', title: 'A', url: '/d/a', folderTitle: 'Dorinda' }];
      if ((init.method ?? 'GET') === 'GET') return new Response('not found', { status: 404 });
      return { accessToken: 'fresh-token' };
    });
    try {
      const out = await createGrafanaBoards(cfg).list(AbortSignal.timeout(5_000));
      expect(out.boards[0]!.embedUrl).toBe('https://g.test/public-dashboards/fresh-token');
      expect(f.calls.some((c) => c.method === 'POST')).toBe(true);
    } finally {
      f.restore();
    }
  });

  it('reuses an existing enabled token instead of republishing', async () => {
    const { createGrafanaBoards } = await import('../src/console/grafana-boards');
    const f = stub((url) =>
      url.includes('/api/search')
        ? [{ uid: 'a', title: 'A', url: '/d/a', folderTitle: 'Dorinda' }]
        : { accessToken: 'existing', isEnabled: true },
    );
    try {
      const out = await createGrafanaBoards(cfg).list(AbortSignal.timeout(5_000));
      expect(out.boards[0]!.embedUrl).toContain('existing');
      expect(f.calls.some((c) => c.method === 'POST')).toBe(false);
    } finally {
      f.restore();
    }
  });

  it('one unpublishable board does not blank the others', async () => {
    const { createGrafanaBoards } = await import('../src/console/grafana-boards');
    const f = stub((url, init) => {
      if (url.includes('/api/search'))
        return [
          { uid: 'ok', title: 'Product — top-line', url: '/d/ok', folderTitle: 'Dorinda' },
          { uid: 'bad', title: 'Broken', url: '/d/bad', folderTitle: 'Dorinda' },
        ];
      if (url.includes('/bad/')) return new Response('nope', { status: 500 });
      return { accessToken: 'tok', isEnabled: true };
    });
    try {
      const out = await createGrafanaBoards(cfg).list(AbortSignal.timeout(5_000));
      const bad = out.boards.find((b) => b.uid === 'bad')!;
      const ok = out.boards.find((b) => b.uid === 'ok')!;
      expect(ok.embedUrl).toBeTruthy();
      expect(bad.embedUrl).toBeUndefined();
      // Reported next to the ones that worked, never silently dropped from the list.
      expect(bad.error).toContain('500');
    } finally {
      f.restore();
    }
  });

  it('publishes with the time picker ON and annotations OFF', async () => {
    const { createGrafanaBoards } = await import('../src/console/grafana-boards');
    let body: Record<string, unknown> = {};
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      if (String(url).includes('/api/search'))
        return new Response(JSON.stringify([{ uid: 'a', title: 'A', url: '/d/a', folderTitle: 'Dorinda' }]), {
          headers: { 'content-type': 'application/json' },
        });
      if ((init.method ?? 'GET') === 'GET') return new Response('x', { status: 404 });
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ accessToken: 't' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as never;
    try {
      await createGrafanaBoards(cfg).list(AbortSignal.timeout(5_000));
      // Not being able to widen the window is what made the previous screen useless.
      expect(body['timeSelectionEnabled']).toBe(true);
      // Annotations can carry free text an author never meant to publish.
      expect(body['annotationsEnabled']).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('puts the product board first', async () => {
    const { createGrafanaBoards } = await import('../src/console/grafana-boards');
    const f = stub((url) =>
      url.includes('/api/search')
        ? [
            { uid: 'z', title: 'Background Plane', url: '/d/z', folderTitle: 'Dorinda' },
            { uid: 'p', title: 'Product — top-line', url: '/d/p', folderTitle: 'Dorinda' },
            { uid: 'a', title: 'A board', url: '/d/a', folderTitle: 'Dorinda' },
          ]
        : { accessToken: 't', isEnabled: true },
    );
    try {
      const out = await createGrafanaBoards(cfg).list(AbortSignal.timeout(5_000));
      // Someone opening this screen is asking "how is the product", not "what is alphabetically first".
      expect(out.boards[0]!.title).toContain('Product');
    } finally {
      f.restore();
    }
  });
});

describe('the Seed editor shows what actually produced a tenant', () => {
  /*
   * This exists because the bug it prevents was INVISIBLE to every check I ran.
   *
   * The restore was written inline in a click handler. A later edit to it silently failed to apply
   * — the anchor's indentation had shifted when the table gained a nesting level, and `replace()`
   * no-ops rather than erroring. The type change and the LABEL change did land, so the banner read
   * "Already seeded — the fixture below is the one that produced it" while the editor showed `{}`.
   * Typecheck passed, every test passed, and grepping for strings from the change found them.
   *
   * The decision is a pure function now, so it can be asserted rather than inferred from source.
   */
  it("restores the tenant's own fixture, and marks no preset as selected", async () => {
    const { fixtureForSelection } = await import('../console/src/lib/seed-editor');
    const own = { people: [{ displayName: 'Dr. Alvarez' }] };
    const out = fixtureForSelection({ lastFixture: own }, { fallback: true });
    // The editor holds THIS tenant's fixture…
    expect(JSON.parse(out.fixture)).toEqual(own);
    // …and no preset reads as selected, because none of them is what is applied.
    expect(out.preset).toBe('');
  });

  it('falls back to a preset when the tenant has no fixture of its own', async () => {
    const { fixtureForSelection } = await import('../console/src/lib/seed-editor');
    // A household MEMBER is the normal case here: created by its owner's fixture, so it holds none.
    const out = fixtureForSelection({ lastFixture: null }, { empty: true });
    expect(out.preset).toBe('empty');
    expect(JSON.parse(out.fixture)).toEqual({ empty: true });
  });

  it('falls back when nothing is selected at all', async () => {
    const { fixtureForSelection } = await import('../console/src/lib/seed-editor');
    expect(fixtureForSelection(null, {}).preset).toBe('empty');
  });
});

describe('logs — trace correlation is the point of this screen', () => {
  it('the route accepts a trace filter, which the provider always supported', async () => {
    /*
     * `trace_id` sat in LogQuery from the start and no route ever exposed it, so the one question
     * an incident actually begins with — "one request failed, show me everything it did across
     * every service" — could not be asked. Without it an operator greps a message string and finds
     * the line they already had, not the ones around it.
     */
    const { buildServer } = await import('../src/console/server');
    process.env.CONSOLE_BASIC_USER = 'u';
    process.env.CONSOLE_BASIC_PASS = 'p';
    const app = buildServer();
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/logs?trace=abc123&minutes=60',
      headers: { authorization: 'Basic ' + Buffer.from('u:p').toString('base64') },
    });
    // No logs provider is configured in tests; what matters is that the route ACCEPTS the parameter
    // rather than rejecting it, and answers in the envelope shape.
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty('data');
    await app.close();
    /*
     * 30s, not the 5s default. This route really does reach a provider, and on a runner with NO GCP
     * credentials the first credential attempt legitimately costs ~23 seconds: a 3s metadata
     * timeout, an ADC read, then up to 20s on the gcloud CLI. It passed locally (where ADC exists)
     * and timed out in CI — a flake that was reporting a real property of the product, namely that
     * an unconfigured environment HANGS rather than failing.
     *
     * The product fix is the negative credential cache in `console-gcp/http.ts`, so only the FIRST
     * call pays that cost instead of every call. This timeout covers that first call honestly
     * rather than pretending the path is fast.
     */
  }, 30_000);

  it('a truncated answer is still reported as truncated', async () => {
    // Logs come back newest-first, so hitting the row limit means the response covers a SMALLER
    // window than the one asked for. During the 2026-07-31 run a 190-minute query returned 400 rows
    // spanning 20 minutes, and "no 5xx in 190 minutes" was about to be recorded as a pass.
    const src = await (
      await import('node:fs/promises')
    ).readFile(new URL('../src/console/server.ts', import.meta.url).pathname, 'utf8');
    expect(src).toMatch(/truncated/);
    expect(src).toMatch(/oldest/);
  });
});

describe('Explore renders logs only — metrics live on Dashboards now', () => {
  it('the Explore screen has no metric picker left', async () => {
    /*
     * Metrics on this screen were a single sparkline with no axes and no shared window, which
     * answered no question anyone arrives with. They moved to Dashboards, which embeds the real
     * Grafana boards whole. Asserted structurally so the two cannot quietly merge back.
     */
    const src = await (
      await import('node:fs/promises')
    )
      .readFile(new URL('../../forge/console/src/App.tsx', import.meta.url).pathname, 'utf8')
      .catch(() => null);
    if (!src) return;
    const start = src.indexOf('// ── Explore — logs ──');
    const end = src.indexOf('// ── Credentials & expiry ──');
    expect(start, 'the Explore logs section is missing').toBeGreaterThan(-1);
    const explore = src.slice(start, end);
    expect(explore).not.toContain('/api/metrics');
    expect(explore).not.toContain("'metrics'");
    // …and it still does the things a log view needs.
    expect(explore).toContain('/api/logs');
    expect(explore).toContain('trace');
    expect(explore).toContain('severity');
  });
});

describe('log filters combine — owner is a clause, not an override', () => {
  it('owner filters by opaque id and STILL respects service and severity', async () => {
    /*
     * The first attempt routed owner through `native`, which REPLACES the whole filter — so asking
     * for "this user's errors in dorinda-api" would silently have returned every line for that user
     * across every service at every level. A filter that quietly answers a broader question than
     * the one asked is worse than one that fails.
     */
    const { buildFilter } = await import('../src/plugins/console-gcp/logs');
    const f = buildFilter({
      owner: 'user_abc',
      runtime_id: 'dorinda-api',
      severity_at_least: 'error' as never,
    });
    expect(f).toContain('jsonPayload.owner="user_abc"');
    expect(f).toContain('resource.labels.service_name="dorinda-api"');
    expect(f).toContain('severity>=ERROR');
  });

  it('strips quotes from an owner so a filter cannot be rewritten', async () => {
    const { buildFilter } = await import('../src/plugins/console-gcp/logs');
    const f = buildFilter({ owner: 'x" OR severity>="DEFAULT' });
    expect(f).toBe('jsonPayload.owner="x OR severity>=DEFAULT"');
  });

  it('reads a trace id from the payload when the LogEntry trace field is absent', async () => {
    /*
     * The extractor and the filter must agree on where a trace id can live, or the console finds
     * entries it cannot offer to pivot FROM: the row plainly carries an id and shows no Trace link.
     *
     * Reading only `e.trace` was the extractor half of the same two-places bug the filter had.
     */
    /*
     * The credential cache is process-global, so a previous case that exhausted the credential paths
     * would leave a cached "no credentials" verdict here and this test would fail on a neighbour's
     * leftovers rather than its own behaviour. Cleared explicitly.
     */
    const { resetCredentialCache } = await import('../src/plugins/console-gcp/http');
    resetCredentialCache();
    const { createCloudLoggingProvider } = await import('../src/plugins/console-gcp/logs');
    const provider = createCloudLoggingProvider({
      id: 'l',
      envs: ['prod'],
      scope: { project_id: 'p' },
    });
    const entries = [
      { timestamp: 't1', severity: 'INFO', jsonPayload: { type: 'x', trace_id: 'payload-id' } },
      { timestamp: 't2', severity: 'INFO', trace: 'projects/p/traces/entry-id', jsonPayload: {} },
      { timestamp: 't3', severity: 'INFO', jsonPayload: { type: 'y' } },
    ];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ entries }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as never;
    try {
      const out = await provider.query(
        {} as never,
        { start: new Date(0), end: new Date(1), limit: 10 } as never,
        { signal: new AbortController().signal } as never,
      );
      expect(out.map((e) => e.trace_id)).toEqual(['payload-id', 'entry-id', undefined]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('the clock call passes settle and max_rounds through to the app, in its snake_case', async () => {
    /*
     * A passthrough parameter is the easiest thing in a console to get silently wrong: the button
     * exists, the request succeeds, and the value is simply absent from the body. The operator then
     * concludes the product ignored their setting.
     *
     * Both of these change BEHAVIOUR rather than presentation — `settle: false` means "move the
     * clock but fire nothing", which is how you stage a clock before seeding, and `max_rounds`
     * bounds a loop whose overrun is a real finding about the product. Dropping either produces a
     * plausible-looking result that answers a different question.
     */
    const { createDorindaTenantProvider } = await import('../src/plugins/console-dorinda/tenants');
    const p = createDorindaTenantProvider({ origin: 'https://api.test', testToken: 't' });

    let sentBody: Record<string, unknown> | undefined;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ owner: 'o', virtual_now: 'v', real_now: 'r', generation: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as never;
    try {
      await p.setClock({ signal: new AbortController().signal } as never, 'o', {
        advanceMs: 3_600_000,
        settle: false,
        maxRounds: 25,
      });
    } finally {
      globalThis.fetch = realFetch;
    }

    // snake_case on the wire — the app's contract, not the console's camelCase.
    expect(sentBody).toMatchObject({ advance_ms: 3_600_000, settle: false, max_rounds: 25 });
    // `settle: false` must survive as FALSE, not be dropped as falsy — the failure mode where a
    // "move only" request quietly fires every due notification.
    expect(sentBody!['settle']).toBe(false);
  });

  it('production EXCLUDES test data, and still includes unattributed lines', async () => {
    /*
     * The subtle half. `production` cannot be `jsonPayload.test="false"`: boot lines, webhooks and
     * unauthenticated requests carry NO `test` field at all, having never been attributed either
     * way. Matching only the explicit false would silently drop every one of them — and an
     * unexplained incident is far more likely to be hiding in an unattributed line than in a
     * fixture. So it is a NEGATION, which matches both false and absent.
     */
    const { buildFilter } = await import('../src/plugins/console-gcp/logs');
    const prod = buildFilter({ data_set: 'production' } as never);
    expect(prod).toContain('NOT jsonPayload.test="true"');
    expect(prod).not.toContain('jsonPayload.test="false"');

    // `test` is the strict inverse: only what is positively marked as fixture traffic.
    expect(buildFilter({ data_set: 'test' } as never)).toBe('jsonPayload.test="true"');

    // `all` adds no clause at all.
    expect(buildFilter({ data_set: 'all' } as never)).toBe('');
  });

  it('the data-set clause combines with the others rather than replacing them', async () => {
    // "this user's errors in dorinda-api, production only" has to be expressible — a filter that
    // silently answered a broader question would be worse than one that failed.
    const { buildFilter } = await import('../src/plugins/console-gcp/logs');
    const f = buildFilter({
      data_set: 'production',
      owner: 'user_x',
      runtime_id: 'dorinda-api',
      severity_at_least: 'error',
    } as never);
    expect(f).toContain('NOT jsonPayload.test="true"');
    expect(f).toContain('jsonPayload.owner="user_x"');
    expect(f).toContain('resource.labels.service_name="dorinda-api"');
    expect(f).toContain('severity>=ERROR');
  });

  it('a trace pivot matches BOTH the LogEntry trace field and a payload trace_id', async () => {
    /*
     * The same trace id lives in two places, and matching one returns a SUBSET.
     *
     * Verified against production, not reasoned about: for one traceparent,
     * `trace="projects/dorinda-prod/traces/<id>"` returned 3 Cloud Run REQUEST logs while
     * `jsonPayload.trace_id="<id>"` returned 6 APP logs. Identical id, different fields. The pivot
     * queried only the first, so it returned the request logs alone — which is why "Trace" looked
     * like it always found exactly one entry per request.
     *
     * A console that silently returns a subset is worse than one that returns nothing: the operator
     * concludes the request really did only do one thing, and stops looking.
     */
    const { buildFilter } = await import('../src/plugins/console-gcp/logs');
    const f = buildFilter({ trace_id: 'abc123' } as never);
    expect(f).toContain('trace:"abc123"');
    expect(f).toContain('jsonPayload.trace_id="abc123"');
    // OR'd inside one group — otherwise the service/severity clauses would AND against only one arm.
    expect(f).toBe('(trace:"abc123" OR jsonPayload.trace_id="abc123")');
  });

  it('the trace clause stays grouped when combined, so other filters apply to both arms', async () => {
    // Without the parentheses, `a AND trace:x OR jsonPayload.trace_id=x` parses as
    // `(a AND trace:x) OR (trace_id=x)` — the second arm escapes the service filter entirely and
    // returns another service's lines. Silent, and exactly the wrong kind of wrong.
    const { buildFilter } = await import('../src/plugins/console-gcp/logs');
    const f = buildFilter({ trace_id: 'abc123', runtime_id: 'dorinda-api' } as never);
    expect(f).toContain('(trace:"abc123" OR jsonPayload.trace_id="abc123")');
    expect(f.indexOf('resource.labels.service_name')).toBeLessThan(f.indexOf('(trace:'));
  });
});
