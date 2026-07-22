import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { store } from '../storage/store';
import { getBackends } from '../storage/backends';
import { newId } from '../shared/ids';
import { nowIso } from '../shared/time';
import { newToken, hashToken, resolveAuthConfig } from '../plugins/auth-identity/index';
import * as authStore from '../plugins/auth-identity/store';
import { SESSION_COOKIE, APP_HEADER, verifySessionToken, parseCookies } from '../shared/session';
import { resolveThemeForApp } from './theme-context';
import { DEFAULT_THEME, themeMetaHead, themeCustomStyleTag, themeTitle, themeLogoImg, escapeHtml, type Theme } from '../shared/theme';
import {
  parseScopes,
  scopeString,
  scopesSubset,
  verifyPkce,
  codeTtlSeconds,
  accessTtlSeconds,
  refreshTtlSeconds,
  expiresAtIso,
  isExpired,
  authServerMetadata,
} from '../mcp/oauth';
import type { OAuthClient, OAuthGrant, Consent, TokenEndpointAuthMethod } from '../mcp/types';

// C23 — the OAuth 2.1 AUTHORIZATION SERVER. The consuming app becomes an OAuth provider: it registers
// clients (RFC 7591 dynamic registration), runs the authorize + consent flow (PKCE mandatory), and mints
// short-lived SCOPED access tokens + rotating refresh tokens the MCP host verifies. Distinct from C10 (the
// app as an OAuth *client* for sign-in) — here the app is the authorization *server*. The logged-in user +
// consent come from C10 (the session cookie); the consent screen is themed via C16.
//
// Registered on BOTH planes (like /auth/*); the app proxies `/oauth/*` + `/.well-known/*` same-origin to
// this sidecar. The transport is plain request/response, so it can relocate to a dedicated public edge
// later without changing tool contracts (the O1 escape hatch).
//
//   GET  /.well-known/oauth-authorization-server                 -> AS metadata (RFC 8414)
//   POST /oauth/register       { client_name, redirect_uris[], token_endpoint_auth_method? } -> client
//   GET  /oauth/authorize      ?response_type=code&client_id&redirect_uri&scope&state&code_challenge&… -> consent HTML | 302 to login
//   POST /oauth/authorize/decision  (consent form) -> 303 redirect to redirect_uri?code=&state=
//   POST /oauth/token          authorization_code | refresh_token -> { access_token, refresh_token, … }
//   POST /oauth/revoke         { token, token_type_hint? } -> {}

const unknownApp = { error: 'invalid_request', error_description: 'unknown app (pass `app` or set FORGE_APP_NAME).' };

export function registerOAuthRoutes(app: FastifyInstance, opts: { defaultApp?: () => string | undefined } = {}): void {
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (e) {
        done(e as Error, undefined);
      }
    });
  }

  const trimmed = (v: unknown): string | undefined => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s || undefined;
  };
  const resolveAppName = (req: FastifyRequest, explicit?: string): string | undefined => {
    const fromExplicit = trimmed(explicit);
    if (fromExplicit) return fromExplicit;
    const fromQuery = trimmed((req.query as { app?: string } | undefined)?.app);
    if (fromQuery) return fromQuery;
    const fromBody = trimmed((req.body as { app?: string } | undefined)?.app);
    if (fromBody) return fromBody;
    const hdr = req.headers[APP_HEADER];
    const fromHeader = trimmed(Array.isArray(hdr) ? hdr[0] : hdr);
    if (fromHeader) return fromHeader;
    return opts.defaultApp?.();
  };
  const resolveAppId = async (req: FastifyRequest, explicit?: string): Promise<{ id: string; name: string } | null> => {
    const n = resolveAppName(req, explicit);
    if (!n) return null;
    const a = await store.findAppByName(n);
    return a && a.type === 'Application' ? { id: a.id, name: n } : null;
  };

  const mcp = () => getBackends().then((b) => b.mcp);

  function publicBase(req: FastifyRequest): string {
    // The OAuth AS issuer (RFC 8414) this server advertises is the MACHINE-FACING api host — the origin the
    // MCP endpoint + this authorization server are actually reached on. That is INDEPENDENT of the
    // browser-facing `/connect/*` callback (connect-routes.ts), which uses FORGE_OAUTH_PUBLIC_URL to pin the
    // USER-FACING app host. Prefer FORGE_MCP_PUBLIC_URL; fall back to FORGE_OAUTH_PUBLIC_URL (back-compat —
    // prod set that before the split); then the forwarded-host header.
    const explicit = process.env.FORGE_MCP_PUBLIC_URL || process.env.FORGE_OAUTH_PUBLIC_URL;
    if (explicit) return explicit.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() || 'https';
    const host = String(req.headers['x-forwarded-host'] ?? req.headers['host'] ?? 'localhost');
    return `${proto}://${host}`;
  }

  // The logged-in C10 user for this app, or null. Reuses the C10 session contract (signed access cookie +
  // a live, non-revoked server-side session record) — the OAuth AS never re-implements sign-in.
  async function currentUser(req: FastifyRequest, appId: string): Promise<{ userId: string; email: string } | null> {
    const cfg = await resolveAuthConfig(appId);
    if (!cfg.sessionSecret) return null;
    const claims = verifySessionToken(parseCookies(req.headers.cookie)[SESSION_COOKIE], cfg.sessionSecret);
    if (!claims) return null;
    const s = await authStore.getSession(appId, claims.sessionId);
    if (!s || s.revoked || new Date(s.expires_at).getTime() <= Date.now()) return null;
    return { userId: claims.userId, email: claims.email };
  }

  const themeFor = async (appId?: string): Promise<Theme> => (appId ? resolveThemeForApp(appId) : DEFAULT_THEME);
  const oauthError = (reply: FastifyReply, status: number, error: string, description?: string) =>
    reply.status(status).send({ error, ...(description ? { error_description: description } : {}) });

  // === discovery ==================================================================================
  app.get('/.well-known/oauth-authorization-server', async (req, reply) => {
    const app_ = await resolveAppId(req);
    let scopes: string[] = [];
    if (app_) scopes = [...new Set((await (await mcp()).listTools(app_.id)).map((t) => t.scope))];
    return reply.status(200).send(authServerMetadata(publicBase(req), scopes));
  });

  // === dynamic client registration (RFC 7591) ====================================================
  app.post('/oauth/register', async (req, reply) => {
    const b = (req.body ?? {}) as {
      app?: string; client_name?: string; redirect_uris?: unknown; token_endpoint_auth_method?: string; scope?: string;
    };
    const app_ = await resolveAppId(req, b.app);
    if (!app_) return reply.status(404).send(unknownApp);
    const redirectUris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)) : [];
    if (redirectUris.length === 0) return oauthError(reply, 400, 'invalid_redirect_uri', 'at least one absolute http(s) `redirect_uris` entry is required.');
    const method: TokenEndpointAuthMethod =
      b.token_endpoint_auth_method === 'client_secret_basic' || b.token_endpoint_auth_method === 'client_secret_post'
        ? b.token_endpoint_auth_method
        : 'none';

    const client_id = newId('mcpc');
    let rawSecret: string | undefined;
    let client_secret_hash: string | undefined;
    if (method !== 'none') {
      const t = newToken();
      rawSecret = t.token;
      client_secret_hash = t.hash;
    }
    const client: OAuthClient = {
      client_id,
      ...(b.client_name ? { client_name: String(b.client_name) } : {}),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: method,
      ...(client_secret_hash ? { client_secret_hash } : {}),
      ...(b.scope ? { scope: String(b.scope) } : {}),
      created_at: nowIso(),
    };
    await (await mcp()).putClient(app_.id, client);
    return reply.status(201).send({
      client_id,
      ...(rawSecret ? { client_secret: rawSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: method,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(b.client_name ? { client_name: String(b.client_name) } : {}),
      ...(b.scope ? { scope: String(b.scope) } : {}),
    });
  });

  // === authorization endpoint =====================================================================
  app.get('/oauth/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const app_ = await resolveAppId(req);
    const theme = await themeFor(app_?.id);
    if (!app_) return htmlReply(reply, 404, errorPage(theme, 'Unknown app', 'This authorization request targets an unknown app.'));

    const client = q.client_id ? await (await mcp()).getClient(app_.id, q.client_id) : null;
    if (!client) return htmlReply(reply, 400, errorPage(theme, 'Unknown client', 'The client_id is not registered.'));
    // redirect_uri MUST match a registered one — never redirect to an unregistered URI (open-redirect guard).
    const redirectUri = q.redirect_uri ?? client.redirect_uris[0];
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return htmlReply(reply, 400, errorPage(theme, 'Invalid redirect_uri', 'The redirect_uri does not match a registered value.'));
    }
    if ((q.response_type ?? 'code') !== 'code') return redirectError(reply, redirectUri, 'unsupported_response_type', q.state);
    // PKCE is MANDATORY (OAuth 2.1). Only S256 is offered.
    if (!q.code_challenge) return redirectError(reply, redirectUri, 'invalid_request', q.state, 'code_challenge (PKCE) is required');
    if (q.code_challenge_method && q.code_challenge_method !== 'S256') return redirectError(reply, redirectUri, 'invalid_request', q.state, 'only S256 code_challenge_method is supported');

    // Require a logged-in C10 user; if absent, bounce through the hosted login and come back here.
    const user = await currentUser(req, app_.id);
    if (!user) {
      const back = req.url; // same-origin /oauth/authorize?… — C10 safeNext accepts a single-slash path
      return reply.code(302).header('location', `/auth/login?next=${encodeURIComponent(back)}`).send();
    }

    const requested = parseScopes(q.scope ?? client.scope);
    return htmlReply(reply, 200, consentPage(theme, {
      appName: app_.name,
      clientName: client.client_name ?? client.client_id,
      email: user.email,
      scopes: requested,
      fields: {
        client_id: client.client_id,
        redirect_uri: redirectUri,
        scope: scopeString(requested),
        state: q.state ?? '',
        code_challenge: q.code_challenge,
        code_challenge_method: q.code_challenge_method ?? 'S256',
      },
    }));
  });

  // === consent decision → mint an authorization code =============================================
  app.post('/oauth/authorize/decision', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const app_ = await resolveAppId(req);
    const theme = await themeFor(app_?.id);
    if (!app_) return htmlReply(reply, 404, errorPage(theme, 'Unknown app', 'This request targets an unknown app.'));
    const user = await currentUser(req, app_.id);
    if (!user) return reply.code(302).header('location', '/auth/login').send();

    const client = b.client_id ? await (await mcp()).getClient(app_.id, b.client_id) : null;
    if (!client) return htmlReply(reply, 400, errorPage(theme, 'Unknown client', 'The client_id is not registered.'));
    const redirectUri = b.redirect_uri;
    if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
      return htmlReply(reply, 400, errorPage(theme, 'Invalid redirect_uri', 'The redirect_uri does not match a registered value.'));
    }
    if (b.decision !== 'approve') return redirectError(reply, redirectUri, 'access_denied', b.state);
    if (!b.code_challenge) return redirectError(reply, redirectUri, 'invalid_request', b.state, 'code_challenge (PKCE) is required');

    const scopes = parseScopes(b.scope);
    // Record consent (revocable; lets a repeat authorize / refresh proceed without re-prompting).
    const now = nowIso();
    const existing = await (await mcp()).getConsent(app_.id, client.client_id, user.userId);
    const consent: Consent = {
      client_id: client.client_id,
      owner: user.userId,
      scopes,
      visibility: 'private',
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    await (await mcp()).putConsent(app_.id, consent);

    // Mint a one-shot, PKCE-bound authorization code.
    const code = newToken();
    const grant: OAuthGrant = {
      kind: 'code',
      token_hash: code.hash,
      client_id: client.client_id,
      owner: user.userId,
      scopes,
      expires_at: expiresAtIso(codeTtlSeconds()),
      code_challenge: b.code_challenge,
      code_challenge_method: (b.code_challenge_method as 'S256' | 'plain') ?? 'S256',
      redirect_uri: redirectUri,
      visibility: 'private',
      created_at: now,
    };
    await (await mcp()).putGrant(app_.id, grant);

    const url = new URL(redirectUri);
    url.searchParams.set('code', code.token);
    if (b.state) url.searchParams.set('state', b.state);
    return reply.code(303).header('location', url.toString()).send();
  });

  // === token endpoint =============================================================================
  app.post('/oauth/token', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const app_ = await resolveAppId(req, b.app);
    if (!app_) return reply.status(404).send(unknownApp);
    const grantType = b.grant_type;
    const store_ = await mcp();

    // Client authentication (confidential clients present a secret; public clients are PKCE-only).
    const authClient = async (clientId: string | undefined): Promise<OAuthClient | 'invalid_client' | null> => {
      if (!clientId) return null;
      const client = await store_.getClient(app_.id, clientId);
      if (!client) return null;
      if (client.token_endpoint_auth_method !== 'none') {
        const presented = extractClientSecret(req, b);
        if (!presented || !client.client_secret_hash || hashToken(presented) !== client.client_secret_hash) return 'invalid_client';
      }
      return client;
    };

    if (grantType === 'authorization_code') {
      const client = await authClient(b.client_id);
      if (client === 'invalid_client') return oauthError(reply, 401, 'invalid_client', 'client authentication failed.');
      if (!client) return oauthError(reply, 400, 'invalid_client', 'unknown client_id.');
      if (!b.code) return oauthError(reply, 400, 'invalid_request', 'code is required.');
      // Consume the code (one-shot — a replay finds nothing).
      const codeGrant = await store_.consumeGrant(app_.id, 'code', hashToken(b.code));
      if (!codeGrant || isExpired(codeGrant.expires_at)) return oauthError(reply, 400, 'invalid_grant', 'authorization code is invalid or expired.');
      if (codeGrant.client_id !== client.client_id) return oauthError(reply, 400, 'invalid_grant', 'code was issued to a different client.');
      if (codeGrant.redirect_uri && b.redirect_uri && codeGrant.redirect_uri !== b.redirect_uri) return oauthError(reply, 400, 'invalid_grant', 'redirect_uri mismatch.');
      if (!verifyPkce(b.code_verifier, codeGrant.code_challenge, codeGrant.code_challenge_method)) return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed.');
      const tokens = await issueTokens(app_.id, client.client_id, codeGrant.owner, codeGrant.scopes);
      return reply.status(200).send(tokens);
    }

    if (grantType === 'refresh_token') {
      const client = await authClient(b.client_id);
      if (client === 'invalid_client') return oauthError(reply, 401, 'invalid_client', 'client authentication failed.');
      if (!client) return oauthError(reply, 400, 'invalid_client', 'unknown client_id.');
      if (!b.refresh_token) return oauthError(reply, 400, 'invalid_request', 'refresh_token is required.');
      // Rotate: consume the presented refresh (one-shot), issue a fresh access + refresh pair.
      const refreshGrant = await store_.consumeGrant(app_.id, 'refresh', hashToken(b.refresh_token));
      if (!refreshGrant || isExpired(refreshGrant.expires_at)) return oauthError(reply, 400, 'invalid_grant', 'refresh token is invalid or expired.');
      if (refreshGrant.client_id !== client.client_id) return oauthError(reply, 400, 'invalid_grant', 'refresh token was issued to a different client.');
      let scopes = refreshGrant.scopes;
      if (b.scope) {
        const requested = parseScopes(b.scope);
        if (!scopesSubset(requested, refreshGrant.scopes)) return oauthError(reply, 400, 'invalid_scope', 'requested scope exceeds the original grant.');
        scopes = requested;
      }
      const tokens = await issueTokens(app_.id, client.client_id, refreshGrant.owner, scopes, refreshGrant.token_hash);
      return reply.status(200).send(tokens);
    }

    return oauthError(reply, 400, 'unsupported_grant_type', 'supported: authorization_code, refresh_token.');
  });

  // === token revocation (RFC 7009) ===============================================================
  app.post('/oauth/revoke', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const app_ = await resolveAppId(req, b.app);
    if (!app_) return reply.status(404).send(unknownApp);
    if (b.token) {
      const h = hashToken(b.token);
      const store_ = await mcp();
      // Try the hinted kind first, then the other — RFC 7009 always returns 200 regardless.
      await store_.revokeGrant(app_.id, 'access', h);
      await store_.revokeGrant(app_.id, 'refresh', h);
    }
    return reply.status(200).send({});
  });

  // Issue a scoped access + rotating refresh token pair, persisting only their HASHES.
  async function issueTokens(appId: string, clientId: string, owner: string, scopes: string[], parentHash?: string) {
    const store_ = await mcp();
    const now = nowIso();
    const access = newToken();
    const refresh = newToken();
    const accessTtl = accessTtlSeconds();
    await store_.putGrant(appId, { kind: 'access', token_hash: access.hash, client_id: clientId, owner, scopes, expires_at: expiresAtIso(accessTtl), visibility: 'private', created_at: now });
    await store_.putGrant(appId, {
      kind: 'refresh', token_hash: refresh.hash, client_id: clientId, owner, scopes, expires_at: expiresAtIso(refreshTtlSeconds()),
      ...(parentHash ? { parent_hash: parentHash } : {}), visibility: 'private', created_at: now,
    });
    return { access_token: access.token, token_type: 'Bearer', expires_in: accessTtl, refresh_token: refresh.token, scope: scopeString(scopes) };
  }
}

// A confidential client's secret from either Basic auth or the body (client_secret_post).
function extractClientSecret(req: FastifyRequest, body: Record<string, string>): string | undefined {
  const auth = req.headers.authorization;
  const h = Array.isArray(auth) ? auth[0] : auth;
  if (h && /^Basic\s+/i.test(h)) {
    try {
      const decoded = Buffer.from(h.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx >= 0) return decoded.slice(idx + 1);
    } catch {
      /* ignore */
    }
  }
  return body.client_secret || undefined;
}

// --- redirect / html helpers ----------------------------------------------------

function redirectError(reply: FastifyReply, redirectUri: string, error: string, state?: string, description?: string) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return reply.code(303).header('location', url.toString()).send();
}

function htmlReply(reply: FastifyReply, status: number, html: string) {
  reply.code(status).type('text/html; charset=utf-8').send(html);
}

// Consent-page CSS — token-driven (C16), same custom-property set as the C10 auth pages.
const CONSENT_CSS = `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--forge-color-bg);color:var(--forge-color-text);font:15px/1.5 var(--forge-font)}
.card{background:var(--forge-color-surface);width:100%;max-width:420px;margin:24px;padding:32px;border-radius:var(--forge-radius-lg);box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06);border:1px solid var(--forge-color-border)}
.brand-logo{display:block;height:34px;width:auto;max-width:200px;margin:0 0 18px}
h1{font-size:20px;margin:0 0 8px}
.muted{color:var(--forge-color-text-muted);font-size:13px}
ul.scopes{list-style:none;padding:0;margin:18px 0;border:1px solid var(--forge-color-border);border-radius:var(--forge-radius)}
ul.scopes li{padding:10px 14px;border-bottom:1px solid var(--forge-color-border);font-size:14px}
ul.scopes li:last-child{border-bottom:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.row{display:flex;gap:10px;margin-top:20px}
button{flex:1;padding:11px;border:0;border-radius:var(--forge-radius);font-size:15px;font-weight:600;cursor:pointer}
button.approve{background:var(--forge-color-primary);color:var(--forge-color-primary-contrast)}
button.deny{background:var(--forge-color-surface);color:var(--forge-color-text);border:1px solid var(--forge-color-border)}
`;

function pageShell(theme: Theme, title: string, bodyHtml: string): string {
  return (
    `<!doctype html><html lang="en"><head>${themeMetaHead(theme, themeTitle(theme, title))}` +
    `<style id="forge-base">${CONSENT_CSS}</style></head><body>${themeCustomStyleTag(theme)}` +
    `<div class="card">${themeLogoImg(theme, 'brand-logo')}${bodyHtml}</div></body></html>`
  );
}

function consentPage(theme: Theme, o: { appName: string; clientName: string; email: string; scopes: string[]; fields: Record<string, string> }): string {
  const scopeList = o.scopes.length
    ? `<ul class="scopes">${o.scopes.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join('')}</ul>`
    : `<p class="muted">No specific scopes requested.</p>`;
  const hidden = Object.entries(o.fields).map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
  return pageShell(theme, 'Authorize', (
    `<h1>Authorize ${escapeHtml(o.clientName)}</h1>` +
    `<p class="muted"><b>${escapeHtml(o.clientName)}</b> wants to connect to <b>${escapeHtml(o.appName)}</b> as <b>${escapeHtml(o.email)}</b> and use:</p>` +
    scopeList +
    `<form method="post" action="/oauth/authorize/decision">${hidden}` +
    `<div class="row">` +
    `<button class="deny" type="submit" name="decision" value="deny">Deny</button>` +
    `<button class="approve" type="submit" name="decision" value="approve">Allow</button>` +
    `</div></form>`
  ));
}

function errorPage(theme: Theme, title: string, detail: string): string {
  return pageShell(theme, title, `<h1>${escapeHtml(title)}</h1><p class="muted">${escapeHtml(detail)}</p>`);
}
