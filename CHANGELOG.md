# Changelog

All notable changes to the **Forge control plane** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Each released version maps to a published control-plane image tag
(`ghcr.io/mardash-ai/forge-control-plane:<version>`).

## [Unreleased]

## [0.72.0] - 2026-07-24

### Added
- **C23/C34 — `DELETE /mcp/consents?owner=…`: revoke EVERY connector a user has authorized**
  (service-token gated). Drops each consent AND its live tokens, then sweeps any orphan grant left
  without a consent row, so the result is "this owner holds no MCP credentials" whatever the prior
  state. Returns `{ clients, revoked_consents, revoked_grants }`; owner-scoped, so another user's
  connectors are never touched. `revokeUserGrants` already existed in every backend but had no caller
  and no HTTP surface — this exposes it for account teardown.

### Fixed
- **A purged account's connected AI kept working.** MCP access tokens outlived the account: after a
  consumer purged an owner, its Claude connector still authenticated and **re-created rows under the
  dead owner id** (observed live 2026-07-24). Per-client revoke existed but a teardown does not know
  the client list, so nothing cut the AIs off — the connector stayed live until the token expired.

## [0.71.0] - 2026-07-23

### Added
- **C24/C34 — `DELETE /connect`: revoke and drop EVERY provider grant an owner holds** (session, or
  service-token + `owner` for a machine caller). Each connection is revoked **at the provider** — Google's
  `revoke_endpoint` — before its sealed tokens are deleted, so account teardown actually withdraws the
  grant instead of orphaning it. Returns `{ providers, disconnected }`; idempotent (no connections ⇒
  `{ providers: [], disconnected: 0 }`) and best-effort per provider, so one failure cannot strand the
  rest. Emits a `connector.disconnected` C3 event per provider with `reason: "teardown"`.

### Fixed
- **A purged account used to leave a LIVE Google grant behind.** The per-provider `DELETE /connect/:provider`
  is session-only, so a consumer's admin purge — a machine call with no browser session — had no way to
  reach it and simply deleted its local rows. The refresh token stayed valid at Google and the app stayed
  listed under the user's third-party access: a "delete my account" that left standing permission to read
  the user's Gmail and Calendar. `DELETE /connect` is the teardown channel that closes it.

## [0.70.0] - 2026-07-23

### Added
- **C23 — `GET /mcp/streams`: a LIVE feed of the attached tool-refresh channels** (service-token gated),
  for the operator dashboard. Returns `{ count, streams: [{ client_name, user_agent, opened_at,
  held_seconds }], observed_at }`. Read straight from the in-process registry at request time, so it is
  **real-time by construction** — there is no cache and no persisted copy to go stale; a dropped socket is
  already absent. `count: 0` is the meaningful answer that no AI is holding the push channel.
- Each attached stream now records the **DCR client name** (which AI) and the **User-Agent**. Note on what
  the UA can and cannot tell you: for a HOSTED connector (ChatGPT / claude.ai) it is the VENDOR'S server UA —
  their backend dials us, so the end user's device (web/mobile/desktop) is **not observable**. A LOCAL client
  (Claude Desktop / Claude Code) connects from the user's machine, so the UA is the one honest signal that
  separates hosted from desktop.


## [0.69.1] - 2026-07-23

### Added
- **C23/C36 — observability for the `tools/list_changed` push channel.** Whether a connected AI actually
  HOLDS the SSE stream was previously invisible, so "clients auto-refresh now" was unprovable. The
  data-plane now logs + spans the channel's real behavior:
  - `[mcp] stream OPEN app=… client=… attached=N` / `[mcp] stream CLOSE app=… client=… held=Ns attached=N`
    — a stream open is the only direct proof a client consumes the push channel; `client` is the DCR name
    (e.g. "Claude"/"ChatGPT") so it says WHICH AI. A very short `held=` exposes a proxy/client dropping it.
  - `[mcp] tools/list_changed app=… notified=N attached=N` on every surface change. **`notified=0` is the
    loud diagnostic**: the tool surface changed but nobody was listening, so every connected AI is still
    serving a stale `tools/list` until it reconnects.
  - Spans `mcp.stream_open` + `mcp.tools_list_changed` (with `mcp.streams_notified` / `mcp.streams_attached`).


## [0.69.0] - 2026-07-23

### Added
- **C23 — `notifications/tools/list_changed` (no more "reconnect to see new tools").** MCP clients CACHE
  `tools/list`; the host previously advertised `tools.listChanged: false`, so a client that connected
  before a tool was added kept serving the stale surface until the **user manually reconnected the
  connector**. The host now:
  - serves the Streamable-HTTP **standalone server→client stream** at **`GET /mcp`** (SSE, same OAuth
    Bearer gate as `POST /mcp`, with a 25s keep-alive and `X-Accel-Buffering: no` so proxies don't buffer),
  - advertises **`capabilities.tools.listChanged: true`**, and
  - **pushes `notifications/tools/list_changed`** to every connected stream for that app whenever the tool
    surface changes (`POST /mcp/tools` register/update and `DELETE /mcp/tools/:name` prune).

  Compliant clients re-fetch `tools/list` on their own — a newly added tool reaches connected AIs with no
  user action. Best-effort + isolated: a dead stream is pruned and can never fail a tool registration, and
  only the app whose surface changed is notified. Guard-proven (5 tests fail without the wiring).

  *Scope (v1, honest):* the subscriber registry is **in-process**. The data-plane runs single-instance
  today; horizontal scaling would need a cross-instance fanout (e.g. Postgres LISTEN/NOTIFY) so a client
  attached to replica A sees a registration that hit replica B.


## [0.68.0] - 2026-07-23

### Added
- **C23 — MCP tool dispatch forwards the DCR client NAME to the app handler.** The dispatch body now
  includes `client_name` (e.g. "Claude", "ChatGPT") alongside the opaque `client_id`, so a consuming
  app can label the connection it records and render "Connected" per AI platform (the opaque `mcpc_…`
  id alone can't identify the host). Omitted when the client registered no name (back-compat). Only the
  public name is forwarded — never a secret.


## [0.67.0] - 2026-07-23

### Changed
- **C23 — OAuth consent shows the product brand, not the internal app slug.** The consent interstitial
  ("<client> wants to connect to <app>") now prefers `FORGE_OAUTH_DISPLAY_NAME` (e.g. "Dorinda") over
  the internal app name ("dorinda-api"), so a connecting user — including a directory reviewer — sees
  the product name. Falls back to the app name when unset (back-compat).


## [0.66.0] - 2026-07-23

### Added
- **C24 — `GET /connect` accepts a service-token + `owner` (query/body), like the broker.** A consuming
  app's SERVER-TO-SERVER connector read can now authenticate over the trusted C10 service-token channel
  with the owner it already resolved, instead of re-forwarding the end-user's browser session cookie —
  which is fragile server-side and was silently yielding an empty connection list (the app's Integrations
  page showed a connected Google account as "not connected"). Session auth is unchanged; a service token
  with no `owner` is refused (401). Same trust model as `/connect/:provider/token` and `/connect/:provider/send`.

## [0.65.0] - 2026-07-23

### Fixed
- **C23 — serve OAuth discovery at the RFC 9728/8414 path-suffixed `…/mcp` URLs.** An MCP client that
  connects to the resource `<host>/mcp` derives the discovery URL by appending the resource path
  (`/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server/mcp`). forge
  served both docs only at the ROOT well-known paths, so Claude's connector validation — which requires
  the path-suffixed form — got 404s and reported a **"server configuration issue"** (connector unusable;
  confirmed live via the edge access log). Both docs are now served at the path-suffixed URLs too, and
  the `POST /mcp` 401 `WWW-Authenticate` advertises the path-suffixed protected-resource URL. Guard-proven.

### Changed
- **C23 — access-token TTL cap raised 24h → 30d** (`FORGE_OAUTH_ACCESS_TTL_SECONDS`). Some connector
  hosts ride the access token until expiry rather than refreshing mid-session, then show the connector
  "unavailable" until a manual reconnect; the 24h ceiling forced frequent reconnects. Default stays 1h;
  access tokens remain individually revocable, so a longer operator-chosen TTL trades a bounded,
  revocable window for a much better connector UX.

## [0.64.0] - 2026-07-22

### Added
- **Productionize emits the dedicated-mTLS-host MCP wiring (durability) — new `mcp_mtls_host` /
  `mcp_mtls_tls_options` production config.** The mTLS wiring dorinda-api carried as HAND-ADDED lines in
  its generated `compose.prod.yaml` (which any `forge productionize` re-run would silently clobber) is
  now emitted by the generator itself. With `--mcp-mtls-host <host>` set on a hosted-auth app, the
  compose gains: a SECOND Traefik router (`mcp`) on the web service for that host —
  `entrypoints=websecure`, `tls.certresolver=<cert_resolver>`, `tls.options=<mcp_mtls_tls_options>`
  (default **`openai-mtls@file`**), plus the `mcpcert` `passtlsclientcert.pem=true` middleware — with a
  generated comment explaining the topology (the reverse proxy OWNS the tls.options definition; the APP
  owns the SAN check on the forwarded cert), and the data-plane's `FORGE_MCP_ALT_HOSTS` interpolation now
  DEFAULTS to the configured mTLS host (previously always empty). Both fields converge like the rest of
  the `production` block (flag > persisted > default; remembered in `forge.app.json`), so a regen
  REPRODUCES the block — proven by a parity test asserting the exact label strings dorinda-api carries.
- **Productionize always wires the MCP OAuth access-token TTL for hosted-auth apps.**
  `FORGE_OAUTH_ACCESS_TTL_SECONDS=${FORGE_OAUTH_ACCESS_TTL_SECONDS:-28800}` lands on the data-plane env
  (and is documented in the generated `.env.prod.example`): 8h, because connector hosts may NOT refresh
  mid-session — they ride one access token until expiry, then show the connector as unavailable until
  the user reconnects.
- **C36 — Langfuse-native user id on the `mcp.tool_call` span (Users view).** The span now also sets
  **`langfuse.user.id`** to the verified token's userId (keeping `mcp.client.user` as the plain span
  attribute), so Langfuse groups MCP traces per user in its Users view. Verified against the Langfuse v3
  ingestion source (`OtelIngestionProcessor.ts`, v3.224.0): `langfuse.user.id` is the highest-precedence
  key in `extractUserId()`, and it is honored on NON-root spans too (the key is in `hasTraceUpdates()`'s
  exact-match list, so a child span carrying it emits a trace-update that sets the trace-level userId —
  load-bearing, since `mcp.tool_call` joins the edge trace as a child).

## [0.63.0] - 2026-07-22

### Added
- **C36 — tool-call payloads on the MCP trace + spans for the failure paths that died invisibly.**
  - **Payload tracing (the headline):** the `mcp.tool_call` span now records the tool-call **arguments**
    as the observation INPUT and the **returned payload** as the observation OUTPUT — on success AND on
    failure outcomes (`isError` payloads / `handler_status_*` error bodies land on the trace too). Uses
    the **Langfuse-native** OTel keys its ingest actually maps onto observation input/output:
    **`langfuse.observation.input`** / **`langfuse.observation.output`** (the `gen_ai.tool.*` attribute
    names are NOT in Langfuse's input/output mapping — they ride along as plain metadata only).
    Guardrails: env-gated **`FORGE_MCP_TRACE_PAYLOADS`** (default ON; the literal string `false`
    disables), each side capped at **8192 bytes** with a `…[truncated]` suffix (`capPayload()` in the
    otel-langfuse plugin), and NEVER auth material — strictly the arguments/payload, never the
    Authorization header, tokens, or client secrets.
  - **Unknown tool now produces a span:** the `mcp.tool_call` span starts BEFORE the tool lookup, so a
    `tools/call` for a nonexistent tool ends as an `unknown_tool` error span carrying the requested name
    (+ the input payload) instead of failing pre-span with zero visibility.
  - **Transport auth rejections are visible:** a failed `POST /mcp` token verification emits a short
    **`mcp.auth_reject`** span with the requested JSON-RPC method and a distinguishable reason —
    `invalid_token` vs `resource_mismatch` (new `verifyAccessTokenDetailed()` in `src/mcp/verify.ts`;
    the plain `verifyAccessToken` seam delegates to it, shape unchanged). The wire response stays a
    uniform `invalid_token` 401; no token material is ever recorded.
  - **OAuth endpoint outcomes:** **`oauth.token`** spans every token exchange (grant_type, the public
    client_id, and outcome `issued` | the oauth error code — invalid_client/invalid_grant/
    invalid_target/…); **`oauth.register`** spans registration (outcome + client_name); and
    **`oauth.authorize_decision`** spans the consent decision (approve/deny). Never recorded:
    authorization codes, access/refresh tokens, client secrets, PKCE values.
  - **Edge + tool call join ONE trace:** `mcp.tool_call` (and `mcp.auth_reject`) now ADOPT an incoming
    W3C `traceparent` header as their parent via the plugin's existing `parentFromTraceparent()`, so the
    edge proxy's OTLP trace and the transport span stitch together (absent header ⇒ roots a fresh trace,
    as before).
  - **Productionize:** the data-plane env block wires
    `FORGE_MCP_TRACE_PAYLOADS=${FORGE_MCP_TRACE_PAYLOADS:-true}` for MCP-hosting (hosted-auth) apps, and
    `.env.prod.example` documents it (tool-call arguments + results are recorded on the Langfuse trace;
    set false to disable payload capture).

### Changed
- **C29 — the no-match default decision no longer carries the `rule: 'default'` sentinel.** The contract
  documents `rule` as "the rule id that FIRED, if any" — nothing fires on the bare default posture, so
  the key is now ABSENT (the `no policy matched; default posture` reason text is unchanged). The
  sentinel had silently broken a consumer's bare-default detection; that consumer was fixed to accept
  BOTH shapes and is deployed, so this cleanup is back-compatible with the live fleet. Decisions where a
  rule actually fires (policy ids, `safety-floor:<class>`, `not-a-member`, `private-resource`) still
  name it.

## [0.62.1] - 2026-07-22

### Fixed
- **C23 — token endpoint now accepts HTTP Basic client identification (RFC 6749 §2.3.1).** The
  `authorization_code` and `refresh_token` grants read the client id from the request BODY only;
  `extractClientSecret` decoded the `Authorization: Basic id:secret` header but DISCARDED the id half.
  A client identifying itself only via Basic (id in the header, empty secret for a public client — a
  shape connector hosts commonly use on refresh) failed with `unknown client_id`, so its session died
  at access-token expiry. `extractClientId` now reads body OR Basic (mismatch between the two →
  `invalid_client`), with both halves form-urldecoded per the RFC. Guard-proven tests: a Basic-only
  refresh succeeds; a contradictory Basic-vs-body id is rejected.

## [0.62.0] - 2026-07-22

### Added
- **C23 — per-host MCP resource identifier (dedicated mTLS host support).** `POST /mcp` and the RFC 9728
  protected-resource discovery doc now derive the MCP **resource identifier** (RFC 8707) from the host the
  client actually connected to, split from the **pinned** OAuth issuer. A request arriving via a dedicated
  host (e.g. a cert-required `mcp.dorinda.ai` for ChatGPT's connector) advertises
  `resource=https://mcp.dorinda.ai/mcp` and the audience check (`verifyAccessToken`) expects that same value,
  while the OAuth **authorization server** stays pinned to the certless api host (browser consent + DCR can't
  present a client cert). Anti-spoofing: a forwarded host is honored as the resource identifier **only** when
  it is the primary MCP host (`FORGE_MCP_PUBLIC_URL`) or listed in the new **`FORGE_MCP_ALT_HOSTS`**
  (comma-separated hostnames) allowlist — otherwise it falls back to the pin and **never** advertises an
  un-allowlisted host. **Back-compatible:** a single-host `api.dorinda.ai` request is unchanged (its host is
  the pin, so resource + issuer both resolve to api; existing tokens/clients unaffected). Productionize wires
  `FORGE_MCP_ALT_HOSTS` into the data-plane defined-but-empty and documents it in `.env.prod.example`.

## [0.61.0] - 2026-07-22

### Security
- **C23 — the MCP management surface is now SERVICE-token gated (closes an unauthenticated-write hole).**
  The app→sidecar management routes (`POST/GET /mcp/tools`, `DELETE /mcp/tools/:name`,
  `POST/GET /mcp/instructions`, `POST /mcp/proactive`, `GET /mcp/consents`,
  `DELETE /mcp/consents/:client_id`) carried **no** authentication, yet the consumer proxies `/mcp/*` to the
  **public** internet — so anyone could register/rewrite an app's tools + instruction ("training") block,
  schedule proactive prompts, or revoke a user's consent. Every management route now requires the app's C10
  `AUTH_SERVICE_TOKEN`, presented as an `x-forge-service-token` header and compared in **constant time**
  (reusing the existing `auth-identity` verifier via `shared/service-auth`). **Fails closed**: an app with no
  configured token rejects (`401`). `POST /mcp` (JSON-RPC — already OAuth-token gated) and the public
  `GET /.well-known/oauth-protected-resource` discovery doc are intentionally **not** gated. **Consumer
  action required:** the app's on-boot MCP bootstrap (and anything else calling `/mcp/*` management) must now
  send `x-forge-service-token: $AUTH_SERVICE_TOKEN`.

### Added
- **C23 — RFC 8707 access-token audience binding (ChatGPT App Directory requirement).** `POST /oauth/authorize`
  parses the optional `resource` request param and binds it onto the authorization-code grant; `POST /oauth/token`
  threads that `resource` onto the issued access + refresh grants (and carries it across a refresh rotation). A
  `resource` presented at token exchange must match the code's (else `invalid_target`). `OAuthGrant` and
  `VerifiedToken` gain an optional `resource`; `verifyAccessToken` takes an optional expected-resource argument
  and `POST /mcp` passes `${issuer}/mcp` — a token bound to a **different** resource is rejected there.
  **Back-compatible:** a token with **no** bound resource still verifies, so existing live tokens keep working.
  (No non-standard AS-metadata flag is advertised — RFC 8414 defines none for resource indicators.)
- **C23 — per-tool `securitySchemes` on `tools/list` (ChatGPT Apps SDK shape).** Each emitted tool now carries a
  top-level `securitySchemes` array: an `oauth2` scheme referencing the tool's OAuth `scope`
  (`[{ "type": "oauth2", "scopes": ["<scope>"] }]`), or `[{ "type": "noauth" }]` for a scopeless tool. This only
  **declares** the requirement to the host; the platform still enforces scope on every call.

### Changed
- **C23 — restrictive `Content-Security-Policy` on the machine-facing MCP surface.** `POST /mcp`, the
  `/.well-known/oauth-protected-resource` discovery doc, and the `/mcp/*` management routes now respond with
  `default-src 'none'; frame-ancestors 'none'; base-uri 'none'` (a URL-scoped Fastify `onSend` hook — it never
  touches the HTML OAuth consent page). JSON responses are unaffected.

## [0.60.0] - 2026-07-22

### Added
- **C23 — MCP tool annotations on the wire.** `ToolRegistration` gains five OPTIONAL annotation hints
  (`title`, `read_only_hint`, `destructive_hint`, `idempotent_hint`, `open_world_hint`; snake_case at rest,
  matching the existing `high_risk`/`input_schema` convention). `POST /mcp/tools` accepts them and stores
  each only when supplied (no forced defaults; `title` must be a trimmed non-empty string). `tools/list`
  surfaces a top-level `title` plus a camelCase `annotations` object (`title`, `readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`), attached only when at least one hint was declared.
  No migration — the tool blob is stored as JSONB, so the new optional fields round-trip for free.

### Changed
- **C23 — MCP resource identifier / OAuth AS issuer host split (`FORGE_MCP_PUBLIC_URL`).** The MCP endpoint
  and its OAuth authorization server are served on the **machine-facing api host**, but `publicBase()` (in
  both `mcp-routes.ts` and `oauth-routes.ts`) preferred `FORGE_OAUTH_PUBLIC_URL`, which prod pins to the
  **user-facing app host** for the browser `/connect/*` callback — so the server wrongly advertised
  `resource: https://app.<domain>/mcp` and an app-host issuer while it is actually reached on api. Both
  `publicBase()` functions now prefer a dedicated `FORGE_MCP_PUBLIC_URL` (the RFC 9728 resource identifier +
  RFC 8414 issuer origin), falling back to `FORGE_OAUTH_PUBLIC_URL` (back-compat) then the forwarded-host
  header. `connect-routes.ts` is untouched — its `FORGE_OAUTH_PUBLIC_URL` (browser Google-connect callback)
  stays on the app host. Productionize wires `FORGE_MCP_PUBLIC_URL` into the data-plane defined-but-empty
  (under the same hosted-auth gate as the sibling public-URL vars) and documents it in `.env.prod.example`
  as "the MCP OAuth resource identifier + issuer origin — the machine-facing api host (e.g.
  https://api.dorinda.ai)". Empty = request-host-derived, so single-host apps are unaffected.

## [0.59.0] — 2026-07-21

### Added
- **C33 — admin account lockout (`POST /billing/admin/lock`, SERVICE-token gated).** A forge-side "lock"
  that reproduces the EXACT trial-expired state (`status: paused` → entitlement locked out: read-only +
  billing redirect) **without mutating Stripe** — the real subscription, card, and status are preserved and
  instantly restored on unlock. Built for acceptance-testing billing redirects + post-trial lockout, and as
  a support "suspend" that never risks a paying customer's subscription.
  - `SubscriptionRecord` gains `admin_locked_at` + `admin_lock_prev_status` (both optional/backward-compatible).
    While `admin_locked_at` is set, `status` is overlaid to `paused`, `grantsPaidPlan` returns false, and
    reconciliation (webhook + the reconcile sweep) is **skipped** so the lock is sticky and can't be un-set
    behind the operator. Unlock clears the flag, restores the saved prior status, then best-effort
    re-reconciles from Stripe (the source of truth).
  - Body `{ subscriber, locked }`; idempotent; emits `billing.admin_locked` / `billing.admin_unlocked` (C3).
  - Regression tests (lock→paused+locked-out, no-Stripe-mutation, unlock→restored, sticky-vs-webhook/sweep,
    idempotent, service-token-gated); the sticky guard is verified to fail without the reconcile skip.

## [0.58.0] — 2026-07-21

### Added
- **P41 — billing (Stripe) provider secrets auto-wired into the data-plane.** Productionize wires the
  auth/email provider secrets into the sidecar (P34: `AUTH_PROVIDER_VARS` → `dpAuthProviderEnv`,
  defined-but-empty so `.env.prod` is the single source of truth) but had **no equivalent for billing**.
  An app using C-billing therefore booted its data-plane with **zero `STRIPE_` env**:
  `resolveBillingConfig()` read not-configured and every checkout / trial-start threw
  `billingNotConfigured()` even when `.env.prod` held a valid `sk_`/`whsec_`. (This is what broke
  dorinda-api's "pick a plan → I couldn't start checkout".)
  - `BILLING_PROVIDER_VARS = [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET]` wired into the **data-plane
    only** (the web tier proxies `/billing/*` and never calls Stripe), defined-but-empty, deduped
    against declared secrets, gated on `usesBilling` (any declared `STRIPE_*`, e.g. the `STRIPE_PRICE_*`
    catalog the web renders).
  - C13 secret-catalog entries for both secrets, and the generated `.env.prod.example` +
    `PROVISIONING.md` now surface them when the app uses billing (zero-drift operator docs).
  - Regression tests in `tests/productionize.test.ts` (wiring, no-auto-wire-without-billing, dedup,
    doc surfacing), verified to fail without the fix.

## [0.57.1] — 2026-07-20

### Added
- **C33 — no-card trial + status-as-entitlement lifecycle (stripe-billing plugin).** Implements the
  full no-card trial + pause-on-end billing lifecycle from `PRICING_BILLING_SPEC.md §1B–§1G`:
  - **`POST /billing/trial`** (service-token gated): creates a Stripe `Customer` + `Subscription` at
    signup in `trialing` status with **no payment method** and a 14-day trial; sets
    `trial_settings.end_behavior.missing_payment_method = pause` so trial-end with no card pauses
    the subscription (no invoice, no charge) instead of creating an unpaid invoice.
  - **`TRIAL_DAYS = 14`** single-source constant in `billing/config.ts`; changing the trial length
    is a one-line edit with no other code changes.
  - **`paused` canonical status** added to `SubscriptionStatus` (7-state vocabulary). `paused` is
    distinct from `canceled`: the subscription persists at Stripe, data is retained, and adding a
    card resumes the SAME subscription (`paused` → `active`, no new Stripe object).
  - **Full webhook set** per spec §1B — `customer.subscription.trial_will_end` (T-2 reminder via
    `billing.subscription.trial_will_end` in-app/email/push notification), `customer.subscription.
    updated` / `deleted` (entitlement sync), `setup_intent.succeeded` / `payment_method.attached`
    (card added at conversion — platform finds the subscription by customer id, resumes if paused,
    reconciles), `invoice.paid` / `invoice.payment_failed` (post-conversion dunning only, §1G).
  - **`paused` notification** (`billing.subscription.paused`): "Your trial has ended — your data is
    safe. Nothing was charged. Add a card anytime." Fires on `trialing → paused` transition.
  - **`resumeSubscription`** on `StripeClient`: resumes a paused subscription after card collection
    (`billing_cycle_anchor: now`); exposed via the `setup_intent.succeeded` /
    `payment_method.attached` webhook path — no new Stripe object is created (§1E).
  - **`createTrialingSubscription`** on `StripeClient`: direct subscription creation (no Checkout
    UI) with `trial_period_days`, no default payment method, and the `pause` end-behavior setting.
  - **`deleteCustomer`** now also cancels `paused` subscriptions on teardown (paused is a live
    Stripe object that must be cleaned up on account closure / right-to-be-forgotten).
  - 18 new tests across `billing.test.ts` and `billing-notify.test.ts` covering: TRIAL_DAYS
    constant, paused status mapping, paused entitlements (read-only grace), `POST /billing/trial`,
    `paused` webhook + notification, setup_intent/payment_method resume flow, T-2 notification.

## [0.57.0] — 2026-07-20

### Added
- **P38 (companion) — split-host public URL for the C24 connectors flow.** Productionize now also wires
  `FORGE_OAUTH_PUBLIC_URL` into the data-plane (defined-but-empty) for hosted-auth apps, mirroring 0.56's
  `FORGE_AUTH_PUBLIC_URL`. The `/connect/*` flow's `publicBase` reads this SEPARATE var; on a split-host
  deploy (UI on `app.<domain>`, API on `api.<domain>`) a "Connect Google" callback + its post-connect
  `return_to` bounce must land on the user-facing host, not the API host the proxied request arrived on.
  Set it in `.env.prod` to the app host. Empty = today's request-host-derived behavior; single-host apps
  unaffected. Data-plane only.

## [0.56.0] — 2026-07-20

### Added
- **P38 — split-host auth public URL.** Productionize now wires `FORGE_AUTH_PUBLIC_URL` into the
  data-plane sidecar (defined-but-empty, `${FORGE_AUTH_PUBLIC_URL:-}`) whenever the app uses hosted auth.
  The data-plane hosts C10 `/auth/*` but builds every auth URL (the OAuth `redirect_uri`, verify/reset
  links, and the post-login redirect) from `publicBase`, which defaults to the host the request arrived
  on. In a SPLIT-HOST deploy — the UI on `app.<domain>` proxying `/auth/*` to the platform on
  `api.<domain>` — that arrival host is the API host, so a Google login callback + its host-only session
  cookie + the `/home` redirect all land on the API host, stranding the user off the app. Setting
  `FORGE_AUTH_PUBLIC_URL` in `.env.prod` now pins the user-facing origin (`publicBase` already reads it
  first; this only makes productionize EMIT it). Empty-default = today's request-host-derived behavior, so
  single-host apps are unaffected. Data-plane only — the web tier proxies `/auth/*` and never computes an
  auth URL itself.

## [0.55.0] — 2026-07-18

### Added
- **C30 — the eval harness now records cost per run.** Both providers return token `usage` in every
  response; the tool-loop was discarding it. Now the loop sums input/output tokens across every
  model↔tool round-trip (the real billed input — context is re-charged each step), the LLM-judge call's
  usage is captured via a new optional `onUsage` callback on the model invoker, and a `pricing` module
  prices both against per-model list pricing (`claude-opus-4-8` $5/$25, `gpt-4o` $2.50/$10, … per 1M;
  override without a code change via `EVAL_PRICING_JSON`). Every `EvalRun` now carries `cost_usd` +
  `tokens_in`/`tokens_out` + `cost_estimated` (true when a model isn't in the table), each
  `EvalCaseResult` carries its own per-execution cost, and Langfuse gets a `cost_usd` score per trace
  and on each dataset-run link — so a run self-reports what it cost. New `tests/eval-pricing.test.ts`
  (7 tests) pin the pricing math + that both providers' usage is captured.

## [0.54.0] — 2026-07-17

### Added
- **C37 — Forge now owns AND provisions the self-hosted Langfuse stack** (`forge
  provision-observability`). Previously the observability stack lived only in forge's dev-profile
  compose + as a hand-managed stack on the box; `setup-observability` (C36) could only *register* an
  already-running stack. The new capability closes the gap: it **generates** the canonical stack and
  **deploys** it end-to-end, then registers the `ObservabilityStack` resource.
  - **`observability-stack` plugin** — the canonical stack generator. Emits the standalone compose +
    `.env`/`.env.example`, with every fix discovered standing the box stack up by hand baked in so a
    fresh provision comes up green: single-node ClickHouse (`CLICKHOUSE_CLUSTER_ENABLED=false`) on
    web+worker (else they crashloop), the S3/MinIO **region + force-path-style** on web+worker (else
    OTLP event uploads 500 *"Region is missing"*), `HOSTNAME=0.0.0.0` on web when fronted (else Next.js
    binds only the first network's IP and the proxy 502s), and optional Traefik fronting (proxy network
    + labels + HTTPS) for a `--public-host` like `monitor.dorinda.ai`.
  - **`provision-observability` capability** (control-plane, long-running, requires Docker) — generates
    the files, ensures the shared external `observability` network (+ the Traefik `proxy` net when
    fronted), `docker compose up -d` (whole-stack, not the app start-first roll), waits for
    langfuse-web `/api/public/health`, and upserts the `ObservabilityStack` resource. Consumers still
    export to the **internal** OTLP endpoint (`http://langfuse-web:3000/api/public/otel`), not the
    public host.
  - **Secrets are preserved by default** — the first forge path that generates *real* secret values
    and writes them to a file (`generateObservabilitySecrets`: `ENCRYPTION_KEY` is exactly 64 hex
    chars; the project key pair is shaped `pk-lf-…`/`sk-lf-…`). If an env file already exists its
    values are reused untouched, so re-provisioning an already-running stack is a safe, diff-clean
    **adopt-in-place** (with `--preserve-volumes-from` to keep existing data on a project rename) —
    never a data-losing reset. `--regenerate-secrets` forces fresh secrets (explicitly destructive).
  - `ObservabilityStack` resource gains optional `public_host` + `stack_dir`. New generator tests
    (`tests/observability-stack.test.ts`, 15 cases) assert every baked-in fix is present.

## [0.53.1] — 2026-07-17

### Fixed / Added
- **C30 — the eval harness now runs fully green against a live app** (validated end-to-end on
  dorinda-api with **both Claude and GPT** passing). Fixes + additions surfaced by the first real run:
  - **Eval-tenant platform-membership provisioning** (`seed.ts` `provisionTenantGroup`, opt-in via
    `EVAL_APP_DB_URL`). Apps that gate write tools on the platform membership graph (dorinda-api's C29)
    deny a fresh tenant with *"not a member of the targeted group"* — its group-of-one is never synced.
    The runner now warms up the local group (a read call), reads its id from the app DB, and ensures the
    platform group under that `external_id` (via `provisionGroup`) — exactly what the app's boot backfill
    does — so write tools pass governance. Skipped entirely for apps that don't set `EVAL_APP_DB_URL`.
  - **Tool-schema sanitization for BOTH providers** (`models.ts`) — strips `oneOf`/`allOf`/`anyOf`
    (Anthropic) plus `enum`/`const`/`not` (OpenAI is stricter) at the top level and guarantees an
    `object` shape; an MCP tool carrying one was HTTP-400'ing the model call.
  - Unique eval-tenant email per execution; unwrap the forge transport's double-wrapped
    `structuredContent`; raw tool results captured in the eval trace.
- With a fresh tenant + no policy, dorinda stages a `track` for approval (safety-first default posture),
  so the reference suite asserts the faithful `status: "pending"` outcome. 759 tests green.

## [0.53.0] — 2026-07-17

### Added
- **C30 — `forge eval <suite>`, the AI eval harness.** A generic, product-agnostic control-plane
  runner that drives a REAL model as an MCP client through an app's live tool surface, grades the
  trajectory, and reports to the self-hosted Langfuse. The agent-under-test is the model API as a
  faithful MCP client (real ChatGPT/Claude connector UIs can't be scripted in CI).
  - **Drives Claude AND GPT** (`models.ts`) — a provider-agnostic tool-loop (Anthropic Messages API +
    OpenAI Chat Completions), native `fetch`, no SDKs. Returns the full trajectory; never throws.
  - **Real transport** (`mcp-client.ts`) — mints a browserless `owner`-scoped access grant in-process,
    then speaks JSON-RPC `tools/list` / `tools/call` over the forge MCP transport, so every eval traces
    through C36 into Langfuse.
  - **Isolated eval tenants** (`seed.ts`) — a throwaway user + an `active` subscription seeded directly
    (no Stripe) so write tools don't 402; the owner auto-provisions as a group-of-one tenant.
  - **Grading** (`graders.ts`) — deterministic asserts (tool called? structured status? args?) + an
    LLM-judge (Claude, structured) scoring five dimensions (grounding, tool selection, permission
    compliance, follow-through, tone). A case passes only when asserts hold AND the dimension average
    clears the suite threshold.
  - **Reporting** (`report.ts`) — best-effort Langfuse dataset run: per-case traces + per-dimension /
    pass / deterministic scores. A reporting outage never fails the eval.
  - The **`Eval` capability** (control-plane, long-running) → an `EvalRun` resource + `EvalRunCompleted`
    event; the platform-defined suite format (`suite.ts`); CLI `forge eval <suite-file> --app --mcp-url
    [--model provider:model]`. 14 eval unit tests (both providers via injected fetch, grader, schema,
    MCP client, Langfuse config).

## [0.52.0] — 2026-07-17

### Added
- **C36 — one-flag MCP observability for any forge app (`production.observability`).** The transport is
  instrumented (0.51.0), but a consumer still had to hand-wire its prod stack — and `forge productionize`
  REGENERATES `compose.prod.yaml` every release, so hand-edits don't survive. This makes observability a
  first-class **generated** concern: set `production.observability: true` in `forge.app.json` (or
  `productionize --observability`) and the generator emits, for BOTH the web + data-plane tiers, the
  join to the shared external `observability` network and the OTLP→Langfuse export env
  (`OTEL_EXPORTER_OTLP_ENDPOINT` defaulting to the internal `langfuse-web`, `OTEL_SERVICE_NAME`, and the
  `LANGFUSE_PUBLIC_KEY`/`SECRET_KEY` pair). `.env.prod.example` documents the key pair.
  - **Keys are empty-default (`${VAR:-}`), never deploy-required (`:?`)** — a missing key silently
    disables tracing and the app is unaffected. Observability can never take the product down.
  - Convergent + remembered like every other production setting (`converge.ts`): flag > persisted > off,
    so a flag-less re-run reproduces it. Off by default — opt-in per app. 4 generator tests.

## [0.51.0] — 2026-07-17

### Added
- **C36 — the transport tier now auto-traces every MCP tool call, and traces span tiers.** The
  self-hosted Langfuse stack + export helper (0.50.1) delivered a helper a consumer *could* import, but
  nothing was instrumented and a trace couldn't cross the sidecar→app boundary. This closes both gaps so
  an app gets platform-level MCP observability **for free** from the sidecar, with no app code required
  for the transport span.
  - **`src/api/mcp-routes.ts` (the C23 remote MCP server) is instrumented.** Every `tools/call` opens a
    root `mcp.tool_call` span carrying GenAI attributes (`gen_ai.operation.name`, `gen_ai.tool.name`,
    `mcp.client.user/host`, `mcp.app`, `mcp.tool.family/high_risk`), records the outcome (ok / error /
    `insufficient_scope` / `app_unreachable`) and the handler HTTP status, and is **fire-and-forget** —
    a down or slow collector never delays or fails a tool call.
  - **W3C trace-context propagation (`traceparent()` / `parentFromTraceparent()`).** The transport
    **injects** a `traceparent` header into the sidecar→app handler callback; a consumer **extracts** it
    to continue the SAME trace, so the full path (transport → app proxy edge → C29 gate → domain →
    Postgres → app-event) is one coherent trace. The exporter already minted spec-width trace/span IDs,
    so propagation is a thin, zero-dep header codec. `SpanOptions.kind` (INTERNAL/SERVER/CLIENT) added.
  - **`initOtelLangfuse()` is wired at data-plane boot** (`src/data-plane/server.ts`) — enabled when
    `LANGFUSE_PUBLIC_KEY`/`SECRET_KEY` are present (boot logs `otel=on|off`); a silent no-op otherwise,
    so an un-instrumented deploy behaves exactly as before.
  - The export helper is the shared observability **contract** consumers adopt (imported by the sidecar
    here; vendored into the app tier for the proxy-edge + dispatch child spans). 5 new propagation tests.

## [0.50.1] — 2026-07-17

### Added
- **C36 — MCP observability / tracing (OTel → self-hosted Langfuse).** The forge platform now ships a
  self-hosted Langfuse v3 observability stack and a thin, fire-and-forget OTel export helper that
  any consumer can import to trace its MCP surface.
  - **Platform compose (6 Langfuse services, `profiles: ["observability"]`).** `langfuse-web`
    (UI + OTLP ingest at `/api/public/otel`), `langfuse-worker` (async ingestion),
    `langfuse-clickhouse` (trace/analytics store), `langfuse-postgres` (Langfuse-own metadata DB,
    separate from any domain Postgres), `langfuse-redis`/Valkey (queue/cache), and `langfuse-minio`
    (blob store for large event payloads) — all isolated on a Docker-internal `observability` network
    with named volumes. Bootstrap seeds a project API key pair from env. `.env.langfuse.example`
    documents all required secrets with generation instructions. Start with:
    `docker compose --env-file .env.langfuse --profile observability up -d`.
  - **`src/plugins/otel-langfuse/`** — zero-external-dep OTel export helper (uses Node 22 built-in
    `fetch` + `node:crypto`). Exports `initOtelLangfuse()`, `startSpan()`, `withSpan()`, and the
    `ATTR` constants map with all required GenAI semantic convention attribute names
    (`gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.input/output`,
    `gen_ai.usage.input/output_tokens`, plus `mcp.client.user/host`, `authz.decision`, `outcome`).
    Export is strictly fire-and-forget (no `await`, 5 s `AbortSignal.timeout`) — a down or slow
    Langfuse collector never delays or fails a tool call. `probeEndpoint()` does a HEAD probe used
    by the capability. `isEnabled()` lets callers guard instrumentation blocks.
  - **`SetupObservability` Capability** (`plane: 'both'`). Validates keys, optionally probes the
    OTLP endpoint for reachability, and persists an `ObservabilityStack` resource (upsert — at most
    one per platform). The secret key is accepted for the probe but **never stored** in the resource
    or emitted in events — only `endpoint` + `public_key` land in durable state. Emits
    `ObservabilityConfigured`. Status is `configured` when the probe passes, `unreachable` when it
    fails, so operators can detect a misconfiguration immediately.
  - **`ObservabilityStack` resource type** + **`ObservabilityConfigured` event** added to the
    canonical catalog. `obs_` id prefix registered in the shared id map.
  - **17 new tests** covering the full capability contract (upsert, event correctness, secret-key
    never-stored invariant, unreachable status when probe fails, input validation) and the plugin
    API (init from cfg + env vars, span ID format, parent trace inheritance, `withSpan` error
    propagation, `ATTR` constant correctness).
  - **Consume signature**: import the helper and call `initOtelLangfuse()` once; instrument any
    surface with `startSpan` / `withSpan` using `ATTR.*` constants. Env:
    `OTEL_EXPORTER_OTLP_ENDPOINT`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`.

## [0.50.0] — 2026-07-15

### Added
- **C33 + C21 — billing state-change notifications.** A subscription's status transition (→ `past_due`,
  → `canceled`, and the recovery `past_due` → `active`) is only observable **inside** the platform's C33
  Stripe webhook reconciliation — the consumer proxies `/hooks/*` **RAW** and never parses the event — so
  the alert now **originates in the platform** and fans out over the C21 `notify()` delivery layer. The
  affected subscriber/owner is resolved straight from the C33 subscription-of-record (`record.subscriber`
  **is** the C10 owner), and the notification deep-links to the app's **`/billing`** page.
  - **Fires only on a real STATE CHANGE.** `applyCanonicalSubscription` now reports the `previous_status`
    that was atomically in place before the upsert; `reconcileSubscription` compares it to the new status
    and notifies only on a genuine transition — an unchanged-status webhook (or a routine `active` update)
    notifies **nothing**. `none`/`trialing`/`incomplete` → `active` is a fresh activation and is **not**
    alerted (only `past_due` → `active` recovery is).
  - **Idempotent — no double-notify.** in_app is idempotent by notification `key`; push/email are deduped
    by an `idempotency_key` of `billing:<subscription>:<new_status>:<period>`, so a webhook retry or the
    same transition detected by **both** the webhook and the C33 self-heal reconcile sweep notifies **at
    most once**. A re-failure in a **later** billing period is a new transition and alerts again.
  - **MUST-DELIVER channels.** A failed-payment / cancellation is a critical transactional alert (same
    spirit as a security email), so the default channels are **`in_app` + `email` + `push`** rather than a
    suppressible per-category preference — email is the reliable channel, in_app always records, and push
    is a clean no-op when the owner has no browser subscription. Fine-grained per-user channel control for
    this is a future refinement.
  - **App-neutral copy + platform-held deep-link.** Wording carries no consumer brand (the platform serves
    any app); the deep-link base is the app public URL the platform already holds (`FORGE_AUTH_PUBLIC_URL`,
    the same origin C10 verify/reset emails link off), falling back to a bare `/billing` path when unset.
  - **Best-effort — never fails billing.** The whole notification is wrapped so a delivery hiccup can never
    fail (and pointlessly retry) the Stripe webhook; the subscription-of-record write is unaffected. The
    admin `deleteCustomer` teardown (account-purge) intentionally bypasses this seam, so closing an account
    does not email the user a "canceled" notice.
  - **No consumer adoption required.** The in_app notification surfaces via the existing `GET /notifications`
    feed the app already renders, and the email sends via C12 to the C10 account email — so this is live for
    users on deploy with **zero app/web change**. Billing + the webhook live in the **data-plane**.

## [0.49.0] — 2026-07-15

### Added
- **C19 — access-aware search (ACL-scoped queries).** C19 indexed documents **owner-keyed** and a
  `/search` returned **only the caller's own** docs — safe, but blind to items **shared to** the caller by
  other members of their household/group. Search is now **access-aware**: a document may carry ACL
  metadata, and a query may carry the caller's **scope**, so `/search` returns the caller's own docs **plus**
  the group/shared docs they are allowed to see — with the access predicate enforced **inside the index,
  BEFORE limit/paging** (a post-query filter would under-fetch under `limit` and corrupt `total`/pagination).
  **Fully additive + backward compatible:** omit the scope, or index a doc without ACL metadata, and behavior
  is **exactly as before** (owner-only). Search lives in the **data-plane**.
  - **Per-doc ACL metadata on `POST /index` / `POST /reindex`.** A document gains four optional fields:
    `groupId` (the household/group it belongs to — group/shared visibility is only ever matched **within the
    same group**), `visibility` (`'private'` (default) | `'group'` | `'shared'`), and explicit grant lists
    `sharedWith` / `sharedWriters` (opaque caller ids; unioned for read scoping). For continuity with
    consumers that already stamp the group into `attrs`, `groupId` falls back to **`attrs.groupId`** when the
    dedicated field is absent. A doc indexed **without** these behaves exactly as today — owner-only. An
    invalid `visibility` value is a `422`.
  - **Scope-aware `POST /search`.** The request gains an optional `scope: { groupId?, canReadAll? }` (the
    caller's own group + the role capability flag "may read all of the group's docs"). The predicate applied
    in the index is: **`owner == caller` OR (`doc.groupId == scope.groupId` AND ((`visibility=='group'` AND
    `scope.canReadAll`) OR (`visibility=='shared'` AND `caller ∈ sharedWith ∪ sharedWriters`)))**. "Shared-to-me"
    is matched by the caller's own `owner` id against the doc's grant lists. **Omit `scope` ⇒ owner-only.** A
    malformed scope safely degrades to owner-only (never a 500). Results stay BM25-ranked with `<mark>`
    snippets; the response shape is unchanged (`{ hits, total, took_ms }`).
  - **Both store backends enforce the identical predicate.** The filesystem backend filters the candidate
    set through the pure `docVisibleTo` predicate (the single source of truth, in `src/search/acl.ts`) before
    ranking; the Postgres backend encodes the same predicate in SQL over the `(owner, group_id, visibility,
    shared_with, shared_writers)` columns and applies it before `LIMIT/OFFSET`, so `total` and pagination are
    correct on both. The owner always sees their own docs (any visibility); cross-group callers never match.
  - **Additive, idempotent migration (Postgres).** The `group_id`/`visibility` scope columns were already
    baked in; the new `shared_with` / `shared_writers` grant columns are added via `ADD COLUMN IF NOT EXISTS`
    with empty-array defaults — **no data migration**. Existing indexed docs default to owner-only (private)
    until the consumer re-indexes them **including** the ACL fields (`groupId`, `visibility`, `sharedWith`,
    `sharedWriters`); the consumer's normal reconcile/reindex now carries those fields. FS→PG backfill
    preserves ACL metadata verbatim.

## [0.48.0] — 2026-07-15

### Added
- **C29 — policy-rule REMOVAL (closes the delete gap).** The C29 policy engine could author a rule
  (`POST /policies`) and decide (`POST /authorize`) but had no first-class, safe way to **remove** one:
  a consumer that let a user delete a governance policy could not retire the underlying engine rule, so
  a local-only delete left an **orphaned rule still enforcing**. `DELETE /policies/:id` is now a proper
  **owner-scoped, idempotent, event-emitting** removal on both planes (control + data).
  - **`DELETE /policies/:id?app=&owner=` → `{ deleted, id }`.** Removes a rule by its engine id (the id
    `POST /policies` returns / the rule is keyed by). **Idempotent** — removing an absent, already-removed,
    or out-of-scope rule is a safe `200` no-op (`{ deleted: false }`), **never a 500**. After a successful
    removal `authorize` no longer loads the rule from the store, so it **stops applying immediately**.
  - **Owner-scoping mirrors the write path.** `owner?` scopes the removal to that user's own rules exactly
    like `POST /policies` scopes creation: an owner-scoped caller can delete **only** rules it owns —
    never another owner's rule, never an app-wide/owner-less rule (both are idempotent no-ops, no leak).
    Omit `owner` for the management scope (any rule in the app, mirroring `GET /policies` with no owner).
    The `PolicyBackend.delete` seam gained an optional `{ owner? }` on the filesystem, Postgres, and
    dual-write backends (the Postgres path adds `AND owner=$3`); the CLI `forge policy delete` gained a
    matching `--owner`.
  - **Policy-lifecycle events (C3 audit).** A create/update now emits **`policy.set`** and a real removal
    emits **`policy.removed`** (subject = the policy id; `owner` carried when the rule is owner-scoped) —
    a matched pair so the policy lifecycle is observable end-to-end. A no-op removal announces nothing.
  - **No migration.** The delete path + the `owner` column already existed (P26); this is an additive
    route/param + event change — no schema change, no destructive change to unrelated data.

## [0.47.0] — 2026-07-15

### Added
- **C21 — notification DELIVERY / multi-channel fan-out (grows C4).** The C4 notification store was an
  in-app store only (upsert-by-key / list / dismiss / clear, no delivery). It now fans a notification out
  over **browser push (Web Push / VAPID)** and **email**, while every existing caller is unchanged. Mobile
  push + SMS are deliberately left as future channels (the channel model is open to them). Delivery lives in
  the **data-plane** image.
  - **`channels` on `POST /notifications` (default `["in_app"]`).** The upsert body gains an optional
    `channels` (a subset of `in_app | push | email`) and an optional `idempotency_key`. Absent/`["in_app"]`
    → the response is **byte-identical** to before (`{ notification }`); when an external channel is
    requested the response adds a `delivery` summary (`{ push?: { attempted, sent, pruned, failed },
    email?: { status }, deduped? }`). The **caller decides channels** — the platform executes delivery; it
    owns no per-category preference system. Best-effort **per channel**: a failing push/email never blocks
    in_app (which still records) or the other channel, and no delivery error propagates. `idempotency_key`
    is claimed **once across both external channels** (atomic first-writer) so a retried notify() sends
    push/email **at most once**; in_app stays idempotent by `key`. Push/email are per-owner — without an
    `owner` the external channels are skipped (in_app still records).
  - **VAPID — zero operator config.** The platform **auto-generates and persists a per-app VAPID keypair**
    on first need in the C5 secret vault (sealed at rest, survives redeploys); the **private key never
    leaves the platform**. `GET /notifications/vapid-public-key` (public; `{ public_key,
    applicationServerKey }`) exposes the raw public key a browser passes to `pushManager.subscribe`. The
    VAPID contact `sub` defaults from `EMAIL_FROM`, overridable via `FORGE_VAPID_SUBJECT` — still no
    required config.
  - **Push-subscription management.** `POST /notifications/push/subscribe` (`{ owner, subscription:
    { endpoint, keys: { p256dh, auth } } }` → `{ subscribed, endpoint }`, deduped by endpoint, a person may
    hold many devices) and `POST /notifications/push/unsubscribe` (`{ owner?, endpoint }`). `owner` is the
    C10 session userId the app passes (never trusted from the browser). A subscription the push service
    reports GONE (404/410) is **pruned automatically** during fan-out.
  - **`webpush-vapid` plugin** — the Web Push technology boundary, hand-rolled on Node's built-in `crypto`
    + `fetch` (no web-push SDK; the slim data-plane image stays dependency-clean): the ES256 VAPID JWT
    (RFC 8292) + RFC 8291 `aes128gcm` payload encryption (ECDH + HKDF + AES-128-GCM, end-to-end to the
    browser). The network call is swappable for tests.
  - **`push` store domain (C21 / P26).** A new pluggable backend (filesystem default; Postgres via
    `FORGE_PUSH_BACKEND=postgres` + optional `FORGE_PUSH_DUAL_WRITE=1`) holding the push subscriptions
    (dedupe-by-endpoint upsert) + a short-lived cross-channel delivery-idempotency ledger (atomic
    first-writer claim). Additive, idempotent migration (`CREATE TABLE IF NOT EXISTS`); kept out of the
    inspectable `/resources` API (like connections/auth), holds no secret material.
  - **Email channel** reuses **C12 SendEmail** to the owner's **account email** (C10), subject = title,
    body = a simple branded template (with a deep-link button when `data.url` is present).

## [0.46.0] — 2026-07-15

### Added
- **Account-security extensions on the C10 identity edge — password CHANGE + strictly-opt-in email
  two-factor auth.** Both are **additive**; existing auth behavior is unchanged. All new endpoints live on
  the same proxied `/auth/*` surface consumers already use.
  - **`has_password` + `twofa_enabled` on the session/"me" payload.** `GET /auth/session` (and
    `POST /auth/refresh`) now also return `has_password` (false for a Google-only account) and
    `twofa_enabled`, so a client knows whether to offer a change-password form / a 2FA toggle. Response is
    now `{ userId, email, exp, has_password, twofa_enabled }`.
  - **`POST /auth/password` — change password (authenticated).** JSON body
    `{ current_password, new_password }`. Verifies the live session **and** the current password, enforces
    the existing ≥8-char policy on the new one, then updates it and **signs out every other device**
    (revokes all sessions + refresh tokens) while keeping the calling device signed in on a freshly-minted
    session (new `Set-Cookie`s). Errors (`{ error: { code, message, retry } }`): `unauthenticated` (401),
    `no_password` (409 — a Google-only account; use reset), `weak_password` (422),
    `current_password_incorrect` (403), `auth_not_configured` (503).
  - **Email second factor (opt-in).** The second factor is a **one-time 6-digit code emailed** to the
    account address (reuses C12 SendEmail — new built-in `twofa-code` template; no authenticator app /
    recovery codes for launch, since email access is already the recovery path). Codes are single-use,
    short-lived (10 min, `FORGE_AUTH_TWOFA_CODE_TTL_SECONDS`), attempt-capped (5,
    `FORGE_AUTH_TWOFA_MAX_ATTEMPTS`), and stored **hashed** — the raw code is never persisted or logged.
  - **`POST /auth/2fa/enable` (authenticated, two-phase).** No body → emails a code and returns
    `{ pending: true, delivery: "email", sent_to, expires_in }`; `{ code }` → verifies it and turns 2FA on
    (`{ twofa_enabled: true }`). `already_enabled` (409), `email_unavailable` (503), `code_incorrect` (401,
    with `attempts_remaining`), `code_expired` (400), `too_many_attempts` (429).
  - **`POST /auth/2fa/disable` (authenticated).** Requires re-verification: `{ password }` (current
    password) **or** `{ code }` (emailed) → `{ twofa_enabled: false }`; with neither, starts re-verification
    by emailing a code (`{ pending: true, … }`). `not_enabled` (409), `current_password_incorrect` (403).
  - **Login challenge — a 2FA-enabled login never issues a session immediately.** When a `twofa_enabled`
    user authenticates by **password OR Google**, the platform withholds the session and instead emails a
    code and returns a **`2fa_required` challenge** carrying a short-lived pending token. A JSON caller gets
    `200 { status: "2fa_required", challenge, delivery: "email", sent_to, expires_in, methods: ["email"] }`
    (no cookies); a browser gets the hosted **"enter your code"** page. The real session is issued **only**
    by **`POST /auth/2fa/verify`** `{ challenge, code, next? }` (content-negotiated: JSON →
    `{ userId, email, has_password, twofa_enabled }` + cookies; hosted form → 303 to `next`). **`POST
    /auth/2fa/resend`** `{ challenge }` re-emails a fresh code. `challenge_invalid` (400),
    `code_incorrect` (401 + `attempts_remaining`), `too_many_attempts` (429).
  - **The non-negotiable safety property:** a user who has **not** enabled 2FA logs in **exactly as
    before** — an immediate session, zero emailed codes, no challenge, existing sessions untouched. Covered
    by dedicated tests (form **and** JSON login), alongside the change-password + full challenge/verify/
    resend/disable flows and a no-code-leak assertion.
  - New identity events (redacted email + ids only, never the code/hash): `TwofaEnabled`,
    `TwofaDisabled`, `TwofaChallengeIssued`, `TwofaChallengeVerified`. New identity-store surface
    (`twofa_enabled` user flag + a single-use, attempt-capped `twofa_codes` store) implemented across the
    filesystem, Postgres (additive `ALTER TABLE … ADD COLUMN IF NOT EXISTS twofa_enabled` + a new
    `forge_identity_twofa_codes` table), and dual-write backends; the 2FA codes are transient and
    deliberately excluded from the FS↔PG migration snapshot. Identity ships in the **data-plane** image.

## [0.45.1] — 2026-07-15

### Fixed
- **Google sign-in "state mismatch" in the nested MCP-connect flow (C10/C23).** Connecting an MCP host
  (e.g. Claude) to a consumer app failed at the Google callback with *"Google sign-in failed (state
  mismatch)"*. Root cause: the Google-OAuth CSRF `state` was a random nonce stashed in a **host-only cookie**
  (`forge_oauth_state`, `Path=/auth`). When an MCP host drives OAuth against `api.<host>/mcp`, the
  `/oauth/authorize` bounce runs `/auth/google` on **`api.<host>`** (setting the cookie there), but Google's
  registered redirect URI returns the callback to **`app.<host>`** (`FORGE_AUTH_PUBLIC_URL`) — a cookie set
  on `api.<host>` is never sent to `app.<host>`, so the state was absent and every connect-time Google
  sign-in was rejected. (Normal same-host app login was unaffected, which is why it only showed up on
  Connect.) **Fix:** the `state` is now a **signed, self-contained token** (HMAC-SHA256 with the app's
  session secret) carrying its own `nonce` + `next` + `app` + expiry. It round-trips through Google in the
  URL and is verified on the callback **by signature — not by a cookie** — so it survives the cross-host
  return. This mirrors the C24 connector flow (server-authoritative, unguessable state; no host-bound
  cookie). A same-host `forge_oauth_state` cookie is still set as **defense-in-depth** (when present it must
  match the state; its absence on the cross-host path is expected and tolerated). `next` is still passed
  through the same-site `safeNext` open-redirect guard. `/auth/google` now also requires the session secret
  to be configured (it must sign the state), matching the callback's existing guard. **No consumer change**
  — the app only proxies `/auth/*`; `forge_oauth_state` is HttpOnly and platform-internal. New pure helpers
  `signOAuthState` / `verifyOAuthState` / `readOAuthStateApp` in `shared/session.ts`.

## [0.45.0] — 2026-07-14

### Added
- **`GET /auth/admin/identities` — administrative "list all accounts" enumeration** (C10/C34). Lists
  EVERY login identity for the calling app so an operator's admin tool can see and pick any account —
  including "zombies" that are missing from the consumer's own app-domain index. **SERVICE-token gated**
  (`AUTH_SERVICE_TOKEN` via the `x-forge-service-token` header **or** `Authorization: Bearer …`), the exact
  same gate as the existing `DELETE /auth/admin/identity/:userId` teardown, and scoped to the same resolved
  app (`?app` / `X-Forge-App` / `FORGE_APP_NAME`). Read-only. Response:
  `{ identities: [ { user_id, email, provider, created_at } ] }` where `email` is the **full** canonical
  stored email (not redacted — a trusted service caller must recognize the account it is about to purge),
  `provider` is `"google"` for an OAuth account / `"password"` for a password account / `null` otherwise,
  and `created_at` is the signup timestamp. Empty app ⇒ `{ identities: [] }` (never a 404). Ordered by
  `created_at`. **Additive** — pairs with the existing delete-by-id (find what to purge → purge it); no
  existing behavior changes. Uses the identity store's existing `listUsers` across the filesystem +
  Postgres + dual-write backends.

## [0.44.0] — 2026-07-14

### Added
- **`POST /billing/checkout` now honors free-trial + payment-collection controls** (C33). The checkout
  request accepts three optional top-level fields — **`trial_period_days`** (integer 1–730),
  **`payment_method_collection`** (`"always"` | `"if_required"`), and **`mode`** (must be `"subscription"`,
  the only supported mode) — and threads the first two onto the Stripe Checkout Session as
  `subscription_data.trial_period_days` and the top-level `payment_method_collection`. A checkout carrying
  `trial_period_days: 30` + `payment_method_collection: "always"` now produces a **card-required 30-day
  trial**: the resulting subscription starts Stripe status `trialing` (`trial_end ≈ now + 30d`) instead of
  immediately `active`. The webhook path already maps Stripe `trialing` → the subscription-of-record
  `status: "trialing"` with `trial_end` populated (now covered by a test). Invalid values (`trial_period_days`
  ≤ 0 / non-integer / > 730, a non-`subscription` `mode`, an unknown `payment_method_collection`) return
  **`422 invalid_input`**.

### Fixed
- **Trialed checkouts were silently downgraded to immediately-active subscriptions.** The C33 checkout
  handler read only `plan_key` / `success_url` / `cancel_url` / `scope_ref` / `customer_email` and **dropped**
  the `mode` / `trial_period_days` / `payment_method_collection` fields a consumer sent, so Stripe created an
  active (non-trial) subscription (`trial_end: null`, period ≈ one interval out). The fields are now read at
  the route, carried through `CheckoutInput` + the `StripeClient.createCheckoutSession` boundary, and set on
  the Session. **No consumer change required** — the accepted request shape is exactly what callers already
  send; checkouts that omit the fields are unchanged (no trial).

## [0.43.0] — 2026-07-14

### Added
- **`GET /billing/catalog` now returns the TRUE data-plane `configured` state** (C33 hardening). The
  catalog response gains a top-level `configured: boolean` alongside `plans`, resolved from
  `resolveBillingConfig()` on the sidecar that actually serves the request — i.e. whether
  `STRIPE_SECRET_KEY` is provisioned on THIS data plane. A consumer app previously had to infer
  purchasability from its own env (e.g. `STRIPE_PRICE_*`), which could disagree with the data plane: if
  price ids were set but the data-plane key was missing, the app would show purchasable plans whose
  checkout then 503s (`billing_not_configured`). The app can now read the real state and hide/disable
  purchase CTAs when `configured` is `false`. **Additive and non-breaking** — existing clients that read
  only `plans` are unaffected; the write path (`PUT /billing/catalog`) and every other billing response
  are unchanged. Mirrors the existing `configured` block already exposed by `GET /auth/config`.

## [0.42.0] — 2026-07-14

### Added
- **Administrative principal teardown — the generic machinery behind account deletion / "right to be
  forgotten" / account closure.** Three **idempotent, service-gated (`AUTH_SERVICE_TOKEN`) admin
  operations**, each keyed by the principal/owner id, extend the identity, billing, and
  membership/household surfaces so a consumer app can fully delete a principal's platform footprint from
  inside its own account-purge cascade. Every op is **NOT end-user reachable** (service token via the
  `x-forge-service-token` header or `Authorization: Bearer …`), **idempotent** (a second run is a clean
  no-op, never a 404/500), and the platform **never touches the consumer's own domain rows** — the app
  handles its domain data itself. All three are **additive and non-breaking**.
  - **`DELETE /auth/admin/identity/:userId` (identity).** Deletes the login identity + ALL its
    credentials (password hash), sessions, refresh tokens, and verify/reset tokens (and its O4 personal
    group-of-one on the Postgres backend) so it can no longer authenticate and its **email/handle is freed
    for re-registration**. Emits a `UserDeleted` fact (redacted email, no secrets). Absent identity ⇒
    `200 { deleted: false }`. Returns `{ deleted, user_id, email? }` (email redacted). New
    `IdentityBackend.deleteUser` on the filesystem + Postgres + dual-write backends.
  - **`DELETE /billing/customer` `{ subscriber }` (billing).** Cancels any **active/`trialing`**
    subscription, deletes the payment-provider (Stripe) customer (the platform holds the Stripe secret —
    the app never does), and drops the platform's subscription-of-record row for the subscriber. The
    provider-side teardown runs **before** the local row is dropped, so a transient Stripe failure (→ `503
    billing_teardown_failed`) leaves the record intact for a clean retry. Safe when the subscriber was
    never a customer **or** Stripe is unconfigured (those steps are skipped; the record is still dropped).
    Returns `{ deleted, subscriber, subscription_canceled, stripe_customer_deleted, record_dropped,
    stripe_configured }`. Adds `cancelSubscription` + `deleteCustomer` to the swappable `StripeClient`
    boundary (both idempotent — a 404 at Stripe resolves to "already gone", not an error).
  - **`DELETE /identities/:owner/memberships` (membership/household).** Removes the identity from the
    entire membership graph: a group it **solely occupies (a group-of-one)** is deleted outright (with its
    member rows + invitations); in a **shared** group it is removed (emitting the existing
    `membership.removed` event, `via: "teardown"`). Because this is a forceful admin op that can never be
    refused for the ≥1-owner invariant, when the departing identity was a shared group's **sole owner** the
    earliest-joined remaining active member is promoted to the owner-role (the group stays valid). Returns
    `{ owner, groups_deleted, memberships_removed, promotions, removed_rows }`.

### Fixed
- **`/commit-and-publish` no longer gathers git context from — or can commit/tag/publish against — the
  wrong repository (P37).** When the command was invoked by a subagent whose shell cwd was not the
  forge repo root (e.g. an orchestrator's cwd), its bare `git status`/`git log`/commit/tag steps
  resolved against that other directory, twice surfacing a sibling repo's commits and risking a
  commit/tag/publish against the wrong repo. The command now **resolves the forge repo root once**
  (`FORGE_ROOT` → `CLAUDE_PROJECT_DIR` → the current dir's git toplevel, accepted only if it is
  actually forge), **hard-refuses** to run unless the resolved root's `package.json` name is `forge`
  and the publish workflow is present, and **binds every git/version operation to that root**
  (`git -C "$ROOT" …`, `npm --prefix "$ROOT" version …`, `gh … -R <forge remote>`) instead of bare
  cwd-relative git. Developer-tooling only — no control-plane behavior or release mechanics changed.

## [0.41.0] — 2026-07-13

### Changed
- **C33 billing — the Stripe technology boundary now runs on the official `stripe` SDK** (added
  `stripe@^22.3.1`), replacing the hand-rolled client that spoke to Stripe over Node's built-in `fetch` +
  `node:crypto`. This is a **purely internal implementation swap behind the existing swappable seam** — the
  `StripeClient` interface, the normalized shapes it returns, and **every external `/billing/*` + webhook +
  catalog + entitlement HTTP signature are unchanged**. The deliberate trade (chosen over the
  dependency-clean built-in approach): the slim data-plane image now bundles `stripe` (a zero-dependency,
  pure-JS package — no native modules, so multi-arch `linux/amd64`+`linux/arm64` builds are unaffected).
  - All Stripe I/O goes through the SDK: `checkout.sessions.create` (subscription mode, `automatic_tax`,
    `tax_id_collection`, customer create/reuse, `client_reference_id` + metadata, subscription-data metadata
    stamp), `billingPortal.sessions.create`, `customers.create`, and the canonical webhook re-fetch via
    `subscriptions.retrieve` (a missing subscription → `null`).
  - **Webhook signature verification now uses `stripe.webhooks.constructEvent(rawBody, sig, secret)`** over
    the **untouched raw request bytes** (the sidecar still passes the raw body through un-parsed). A bad /
    stale / tampered signature still yields `400 signature_invalid` and writes nothing; the tolerance-window
    replay defense is preserved. The test-only header generator now delegates to the SDK's
    `generateTestHeaderString` — the exact inverse of `constructEvent`.
  - Config is still read from the C5 vault exactly as before (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
    `STRIPE_TAX_ENABLED`); unset ⇒ `configured:false` graceful degradation unchanged. Keys are never
    hardcoded. The seam stays swappable, so the 30 `billing` tests run against a deterministic in-memory
    Stripe double with **no network** — unchanged.

## [0.40.0] — 2026-07-13

### Added
- **C33 — Billing / subscriptions / entitlements.** A generic, **payment-source-agnostic** billing
  capability: the platform owns the plans catalog, the ONE canonical subscription-of-record per
  `(app, subscriber)`, and the derived entitlement map. Consumers check an entitlement **key** — never a
  price id or receipt. The **web / Stripe (direct + Stripe Tax, no Connect)** surface ships now; the model
  carries the `stripe | apple | google` source enum + `provider_refs` slots + reserved routes from day one,
  so a mobile IAP/Play adapter slots into the SAME internal upsert seam with no schema rewrite (the Apple/
  Google decoders are **deferred**). Nothing platform-side names a Dorinda plan/price — plans + prices are
  entirely app-supplied via the catalog API; a "household" is just an entitlement a plan unlocks (the
  platform stays ignorant of any group model and only **echoes** a `scope_ref`).
  - **Billing store** (new `billing` P26 store domain — `src/storage/backends/billing/`, filesystem default
    + Postgres + dual-write + backfill) — one per-app document holding the catalog + subscriptions +
    processed-webhook-event dedupe set; the **monotonic-version** subscription upsert and one-shot webhook
    dedupe are serialized by a per-app lock (FS) / `SELECT … FOR UPDATE` (PG), so they hold identically on
    both backends. Held OUT of the inspectable `/resources` API (like membership/secrets/auth). Selectable
    via `FORGE_BILLING_BACKEND` / `FORGE_BILLING_DUAL_WRITE`.
  - **Subscription-of-record** (`GET /billing/subscription?subscriber=`) — the canonical record
    `{ subscriber, app, plan_key, status, source, current_period_end, cancel_at_period_end, trial_end,
    currency, scope_ref, provider_refs{…}, … }`. Each source's native states map into a canonical 6-state
    vocabulary (`active | trialing | past_due | canceled | incomplete | none`). The read **never 404s** — it
    returns an explicit `status:"none"` free/default record when absent. Written ONLY by reconciliation
    inputs (no consumer write path).
  - **Entitlements** (`GET /billing/entitlements?subscriber=` · `GET /billing/entitlement?subscriber=&key=`)
    — a flat, platform-derived `key→typed value` map: `active|trialing` → the active plan's map;
    `past_due|incomplete` → **GRACE** (keep the paid entitlements through `current_period_end`, then free);
    `canceled|none` → the free/default plan. Keys are app-defined and copied through verbatim.
  - **Plans catalog** (`PUT /billing/catalog` idempotent replace, service-token gated · `GET /billing/catalog`
    public) — app-supplied `PlanDef` `{ plan_key, display, interval(month|year), prices{stripe,apple,google},
    entitlements, seat_limit?, is_default }`. Validated: exactly one `is_default`, unique `plan_key`; a plan
    with no `prices.stripe.price_id` is catalog-valid but **not purchasable** (→ `price_unconfigured`). Month
    vs. year are separate `plan_key`s sharing an entitlement map.
  - **Stripe ops** (`POST /billing/checkout` · `POST /billing/portal`) — the platform holds the key and does
    ALL Stripe I/O; the app never imports a Stripe SDK. Checkout is subscription-mode with
    `automatic_tax` (Stripe Tax, default on via `STRIPE_TAX_ENABLED`), `tax_id_collection`, `customer_update`
    address/name auto, `client_reference_id`+metadata `{subscriber,app,plan_key,scope_ref}`, and **reuses**
    the subscriber's Stripe customer (else creates + remembers it). Returns a hosted `url` the app 302s to.
  - **Webhook** (`POST /hooks/billing/stripe`, platform-owned; the app proxies Stripe's request **RAW** to
    it) — the **Stripe-Signature is verified from the RAW bytes in the sidecar** (the app never sees the
    signing secret or parses an event); deduped on `event.id`; each handled event **re-fetches the canonical
    Stripe subscription** and upserts the record — **idempotent under duplicate / out-of-order delivery** via
    the monotonic-version guard. A transient failure returns 5xx so Stripe retries. Best-effort `billing.*`
    C3 facts (non-hard-dep).
  - **Reconciliation seam + reserved routes** — a platform-internal **reconcile sweep**
    (`POST /billing/reconcile`, service-token gated) re-pulls active subscribers to self-heal dropped
    webhooks (not auto-scheduled; wire to C2 per deployment). `POST /hooks/billing/apple` +
    `/hooks/billing/google` are **reserved → `501 not_configured`** until their adapters ship — they will
    feed the same internal upsert.
  - **New C5 secrets** (per app, in the vault; never hardcoded): `STRIPE_SECRET_KEY`,
    `STRIPE_WEBHOOK_SECRET`, config `STRIPE_TAX_ENABLED` (default `true`). **Graceful degradation:** unset ⇒
    `configured:false` — checkout/portal `503 billing_not_configured`, the subscription read still `200 none`,
    the webhook no-ops. Adoptable BEFORE the Stripe account is live.
  - **Stripe technology boundary** (`src/plugins/stripe-billing/`) — a **swappable** `StripeClient` (real
    REST via built-in `fetch`; tests inject a deterministic in-memory Stripe, no network) + the raw-bytes
    HMAC-SHA256 webhook verification + the Stripe→canonical status mapping. Dependency-clean (no SDK), keeping
    the slim multi-arch data-plane image clean — the same posture as the C24 outbound-OAuth client.
  - **Consume surface** — the billing routes register on BOTH planes (like `/auth`, `/connect`); the app
    proxies the browser-facing `/billing/*` ops same-origin (subscriber derived from the C10 session; a C10
    **service token** may act for a passed subscriber for background checks) and proxies the webhook raw.
    Failure vocabulary: `billing_not_configured` (503) · `unknown_plan`/`price_unconfigured` (422) ·
    `not_a_customer` (404) · `signature_invalid` (400) · `forbidden` (403) · a subscription read is `200 none`.

## [0.39.0] — 2026-07-13

### Added
- **C31 — Household / multi-member identity + roles + shared-private scoping.** A generic, product-agnostic
  extension of the shipped identity/ownership + **C29** authorization capabilities that makes **group
  membership + an app-defined role** a **platform-owned, unspoofable** primitive: the caller's
  `role`/`is_member`/`group_id` are **resolved server-side from the membership graph**, never trusted from a
  request. Nothing here names a household/family/team — a "group" is only a tenancy + sharing boundary, and
  roles + their permissions are entirely app-supplied.
  - **Membership graph store** (new `membership` P26 store domain — `src/storage/backends/membership/`,
    filesystem default + Postgres + dual-write + backfill) — the platform owns groups, members, invitations,
    and the app **role registry** as one per-app document; multi-record invariants (**≥1-owner**, singleton
    flip, one-shot invitations) are serialized by a per-app lock (FS) / `SELECT … FOR UPDATE` (PG), so they
    hold identically on both backends. The invariant logic lives once as pure ops over a state snapshot
    (`src/membership/service.ts`). Selectable via `FORGE_MEMBERSHIP_BACKEND` / `FORGE_MEMBERSHIP_DUAL_WRITE`.
  - **Role registry** (`PUT /roles` idempotent replace · `GET /roles`) — app-registered `RoleDef`
    `{ key, label?, permissions:[opaque tokens], rank, owner_role, assignable }`. Permissions are opaque app
    tokens the platform stores + set-tests but never interprets, except three well-known membership tokens it
    recognizes to gate the lifecycle: `members.invite` / `members.manage_roles` / `members.remove`. Exactly
    one role must be `owner_role:true` (it tracks the ≥1-owner invariant without the platform naming it).
  - **Group lifecycle** — `POST /groups/ensure` (idempotent on a caller-supplied `external_id`, else on the
    owner's personal singleton) + `POST /groups` + `GET /groups/:id` (resolvable by internal id **or** the
    consumer's `external_id`). A group is **lazily auto-provisioned as a group-of-one** on first sight of an
    identity and holds ≥1 owner-role member; the singleton flips false when a 2nd member joins. `external_id`
    is the migration linchpin: a consumer registers its **existing** group UUIDs with **zero row rewrites**.
  - **Members** — `GET /groups/:id/members` · `GET /groups/:id/members/:owner` (role + expanded permissions +
    membership) · `GET /identities/:owner/groups` · `POST /groups/:id/members/:owner/role`
    (needs `members.manage_roles`) · `DELETE /groups/:id/members/:owner` (needs `members.remove`; **emits a
    `membership.removed` fact via the C3 app-event log and never touches app rows**) ·
    `POST /groups/:id/transfer-ownership` (atomic; preserves ≥1 owner) · `POST /groups/:id/leave` (the sole
    owner is refused with `409 last_owner`).
  - **Invitations** — `POST /groups/:id/invitations` mints an **opaque single-use token** (only its hash is
    stored) the **consumer delivers** (the platform never sends email); the token is **bound to the invited
    hint** (accept must match — not bearer). `GET /groups/:id/invitations` · `POST /invitations/:id/revoke` ·
    `POST /invitations/accept { token, owner, invitee_hint? }` (adds the member + flips the singleton). Reuse
    of a pending invite returns the existing one (`already_invited`).
  - **C29 `authorize()` extension (additive, non-breaking)** — the request gains optional `group_id` (the
    targeted group; omit = the caller's personal group-of-one) and the targeted resource's stored scope on
    `action`: `resource_owner?`, `visibility? ∈ {private,group,shared}`, `shared_with?[]`. The response gains
    platform-**resolved** `role` / `permissions[]` / `is_member` / `group_id`. Two new deterministic floors:
    **NOT-A-MEMBER** (a non-personal group you don't belong to → deny) and the **PRIVATE-LEAK FLOOR** (a
    private/shared row that excludes the caller → deny `private-resource`, so it can't leak to another group
    member). Policy matching now uses the **resolved** role (the request `role` is **accept-and-ignore** once
    a role registry exists), and `PolicyMatch` gains an additive `permission?: string[]` gate tested against
    the resolved permission set.
  - **Membership surface on both planes** — `src/api/membership-routes.ts` registered on the control plane
    (`src/api/server.ts`) and the data-plane sidecar (`src/data-plane/server.ts`), like the C29 authz surface.
    Trusted-internal model (owner/actor + app ride the request over the compose network), same as `/authorize`.

### Changed
- **`/authorize` resolves membership server-side** when the app has registered a role registry: it lazily
  provisions the caller's group-of-one on first sight, resolves role/permissions/is_member/group_id from the
  graph, and records them on the C3 authz-decision audit fact. Until a registry exists (`PUT /roles`), the
  endpoint behaves **byte-identically to C29** — the request `role` is honored and no new floor can fire, so
  every current caller is unaffected (no `group_id` + no resource scope ⇒ verdict identical to before).

## [0.38.0] — 2026-07-12

### Added
- **C25 — SendMessage: outbound message delivery AS a connected user.** A generic, provider-agnostic
  capability that sends a message **from the user's own connected account** — so a consuming app's approved
  drafts actually go out **as the user**. MVP: **email via connected Google (Gmail)**; the architecture is
  channel/provider-extensible so SMS/push and Microsoft/Outlook are additive.
  - **Capability** (`src/capabilities/send-message/`, data plane, slug `send-message`) — given
    `{ owner, provider="google", channel="email", to[], cc?, bcc?, subject, body, content_type?, in_reply_to?,
    references?, thread_ref? }` it brokers a **fresh provider access token in-process via the C24 broker**
    (`getFreshAccessToken`, which auto-refreshes and enforces the required scope), composes the message, and
    hands it to the resolved channel/provider Implementation so the mail genuinely lands in the user's
    account/Sent folder.
  - **Gmail Implementation** (`src/plugins/message-gmail/`) — composes an RFC 5322 / MIME message
    (multi-recipient To/Cc/Bcc, RFC 2047 subject encoding, In-Reply-To/References threading, text or HTML)
    and POSTs it base64url-encoded to Gmail's `users.messages.send` **as the user**. Dependency-clean (Node
    `fetch`/`crypto`, no Google SDK); **swappable** (`setGmailSender`) so the suite runs with no network.
  - **Channel × provider dispatch** (`src/capabilities/send-message/senders.ts`) — the extensibility seam:
    `email:google` is registered (requires the `gmail.send` scope); an unimplemented pair returns a precise
    `unsupported_channel` change-input. SMS/push + Microsoft are stubbed (additive descriptors), not wired.
  - **Unified sent-mail record** — reuses the **C12 `EmailDelivery`** resource (now carrying optional
    `owner`, `channel`, `provider`, `thread_id`, `sent_at`), persisted for success **and** failure, **owner-
    scoped**, with the recipient **REDACTED** and **no body/token** at rest. Emits **`MessageSent` /
    `MessageFailed`** facts. Listable/readable by owner (`/resources?type=EmailDelivery&owner=…`).
  - **Authenticated send surface** — `POST /connect/:provider/send` (registered on both planes) sends AS the
    user with the **same trust model as the C24 broker**: the C10 **session** (user-in-the-loop) OR a valid
    C10 **service token + `owner`** (a background/approved send). `owner` is never trusted from an
    unauthenticated client. Records a `message.sent` / `message.failed` fact to the C3 app timeline.
  - **Precise, never-silent failures** — a broker precondition is surfaced as a typed error the app relays as
    a "reconnect Gmail" state: **404 `not_found`** (not connected) · **403 `insufficient_scope`** (send not
    granted) · **409 `reconnect_required`** (dead refresh). A provider **rejection** is a recorded
    `status:'failed'` (scrubbed of PII) with `error`, never a silent drop — the app can trust `status`.

## [0.37.0] — 2026-07-12

### Added
- **C24 — third-party connector vault / outbound OAuth.** A generic, product-agnostic capability that lets a
  consuming app's users connect their own third-party accounts (Gmail send + Calendar read via **Google**)
  so the app can act **as them**, without the app ever handling raw tokens.
  - **Provider registry** (`src/connectors/providers.ts`) — config-driven descriptors (`authorization_endpoint`,
    `token_endpoint`, `revoke_endpoint`, default scopes, the offline/consent authorize params, PKCE). Google
    ships as the MVP provider; **Microsoft** is registered too (endpoints known) to prove the architecture is
    config-driven — it lights up the moment its creds are provisioned. Client credentials come from
    **per-provider C5 secrets/env** (`GOOGLE_CONNECT_CLIENT_ID/SECRET`), never hardcoded, and are **distinct**
    from the C10 `GOOGLE_CLIENT_ID` sign-in client.
  - **Connect flow** — `GET /connect/:provider/start` (owner from the C10 session) mints a PKCE + `state`
    pending request and 302s to the provider consent (offline access → refresh token); `GET
    /connect/:provider/callback` exchanges the code and stores the tokens. Pending requests are one-shot and
    short-lived; a callback whose session user differs from the initiator is rejected.
  - **Vault + auto-refresh** — access + refresh tokens are **encrypted at rest** (AES-256-GCM under the C5
    master key `FORGE_SECRETS_KEY`; the store only ever holds ciphertext) in a new **P26 `connections` store
    domain** (`forge_connections` + `forge_connection_requests`; filesystem default / Postgres opt-in via
    `FORGE_CONNECTIONS_BACKEND`, with dual-write + backfill). An expired access token is refreshed
    transparently (in-process per-connection mutex prevents a refresh stampede); a dead refresh marks the
    connection `expired` and returns `409 reconnect_required`.
  - **Broker** — `POST /connect/:provider/token` returns a **fresh, valid access token** for
    `(owner, provider)` so the app makes the provider call itself. Owner comes from the C10 **session**;
    a background/server call authenticates with the C10 **service token** and passes `owner` (the same
    trusted-internal model as the C2 scheduler / `/mcp/consents`). A future proxy mode can layer on this.
  - **Management** — `GET /connect` lists a user's connections (provider, scopes, status, `account_label`,
    timestamps — **never a token**); `DELETE /connect/:provider` revokes at the provider (when supported)
    and deletes the stored tokens. `GET /connect/providers` advertises the registry + per-provider
    configured-state. Connect / disconnect / token-issue are recorded to the C3 app-event log (no token).
  - Served on **both planes** (the app proxies `/connect/*` same-origin, like `/auth`/`/oauth`/`/mcp`).
- **Operator provisioning catalog (C13)** — added `GOOGLE_CONNECT_CLIENT_ID` / `GOOGLE_CONNECT_CLIENT_SECRET`
  (optional; the Google connector degrades to a clean 503 until both are provisioned), with the Google Cloud
  setup (Gmail + Calendar APIs, the `.../connect/google/callback` redirect URI, the requested scopes).

### Changed
- `secrets-local` now also exports `sealValue`/`openValue` — reusable envelope encryption under the **same**
  C5 master key (`FORGE_SECRETS_KEY`), so the connector vault encrypts tokens with one key mechanism and no
  second key to provision. The existing `set/unset/list`/runtime-injection contract is unchanged.

## [0.36.0] — 2026-07-12

### Fixed
- **P30 — control-plane host-port collision on a shared host.** The deployable-consumer scaffolding gave
  the control-plane `api` service a fixed host `ports:` publish (`127.0.0.1:3717:3717`), so a **second**
  Forge app on a shared host failed `make up` with *"port is already allocated."* The publish is vestigial —
  the `./forge` wrapper reaches the control plane via `docker compose exec` **into** the container, nothing
  on the host dials `:3717`. Dropped the `ports:` block from the scaffolding spec
  (`docs/architecture/09-deployable-consumer.md` §2). *(The scaffold template file itself lives in
  **forge-starter** — same change to apply there.)*
- **P31 — platform-DB init failed to boot on Docker Desktop for Mac.** `productionize` bind-mounted the
  generated `forge-platform-init.sh` into `/docker-entrypoint-initdb.d/`; on macOS the mount is effectively
  `noexec`, so first boot died with `/bin/sh: bad interpreter: Permission denied` → the least-priv
  `forge_platform` role/DB were never created → the data-plane crashed at `ensureIdentitySchema`. The init
  file is now a **`.sql`** (`forge-platform-init.sql`) the Postgres entrypoint runs via `psql -f` — no
  shebang, no exec bit — so it works identically on Linux and macOS. The role password is read from the
  container env at init time (psql `\set` backtick) and quoted with `format(%L)`; nothing is committed.
- **P32 — base64 DB passwords broke the connection URL.** The provisioning guidance generated
  `POSTGRES_PASSWORD` / `FORGE_PLATFORM_DB_PASSWORD` with `openssl rand -base64`, whose `/ + =` alphabet
  makes `postgres://user:pa/ss@host/db` throw `ERR_INVALID_URL`. Anything interpolated into a connection URL
  is now generated **URL-safe** (`openssl rand -hex 32`) across the secret catalog, `.env.prod.example`,
  `PROVISIONING.md`, and the deploy docs. HMAC/vault keys (`FORGE_SECRETS_KEY`, `AUTH_SESSION_SECRET`) stay
  base64 — they are decoded as keys, not placed in a URL.
- **P33 — `FORGE_STORE_BACKEND=postgres` forced the S3 blob backend.** A single-node Postgres deploy without
  an object store hard-failed at boot (*"FORGE_S3_ENDPOINT + FORGE_S3_BUCKET are required…"*) even though
  blobs weren't in the flip set. Blob storage is now **decoupled** from the structured-store switch: blobs
  default to the **filesystem** (bytes on the durable `forge_state` volume) and only ride S3 when S3 is
  **explicitly** configured (`FORGE_BLOBS_BACKEND=s3` or `FORGE_S3_ENDPOINT`+`FORGE_S3_BUCKET` present). A
  deploy that already had S3 configured is unaffected.

### Added
- **P33 — `--blobs-backend` knob.** `forge productionize --blobs-backend s3` (persisted in `forge.app.json`
  `production.blobs_backend`, default `filesystem`) opts the C20 blob store into an S3-compatible object
  store: the data-plane gets `FORGE_BLOBS_BACKEND=s3` and `.env.prod.example` documents the `FORGE_S3_*`
  values. Object storage is what unlocks horizontal scale for blobs.
- **P34 — optional auth providers wired automatically.** When an app uses hosted auth (declares
  `AUTH_SESSION_SECRET`), `productionize` now wires the OPTIONAL provider vars — `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `SMTP_URL`, `EMAIL_FROM` — into the **data-plane** env as defined-but-empty even
  when they aren't separately declared. `.env.prod` is the single source of truth: fill a value and redeploy
  to enable Google/email — no `--secret` re-declare + re-productionize round trip. (Wired into the data-plane
  only; the web tier proxies `/auth/*` to it.)
- **P36 — cron fires are authenticated by default.** When an app declares scheduled jobs
  (`forge.jobs.json` → `/api/cron/*`), `productionize` now makes `AUTH_SERVICE_TOKEN` **deploy-required**
  (`${AUTH_SERVICE_TOKEN:?…}`) in **both** the web and data-plane containers — a missing token **fails the
  deploy** instead of firing bare, unauthenticated POSTs at publicly-routed cron endpoints. The fire-auth
  contract (Bearer + `x-forge-service-token`, constant-time compare, app-side guard) is documented in
  `docs/architecture/09-deployable-consumer.md` §2. *(The app-side guard is scaffolded by **forge-starter**.)*

### Changed
- **Docs — P35 app self-bootstrap contract.** `docs/architecture/09-deployable-consumer.md` gains a §6
  specifying that a deployed consumer must **self-bootstrap idempotently on boot** (apply its own DB
  migrations + register its C23 MCP tools/instruction block), mirroring how the data-plane auto-registers
  `forge.jobs.json`. This is scaffold-owned (**forge-starter**); no forge-core change — the section is the
  spec forge-starter implements.

## [0.35.0] — 2026-07-11

### Added
- **C23 — remote MCP-server hosting + an OAuth 2.1 authorization server + a versioned agent "training"
  block + proactive scheduling.** The platform hosts a consuming app's declared tool surface as a **remote
  MCP server** reachable by the OpenAI Apps SDK + the Anthropic MCP connector, gates it with the app as an
  **OAuth 2.1 authorization server**, serves a **versioned instruction/training block** to the connecting
  host, and can **proactively nudge** the connected agent via C2 — all generic and product-agnostic (an app
  publishes its OWN tools + instruction text + scopes; their meaning is the app's domain).
- **Remote MCP server (`POST /mcp`).** JSON-RPC 2.0 over the **Streamable-HTTP** transport
  (request/response; no persistent SSE server-push in v1, per O1): `initialize` (returns serverInfo + the
  latest instruction block), `tools/list` (the app's registered surface), `tools/call` (dispatched to the
  app's handler), and `ping`. Each call is gated by an OAuth access token; a missing/invalid token → **401
  with `WWW-Authenticate` + the RFC 9728 protected-resource pointer**, which kicks off the OAuth flow.
- **Tool registration + dispatch.** An app registers tool schemas (name, description, input/output JSON
  Schema, required **scope**, read/write/action **family**, high-risk hint, handler path). The platform
  serves them as MCP tools and **dispatches each `tools/call` to the app's handler** using the SAME
  sidecar→app callback the C2 scheduler uses (`FORGE_APP_CALLBACK_HOST/PORT`, service-token authenticated) —
  the callback resolver is now shared between C2 and C23.
- **OAuth 2.1 authorization server (`/oauth/*`).** Dynamic client registration (RFC 7591, public/PKCE by
  default), the authorize + **consent** flow (the consent screen is **C16-themed**; the logged-in user comes
  from **C10** — the app is the authorization *server* here, distinct from C10's app-as-client sign-in),
  **mandatory PKCE (S256)**, short-lived **scoped** access tokens + **rotating** refresh tokens (one-shot
  rotation; replay of a rotated token is rejected), scope narrowing on refresh, and token revocation
  (RFC 7009). Discovery at `/.well-known/oauth-authorization-server` (RFC 8414). The **token → { user,
  scopes }** verifier is the mirrorable resource-server seam.
- **Governance.** Per-tool **scope enforcement** against the granted token (a call lacking the tool's scope
  is refused with a JSON-RPC `insufficient_scope` error and audited); the platform passes the user + the
  tool's safety **family**/high-risk hint into the handler so the app runs its **C29 `authorize()`** on
  write/act tools — the platform enforces scopes, the app decides allow/stage/deny.
- **Versioned instruction/training block + proactive scheduling.** `POST /mcp/instructions` appends a
  monotonically-versioned block (A/B-testable later); `initialize` serves the latest. `POST /mcp/proactive`
  registers a per-app **C2 ScheduledJob** that periodically calls back into the app to prompt the connected
  agent toward a designated tool (the app names the tool + cadence + callback path).
- **Attribution.** Every host tool call (and every scope denial) is recorded to the **C3** audit trail
  (`mcp.tool_call`, owner-scoped, keyed by tool, carrying the connecting host + outcome).
- **New pluggable P26 store domain (`mcp`).** Tool registrations, instruction versions, OAuth client
  registrations, **consent grants**, and issued authorization codes + access/refresh tokens live behind the
  `McpBackend` interface: **filesystem default**, `FORGE_MCP_BACKEND=postgres` opt-in (five tables:
  `forge_mcp_tools|instructions|clients|consents|grants`, jsonb + projected + O4 columns), a `DualWrite`
  impl, and `forge storage migrate --store mcp`. **Secrets are hashed at rest** (token/code/client-secret
  HASHES only, never a raw value — like the C10 vault); codes + refresh tokens are **one-shot** (an atomic
  delete-returning, so no double-spend). The `test-postgres` CI job now also covers the mcp store.
- **CLI.** `forge mcp register-tool|list-tools|delete-tool|set-instructions|get-instructions|proactive`.
- **Public edge (O1).** The app proxies `/mcp`, `/oauth/*`, and `/.well-known/*` **same-origin** to the
  sidecar (the proven C10 `/auth/*` pattern); the issuer/base URL derives from forwarded headers (or
  `FORGE_OAUTH_PUBLIC_URL`), so the whole surface can relocate to a dedicated public edge later **without
  changing tool contracts**.

### Changed
- The C2 scheduler's app-callback resolution (`appCallbackBase` + service-auth headers) moved to a shared
  `shared/app-callback.ts` and is now reused by the C23 MCP tool dispatch — one address resolver for both
  sidecar→app callbacks. No behavior change to the scheduler.

## [0.34.0] — 2026-07-10

### Added
- **C29 — the deterministic authorization / policy engine.** A generic, product-agnostic decision
  capability: given an actor + an action + the app's policies it returns
  `{ decision: 'allow' | 'needs-approval' | 'deny', rule, reason, high_risk, action_class }`.
  **Fully deterministic — no model calls, no I/O in the decision core** (`src/authz/authorize.ts`):
  same inputs always yield the same decision, and it names the rule that governed it. Precedence is
  **deny-overrides → non-overridable safety floor → highest-priority matching allow/needs-approval →
  default posture**.
- **Non-overridable safety floor.** High-risk action classes — external message sends (email/sms/push/
  webhook/call), spending money, contacting a new/unknown recipient, and irreversible actions — ALWAYS
  return `needs-approval` regardless of any policy (a rule can never downgrade a high-risk action to
  auto-allow; only a matching `deny` is stricter). The high-risk class-set is **configurable by the app**
  (`AuthorizeOptions.highRiskClasses`), but "always stage" itself is non-overridable.
- **Structured policy rules over many dimensions.** A `PolicyRule` matches on tool, action type, contact,
  domain, channel, project, location, device, data sensitivity, reversibility, actor role, a monetary
  ceiling (`max_amount`), and a time window (UTC days + start/end) — conditions ANDed, an empty match =
  matches all. Rules carry `effect` + `priority` and the O4 `(owner, group_id, visibility)` scope.
- **Policy store — a new pluggable P26 store domain.** `PolicyBackend` behind the same interface as the
  other stores: **filesystem default**, `FORGE_POLICY_BACKEND=postgres` opt-in (one `jsonb` row per
  `(app_id, id)` in `forge_policies`, O4 columns projected + indexed on `(app_id, owner)`), a
  `DualWrite` impl (`FORGE_POLICY_DUAL_WRITE=1`) + `forge storage migrate --store policies`. CRUD surface;
  the `test-postgres` CI job now also runs policies on Postgres (via the shared pg vitest env).
- **The consume contract — two-plane HTTP/CLI + a mirrorable core.** `POST /authorize` (loads the
  actor's policies, evaluates, and **records the decision to the C3 audit trail** as `authz.decision`,
  owner-scoped, keyed by `action_class`); `GET/POST /policies`, `GET/DELETE /policies/:id` for policy
  management. `authorize()` itself is exported as a **pure, mirrorable function** (like `shared/session.ts`
  / `shared/health.ts`) — a consumer can evaluate locally or call the plane. CLI: `forge policy list/set/delete`.
- **Progressive autonomy (mechanism, not UX).** `POST /authz/approvals` records an approval to C3; 
  `GET /authz/approvals?owner=&action_class=&threshold=` surfaces "this action class was approved N times"
  with a `suggest_policy` flag at the threshold — the raw signal a consumer's UX turns into a "always
  allow this?" prompt. The platform ships the count; the app owns the plain-language authoring UX.

## [0.33.0] — 2026-07-10

### Added
- **P26 (increment 6) — C5 secrets vault + the generic Resource store on Postgres (transactional).**
  Two `SecretsBackend` + `ResourceBackend` implementations behind the pluggable interface:
  filesystem (default) and Postgres. **Secrets:** one SEALED row per (app, name) in `forge_secrets`
  (still AES-256-GCM at rest — the row holds ciphertext, never plaintext; sealing/opening stays in the
  facade under the master key). **Resources:** one `jsonb` row per resource in `forge_resources`
  (PK `(type, id)`; the full object round-trips via `data`, with type/id/app_id/owner/timestamps
  projected into indexed columns). Config-selected (`FORGE_SECRETS_BACKEND`/`FORGE_RESOURCES_BACKEND=postgres`
  or `FORGE_STORE_BACKEND=postgres`; filesystem stays default), sharing the pool + `FORGE_DB_URL`.
- **Contract-stable.** `forge secrets set/unset/list` + the C1/C10/C12 runtime injection, and the whole
  `store` resource surface (`saveResource`/`getResource`/`deleteResource`/`findResourceById`/
  `listResources`/`assignResourceOwner`/`findAppByName`) + the `/resources` routes + `inspect` + the
  `AgentTask`/`Artifact`/`ScheduledJob`/`Deployment`/`EmailDelivery`/`Verification` shapes — all
  unchanged. The five secrets + seven resource methods forward to the configured backend; the SAME
  store + route suite (every capability that seeds an Application) passes on both backends.
- **O4 scope baked in.** `forge_resources` carries `group_id` + `visibility` (default `private`), so
  owner-scoped resources (C1 agent-runs) extend to group scoping (C31) with no second migration. Active
  C11 owner-scoping (owner-scoped list, `claim-legacy`) is unchanged.
- **Migration + backfill.** `forge storage migrate --store secrets` moves the sealed vault verbatim;
  `--store resources` copies every resource with ids preserved. `DualWriteSecretsBackend` /
  `DualWriteResourceBackend` (`FORGE_SECRETS_DUAL_WRITE=1` / `FORGE_RESOURCES_DUAL_WRITE=1`) for a
  reversible cutover. The `test-postgres` CI job now runs identity/search/events/notifications/**secrets**/
  **resources** on Postgres (+ blobs on MinIO); new `tests/pg-secrets.test.ts` + `tests/pg-resources.test.ts`.

### Fixed
- **P27 fully CLOSED — no unguarded read-modify-write / torn write remains in any platform store.** The
  two stores flagged in `docs/architecture/07-data-storage.md` §5 are now safe on BOTH backends: the C5
  secrets vault (FS: per-app mutex + atomic temp+rename; PG: single-row upsert) and the generic Resource
  store (FS: atomic temp+rename on save; PG: transactional upsert). Proven by concurrency tests that fire
  40 concurrent distinct-key writes and lose none.
- **Blob upload hard-ceiling guard wired.** `HARD_FILE_CEILING` (2 GB) in `blobs-routes.ts` was declared
  but never applied (dead since C20 shipped). It is now the busboy `fileSize` limit as
  `min(configured, ceiling)` — so a misconfigured (absurdly high) `FORGE_BLOB_MAX_BYTES` can no longer
  buffer an unbounded upload; the default 15 MB behavior is unchanged.

## [0.32.0] — 2026-07-10

### Added
- **P26 (increment 5) — C20 blobs on an object store (S3/MinIO) + metadata in Postgres.** The first
  store whose BYTES move off the filesystem. A pluggable `BlobBackend` interface with two
  implementations: `filesystem` (bytes on the `forge_state` volume + metadata in a JSON map, the legacy
  default) and `s3` (**bytes in an S3-compatible object store, metadata in a `forge_blobs` Postgres
  table**). Config-selected: `FORGE_BLOBS_BACKEND=s3` (or `FORGE_STORE_BACKEND=postgres`) +
  `FORGE_S3_ENDPOINT`/`FORGE_S3_BUCKET`/`FORGE_S3_ACCESS_KEY`/`FORGE_S3_SECRET_KEY`/`FORGE_S3_REGION` +
  `FORGE_DB_URL`. The bucket is ensured at boot (fail-fast).
- **A zero-dependency S3 client.** AWS Signature V4 (path-style) implemented on native `crypto` + `fetch`
  (`src/storage/backends/blobs/s3-client.ts`) — no SDK, so the slim data-plane image stays clean and
  multi-arch. It targets **MinIO** (dev/test) and AWS S3 (prod) identically, and preserves the C20
  contract's **native ranged reads** (a Range `GetObject` streamed to the response) + ETag (still derived
  from the metadata checksum).
- **Contract-stable.** `POST /blobs` (multipart→`blob_id`), `GET /blobs/:id?owner=` (Range/ETag/304),
  `DELETE /blobs/:id`, `GET /blobs` — payloads + owner-scoping + magic-byte/allowlist/size/quota checks
  are unchanged. `blobs-routes.ts` now streams through the configured backend (`openRange` replaces the
  filesystem `createReadStream`); the same store + route suite passes on **both** backends (filesystem
  and s3+postgres). The per-owner access + quota checks are driven off the metadata table.
- **O4 scope baked in.** `forge_blobs` carries `group_id` + `visibility` (default `private`) — same model
  as the other stores — so group-shared files (households / C31) light up with no second migration.
- **Blob migration + backfill.** `forge storage migrate --store blobs` copies each app's bytes into the
  object store and metadata into Postgres with the **`blob_id` preserved** (the app's stored handle keeps
  working); a `DualWriteBlobBackend` (`FORGE_BLOBS_DUAL_WRITE=1`) reads S3+Postgres while mirroring bytes
  + metadata to the filesystem for a reversible cutover. Commit is atomic: a metadata-write failure rolls
  back the just-PUT object (no orphan).
- **CI covers blobs on the object store.** The `test-postgres` job now also stands up **MinIO**;
  `tests/pg-blobs.test.ts` asserts bytes really land in the bucket, metadata + O4 columns in Postgres,
  the rollback path, ranged reads, and id/bytes-preserving backfill.

## [0.31.0] — 2026-07-10

### Added
- **P26 (increment 4) — C4 notifications on Postgres.** A `PgNotificationBackend` behind the pluggable
  `NotificationBackend` interface: keyed durable state in a table `forge_notifications` (PK
  `(app_id, owner, key)`). Upsert is one **`INSERT … ON CONFLICT (app_id, owner, key) DO UPDATE`** — **no
  whole-map read-modify-write** (preserving `dismissed` + `created_at`); dismiss/clear are targeted
  `UPDATE`/`DELETE`; the list is an indexed read (`(app_id, owner, created_at DESC)`). So concurrent
  mutations to distinct keys can't lose an update — the **P5/P27 lost-update race is gone by
  construction**, no application lock. Config-selected (`FORGE_NOTIFICATIONS_BACKEND=postgres`;
  filesystem stays default), sharing the same pool + `FORGE_DB_URL`.
- **Contract-stable.** `POST /notifications`, `/notifications/dismiss`, `/notifications/clear`, and
  `GET /notifications` payloads + owner-scoping (C11, incl. `claim-legacy`) are unchanged — the five
  `store` notification methods now forward to the configured backend, and the SAME store + route + P5
  concurrency suite passes on both backends. Legacy/app-scoped (owner-less) records use an empty-string
  owner sentinel so a NULL doesn't defeat the `(app, owner, key)` uniqueness (owner-less re-derive stays
  idempotent).
- **O4 scope baked in.** `group_id` + `visibility` (default `private`) columns — same model as
  identity/search/events — so group-shared inboxes (households / C31) light up with **no second
  migration**. Active C4 owner-scoping unchanged.
- **Notifications migration + backfill.** `forge storage migrate --store notifications` copies each app's
  keyed map into Postgres verbatim (owner/key/dismissed/created_at preserved); a
  `DualWriteNotificationBackend` (`FORGE_NOTIFICATIONS_DUAL_WRITE=1`) reads Postgres while mirroring to
  the filesystem for a reversible cutover.
- **CI covers notifications on Postgres.** The `test-postgres` job now runs the suite with identity,
  search, events, AND notifications on Postgres; `tests/pg-notifications.test.ts` adds Postgres-specific
  coverage (ON-CONFLICT upsert preserving dismissed/created_at, the owner sentinel + O4 columns, native
  concurrency with 50 distinct-key upserts, and backfill parity).

### Removed
- **Dead code the facade refactors left behind.** Trimmed now-unused imports from
  `src/storage/store.ts` — `rename`, `appEventsDir`, `appEventsFile`, `notificationsDir`,
  `notificationsFile`, `newId` — and the private notification helpers (`notifLocks`, `withNotifLock`,
  `readNotifications`, `notifStorageKey`, `writeNotifications`) now that C3 events + C4 notifications live
  in their backends.

## [0.30.0] — 2026-07-10

### Added
- **P26 (increment 3) — C3 events/timeline on Postgres (the highest-write store).** A `PgEventBackend`
  behind the pluggable `EventBackend` interface: an **append table** (`forge_app_events`) with B-tree
  indexes on `(app_id, owner, at)` and `(app_id, subject)`. The per-(app, owner) feed is an indexed
  range read (newest-first), and **"latest time per subject" is a single `DISTINCT ON`** — no more
  whole-file scan-and-parse. A monotonic `seq` (IDENTITY) preserves append order as the deterministic
  newest-first tiebreak, so events sharing an `at` millisecond keep insertion order exactly like the
  JSONL backend; timestamps (`at`) are stored **verbatim** and ids are preserved. Config-selected
  (`FORGE_EVENTS_BACKEND=postgres`; filesystem stays the default), sharing the same pool + `FORGE_DB_URL`.
- **Contract-stable.** `POST /app-events`, `GET /app-events?owner=&subject=&limit=`,
  `GET /app-events/latest`, and the control-plane `inspect app-events` payloads + owner-scoping (C11,
  incl. the `claim-legacy` migration) are unchanged — the four `store` app-event methods now forward to
  the configured backend, and the SAME store + route suite passes on both backends.
- **O4 scope baked in.** The events schema carries `group_id` + `visibility` (default `private`), the
  same ownership model as identity/search, so group-shared timelines (households / C31) light up with
  **no second migration**. The active C3 owner-scoping (owner-scoped read = that owner's events;
  owner-less read = app-scoped) is unchanged.
- **Events migration + backfill.** `forge storage migrate --store events` copies each app's JSONL log
  into Postgres **oldest-first**, preserving ids, timestamps, AND append order (the app never re-emits);
  a `DualWriteEventBackend` (`FORGE_EVENTS_DUAL_WRITE=1`) reads Postgres while faithfully mirroring each
  append (O(1), no whole-log rewrite) to the filesystem for a reversible cutover.
- **CI covers events on Postgres.** The `test-postgres` job now runs the suite with identity, search,
  AND events on Postgres; `tests/pg-events.test.ts` adds Postgres-specific coverage (the B-tree indexes,
  the `DISTINCT ON` latest-per-subject, the same-millisecond append-order tiebreak, verbatim timestamps,
  the O4 columns, and id/timestamp/order-preserving backfill).

## [0.29.0] — 2026-07-10

### Added
- **P26 (increment 2) — C19 search on Postgres full-text (a real inverted index).** A `PgSearchBackend`
  behind the pluggable `SearchBackend` interface: a `tsvector` (title **A** / tags **B** / body **C** via
  `setweight`, maintained by a trigger) indexed with **GIN**, queried with `websearch_to_tsquery` +
  `ts_rank`. This **eliminates the filesystem backend's O(owned-docs) in-memory BM25 rescan** — a search
  is now a GIN-indexed lookup. Config-selected (`FORGE_SEARCH_BACKEND=postgres`; filesystem stays the
  default), sharing the same pool + `FORGE_DB_URL` as identity. Contract-stable: `/index`, `/index/delete`,
  `/reindex`, `/search` payloads + owner-scoping are unchanged — `src/storage/search-store.ts` is now a
  forwarding facade, and the SAME store + route suite passes on both backends.
- **Owner-scoping via the O4 `(owner, group_id, visibility)` model.** The search schema carries
  `group_id` + `visibility` (default `private`); every search is `WHERE owner = <caller> AND visibility =
  'private'` — the same scope model as identity, with the columns baked in + defaulted so group-shared
  results (households / C31) light up with **no second migration**.
- **Snippet security parity on Postgres.** `ts_headline` marks matches with sentinels; the backend then
  HTML-escapes the snippet and reveals the marks as `<mark>` — so raw HTML in document content can never
  reach the rendered snippet (matching the FS ranker's escaping), while matches still highlight.
- **Search migration + backfill.** `forge storage migrate --store search` copies each app's filesystem
  index into Postgres with `(owner, type, id)` keys preserved (no app re-index needed); a
  `DualWriteSearchBackend` (`FORGE_SEARCH_DUAL_WRITE=1`) reads Postgres while mirroring writes to the
  filesystem for a reversible cutover.
- **CI covers search on Postgres.** The `test-postgres` job now runs the suite with BOTH
  `FORGE_IDENTITY_BACKEND` and `FORGE_SEARCH_BACKEND` on Postgres; `tests/pg-search.test.ts` adds
  Postgres-specific coverage (the GIN index is present + used, the O4 scope `WHERE`, snippet escaping,
  and id-preserving backfill parity).

## [0.28.0] — 2026-07-10

### Added
- **P26 (increment 1) — a pluggable store-backend seam + C10 identity/sessions on Postgres.** Forge's
  own platform state is no longer filesystem-only. A per-domain backend interface
  (`src/storage/backends/identity/types.ts` → `IdentityBackend`) now has TWO implementations selected
  by config — `filesystem` (the default; the legacy JSON-doc store, unchanged) and `postgres`
  (transactional, multi-replica-safe). Selection: `FORGE_STORE_BACKEND` (global default) +
  per-domain `FORGE_IDENTITY_BACKEND` + `FORGE_DB_URL`, wired once by a `makeBackends(cfg)` factory at
  the composition root (`src/storage/backends/index.ts`). The C10 hosted-auth routes, `inspect`, and
  the whole test suite are **contract-stable** — `plugins/auth-identity/store.ts` is now a thin facade
  forwarding to the configured backend, with identical exported signatures.
- **The `(owner, group_id, visibility)` ownership model, baked in now (O4).** The Postgres identity
  schema carries `groups` + `group_members`; creating a user also creates a personal **group-of-one**
  + an owner membership in the same transaction, and exposes `getUserScope()` — so multi-member
  households (C31) light up later with **no second migration**. `StoredUser` gains an optional
  `personal_group_id`.
- **The data-plane sidecar is datastore-aware.** Both servers initialize the backends eagerly at boot
  (`getBackends()`): a Postgres backend opens a small pooled connection + ensures the schema, and the
  boot **fail-fasts** with a clear message if `FORGE_DB_URL` is missing or the DB is unreachable
  (verified). `productionize`/`provision` wire a **separate `forge_platform` database + a
  least-privilege role** (co-located on the app's Postgres by default, or a dedicated instance when the
  app has no DB): `forge provision --platform-store postgres` (remembered convergently in the
  manifest), and `productionize` emits the sidecar `FORGE_DB_URL`, the `forge_platform` init script
  (`forge-platform-init.sh`), the `depends_on: postgres`, and the documented `FORGE_PLATFORM_DB_PASSWORD`
  in `.env.prod.example`.
- **Backfill + migration mechanism.** `forge storage migrate --store identity` copies each app's
  filesystem identity state into Postgres with **ids preserved** (live cookies/sessions stay valid),
  the first step of backfill → dual-write → cutover. A `DualWriteIdentityBackend`
  (`FORGE_IDENTITY_DUAL_WRITE=1`) reads Postgres while mirroring writes back to the filesystem, so an
  operator can roll a bad cutover back with no data loss.
- **Both backends are proven green in CI.** A new `test-postgres` job runs the SAME suite against a
  Postgres service (`npm run test:pg`), and `tests/pg-identity.test.ts` adds Postgres-specific coverage
  (password/token hashing in the DB, the O4 group-of-one, backfill parity, and a P27 concurrent-rotation
  race that yields exactly one success).

### Fixed
- **P27 — the unguarded read-modify-write on the identity store is eliminated on the Postgres backend.**
  Every identity mutation runs in ONE transaction (refresh-token rotation locks the row `FOR UPDATE`;
  single-use token consume is one conditional `UPDATE … RETURNING`), so the lost-update / rotation race
  is structurally impossible — no application-level lock needed. (The filesystem backend keeps its
  existing per-app mutex + atomic temp+rename.)

### Changed
- `plugins/auth-identity/store.ts` is now a forwarding facade over the pluggable backend (no behavior
  change on the filesystem default). Adds the `pg` runtime dependency (pure JS — stays multi-arch and
  ships in the slim data-plane image).

## [0.27.0] — 2026-07-10

### Fixed
- **P28 — `forge verify` / `forge release` no longer false-red on a start-first roll's warm-up window
  (the "C19-deploy flake").** A C7 start-first deploy returns as soon as the NEW replica reports
  container-healthy, but the public endpoint can still be a beat behind — the reverse proxy re-pointing
  at the fresh replica, the app finishing its own warm-up. A post-deploy `forge verify` — including the
  one `forge release` runs as its final gate — probing in that instant saw a transient miss (an
  unreachable dial, a proxy 502, a half-booted non-conforming body) and reported a red, even though a
  manual re-run a few seconds later passed. `verify`/`release` now poll the C6 health endpoint with a
  bounded, backed-off retry until it answers a clean 200 **before** asserting, so the deploy→verify
  handoff can't race the roll into a false failure. It **never turns a real failure green**: if the app
  never warms up, the wait simply ends and the normal health assertion runs and fails. (New
  `waitForHealthReady` in `src/shared/health-probe.ts`, wired through `src/shared/contract-checks.ts`,
  C14 `verify`, C18 `release`, and the CLI.)

### Added
- **P28 — a post-deploy warm-up readiness gate (opt-in inputs + the `waitForHealthReady` primitive).**
  `verify` gains `readiness_timeout_ms` (default `0` — off, since a standalone `forge verify` runs after
  a deploy has settled) + `readiness_interval_ms`; `release` gains `verify_readiness_timeout_ms` (default
  `30000` — on for its deploy→verify handoff) + `verify_readiness_interval_ms`; and the CLI gains
  `forge verify --readiness-timeout-ms/--readiness-interval-ms` and `forge release
  --verify-readiness-timeout-ms`. Backward-compatible — unset keeps the prior immediate-assert behavior.
  Deterministic coverage in `tests/readiness-wait.test.ts` (injectable clock/sleep exercise the first-200
  fast path, backoff through transient misses, budget/no-overrun on timeout, the `timeoutMs<=0` no-op,
  and the `verify`/`release` wiring).
- **Platform architecture reference (`docs/architecture/`).** Authoritative, product-agnostic
  developer documentation of the shipped architecture — the control-plane vs data-plane image
  split, the production sidecar model, the deployed runtime topology (Traefik ingress, the
  `internal`/`proxy` networks, the `forge_state` volume), runtime call-path sequence diagrams for
  every data-plane capability (events, scheduler, agent, secrets, search, blobs, auth/session), a
  capability catalog mapping each `Cn` to its plane + consumption mechanism, the app adoption model,
  and a clearly-marked *PROPOSED, not yet built* extension-points section (remote MCP + OAuth 2.1
  AS, outbound connector vault, inbound email, webhook ingestion, native push, policy engine,
  multi-member identity, eval harness). Mermaid diagrams throughout. Docs-only — no image or
  capability version change. `docs/architecture/README.md` indexes the set.
- **Data-storage reference (`docs/architecture/07-data-storage.md`).** A rigorous, code-verified,
  de-abstracted account of every backing store: the exact per-capability on-disk layout on the
  `forge_state` volume (path / format / write model per capability); the truth about C19 search
  (a pure in-TypeScript BM25(F)-lite ranker over a per-app JSON document map — no Solr/ES/Redis, no
  persistent inverted index); the store-interface reality (a method-surface seam only — the
  Postgres/S3 swap is planned, not implemented; no pluggable-backend interface exists today);
  confirmation that no Forge capability uses Postgres/Redis (those are app-only, provisioned-only);
  and per-store atomicity/concurrency/durability — flagging that the C5 secrets vault and the
  generic Resource store are unguarded read-modify-write / plain-overwrite, unlike the mutex +
  atomic-rename engine stores (C4/C10/C15/C19/C20). Includes an un-abstracted storage diagram.
- **Storage-strategy proposal (`docs/architecture/08-storage-strategy.md`).** A design-only proposal
  (no code changed) to harden the single-node filesystem before a production-ambition consumer builds
  on it: a real pluggable store-backend seam (semantic backend interface per store domain, selected by
  config, with filesystem / Postgres / object-store implementations, capability code unchanged);
  per-capability backend recommendations with justification (Postgres for C10 identity, C11/C29 authz,
  C3 events, C4 notifications, C15; object-store for C20 blob bytes; Postgres FTS for C19 search;
  filesystem stays for C16 theme); the C19 search recommendation (Postgres tsvector/GIN over a
  dedicated engine, with the tie-breakers); making the data-plane sidecar datastore-aware
  (`FORGE_DB_URL`, pooling, a separate `forge_platform` DB/role vs. the app DB, `forge provision`/
  `productionize` wiring); folding in the P27 unguarded-store fix; and a contract-stable migration
  sequence (identity + search first; backfill → dual-write → cutover). Honest about what it does not
  solve (the sidecar SPOF, scheduler single-runner, Postgres as the new HA dependency).

## [0.26.5] — 2026-07-09

### Fixed
- **P25 — an operator could not declare a status incident on a box provisioned via
  `forge deploy`/`productionize` (a store-less box), because `forge status incident
  create/update/resolve/list` resolved the app the STRICT way and 404'd `not_found` even with
  `FORGE_APP_NAME` set.** The operator write surface (`src/api/incident-routes.ts`) resolved
  `--app`/`FORGE_APP_NAME` via `store.findAppByName` — the strict lookup that requires an
  Application record from `forge init app`. On a real production host that record never exists
  (the box only ever ran `forge deploy`/`productionize`), so `forge status incident create --app
  forge-os` returned `{"error":{"code":"not_found","message":"unknown app (pass app or set
  FORGE_APP_NAME)."}}` — the **exact P19 store-less condition** that `forge release`/`deploy`/
  `verify` were already immune to via `resolveAppLenient`, but which the `status incident` family
  was never switched to. It now resolves through the SAME store-optional `resolveAppLenient`: a
  store-registered Application still wins (its id links the `/status` render + the emitted
  `Incident*` facts), else the app is inferred from the single-app layout + the committed
  `app/forge.app.json`, exactly like `forge release`. `--app`/`FORGE_APP_NAME` are still honored,
  and a genuinely unresolvable app (no store record AND no readable `app/forge.app.json`) still
  cleanly 404s. The incident store is unchanged — it was already the ONE data-plane-resident
  `forge_state` incident store the public `/status` + `/status.json` render from (the data plane
  keys both the write and the read by the same app id its boot `ensureApp` registers; a store-less
  box keys by the app name), so no second store was introduced and none was needed — the only
  defect was the strict app resolution on the write path.
  (`src/api/incident-routes.ts` → `resolveAppKey` wraps `resolveAppLenient` and keys the store by
  `id ?? name`.)

### Added
- **P25 guard — store-less incident-resolution tests in `tests/incidents.test.ts`.** With an EMPTY
  Application store and only `app/forge.app.json` present (the box condition), `forge status
  incident create`/`list`/`resolve` now succeed (previously `not_found`), the created incident
  round-trips through the same `incidentStore` the `/status` render reads, `FORGE_APP_NAME` is
  honored when `--app` is omitted, and a truly unresolvable app still 404s.

## [0.26.4] — 2026-07-09

### Fixed
- **P23 — `forge release` polled GHCR for an image tag the app's publish workflow never creates
  (full-SHA vs. short-SHA), so every real release timed out its whole `--timeout` and never rolled.**
  With P22's fetch-timeout fixed, the publish phase (ci mode) correctly WAITED — and surfaced the true
  bug: it derived the poll tag from the **FULL 40-char** git SHA (`git rev-parse HEAD`), e.g.
  `ghcr.io/<owner>/<app>-app:sha-dae6c6a14afedc315f43823c6700e3b8f7e53ad8`, but the app's standard publish
  workflow (GitHub Actions `docker/metadata-action` with `type=sha`) tags the image with the **SHORT
  7-char** SHA — `…:sha-dae6c6a` (the `format=short` default is `${GITHUB_SHA:0:7}`). The full-SHA tag
  never exists, so `waitForDigest` polled a tag that would NEVER appear and failed `publish` after the
  full 600s budget — silently blocking **every** production release. `forge release` now derives the poll
  tag from the **short** SHA (matching what the workflow publishes) while keeping the **full** SHA for git
  operations + the `Release` resource id. **Made robust against this class of drift:** assess and the
  publish poll now try **both** `sha-<short>` and `sha-<full>` and resolve against whichever the registry
  actually has (short first, since that is the standard workflow's output); `--image-ref` / `--image-suffix`
  / `--owner` / `--registry` overrides still flow through unchanged. The final digest pin is tag-stripped
  (`<repo>@sha256:…`), so which tag won never affects the deployed pin.
  (`src/plugins/release-orchestrator/plan.ts` → `shortSha` + `candidateImageRefs`;
  `src/plugins/release-orchestrator/ghcr.ts` → `resolveAnyDigest` + `waitForAnyDigest`;
  `src/capabilities/release/index.ts` assess/publish wired to the candidate list.)
  NOTE: Forge does **not** generate the app's publish workflow (that lives in the app repo — forge-starter /
  forge-os own their `.github/workflows`), so there is no forge-side generator to share a helper with; the
  fix aligns release with the standard `docker/metadata-action` `type=sha` short-SHA convention and hardens
  it with the short/full dual-tag probe.

### Added
- **P23 guard — short-SHA publish-resolution tests in `tests/release-plan.test.ts`.** Locks in the
  derivation + robustness with the exact production condition: `shortSha` returns the first 7 chars (not
  `git rev-parse --short`'s minimum-unique abbreviation); `candidateImageRefs` puts `sha-<short>` first with
  `sha-<full>` as a fallback (honoring overrides, deduping a ≤7-char commit); and `resolveAnyDigest` /
  `waitForAnyDigest`, driven by a per-ref docker fake where **only** `sha-<short>` exists and `sha-<full>`
  is 404, resolve the short-SHA image (and still resolve via the full tag when only that exists) — proving
  the release no longer wedges on the timeout, plus a timeout error that names every candidate.

## [0.26.3] — 2026-07-09

### Fixed
- **P22 — a real `forge release` reported `Cannot reach Forge API` while `--dry-run` reached it fine
  (client-side headers-timeout on the long-running request).** `forge release` is the platform's one
  LONG-RUNNING capability: the CLI issues a single blocking `POST /capabilities/release` and the request
  stays open while the server does real work — publish POLLS GHCR for the commit's image up to `--timeout`
  (default **600s**), then repin → deploy → verify. Node's global `fetch` (undici) applies a **default
  `headersTimeout`/`bodyTimeout` of 300s** to every request, so on a box where the wait is real (the
  commit's image is not yet resolvable in the registry) the server can't send response headers within 300s
  and undici **aborts the fetch with `UND_ERR_HEADERS_TIMEOUT`** — which the CLI's `api()` catch surfaces as
  `{"error":{"message":"Cannot reach Forge API at http://127.0.0.1:3717 …"},"details":"TypeError: fetch
  failed"}`, even though the API is healthy (plain `node` and the dry-run both reach it). `--dry-run`
  assesses + prints the plan and returns in ~1s, so it **never approaches the ceiling** — that wait-time gap
  is the entire dry-vs-real divergence, and why the failure is box-specific (a box where the image is
  already published skips the publish poll and finishes fast). The CLI now sends a long-running capability
  request through a dispatcher with `headersTimeout`/`bodyTimeout` **= 0** (unlimited), so it waits exactly
  as long as the server legitimately needs (the server keeps its OWN bounded budget via `--timeout`). Same
  `resolveApiBaseUrl` (127.0.0.1), same global `fetch`, no alternate client and no global-dispatcher swap —
  **dry-run and real now use a byte-for-byte identical connection**, the only difference being the request
  body's `dry_run` flag (`src/cli/api-base.ts` → `longRunningDispatcher`, wired into `api()` in
  `src/cli/index.ts`).

### Added
- **P22 guard — `tests/cli-release-longrunning.test.ts`.** Reproduces the exact abort: a deliberately
  slow-to-respond server trips a short client headers timeout with `TypeError: fetch failed` (the production
  symptom), while the shared `longRunningDispatcher` lets the SAME slow response through; also asserts the
  dispatcher disables both timeouts and that dry-run and real dial the same `resolveApiBaseUrl` release
  endpoint through the same dispatcher (no alternate-client / global-dispatcher divergence).

## [0.26.2] — 2026-07-09

### Changed
- **P21 — the control-plane image build is now reproducible (installs from the committed lockfile).**
  The control-plane `Dockerfile` used to `COPY package.json` (only) and run `npm install`, which
  **ignores `package-lock.json`** — so every image build resolved dependencies **fresh** and could drift
  onto a different (newer, possibly broken) transitive version than the audited lockfile that source +
  CI test. That is the one and only structural *"works from source, fails in the built image"* gap
  (the reported P21 shape: `:0.26.1` container `Running` but its API never reachable at `:3717`, while
  the same code served fine from `tsx src/api/server.ts`). It now `COPY`s `package-lock.json` and runs
  `npm ci` (all deps — the control plane keeps its `tsx`/`tsc`/`vitest` toolchain; `|| npm install`
  fallback if the lock is ever momentarily out of sync), matching the data-plane image, so the image's
  dependency tree is **byte-identical to source**. NOTE: the exact not-serving symptom could **not** be
  reproduced from Forge alone — the published `:0.26.1` (amd64 + arm64), a HEAD build, a fresh lockless
  install, and `--omit=dev` all bind `:3717` and answer `/health` 200 on a clean host (incl. under
  128 MB / 0.25 CPU); this change removes the non-determinism that is the most likely real cause and the
  guards below turn the whole class into a failing check.

### Added
- **P21 guard (static) — `tests/runtime-deps.test.ts`.** Asserts every external package imported by
  `src/**` is declared in `dependencies` (not merely a `devDependency` or a transitive that the dev tree
  happens to have). This is the exact failure class it guards: a route that `import`s a package which is
  present in dev but **dropped by the slim `--omit=dev` data-plane image** would throw at import before
  the server could `.listen()`. Parsed with the TypeScript compiler, so specifiers that appear only
  inside string literals (e.g. the scaffold plugin's Next.js code templates) are correctly ignored.
- **P21 guard (runtime) — `tests/smoke/image-serves.sh` + the `image-smoke` CI job.** Builds the
  control-plane **and** data-plane images the way they actually ship and probes each container's
  in-container `/health`, asserting HTTP 200 — the check a source-only test can never make. Now runs on
  every PR / push to `main`, so *"the built image doesn't serve"* fails CI instead of a production host.

## [0.26.1] — 2026-07-09

### Fixed
- **P20 — `forge release` could not reach a healthy control-plane API (IPv4/IPv6 loopback mismatch).**
  The CLI runs in-container (the `./forge` wrapper `docker compose exec … src/cli/index.ts`) and dialed
  the co-located API by the name `localhost`. The API binds IPv4 `0.0.0.0`, but on the base image
  `localhost` resolves to IPv6 `::1` **first** (`getent hosts localhost` → `::1  localhost …`), and Node 22
  keeps DNS results in resolver order by default. So `fetch('http://localhost:3717')` dialed `[::1]:3717`,
  which the IPv4-only server refuses (ECONNREFUSED); Happy-Eyeballs' IPv4 fallback did not fire within the
  release fetch's window, so `forge release` reported `Cannot reach Forge API at http://localhost:3717 …`
  even though the API was up. The CLI now dials the **IPv4 loopback literal `127.0.0.1`** for the local
  control plane — both the code default (`src/cli/api-base.ts` → `resolveApiBaseUrl`) and the `./forge`
  wrapper's `FORGE_API_URL` / boot-probe — matching the `0.0.0.0` bind with no `::1` detour and no reliance
  on fallback. The server bind is unchanged (IPv4 `0.0.0.0`); `127.0.0.1` + `0.0.0.0` is the clean,
  guaranteed-matching pair. Regression origin: the client host has been `localhost` since the first commit
  — nothing in Forge code changed it between 0.23.0 and 0.24.1; the regression was environmental (base-image
  loopback ordering under Node's `verbatim` DNS), which the literal-IPv4 dial removes the dependency on.

## [0.26.0] — 2026-07-09

### Added
- **C20 — File / blob storage.** A generic, per-app, owner-scoped blob store. An app uploads a user's
  file (avatar, attachment, export, …), gets back an opaque `blob_id`, and later streams the bytes back —
  reached server-side the same way the app reaches the C3 app-event log / C4 notifications / C19 search
  (base URL via `FORGE_EVENTS_URL`; the `app` field defaults to the sidecar's `FORGE_APP_NAME`). The
  endpoints are **data-plane**, registered on BOTH the control-plane API (dev) and the data-plane sidecar
  (prod), like app-events/notifications/search:
  - `POST /blobs` — **app-proxied multipart upload** (`multipart/form-data`: a `file` part + fields
    `{ app?, owner (required), content_type, filename?, attrs? }`) → `201 { blob_id, content_type, size,
    checksum (sha256), filename?, created_at }`. The upload is **streamed** (never buffered whole) through
    an incremental hash + size counter into a durable temp file.
  - `GET /blobs/:id?owner=<userId>` — streams the bytes with `Content-Type`, `Content-Length`, an
    `ETag` (the sha256), `Cache-Control`, and `Accept-Ranges`; supports a single **Range** request (206 /
    416) and conditional `If-None-Match` (304).
  - `DELETE /blobs/:id?owner=` — owner-scoped, removes bytes + metadata; **204** on success, **404** if
    absent/already-gone/not-owner (idempotent by effect).
  - `GET /blobs?owner=` — the owner's blobs (newest-first) + a `usage` readout `{ bytes, count,
    quota_bytes, quota_objects }`.
- **Owner-scoping is structural (mandatory).** Every blob is stamped with `owner` on upload; the metadata
  store is keyed by `(owner, blob_id)`, so a `get`/`delete`/`list` for one owner can only ever name records
  in that owner's slice — a blob owned by someone else is therefore **404, absent, never 403** (the
  "absent not forbidden" rule). The consuming app fronts these with its own auth-checked route; Forge
  enforces owner on the raw GET/DELETE as defense-in-depth. Trust model is app-asserted (the private
  data-plane trusts the verified `owner` the app sends, exactly as C3/C4/C1/C19 do); no per-user token
  scheme.
- **Content allowlist + magic-byte sniffing (security).** Only allowlisted types are accepted
  (`image/png` · `image/jpeg` · `image/webp` · `image/gif` · `application/pdf` · `text/plain` ·
  `text/markdown`, configurable via `FORGE_BLOB_ALLOWED_TYPES`); the declared `content_type` is validated
  against the actual leading bytes, so a spoofed header (declaring `image/png` while sending a PDF, or
  `text/plain` while sending a PNG) is rejected **415**, not stored.
- **Per-file + per-owner limits.** Configurable max file size (`FORGE_BLOB_MAX_BYTES`, default **15 MB**)
  and per-owner quota (`FORGE_BLOB_QUOTA_BYTES`, default **500 MB**, and `FORGE_BLOB_QUOTA_OBJECTS`,
  default **1000**). **Upload is NOT best-effort** (the app needs the `blob_id`), so it surfaces real
  errors: file too large → **413**; disallowed type / magic-byte mismatch → **415**; owner byte quota →
  **413**; owner object quota → **409**; missing owner → **422**; client abort mid-stream → **400** with
  **nothing persisted**; disk-full/IO → **507/503**; not-found/not-owner → **404**.
- **Durable, atomic backend — no new dependency.** Metadata is one JSON doc per app (a keyed map,
  atomic temp-and-rename, per-app mutex) and the bytes are one opaque file per blob, both on the SAME
  durable state volume the data-plane already uses (`FORGE_STATE_DIR`, e.g. `/forge-state` on the
  `forge_state` named volume) — so uploads survive a redeploy like C10 auth / C5 secrets. Writes are
  atomic: a fully-streamed temp file is quota-checked and only then moved into place + recorded (or fully
  cleaned up), so a failed or aborted upload never orphans bytes. An object store (S3/MinIO) is a
  documented scale-out swap behind the SAME API — the app only ever sees the `blob_id`. The optional
  presigned-URL / signed-URL direct paths are documented generic alternatives; C20 ships the multipart
  proxy + owner-scoped serve first.

### Changed
- The control-plane API and the data-plane sidecar both register the C20 blob routes (via
  `@fastify/multipart`), alongside app-events/notifications/search.

### Added
- **C19 — Search / indexing.** A generic, per-app, owner-scoped full-text search capability. An app
  indexes its own resources and queries them back over the internal network, reached server-side the
  same way the app reaches the C3 app-event log + C4 notifications (base URL via `FORGE_EVENTS_URL`;
  the `app` field defaults to the sidecar's `FORGE_APP_NAME`). Four **data-plane** endpoints,
  registered on BOTH the control-plane API (dev) and the data-plane sidecar (prod), like
  app-events/notifications:
  - `POST /index` — upsert one indexable document, **idempotent by `(owner, type, id)`** (re-indexing
    updates in place, exactly the C4 upsert-by-key pattern). Best-effort: the app calls it alongside
    its mutations and fire-and-forgets.
  - `POST /index/delete` — remove one document by `{owner, type, id}` (idempotent).
  - `POST /reindex` — bulk-upsert an array (backfill / cutover reconciliation).
  - `POST /search` — `{ owner, q, types?, limit?, offset?, date_from?, date_to? }` →
    `{ hits: [{ type, id, title, snippet, score, attrs?, created_at? }], total, took_ms }`.
- **Type-agnostic indexable document** `{ owner (required), type, id, title, body?, tags?, attrs?,
  created_at?, updated_at? }` — the app's resource kinds (goal/task/note/…) are just `type` values, so
  one index serves everything the app owns. `attrs` is a small denormalized bag round-tripped verbatim
  on every hit so the app can render a result without a second lookup.
- **Owner-scoping is structural (mandatory).** Every write is stamped with (and keyed by) `owner`, and
  every search filters to `owner` **before** ranking — a `/search` is implicitly `WHERE owner =
  <caller>` and can never return another owner's document; two owners may hold the same `(type, id)` as
  distinct records. Trust model is app-asserted (the private data-plane trusts the verified `owner` the
  app sends, exactly as C3/C4/C1 do). The document shape + `/search` are designed so a future
  `mode: 'semantic' | 'hybrid'` (vector/RAG search) extends cleanly; **semantic search is out of C19
  scope.**
- **BM25(F)-lite ranking** over a self-contained inverted view built per query (no Postgres dependency
  — Forge's own data-plane state is file-backed, so C19 ships in the slim data-plane image like the
  C3/C4/C15 stores). `title` is weighted above `body` (a title match outranks a body-only match),
  tokens are case-folded and lightly stemmed, the snippet is a highlighted excerpt with matched terms
  wrapped in HTML `<mark>…</mark>` (surrounding doc text HTML-escaped), and the tie-break is
  deterministic (`updated_at` desc, then `id`).
- **Failure modes.** Index writes are best-effort (non-fatal; `/reindex` is the backstop); a
  user-invoked `/search` degrades on an internal store failure to a **503 `search_unavailable`** the
  app can soft-handle (empty results), **never a 500**; an empty `q` → **400**; pagination past the end
  → empty hits (a 200, not an error); `limit` is clamped server-side to `[1, 100]` (default 20).

## [0.24.1] — 2026-07-09

### Fixed
- **P19 — `forge release` failed at ASSESS on a deploy host whose control-plane store was never
  populated by `forge init app`.** Symptom, deterministic on the box: `forge release --app forge-os
  --host forge-os.mardash.ai …` aborted with `not_found: No Application named "forge-os". Run: forge
  init app --name forge-os` — even though the **same app deployed fine via `forge deploy`** on that
  same host, and `forge release --dry-run` planned all five phases on a *local* control plane where
  the store **did** have the app.
  - **Root cause: the release path's app lookup was STRICTER than the `forge deploy` it composes.**
    `forge deploy` resolves the target **leniently** — a store-registered `Application` is optional;
    it infers the app from the single-app layout + the committed `app/forge.app.json` (name, host,
    current `web_image` pin), so a prod host that only ever ran `forge deploy`/`forge productionize`
    (never `forge init app`) deploys fine with an empty store. `forge release`, by contrast, resolved
    the app with the strict `resolveApp` (a store `Application` lookup by name that throws
    `not_found`) — so it broke exactly where the store lacked the registration. The strictness was
    **not** unique to assess: the `productionize` (repin) and `verify` (post-deploy gate) capabilities
    that `release` composes used the same strict lookup, so a real (non-dry-run) release of a new
    commit would also have failed at repin/verify on that host, not only at assess.
  - **Fix — the deploy-time capabilities now share one lenient resolver, so they can't drift apart.**
    A new `resolveAppLenient` in `capabilities/_shared.ts` resolves a store `Application` when present
    (its id still links Resources/Events) and otherwise infers the app from the single-app layout +
    `app/forge.app.json` — the SAME repo `forge deploy` operates on. `release` (assess), `productionize`
    (repin), and `verify` (the gate) all resolve through it now; a store record's **absence is no
    longer fatal** when `forge.app.json` resolves the app, so none of them require a box-side `forge
    init app`. `forge deploy` itself is unchanged (already lenient; it needs no repo path). If NEITHER
    a store record NOR a usable `app/forge.app.json` resolves the app, it still fails clearly with a
    `not_found` that names the fix. Everything else about `forge release` — the 5 phases, the fail-safe
    abort, the idempotent resume — is intact.
  - **Verified.** New hermetic regression tests (`tests/release-app-resolution.test.ts`) lock the box
    condition: `resolveAppLenient` resolves from `app/forge.app.json` with an empty store (previously
    `not_found`), a store record still wins, and a truly-unresolvable app still fails 404. Driven
    end-to-end in-process: with **0** registered Applications, the real `release` capability
    `--dry-run` for a `forge.app.json`-only app now **succeeds at assess** and plans all five phases
    (assess → publish → repin → deploy → verify), recovering the host + current pin from the manifest.

## [0.24.0] — 2026-07-09

### Added
- **Status page Phase 3 (C15) — operator-declared INCIDENTS on top of the public `/status`
  page.** Phases 1+2 aggregate live C6 health into a banner + per-component rows and an opt-in
  uptime timeline; Phase 3 lets an operator DECLARE an incident the probes can't see (a partner
  API down, a data issue, maintenance) with a status, an impact, affected components, and an
  ordered timeline of updates. Incidents are a separate FACT from measured health: they colour
  the LIVE banner but never rewrite the sampled uptime history.
  - **Operator CLI (control-plane).** A new `forge status incident …` family:
    - `create --app --title --status <investigating|identified|monitoring|resolved> --impact <none|minor|major|critical> [--component <key> …] [--body <text>]` → the created incident.
    - `update --app --incident <id> --status <…> [--body <text>]` — append an update, moving status.
    - `resolve --app --incident <id> [--body <text>]` — force `status:resolved`, stamp `resolved_at`, append a final update.
    - `list --app` — active (newest-first) then recent-resolved.
    These hit the incident routes (`POST /status/incidents`, `/status/incidents/update`,
    `/status/incidents/resolve`, `GET /status/incidents`), registered on BOTH planes (dev control
    plane + prod data-plane sidecar), like the other status/notification routes.
  - **Public rendering (data-plane, no auth — same as `/status`).** `/status` renders an **Active
    Incidents** section (title, current-status pill, impact, affected components, and the update
    timeline newest-first) above the component rows while anything is unresolved, plus a
    resolved-incident **Past incidents** disclosure — all themed through the existing C16
    `--forge-*` tokens (no new theming path). `/status.json` gains an additive **`incidents`**
    array (`id, title, status, impact, affected_components, updates[], created_at, resolved_at`),
    active then recent-resolved.
  - **Banner precedence (documented).** The live `overall` is `max(measured health, incident
    floor)` on the `operational < degraded < partial_outage < major_outage` ladder — an
    operator-declared outage can only make the banner WORSE, never better. Only UNRESOLVED
    incidents contribute: `critical → major_outage`, `major → partial_outage`, `minor → degraded`,
    `none → no floor`. So an unresolved critical forces at least **Major Outage** even when every
    probe is green; resolving it lets the banner recover.
  - **Bounded per-app store.** Incidents persist to a per-app JSON doc under the state dir
    (`/forge-state/incidents/<appId>.json`), OUT of the generic `/resources` API — like the C2
    uptime + C4 notification stores. Every write serializes under a per-app async mutex and
    replaces the file atomically (temp + rename); retention keeps all active incidents plus a
    bounded resolved-history (most-recent 50, resolved within 90 days), pruned on every write.
  - **Events.** Emits `IncidentOpened` / `IncidentUpdated` / `IncidentResolved` platform facts
    (carrying only the incident id/title/status/impact — no PII).
  - **Backward compatible.** An app that has declared NO incidents renders `/status` **byte-for-
    byte** the Phase-2 page (the incident section + its `<style>` are emitted only when an incident
    exists), and `/status.json`'s existing `overall`/`components`/`uptime` fields are unchanged
    (the `incidents` array is additive). Subscriptions/notification of subscribers are explicitly
    **out of scope** for this phase (deferred to a separate delivery-channels capability).

## [0.23.0] — 2026-07-09

### Added
- **`forge release` (C18) — one command runs the ENTIRE production deploy pipeline, end-to-end,
  idempotently and fail-safe.** The capstone over Deploy (C7), Productionize/repin (C8), and
  Verify (C14): given a committed app it goes to *deployed + verified* without a human or an
  agent hand-orchestrating the ~10 steps. Phases, in order: **assess** (resolve the commit +
  the target image ref `ghcr.io/<owner>/<app>-app:sha-<commit>`, probe whether it is already
  published, read the current pin + host) → **publish** (ensure the commit's web image is in
  GHCR and resolve its digest) → **repin** (`forge productionize --web-image <ref>@sha256:…`,
  keeping the data-plane pin) → **deploy** (the C7 start-first roll + the P14 drift gate) →
  **verify** (the C14 post-deploy contract smoke — the final gate). It **reuses** those
  capabilities' code paths in-process; it reimplements none of them.
  - **Idempotent + resumable.** A re-run after a partial/interrupted release **assesses current
    state** and continues from the first unfinished phase: publish is skipped when the commit's
    digest already resolves, repin when the compose is already pinned to that digest, deploy when
    the running web container is already on the target image (compared by local image id, the
    same identity the drift gate uses). A fully-landed release re-run is a **no-op** — only the
    read-only verify re-confirms. (Built for the failure the manual flow hit: it died twice on
    transient GHCR API errors mid-roll and had to be recovered by hand; `forge release` self-
    recovers — the CI-mode publish poll retries through transient errors + not-found until a
    configurable timeout.)
  - **Fail-safe.** ANY phase failing (CI never publishes → timeout, a digest mismatch, the P14
    drift gate catching a stale image, a non-zero `forge verify`) **aborts with a precise,
    actionable error and leaves prod on the last-good version** — no later phase runs, so a
    deploy is never half-applied. Exits non-zero on failure. Non-destructive: it recreates
    containers but never touches volumes/DB.
  - **Observable.** Prints each phase with progress; `--json` for a machine-readable Release
    resource; `--dry-run` shows the plan (which phases would run vs. skip) mutating nothing; a
    configurable GHCR poll `--timeout` / `--poll-interval`. `--publish-mode ci` (default) waits
    for the app's publish workflow; `--publish-mode build` cross-builds + pushes a multi-arch
    image itself. A `Release` Resource records the ordered per-phase outcome and links the
    Deployment (C7) + Verification (C14) it produced; `ReleaseStarted` / `ReleaseCompleted` /
    `ReleaseFailed` events are emitted.
  - The control-plane image now carries **git** (resolve the app's HEAD commit + GHCR owner) and
    the **Buildx** plugin (resolve an image's registry digest via `docker buildx imagetools
    inspect`; cross-build in `--publish-mode build`).

## [0.22.0] — 2026-07-08

### Fixed
- **A production deploy could silently log every signed-in user out.** Reported symptom: after
  `forge deploy`, active users had to sign in again. Diagnosed to the auth/session/`forge_refresh`
  store on the data-plane sidecar + the productionize-generated `compose.prod.yaml`.
  - **The store itself is already durable — that half was a red herring.** C10's users, sessions,
    and `forge_refresh` records live at `/forge-state/auth/<appId>.json`, and the generator has
    (since C8) mounted the data-plane's whole state dir (`FORGE_STATE_DIR=/forge-state`) on the
    **durable named volume `forge_state`**. `forge deploy` recreates the sidecar onto its new pin,
    and a named volume **persists across that container recreate** — so a valid session/refresh
    survives a deploy. Reproduced end-to-end: create a session → `docker compose up -d
    --force-recreate data-plane` → `GET /auth/session` **200** and `POST /auth/refresh` **200**
    (still authenticated). The negative control (same sidecar with the store on the container's
    ephemeral fs, no volume) reproduced the exact symptom: **401 / 401** — every session + refresh
    token wiped. The C5 secrets vault (`/forge-state/secrets`, including its master key) rides the
    same volume, so it does not regenerate across a recreate either.
  - **Root cause (the remaining silent-logout surface): the session-signing secret defaulted to
    empty.** The generator injected every declared secret — including `AUTH_SESSION_SECRET`, the
    HS256 key that BOTH signs (data-plane) AND verifies (app middleware) the `forge_session` access
    token — as `${NAME:-}` (defined-but-**empty** when unset). If that required key was ever unset
    or emptied in `.env.prod` (a typo, a dropped var), the whole stack silently came up with an
    **empty** signing key: the data-plane could neither mint nor verify a session, so every user was
    logged out — while `docker compose config` and the deploy still reported **success**. An empty
    signing secret is the "silently rotate to nothing" footgun, not a durability problem.
  - **Fix — a missing required auth secret now FAILS THE DEPLOY LOUDLY, never silently empties.**
    `AUTH_SESSION_SECRET` is now emitted as `${AUTH_SESSION_SECRET:?…}` in **both** the web and
    data-plane services — the exact fail-loud shape `POSTGRES_PASSWORD` already uses — so a
    missing/empty value aborts `docker compose config` (the step the C7 roll runs) with a clear
    message (`… logs every signed-in user out on deploy`) **before** any replica starts, instead of
    shipping a stack that logs everyone out. A stable, operator-set value (the normal case)
    interpolates fine and — with the durable `forge_state` store — keeps sessions alive across the
    deploy. Verified: `docker compose config` now exits non-zero + names the fix when
    `AUTH_SESSION_SECRET` is unset, and exits 0 when it is set.

### Changed
- **Productionize secret injection is catalog-driven and distinguishes *deploy-required* from
  *optional* secrets.** The C13 secret catalog gains a `deploy_required_reason`, and a new
  `secretInterpolation(name)` helper picks the compose interpolation per secret: a deploy-required
  secret (currently only `AUTH_SESSION_SECRET`) renders fail-loud `${NAME:?reason}`; every other
  secret keeps the defined-but-empty `${NAME:-}` so it still degrades detectably (real values come
  from `.env.prod`, never the compose file). The optional sign-in **alternatives** — `GOOGLE_*`,
  `SMTP_URL`, `EMAIL_FROM` — stay `${NAME:-}` on purpose: their absence disables one method, it does
  not log anyone out. New regression tests lock (a) `AUTH_SESSION_SECRET` fail-loud in both tiers,
  (b) the optional alternatives staying non-fatal, and (c) the deploy-survival guard that the
  auth/session/refresh store is mounted on the durable named `forge_state` volume (so an ephemeral
  regression can't silently return). No app re-scaffold needed; adopt by re-running
  `forge productionize` (regenerates `compose.prod.yaml`) then `forge deploy`.

## [0.21.1] — 2026-07-08

### Fixed
- **P16 — `forge deploy` aborted on a relative `--env-file`, breaking `make deploy`.** An operator
  running `forge deploy --app <app> --env-file app/.env.prod` (a relative path, as `make deploy`
  passes) failed immediately with `node: app/.env.prod: not found` (exit 9), **before any rollout** —
  never reaching the P14 drift gate.
  - **Root cause (the CLI launch, not the deploy path).** The `forge` wrapper ran the CLI as
    `tsx src/cli/index.ts "$@"`. `tsx` hoists **any** node CLI flag it finds in argv — even one that
    appears *after* the script — into the underlying `node` process. `--env-file` **is** such a node
    flag, so node consumed the operator's `--env-file app/.env.prod`, resolved it against the
    control-plane container's **process CWD (`/forge`)** — which holds no app files — and aborted at
    startup, so forge's own parser (which resolves against **`FORGE_WORKSPACE`**, where Compose runs)
    never ran. `--compose-file` was unaffected (it is not a node flag). This is a launch-layer trap,
    **not** the 0.19.0 P14 refactor: the deploy/rollout path code is byte-identical to 0.18.0.
  - **Fix.** The `forge` wrapper now launches the CLI as `tsx -- src/cli/index.ts "$@"`. The `--`
    tells `tsx` that everything after is the script + its args, so operator flags reach forge's own
    parser and a relative `--env-file`/`--compose-file` resolves under `FORGE_WORKSPACE` (never CWD).
    Absolute paths still pass through unchanged.
  - **Hardening.** The Deploy capability's env-file existence probe now uses `path.resolve(workspace,
    arg)` instead of `path.join`, so an **absolute** `--env-file` is no longer mis-joined under the
    workspace (which would have silently dropped a valid absolute env-file); relative args still
    resolve under `FORGE_WORKSPACE`.
  - **P14 drift gate intact.** No rollout/drift logic changed — a deploy now finds the env/compose
    files, runs the start-first roll, and reaches the running-vs-pinned drift gate (recreate-on-pin
    change + fail-loud-on-drift) exactly as before. New regression tests lock both the CLI launch
    (a relative `--env-file` reaches forge instead of aborting node) and the workspace-relative /
    absolute-passthrough path math; the existing deploy-rollout + drift tests stay green.

## [0.21.0] — 2026-07-08

### Added
- **C15 Phase 2 — uptime history on the status page.** The public `/status` dashboard grows a
  Statuspage-style **per-component uptime timeline** (a per-day bar + windowed uptime %), backed by a
  periodic health **sampler** and a durable, **bounded** snapshot store. Phase 1 (the live banner +
  component rows) is unchanged; history is **opt-in** and additive.
  - **Sampling (C2).** A platform-internal periodic probe run by the **scheduler-node** Implementation
    (the same always-on, non-overlapping, unref'd ticker as the job scheduler — NOT an app-callback
    `ScheduledJob`). Each tick it does a **cheap, read-only GET** to every app's C6 health and records
    a `HealthSnapshot` (overall + per-component state at that instant), **reusing the same `probeHealth`
    + `computeStatus` core** the live page uses — one health definition, no writes to the app.
    **Opt-in + safe by default:** runs only when **`FORGE_STATUS_SAMPLE`** is truthy on the plane;
    cadence is **`FORGE_STATUS_SAMPLE_INTERVAL`** (e.g. `1m`, `5m`; default **5m**, floored at 30s).
    When off, `startHealthSampler` is a no-op and every app still gets the exact Phase-1 page.
  - **Durable store + retention/rollup (bounded storage).** A per-app store under the state dir keeps
    **raw** snapshots for a short window (default **2 days**) so today/yesterday are exact, **rolls up**
    completed days to per-day counts kept for a long window (default **90 days**), and prunes both on
    every write — so storage stays bounded no matter how long sampling runs. Kept out of the generic
    Resource store (like the C3 app-event log / C4 notifications), so it never bloats `/resources`.
  - **Page + JSON.** `/status` renders each **live** component's per-day bar (themed via the C16
    `--forge-color-success/warning/danger` tokens, muted for no-data days; responsive) plus its uptime %.
    `/status.json` gains an **additive** `uptime` section: `{ window_days, sampling, overall_uptime_pct,
    components:[{ name, uptime_pct, days:[{ date, state, uptime_pct }] }] }`. **No breaking change** to
    the Phase-1 `/status.json` shape (`overall`/`banner`/`components`/`checked_at` are untouched); an app
    with no history reads `sampling:false` + empty components ("collecting…").
  - **Out of scope (Phase 3, not built):** incident management + subscriptions (not stubbed).

### Changed
- The status aggregation (`computeStatus` + the status type unions) moved from `src/api/status-routes.ts`
  to a pure **`src/shared/status.ts`**, shared by the status route and the new health sampler so there is
  a single definition of "what the app's health says." Re-exported from `status-routes.ts` — no importer
  change. `src/shared/health-probe.ts` (the C6/C14/C15 probe core) is untouched.

## [0.20.0] — 2026-07-08

### Added
- **C14 — `forge verify`: a generic post-deploy contract smoke for deployed apps.** One read-only
  command asserts that a deployed forge app actually honors the platform contracts it adopted, against
  its public host, and **exits non-zero on any failed assertion** (the CI post-deploy gate). It is the
  platform lift of an app-local smoke suite: the app declares which of its own paths/methods to probe;
  the platform owns the contract assertions, so **forge-starter inherits post-deploy smoke for free**.
  - **Command:** `forge verify --app <app> --host <host>` (host may be a bare `app.example.com` — https
    is assumed — or a full URL). Flags: `--page-path` (default `/`), `--health-path` (default
    `/api/health`), `--api-path <path>` (repeatable), `--cron-path <path>`, `--expect google,email,password-signup`
    (or `--expect-google` / `--expect-email` / `--expect-password-signup`), `--check-refresh`,
    `--timeout-ms`. Human-readable pass/fail report by default; `--json` emits the machine-readable
    `Verification` resource.
  - **Assertions (read-only; a fresh request each; redirects not followed):** (1) **C6 health** — `GET
    /api/health` is 200, **public** (not behind an auth redirect/401), and matches the standard schema;
    (2) **C10 page gate** — an unauthenticated page 302-redirects to `/auth/login?next=…`; (3) **C10 API
    gate** — each `--api-path` is 401 unauthenticated (skipped-with-note if none given, never guessing
    app routes); (4) **C10 service gate** — `--cron-path` is **403** (not 401) with no service token
    (optional); (5) **C10 `/auth/config`** — 200 + the `{methods,configured}` shape, and any declared
    `--expect` methods are enabled; (6) optional **`/auth/refresh`** — a cookie-less POST is 401.
  - **Shares the C15/C6 logic, not a duplicate.** The health assertion reuses the same `probeHealth` +
    C6 schema recognizer the C15 status page uses (`src/shared/health-probe.ts` + `src/shared/health.ts`).
    `probeHealth` is refactored onto a new generic never-throws `httpProbe` primitive (with redirect
    control) that all the contract checks build on; `forge inspect health` + `/status` output are
    unchanged. New `src/shared/contract-checks.ts` holds the parameterized assertions.
  - **Domain:** new **Verify** Capability (`plane: 'both'` — usable from CI against the control plane and
    from the data plane), a **Verification** Resource (durable record: host, `passed`, per-assertion
    outcomes — status codes only, never a body or credential), and a **VerificationCompleted** Event.
    Non-destructive: GET-only (plus the optional cookie-less refresh POST); never writes, never needs
    credentials.

## [0.19.0] — 2026-07-08

### Fixed
- **C16 theming — a pinned `mode` now makes `colors{}` the WHOLE palette (neutral surfaces included).**
  Found adopting the theme during the forge-os prod cutover: with `mode:'dark'`, the **brand** colors from
  `colors{}` carried into dark but the **neutral surfaces** (`background`/`surface`/`text`/`textMuted`/`border`)
  reverted to the platform dark defaults unless the app *also* mirrored them into a redundant `dark{}` block
  (so `colors.background:#16120e` + `mode:'dark'` rendered on the platform's `#0b0f19`). Now a **pinned mode
  is self-contained:** `mode:'dark'` (and `mode:'light'`) treats the base `colors{}` — merged over that mode's
  default for any unset field — as the **entire palette for the mode, surfaces and all**, so no `dark{}` is
  needed. `mode:'auto'` is **unchanged** (there `colors{}` is the light palette and `dark{}` supplies the dark
  overrides — the only mode where `dark{}` is meaningful). **Regression-safe:** a theme that sets `colors{}`
  **and** a matching `dark{}` (the previous forge-os shape) renders **identically**. Schema comments + the
  generated starter theme now say it plainly: *`colors{}` is your palette for the chosen `mode`; add a `dark{}`
  block only for `mode:auto`.*
- **P14 — `forge deploy` no longer silently runs a stale image.** The image pull was quietly non-fatal, so a
  failed pull (e.g. a locked Docker keychain over non-interactive SSH) left the already-cached **old**
  container running while deploy reported **success** — "requested pin X, running Y" drift with no warning
  (it cost two no-op prod deploys). Deploy now:
  - **Verifies against the pins (drift gate).** After the reconcile + roll it compares each digest-pinned
    service's **running** image against the image its **compose pin** resolves to; on any mismatch it **fails
    loudly** (non-zero) naming the service + `running <Y>` vs `pinned <X>` and why (e.g. the pull failed — is
    the registry authenticated?), instead of reporting success.
  - **Recreates on a pin change.** A reconciled digest-pinned sidecar (the data-plane) left on a stale image by
    the `restart: unless-stopped` + only-image-changed trap is **force-recreated onto its pin**; the public web
    tier keeps its start-first, zero-downtime roll.
  - **Surfaces pull failures.** A failed pull is no longer swallowed — it is reported and, when it caused any
    drift, blocks the success report.
  Fixed for **every** consumer + forge-starter — no deploy needs hand-forcing.

### Changed
- **`make up` now `--force-recreate`s the control-plane container** — the P14 sibling trap: a container under
  `restart: unless-stopped` is not swapped by `compose up` when only its image changed (a rebuilt / re-pinned
  `FORGE_IMAGE`), silently keeping the old one. `make up` now always lands the freshly built/pinned image
  instead of leaving `forge productionize`/commands running on a stale one.

## [0.18.0] — 2026-07-08

### Added
- **C16 — app theming for platform-served UI: one declarative contract brands every hosted page.**
  A single `forge.theme.json` at the app repo root now brands **all** platform-served UI the app
  leverages — the C10 hosted auth pages, the new C15 status page, and any future UI capability — from
  **one token set**, not per-capability knobs.
  - **Schema** (`src/shared/theme.ts`, pure/testable): app display `name`, `logo`, `favicon`, `mode`
    (`auto`|`light`|`dark`), `font`, `radius`, a full `colors` palette (primary + auto-derived
    contrast, accent, background, surface, text, textMuted, border, success, warning, danger), an
    optional `dark` override block, and a sandboxed `custom_css` / `custom_css_path` escape hatch.
    Every declared value is sanitized (colors/font/size against allowlists; asset URLs against a
    scheme allowlist — no `javascript:`) so a theme value can never break out of the page `<style>`.
  - **Token set:** pages render from CSS custom properties (`--forge-color-primary`, `--forge-font`,
    `--forge-radius`, …) — the **same** properties across every UI capability, so theming once themes
    auth + status together. Light/dark switch at the token level (`mode:auto` emits a light `:root`
    plus a dark `@media` override).
  - **Serving:** a new **`GET /theme.css`** (both planes, public) serves the token set + sandboxed
    custom CSS as a linkable/cacheable stylesheet; the auth + status pages ALSO inline the same tokens
    so they render with no flash-of-unthemed-content and no extra round trip.
  - **Escape hatch:** an optional custom CSS (inline or file) is injected as a trailing `<style>`,
    sandboxed CSS-only — HTML/script breakout, `@import`, `expression()`, IE `behavior`, and
    non-https/data `url()` are all stripped.
  - **Neutral default:** an app that declares no theme gets a clean, professional default look.
  - **`forge productionize` scaffolds + carries it:** a neutral starter `forge.theme.json` is written
    once (never clobbered), mounted read-only into the data-plane sidecar, and pinned via
    `FORGE_THEME_FILE`, so the hosted pages render branded in production.
- **C15 — public status page (Phase 1): a per-app, themed health dashboard.**
  A **public, no-auth** `GET /status` (+ `GET /status.json`) served by the platform on both planes
  (like `/auth/*`; the app proxies it same-origin — no app page code). It aggregates the app's **live
  C6 health** into a Statuspage-style **overall banner** (*All Systems Operational / Degraded
  Performance / Partial Outage / Major Outage*) plus **per-component rows** (the web tier, each C6
  check, and the serving platform plane). Rendered through the C16 theme — responsive, light/dark,
  brandable. Uptime history, incident management, and subscriptions (Phase 2/3) are explicitly
  deferred.

### Changed
- **C10 hosted auth pages are now theme-driven.** Login / signup / verify / reset / logout and the
  interstitial pages render from the C16 `--forge-*` tokens (brand color, surface, text, radius,
  font, status colors) with the app's logo, display name (in the `<title>`), favicon, and custom-CSS
  override applied. No behavior change to auth — purely presentational.
- **`forge productionize` now wires the app-callback env into the data-plane sidecar**
  (`FORGE_APP_CALLBACK_HOST=web`, `FORGE_APP_CALLBACK_PORT`, `FORGE_READINESS_PATH`), so the C15
  status page can probe the app's C6 health over the internal network in production (this is also the
  documented config the C2 scheduler's prod callback expects).
- **Refactor:** the live C6 health probe (`resolveAppBase` + fetch/parse) is extracted to
  `src/shared/health-probe.ts` and shared by `forge inspect health` and the C15 status page — one
  definition of "where the app is" and "what its health says." `forge inspect health` output is
  unchanged.

## [0.17.0] — 2026-07-07

### Added
- **C13 — the operator provisioning contract: an operator can now tell what they must provision.**
  Driven by a real report — prod `/auth/signup` showed *no form* and *"Email/password sign-up is
  unavailable"* because **both** SMTP (C12) and Google OAuth (C10) were unset, so there was **no
  working sign-in method** — and nothing told the operator what `GOOGLE_CLIENT_ID` / `SMTP_URL` / … are,
  which capability needs them, or how to set them. This fixes the class:
  - **A canonical secret catalog** (`src/plugins/productionize-nextjs-compose/secret-catalog.ts`) — the
    single source of truth describing every provisioning value (capability, required-vs-optional, what
    it is, external setup, how to generate, how to set). Both the human guide and the generated
    per-app artifacts derive from it, so they can't drift.
  - **`forge productionize` now emits a per-app operator runbook** — a generated **`PROVISIONING.md`**
    in the app repo listing exactly the secrets **that** app needs (its subset of the matrix), each
    explained, with the exact dev (`forge secrets set`) and prod (`.env.prod` + `forge deploy`)
    commands. Generated from the app's declared capabilities → convergent/idempotent, inherited like
    `compose.prod.yaml`. When the app uses C10 auth but has **neither** Google nor SMTP declared, the
    runbook spells out the unblock (the exact Google redirect URI `https://<host>/auth/google/callback`
    and a `provision → productionize → deploy` snippet naming the missing secrets).
  - **The generated `.env.prod.example` is now annotated** — each secret is preceded by a `#` comment
    (what it is · which capability · required/optional · how to obtain · how to generate) instead of a
    bare `NAME=`.
  - **An authoritative `PROVISIONING.md` at the forge repo root** — the operator guide: how to bring up
    the control plane and a data-plane sidecar, how secrets reach the runtime (C5 vault vs `.env.prod`),
    the full per-capability secret/token matrix, and an explicit "no sign-in method ⇒ no signup path"
    section (Google unblocks sign-in with no email dependency; SMTP unblocks email/password
    signup+verify+reset). `AUTH_SESSION_SECRET` is required for either to function; `GET /auth/config`
    reports what's enabled.

### Changed
- **No regression to existing productionize output.** The Dockerfile / `compose.prod.yaml` / next-config
  generation is unchanged; `.env.prod.example` gains explanatory comments (same variable lines) and a new
  `PROVISIONING.md` is added to the emitted file set (and to the generated `.dockerignore`).

## [0.16.0] — 2026-07-07

### Added
- **P8 — logout/revocation is now real: short-lived access token + a revocable, rotating refresh
  token.** Before this, the app's gate verified the long-lived (`~30d`) `forge_session` cookie
  **locally with no round-trip**, so a **replayed** cookie still passed the gate after
  logout/reset/leak until its far-off `exp`. C10 now issues **two** cookies:
  - **`forge_session` (access)** — the **same** HS256-JWS shape/verification an app already mirrors
    (`{ userId, email, sessionId, iat, exp }`, signed with `AUTH_SESSION_SECRET`, verified locally with
    no round-trip), but its JWS **`exp` is short (~15m)**. That short window is what now bounds exposure
    after a revocation. The cookie's `Max-Age` is the session lifetime so the browser keeps presenting
    the (soon-expired) token, which drives the gate's decision to refresh.
  - **`forge_refresh` (refresh)** — a **new**, **opaque**, high-entropy httpOnly + Secure +
    SameSite=Lax cookie (NOT a JWS). The server persists only its **SHA-256 hash** in the per-app auth
    store (`{ id(hashed), user_id, session_id, created_at, expires_at(~30d), revoked_at, rotated_from?,
    rotated_to? }`), so a store leak can't be replayed. **Path=/** (not `/auth`) on purpose — the app's
    gate runs on every path and must read this cookie to decide whether to refresh.
  - **`POST /auth/refresh`** (both planes) — reads `forge_refresh`, validates it (exists, unrevoked,
    unexpired, live session), then **issues a fresh short access token AND rotates the refresh**
    (mints a new `forge_refresh`, single-use-revokes the old, links them). Returns `200 { userId,
    email, exp }` + `Set-Cookie` for both; on failure `401` + clears both cookies. **Refresh-token
    rotation** makes a stolen refresh single-use and reuse **detectable**: re-presenting an
    already-rotated token (outside a small benign-concurrency grace) **revokes the whole session's
    refresh chain + the server session**.
  - **Revocation is real.** **Logout** revokes the session **and** its refresh chain (works even when
    the access token has already expired, via the refresh record) and clears both cookies. **Password
    reset** revokes **all** of the user's sessions **and** refresh tokens ("sign out everywhere"). After
    a revocation the current access token still works only until its ~15-min `exp`, and **no new access
    can be minted** — so the session dies within the window.
  - Every sign-in path (`/auth/login`, OAuth callback) now sets **both** cookies; the `/auth/session`
    accessor signs the short access token and transparently refreshes on expiry so accessor-pattern
    apps keep a ~30d session. New event **`SessionRefreshed`**; `SessionRevoked` now also fires on a
    detected refresh reuse. New TTL knobs (env, with defaults): `FORGE_AUTH_ACCESS_TTL_SECONDS`
    (900), `FORGE_AUTH_REFRESH_TTL_SECONDS` (2592000), `FORGE_AUTH_REFRESH_REUSE_GRACE_SECONDS` (15).
- **P9 — the multi-app control plane can scope `/auth` for a dev app without a single-app sidecar
  workaround.** The single-app data-plane sidecar infers the app from `FORGE_APP_NAME`, but the
  multi-app control plane (dev) serves `/auth` for many apps and couldn't infer which — a pure
  same-origin form POST 404'd (`Unknown app`). The `/auth` routes now resolve the target app from a
  new **`X-Forge-App`** request header (which a dev proxy sets), **and** honor the `app` query param
  uniformly on **POST** as well as GET (so a `?app=<name>` rewrite destination works too). Precedence:
  explicit `app` → `X-Forge-App` header → the server default (`FORGE_APP_NAME`).

### Changed
- **Backward compatible for adopters; a re-verify, not a breaking change.** The access cookie keeps the
  **same name and JWS verification** an app already mirrors — only its `exp` shrinks — so an app's local
  `verifySessionToken` path is unchanged. To gain real revocation an app adds the small refresh step to
  its middleware: when `forge_session` is expired/absent **and** `forge_refresh` is present, do a
  server-side same-origin `POST /auth/refresh`; on `200` set the rotated cookies and admit the request,
  on `401` treat it as unauthenticated. Public/service paths are unchanged. **Prod is un-regressed:** the
  single-app data-plane path (no header, no `app` param) still defaults from `FORGE_APP_NAME`.

## [0.15.1] — 2026-07-07

### Fixed
- **P10 — a plain `forge deploy` now loads the documented secrets file (`app/.env.prod`).** The
  Productionize generator emits the secrets template as `.env.prod.example` and the generated
  `compose.prod.yaml` interpolation hints name `.env.prod` (`${POSTGRES_PASSWORD:?… in .env.prod}`),
  but `forge deploy` ran `docker compose -f app/compose.prod.yaml` with **no `--env-file`**, so
  Compose auto-read only `app/.env` — secrets placed in the documented file were **silently ignored**
  and the deploy aborted at interpolation (`required variable … is missing a value`). `forge deploy`
  now **defaults `--env-file` to `app/.env.prod`** (mirroring the P7.2 `--compose-file` default), so
  the emitted example, the compose hint, and the deploy default all name the **same** file and a
  flag-less deploy interpolates the secrets. It is passed only when the file is present (Compose
  errors on a named-but-absent env-file, and a secret-less app legitimately ships none — Compose's
  own `app/.env` auto-read still applies).
- **P11 — the generated `next.config.mjs` no longer compiles the `/auth/*` rewrite out of the image.**
  C10 apps proxy `/auth/*` to the data-plane sidecar via Next `rewrites()`. Next evaluates
  `rewrites()` (like `headers()`/`redirects()`) at **build** time, so a config gating the destination
  on a **runtime-only** env (`FORGE_DATA_PLANE_URL`, set by compose but absent at `next build` in CI)
  returned `[]` and baked the rewrite **out** of the image → `/auth/login` 404'd in prod. The
  generated config now **always emits** the `/auth/:path*` rewrite with the destination **defaulted to
  the in-cluster `http://data-plane:3718`**; a runtime `FORGE_DATA_PLANE_URL`/`FORGE_EVENTS_URL` still
  **overrides** it (e.g. `next dev`). Fixed in **one shared config** (`src/shared/next-config.ts`) used
  by both the Productionize generator and the `init app` scaffold, so neither a productionized nor a
  newly-scaffolded app re-discovers it. **forge-starter inherits the generator**, so its template is
  corrected too.

## [0.15.0] — 2026-07-07

### Added
- **C11 — permissions / access control (per-user ownership).** Now that C10 ships a multi-user
  session (`getSession() → { userId }`), the shared stores are made **owner-aware** so records no
  longer leak across users. Every shared store gains an opaque **`owner`** dimension (the app passes
  C10's `userId`): **write** takes an `owner`; **feed/query/inspect** filter by `(app, owner)` so a
  read scoped to an owner returns **only** that owner's records — user A can never read user B.
  Generic + opaque (no goal/task/auth specifics); the platform provides the owner-scoping primitive
  the app builds its own tables on.
  - **C3 application event log (`POST/GET /app-events`, `GET /app-events/latest`).** Emit accepts
    `owner`; the feed, subject filter, and `latest` (cold-subject) map all filter by owner, so one
    user's activity never resets another's clock. `AppEvent` carries `owner?`.
  - **C4 notifications (`POST /notifications[/dismiss|/clear]`, `GET /notifications`).** Scoping is by
    `(app, owner, key)`: two users may hold the **same** app key (e.g. `cold:g1`) as **distinct**
    notifications (namespaced internally by an owner + NUL storage key — the returned `.key` is
    unchanged), and dismiss/clear/list act only on the caller's own. `Notification` carries `owner?`.
  - **C1 agent runs (`agent-run` capability + `GET /resources?...&owner=`).** `agent-run` input takes
    `owner`; **both** the `AgentTask` and its `Artifact` are stamped, so a run and its result stay
    attributed to the same user (success **and** failure). `listResources` gains an `owner` filter;
    `BaseResource` carries `owner?` (set only by owner-scoped stores).
  - **`forge inspect <app-events|notifications|agent-runs> --owner <id>`** and
    **`forge resources --owner <id>`** scope those views to one user.
  - **One-time migration — `POST /owner/claim-legacy` / `forge owner claim-legacy --app --owner`.**
    Assigns every owner-**less** record across C3 + C4 + C1 to a seeded owner (pairs with C10's
    `auth seed-owner`) on cutover. Idempotent — already-owned records are untouched.
  - **Convention (for the consumer): 404-not-403.** An unknown/other-owner id returns **404** (not
    403) so existence never leaks; the app enforces this on its own tables using this owner-scoping
    primitive (a cross-owner read returns empty/nothing to render → 404).

### Changed
- **Backward compatible.** `owner` is optional everywhere: a caller that doesn't pass one is
  **app-scoped** exactly as before C11 (a C10-less app is unaffected), and legacy/pre-C11 records
  (no owner) still read under app-scope. An owner-scoped query excludes legacy records until they're
  claimed via `claim-legacy` — no data is lost or broken, no re-provision required.

## [0.14.0] — 2026-07-07

### Added
- **C10 — hosted, multi-user identity / auth.** Auth is generic platform machinery — apps must not
  hand-roll it. C10 lets any app gate itself while shipping **no auth UI and no auth tables**: it
  proxies `/auth/*` to the platform and reads a signed session. Google OAuth **and** email+password
  are both live at launch; anyone can sign up (each user is a distinct account). Like C3/C4, this is
  delivered as **routes** (registered on the control-plane API for dev and the **data-plane** sidecar
  for prod), not a Capability — so password hashes/session material never touch the `/resources` API.
  - **Hosted pages + routes (`src/api/auth-routes.ts`, `registerAuthRoutes`).** Platform-rendered
    `GET/POST /auth/{login,signup,forgot,reset}`, `GET /auth/verify`, `GET /auth/{google,google/callback}`,
    `GET|POST /auth/logout`, plus `GET /auth/session` (the session accessor / verify-endpoint option →
    `{ userId, email }` | 401) and `GET /auth/config` (which methods are enabled). The app proxies
    `/auth/*` same-origin so the session cookie lands on the app's domain.
  - **Signed session token + tiny app surface (`src/shared/session.ts`).** A compact HS256 JWS signed
    with a C5 key; the app's middleware **verifies it locally** (`verifySessionToken`) with no
    per-request round-trip. Ships the exact reference the app mirrors: `SESSION_COOKIE`,
    `signSessionToken`/`verifySessionToken`, `sessionCookie`/`clearSessionCookie` (**httpOnly + Secure
    + SameSite=Lax**, 30-day sliding), `parseCookies`, `isPublicPath`/`isServicePath`, and
    `SERVICE_TOKEN_HEADER`. Public list defaults to `/auth`, `/api/health`, `/api/cron`. Unauthenticated
    **pages → redirect to hosted login**; unauthenticated **`/api/*` → 401**.
  - **Durable, multi-user store (`src/plugins/auth-identity/`).** Users + sessions + verify/reset
    tokens persist per-app under the (gitignored) state dir — a private store like the C5 vault, never
    a Forge Resource. Passwords hashed with **scrypt** (memory-hard KDF; per-user salt; constant-time
    verify) — never stored or logged in plaintext. Google users are linked by provider id (or adopt an
    existing email account). Verify/reset tokens are **single-use + expiring** and stored only as a
    SHA-256 hash. Sign-out revokes the server session; a password reset revokes all of a user's sessions.
  - **Email via C12.** Signup verification and password reset send through **`send-email`** with
    `template:'verify-email'|'reset-password'` + the `data.url` link **C10 generates** (C10 owns
    token/link generation; C12 only delivers).
  - **Service/cron auth (§5).** The **C2 scheduler** now authenticates its `/api/cron/*` callbacks as a
    **service** — it attaches the `AUTH_SERVICE_TOKEN` (C5) under both `X-Forge-Service-Token` and
    `Authorization: Bearer`, closing what used to be fully-open cron endpoints. Absent token ⇒ no header
    ⇒ the app's gate rejects it (detectable, not silently reopened).
  - **Secrets via C5.** `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (OAuth), `AUTH_SESSION_SECRET`
    (session signing), `AUTH_SERVICE_TOKEN` (service auth) resolve vault→env, same pattern as
    `ANTHROPIC_API_KEY`. Nothing hardcoded.
  - **Detectable degradation (§7).** No Google creds → OAuth disabled, email/pw still works. No
    C12/email → email/pw signup is blocked cleanly (503), Google still works, no half-account. No
    session key → sign-in is cleanly unavailable, never a crash. All surfaced via `GET /auth/config`
    and `forge inspect auth`.
  - **Owner migration hook (§8).** `POST /auth/admin/seed-owner` / `forge auth seed-owner` designates a
    verified first/owner user (with or without a password) so a consumer can assign existing app data
    to it on cutover.
  - **Observability without leaking.** New facts `UserSignedUp` / `UserVerified` / `UserAuthenticated`
    / `SessionRevoked` / `PasswordResetRequested` / `PasswordChanged` / `OwnerSeeded` carry a **redacted**
    email + ids only — never a password, hash, or token. Inspect with **`forge inspect auth`** /
    **`forge auth users`** (redacted emails, verified/provider/owner, active-session count, and what's
    configured).
  - **Dependency-clean, multi-arch-safe.** All crypto is Node built-ins (scrypt, HMAC, timing-safe
    compare) and the form parser is `URLSearchParams` — no argon2/bcrypt native module, no OAuth SDK, no
    `@fastify/formbody`, so the slim data-plane image stays clean and cross-builds for amd64+arm64.

## [0.13.0] — 2026-07-07

### Added
- **C12 — transactional email delivery.** A generic, provider-agnostic capability to *deliver* a
  transactional email — the platform surface C10 (identity/auth) will call to send signup-verification
  and password-reset messages, and later the channel behind C4 Notifications' email. It composes +
  delivers a message it is handed; it does **not** generate tokens or links (that stays C10's job).
  Runs on the **data plane** (email is sent at runtime by the app / an auth flow); the control plane
  only inspects it.
  - **`SendEmail` Capability (`send-email`, plane `data`).** Input
    `{ to; subject?; html?; text?; template?; data?; app? }` — provide **either** an inline
    `subject` + `html`/`text` **or** a built-in `template` (+ `data`). Returns a durable
    **`EmailDelivery`** Resource (`status: 'sent' | 'failed'`, `message_id?`, `error?`). Persists
    **every attempted** send (success *and* failure) so a delivery failure is reported, never silently
    dropped. Primary caller is platform-internal (C10 via `executeCapability('send-email', …)` / the
    data-plane `POST /capabilities/send-email`); the same route is available to an app later.
  - **Built-in templates.** `verify-email` and `reset-password` render subject + HTML + plain-text from
    the `data.url` link the caller supplies (HTML is escaped — no injection). C10 generates the link;
    C12 only composes and delivers it.
  - **Provider-agnostic, configured via C5.** Credentials come from the C5 secret store (or process
    env), never hardcoded: **`SMTP_URL`** (`smtp[s]://user:pass@host:port` — any SMTP relay: SES /
    Postmark / Sendgrid / Mailgun / Postfix) + **`EMAIL_FROM`** (the From address). The transport is
    Node's built-in `net`/`tls` (implicit TLS, opportunistic STARTTLS, AUTH LOGIN) — **no new
    dependency**, so the slim data-plane image stays clean. The `email-smtp` Implementation is a real
    technology boundary a future `email-api` Implementation can replace without touching the contract.
  - **Detectable absence → graceful degrade.** When email is unconfigured (missing `SMTP_URL` and/or
    `EMAIL_FROM`), `SendEmail` throws a typed **503 `dependency_unavailable`** naming exactly what is
    missing — it never crashes, and no delivery is persisted (there was no send). C10 can detect this
    and decide (block a signup that needs verification, or surface the state).
  - **Observable without leaking.** An `EmailDelivery` and the `EmailSent`/`EmailFailed` Events record
    **to (redacted, e.g. `j***@example.com`) / subject / status** only — never credentials, never the
    message body/PII; a provider error is scrubbed of any recipient address before it is stored.
    Inspect with **`forge inspect email --app <app>`** / **`forge email list`**; send manually with
    **`forge email send`**.

## [0.12.0] — 2026-07-07

### Added
- **C6 — a standard health / telemetry contract the platform owns and observes.** Apps used to
  hand-roll `/api/health` as a liveness-only endpoint that returned `200 {status:'ok'}` even when a
  dependency (e.g. Postgres) was down — it lied about readiness. C6 standardizes the shape, the
  readiness → HTTP-code convention, and adds a way to inspect it. The route STAYS in the app
  (framework-native); the platform owns the contract.
  - **Standard health schema (`src/shared/health.ts`).** `{ status: 'ok'|'degraded'|'unavailable';
    service; time: ISO-8601; checks: [{ name; status: 'ok'|'unavailable'; detail? }] }`
    (`checks: []` = valid liveness-only). Recognized/validated by `parseHealthResponse`.
  - **Readiness → HTTP-code convention.** `httpStatusFor`: **200** when `ok` (all required checks
    pass, or none) or `degraded` (a *non-required* check failed, flagged); **503** when a *required*
    check fails (`unavailable`). Every prober already treats non-2xx as unhealthy, so 503-on-not-ready
    needs no prober change (dev/prod compose healthchecks, the C7 Traefik `loadbalancer.healthcheck`).
  - **Platform-owned check aggregation.** `aggregateHealth(service, results)` rolls a list of resolved
    check results up into `{ body, httpStatus }` per the convention above. The app supplies its checks
    (opaque thunks, e.g. a DB `SELECT 1`) + its service name; the platform owns the shape + rollup.
  - **`forge inspect health --app <app>`.** New `health` inspection type: reads
    `production.readiness_path` from `forge.app.json` (default `/api/health`), fetches it LIVE
    (no-cache, 5s timeout) over the same app-callback convention the scheduler uses
    (`FORGE_APP_CALLBACK_HOST`/`_PORT`, else `host.docker.internal` + the provisioned web port), and
    renders the parsed schema — overall status + per-check. Flags a reachable-but-non-conforming
    endpoint and a 200/503 convention mismatch; degrades (never throws) when unreachable.

### Changed
- **The `init app` scaffold now emits the standard health handler** (distribution (A) — the reference
  snippet, materialized), replacing the retired always-`ok` `healthPayload`. New apps get a vendored
  `lib/health.ts` (`buildHealth({ service, probes })` → `{ body, httpStatus }`), an `/api/health` route
  that returns real 200/503 readiness, and matching tests. No new distribution mechanism, no npm
  package, no data-plane code — the contract is platform-owned; the route is app-owned.

## [0.11.1] — 2026-07-07

### Fixed
- **`productionize` — the generated `compose.prod.yaml` now matches the runtime contract the
  platform’s own capabilities (C1–C5, C7) establish.** Adopting C8 surfaced four seams where the
  emitted prod stack didn’t line up with how the shipped capabilities actually run; the generator
  now derives all four from the app’s declared `infra`/manifest (still generic — no app specifics):
  - **P6 — the data-plane sidecar can now read the C5 secrets vault.** The sidecar runs the
    **data-plane** capabilities (C1 agent-run reads `ANTHROPIC_API_KEY` from the C5 vault here), but
    the generated compose gave it **no `FORGE_SECRETS_KEY`** and injected the declared secrets only
    into `web` — so prod agent-run would 503. The generated `data-plane` service now gets
    `FORGE_SECRETS_KEY` (to decrypt the vault at rest on the `forge_state` volume) **and** each
    declared secret as a defined-but-empty interpolation (the process-env fallback), mirroring the
    web tier. `.env.prod.example` documents `FORGE_SECRETS_KEY`.
  - **P7.1 — the web app now reaches the data-plane under the name the shipped clients read.** The
    C1/C3/C4 delivery has apps read the data-plane base URL from **`FORGE_EVENTS_URL`**; the
    generator only set `FORGE_DATA_PLANE_URL`, so prod lost data-plane reachability. `web` now sets
    **`FORGE_EVENTS_URL=http://data-plane:3718`** (the load-bearing contract), keeping
    `FORGE_DATA_PLANE_URL` as a compatible alias.
  - **P7.2 — `forge productionize` and `forge deploy` now agree on the compose path.**
    `productionize` writes `app/compose.prod.yaml`, but `forge deploy` defaulted `--compose-file` to
    `compose.prod.yaml` at the workspace root and couldn’t find it. `forge deploy` now defaults to
    **`app/compose.prod.yaml`** (the single-app layout `provision` uses), so a plain
    `forge productionize` → `forge deploy` works end-to-end and the compose’s relative bind-mounts
    resolve from `./app`.
  - **P7.3 — declared C2 scheduled jobs are now mounted into the sidecar.** The generated sidecar
    set `FORGE_JOBS_FILE` but never mounted the file, so scheduled jobs never registered in prod.
    When the app declares jobs (a `forge.jobs.json` at the repo root), the compose now bind-mounts it
    read-only into the data-plane (`./forge.jobs.json:/app/forge.jobs.json:ro`) and pins
    `FORGE_JOBS_FILE` at it, so C2 registers them on boot (their `ScheduledJob` state persists on the
    `forge_state` volume). With no jobs declared the `FORGE_JOBS_FILE` seam stays optional.

## [0.11.0] — 2026-07-07

### Added
- **`forge productionize` — generate the app’s canonical production artifacts (C8).** A new
  control-plane `Productionize` Capability (HTTP `POST /capabilities/productionize`,
  `forge productionize --app <app> --host <domain> [--readiness-path /api/health]
  [--web-image <ref@sha256:…>] [--data-plane-image <ref@sha256:…>] [--cert-resolver <name>]`) that
  EMITS files — like `provision` generates the dev `compose.yaml`; nothing new runs in prod. It
  writes, into the app repo:
  - a multi-stage **`Dockerfile`** that builds a slim runtime image from Next’s
    `output: 'standalone'` (no build tooling in the runner, non-root, `CMD ["node","server.js"]`)
    and a matching **`.dockerignore`**;
  - **`output: 'standalone'`** set in the app’s Next config — injected idempotently, never clobbering
    a hand-set `output` (a config is created if the app has none);
  - **`compose.prod.yaml`** — the CANONICAL production stack, derived from the app’s declared `infra`
    (postgres/redis/secrets, per P1) + `--host`: the **Traefik** ingress labels (host rule + the
    `loadbalancer.healthcheck` that **C7 Deploy** gates on), `stop_grace_period`, the external
    `proxy` network, the **Forge data-plane sidecar** (C3/C4 — reached at `http://data-plane:3718`
    via `FORGE_DATA_PLANE_URL`, state on a volume), and the **DB** service (healthcheck names the db).
    It is **exactly what `forge deploy` rolls**;
  - **`.env.prod.example`** documenting the values `.env.prod` must supply (never a real secret).

  **Idempotent + convergent** like `provision`: the converged production config (host, readiness
  path, image pins, cert resolver) is persisted under `forge.app.json` `production`, so a flag-less
  re-run reproduces byte-identical artifacts and never resets a value it isn’t given. **R1:** the
  generated compose references only **digest-pinned** images (`ref@sha256:…`) for the web and
  data-plane services — a non-digest `--web-image`/`--data-plane-image` (or a bare tag / `latest`) is
  rejected `422 invalid_input`; postgres/redis use the same fixed tags `provision` uses. A new
  `ProductionArtifacts` Resource + `ProductionArtifactsGenerated` Event record what was generated.
  Pairs with **C7 Deploy**; additive — no change to already-adopted capabilities. Consumers replace
  their hand-authored `app/Dockerfile` + `compose.prod.yaml` (and any template deploy-image staging)
  with this generator’s output.

## [0.10.0] — 2026-07-07

### Added
- **`forge secrets unset` — remove/revoke a secret (P2, C5 follow-up).** C5 shipped `secrets set`/
  `list` but no way to remove a secret; this adds `forge secrets unset --app <app> --name <NAME>`
  (a new `UnsetSecret` Capability, HTTP `POST /capabilities/unset-secret { app, name }`). It deletes
  the encrypted entry from the app's vault and retires the `Secret` Resource, emitting a `SecretUnset`
  fact (name only). **Idempotent** (unsetting an absent secret succeeds), `404 not_found` for an
  unknown app, `422 invalid_input` for an invalid name, and it **never logs, echoes, or returns the
  value**. Served on both planes like `set-secret`, so a live `unset` revokes the key the running app
  reads — its next lookup sees it absent and degrades (e.g. `agent-run` → `503`).

### Fixed
- **`forge build` then `forge dev` no longer corrupts the shared `.next` (P4).** `next build`
  (production) and `next dev` (development) both write `.next`, which Forge runs over the same
  bind-mounted directory — so a build-then-dev sequence left the dev server loading stale production
  chunks and 500ing every route (`Cannot find module './chunks/vendor-chunks/next.js'`), recoverable
  only by manually wiping `.next`. `RunDevServer` now detects a leftover **production** `.next` (by
  its build-only markers — `BUILD_ID` / `required-server-files.json` / `prerender-manifest.json`) and
  resets it before starting dev, so the build→dev order can never corrupt dev state. A dev-mode
  `.next` is left untouched (the cache stays warm); the reset is reported on `DevServerStarted`.
  Transparent to apps on the image bump — no app change or reprovision.
- **The C4 notification store is now safe under concurrent writes (P5).** Each mutation
  (`POST /notifications`, `/notifications/dismiss`, `/notifications/clear`) is a read-modify-write of
  the whole per-app list; that RMW was **not atomic**, so concurrent writes — even to different keys —
  lost updates (identical GETs returned different subsets). Mutations now run under a **per-app async
  mutex** so the RMW is serialized, and the store file is replaced **atomically** (temp + rename) so a
  concurrent reader never sees a half-written file. Concurrent `upsert`/`dismiss`/`clear` to distinct
  keys all persist. Contract unchanged; transparent on image bump.

## [0.9.0] — 2026-07-06

### Added
- **Platform capability C1 — Agent runtime (model access + Agent Task / Artifact resources).** A new
  `AgentRun` Capability + `model-anthropic` Implementation lets the running app invoke a model with a
  **system prompt + user input + an enforced output schema** and get back the **parsed structured
  result** — the platform absorbs the model SDK so apps don't carry one. Data-plane capability
  (`plane: 'data'`): served by the data-plane sidecar in prod and by the control plane in `forge dev`,
  the established app→Forge HTTP pattern.
  - `POST /capabilities/agent-run { app?, capability, system, input, schema, model?, max_tokens? }`
    → `{ capability: "AgentRun", resource: <AgentTask> }`. `capability` is a free-form **label/kind**
    (generic — no goal/planner domain concepts); `app` defaults to the sidecar's `FORGE_APP_NAME`, so
    the app usually needn't pass it. Structured output is enforced provider-natively via a forced
    tool whose `input_schema` is the caller's **JSON Schema**; the model's output is **untrusted** and
    returned (not acted on) so the consumer can post-validate it.
  - **Durable run records.** Every run — success *and* failure — is persisted as an inspectable
    **`AgentTask`** Resource (`id` = runId, `label`/kind, `status`, `model`, `artifact`, `error`,
    `created_at`); a successful run's result is a first-class **`Artifact`** Resource (the parsed
    result + the schema it conformed to), referenced by `AgentTask.artifact_id` and echoed inline on
    the run. Survives restart; observable via `forge inspect agent-runs --app <app>` and
    `/resources?type=AgentTask|Artifact`. Emits `AgentRunSucceeded` / `AgentRunFailed` /
    `ArtifactCreated` facts.
  - **Detectable absence → graceful degradation.** The model key is the C5 secret `ANTHROPIC_API_KEY`,
    resolved from Forge's encrypted vault (falling back to the runtime env). When it is
    absent/unconfigured, `agent-run` returns **`503 dependency_unavailable`** (a typed error, never an
    unhandled throw), so the consuming app can return 503 and never crash. Defaults to
    `claude-opus-4-8`; the caller may specify `model`. Implemented with native `fetch` (no new
    dependency) so both images stay slim.

## [0.8.0] — 2026-07-07

### Added
- **Platform capability C4 — Notifications.** A durable, per-app notification store the running app
  drives over HTTP (on **both** the control-plane API and the data-plane sidecar, like C3):
  - `POST /notifications { app?, key, title, body?, data?, subject? }` — upsert by stable `key`
    (idempotent; re-deriving the same condition updates in place and **preserves `dismissed` +
    `created_at`**, so a still-true dismissed notification never resurfaces).
  - `POST /notifications/dismiss { app?, key }` — dismissal **persists** (leaves the active feed but
    not `?include_dismissed=`).
  - `POST /notifications/clear { app?, key }` — remove one whose condition no longer applies.
  - `GET /notifications?app=&include_dismissed=` — the active feed, newest-first.

  The app owns WHICH conditions matter (derivation stays domain); Forge owns produce/track/dismiss/
  clear. A scheduled job (C2) can upsert while the user is away, so the inbox/badge is current before
  they open the app. Observable via `forge inspect notifications`.

## [0.7.0] — 2026-07-06

### Added
- **Platform capability C3 — Application event log.** A running app can now emit its own typed
  DOMAIN events and query them back as a per-app feed, via new routes on **both** the control-plane
  API (dev) and the data-plane sidecar (prod) — the first *app→Forge* direction:
  - `POST /app-events { app?, type, subject?, data? }` — best-effort emit (a failed emit must never
    break the mutation that triggered it).
  - `GET /app-events?app=&subject=&limit=` — the feed, newest-first, filterable by subject.
  - `GET /app-events/latest?app=` — latest event time per subject (the primitive cold-subject /
    "stale goal" detection needs).

  App events (`AppEvent`) are an open-`type`, subject-keyed, denormalized fact log kept in a per-app
  `app-events/<app_id>.jsonl` — deliberately separate from the platform's closed `ForgeEvent`
  catalog (facts about *Resources*). Observable via `forge inspect app-events --app <app>`. `app`
  defaults to the sidecar's `FORGE_APP_NAME`, so the app usually needn't pass it.

## [0.6.1] — 2026-07-06

### Fixed
- **`Deploy` no longer requires a registered Application.** Deploy targets a production
  compose stack at the project root, and a deploy host may never have run `forge init` — so
  `--app` is now a soft label (resolved if present, else the `Deployment` is recorded with no
  `app_id`) instead of a hard `resolveApp` that 404s. Lets `forge deploy` run on a host that
  carries only the manifests + images (e.g. via a transiently-started control plane).

## [0.6.0] — 2026-07-06

### Added
- **Platform capability C7 — Deploy (zero-downtime rollout).** A new `Deploy`
  Capability + `deploy-compose-rollout` Implementation performs a **start-first**
  release of an app's production stack behind a reverse proxy (Traefik): it
  reconciles the non-public services in place, then rolls the public `--service`
  (default `web`) by bringing up a new replica alongside the old, waiting until it
  is **healthy**, draining the old out of the proxy network, and removing it — so
  there is never a moment with zero healthy backends (no 502 window). A new replica
  that never becomes healthy is discarded and the old one keeps serving (automatic
  rollback → `DeploymentRolledBack`). Drive it with `forge deploy --app <app>
  [--service <s>] [--context <docker-context>] [--compose-file <f>]`; each deploy is
  a `Deployment` Resource recording old→new container ids + outcome, emitting
  `DeploymentStarted` / `DeploymentCompleted` / `DeploymentRolledBack` facts.
  Targets the local Docker daemon by default; `--context` targets a remote daemon
  over Docker's native transport. Ports the proven forge-os `deploy/rollout.sh`
  into the platform so apps **consume** the behavior instead of copying the script.

## [0.5.1] — 2026-07-06

### Fixed
- **Generated Postgres healthcheck now names the database.** `generateCompose` emitted
  `pg_isready -U forge` with no `-d`, which probes a database named after the *user* (`forge`)
  — but the db is the app name (e.g. `forge_os`). For any app whose name isn't `forge`, every
  10s healthcheck logged a harmless-but-alarming `FATAL: database "forge" does not exist`. Now
  emits `pg_isready -U forge -d <db>`. Re-run `forge provision` to regenerate `compose.yaml`.

## [0.5.0] — 2026-07-06

### Added
- **Data-plane image + deployment split (R3).** A `plane` field on the Capability contract
  (`control` / `data` / `both`) classifies each capability, and a new **data-plane server**
  (`src/data-plane/server.ts`) exposes only the data-plane capabilities (scheduler C2, secrets
  store C5, and read/observe surfaces) and runs the scheduler — no build/test/lint/provision.
- A slim **`forge-data-plane`** image (`Dockerfile.data-plane`, ~403 MB vs the control plane's
  ~799 MB): no Docker CLI, no dev dependencies. Published multi-arch by a new **continuous**
  workflow (on push to `main` → `:latest` + `:sha-…`, and on version tags → `:X.Y.Z`).
- The scheduler reaches the app in production via `FORGE_APP_CALLBACK_HOST` /
  `FORGE_APP_CALLBACK_PORT` (sidecar mode, no provisioned state), and the data plane can register
  jobs from a mounted `FORGE_JOBS_FILE` at boot.

## [0.4.0] — 2026-07-06

### Added
- **Platform capability C2 — Scheduler / background jobs.** A new `ScheduleJob`
  Capability + `scheduler-node` Implementation (an in-process ticker in the always-on
  control plane): register durable **recurring** (`--every <dur>` or `--cron "<expr>"`,
  evaluated in UTC) or **one-shot** (`--at <iso>`) jobs that Forge fires on cadence by
  calling back into the app (`--target <path>`). Jobs are `ScheduledJob` Resources, so
  the ticker resumes across restarts (a job due while the plane was down fires on the
  next tick); a failed run retries with backoff, then skips to the next fire. Manage and
  observe with `forge schedule` / `forge jobs` (and `inspect jobs`); every run records a
  `JobRan` / `JobRunFailed` event. The app callback host is `host.docker.internal` by
  default (override with `FORGE_APP_CALLBACK_HOST`).

## [0.3.0] — 2026-07-06

### Fixed
- **`provision` is no longer destructive (P1).** It now **converges** the desired
  environment from `forge.app.json` (+ this call's flags) instead of regenerating
  `compose.yaml` from *only* the flags, so a flag-less re-provision no longer silently
  drops a service (e.g. Postgres and its data volume) or resets a host-port remap. Apps
  provisioned before this fix are recovered from their existing `compose.yaml` on the
  first re-provision. Dropping a data-volume service now requires an explicit `--force`.

### Added
- `provision` persists the desired infra (postgres / redis / secrets / host-ports) under
  an `infra` key in `forge.app.json`, so a re-provision needs no flags. New flags:
  `--without-postgres` / `--without-redis` (explicit removal), `--postgres-port` /
  `--redis-port` / `--web-port` (host-port overrides), and `--force`. `inspect app` now
  surfaces the persisted `infra`.
- `CHANGELOG.md` following Keep a Changelog + SemVer; the `add-platform-capability` skill
  maintains it automatically as part of shipping each capability.

### Changed
- The publish workflow builds **multi-arch** images (`linux/amd64` + `linux/arm64`) via
  QEMU + buildx, so control-plane images run natively on arm64 (Apple Silicon) dev hosts
  as well as x86 servers; `0.2.0` was republished multi-arch and all future images are
  multi-arch.

## [0.2.0] — 2026-07-06

### Added
- **Platform capability C5 — Secrets / credential management.** New `SetSecret`
  Capability and `secrets-local` Implementation (AES-256-GCM): an app declares the
  secrets it needs (`forge provision --app <app> --secret <NAME>`, or a `"secrets"`
  array in `forge.app.json`), Forge stores them encrypted under the gitignored state
  dir, and injects the decrypted values into the app's `docker compose` process at
  `forge dev` — never into a tracked file or an image layer. The `Secret` Resource
  records only that a secret is set (name + status), never its value.
- `forge secrets set` / `forge secrets list` CLI commands and a `forge inspect secrets`
  view (names only).
- `add-platform-capability` skill — codifies the platform-builder's relay turn
  (read the ledger → build the next capability → publish a pinned image → fill the
  Delivery block → emit a forge-os adoption prompt).

### Changed
- `ProvisionEnvironment` accepts declared secrets and emits an empty-by-default
  `- <NAME>=${<NAME>:-}` interpolation line per secret, so an unset secret is detectable
  and the app degrades gracefully (e.g. returns 503) instead of crashing. Apps that
  declare no secrets are byte-for-byte unchanged.

## [0.1.1] — 2026-07-05

### Added
- Single-app `./app` workspace layout via `FORGE_APP_LAYOUT=single`: every repo holds
  exactly one app at `./app`, and a second `init` is rejected.

### Changed
- `appDir()` resolves to `./app` in single-app mode; any other value keeps the
  multi-app `./apps/<name>` layout, so existing projects are unaffected.

## [0.1.0] — 2026-07-05

### Added
- Initial Forge v1 control plane: a Docker-first, API-first platform (Fastify API,
  filesystem-backed Resource/Event store) that can initialize, provision, install, run,
  build, test, lint, inspect, explain failures for, and plan a Dockerized Next.js app,
  driven by a thin `./forge` CLI.

[Unreleased]: https://github.com/mardash-ai/forge/compare/v0.50.0...HEAD
[0.50.0]: https://github.com/mardash-ai/forge/compare/v0.49.0...v0.50.0
[0.49.0]: https://github.com/mardash-ai/forge/compare/v0.48.0...v0.49.0
[0.48.0]: https://github.com/mardash-ai/forge/compare/v0.47.0...v0.48.0
[0.47.0]: https://github.com/mardash-ai/forge/compare/v0.46.0...v0.47.0
[0.46.0]: https://github.com/mardash-ai/forge/compare/v0.45.1...v0.46.0
[0.45.1]: https://github.com/mardash-ai/forge/compare/v0.45.0...v0.45.1
[0.45.0]: https://github.com/mardash-ai/forge/compare/v0.44.0...v0.45.0
[0.44.0]: https://github.com/mardash-ai/forge/compare/v0.43.0...v0.44.0
[0.43.0]: https://github.com/mardash-ai/forge/compare/v0.42.0...v0.43.0
[0.42.0]: https://github.com/mardash-ai/forge/compare/v0.41.0...v0.42.0
[0.41.0]: https://github.com/mardash-ai/forge/compare/v0.40.0...v0.41.0
[0.40.0]: https://github.com/mardash-ai/forge/compare/v0.39.0...v0.40.0
[0.39.0]: https://github.com/mardash-ai/forge/compare/v0.38.0...v0.39.0
[0.38.0]: https://github.com/mardash-ai/forge/compare/v0.37.0...v0.38.0
[0.37.0]: https://github.com/mardash-ai/forge/compare/v0.36.0...v0.37.0
[0.36.0]: https://github.com/mardash-ai/forge/compare/v0.35.0...v0.36.0
[0.35.0]: https://github.com/mardash-ai/forge/compare/v0.34.0...v0.35.0
[0.34.0]: https://github.com/mardash-ai/forge/compare/v0.33.0...v0.34.0
[0.33.0]: https://github.com/mardash-ai/forge/compare/v0.32.0...v0.33.0
[0.32.0]: https://github.com/mardash-ai/forge/compare/v0.31.0...v0.32.0
[0.31.0]: https://github.com/mardash-ai/forge/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/mardash-ai/forge/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/mardash-ai/forge/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/mardash-ai/forge/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/mardash-ai/forge/compare/v0.26.5...v0.27.0
[0.26.5]: https://github.com/mardash-ai/forge/compare/v0.26.4...v0.26.5
[0.26.4]: https://github.com/mardash-ai/forge/compare/v0.26.3...v0.26.4
[0.26.3]: https://github.com/mardash-ai/forge/compare/v0.26.2...v0.26.3
[0.26.2]: https://github.com/mardash-ai/forge/compare/v0.26.1...v0.26.2
[0.26.1]: https://github.com/mardash-ai/forge/compare/v0.26.0...v0.26.1
[0.26.0]: https://github.com/mardash-ai/forge/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/mardash-ai/forge/compare/v0.24.1...v0.25.0
[0.24.1]: https://github.com/mardash-ai/forge/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/mardash-ai/forge/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/mardash-ai/forge/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/mardash-ai/forge/compare/v0.21.1...v0.22.0
[0.21.1]: https://github.com/mardash-ai/forge/compare/v0.21.0...v0.21.1
[0.21.0]: https://github.com/mardash-ai/forge/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/mardash-ai/forge/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/mardash-ai/forge/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/mardash-ai/forge/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/mardash-ai/forge/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/mardash-ai/forge/compare/v0.15.1...v0.16.0
[0.15.1]: https://github.com/mardash-ai/forge/compare/v0.15.0...v0.15.1
[0.15.0]: https://github.com/mardash-ai/forge/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/mardash-ai/forge/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/mardash-ai/forge/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/mardash-ai/forge/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/mardash-ai/forge/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/mardash-ai/forge/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/mardash-ai/forge/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/mardash-ai/forge/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/mardash-ai/forge/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/mardash-ai/forge/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/mardash-ai/forge/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/mardash-ai/forge/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/mardash-ai/forge/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/mardash-ai/forge/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mardash-ai/forge/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mardash-ai/forge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mardash-ai/forge/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mardash-ai/forge/compare/defed64...v0.1.1
[0.1.0]: https://github.com/mardash-ai/forge/commit/defed64
