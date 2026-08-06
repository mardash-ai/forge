# C23 — Remote MCP hosting: operator runbook + agent-facing reference

> **Status:** Shipped. `src/api/mcp-routes.ts` + `src/mcp/` + `Dockerfile.data-plane`.  
> No new secrets are required — C23 reuses the `AUTH_SESSION_SECRET` the C10 auth surface already needs.

---

## What C23 does

The data-plane sidecar hosts the consuming app's declared tool surface as a **remote MCP server**
(Streamable-HTTP / JSON-RPC 2.0) and acts as the **OAuth 2.1 authorization server** that gates it.

- The app registers its tools (`POST /mcp/tools`) and instruction text (`POST /mcp/instructions`) over
  the compose-internal network. All management routes require the app's C10 service token
  (`x-forge-service-token`).
- The sidecar serves `POST /mcp` (OAuth Bearer-gated JSON-RPC) and `GET /mcp` (OAuth Bearer-gated SSE
  stream for server→client notifications).
- An external MCP host (Claude, ChatGPT, etc.) discovers the authorization server via
  `GET /.well-known/oauth-protected-resource/mcp` (RFC 9728), performs the OAuth 2.1 flow (DCR +
  PKCE authorize + token endpoint), then calls `POST /mcp` with the scoped access token.
- Each `tools/call` is dispatched back into the app at the tool's `handler_path` (the same sidecar→app
  callback mechanism C2 uses), with the user identity, scope, and C29 governance seam context forwarded.

---

## Startup manifest-fingerprint diff

### What it is

At every sidecar boot the C23 host:

1. Loads the current tool surface from the MCP store (all tools registered for this app).
2. Computes a **SHA-256 fingerprint** over the **client-visible manifest fields**: tool names,
   description text, `input_schema`, `output_schema`, and all MCP annotation hints (`title`,
   `read_only_hint`, `destructive_hint`, `idempotent_hint`, `open_world_hint`).
   - **A description-only change flips the digest.** The fields that do NOT appear in the fingerprint
     (scope, family, handler_path, high_risk, created_at/updated_at) carry no client-visible semantics.
3. Compares the computed fingerprint against the one persisted from the **previous boot**
   (`FORGE_STATE_DIR/mcp/<appId>.fingerprint`).
4. On a **difference** (or on first boot, when no record exists): saves the new fingerprint, then calls
   `broadcastToolListChanged(appId)` — which pushes `notifications/tools/list_changed` to every SSE
   session currently connected on `GET /mcp`.
5. On **no change**: does nothing.

### Why it exists

`broadcastToolListChanged` already fires on every live `POST /mcp/tools` and `DELETE /mcp/tools/:name`
while the sidecar is running. The startup-diff check covers the case where the tool surface changes
while the sidecar is **down** (e.g. a rolling deploy where the app registers updated tools before the
new sidecar image starts). Without the startup diff, those changes would be invisible to any MCP client
until the user manually reconnects.

### Honest boundary

- **In-process broadcaster.** The `toolListSubscribers` map is module-level in-process state. The
  startup broadcast and the live register/delete broadcasts reach only sessions attached to **this
  replica**. In a horizontally scaled deployment (multiple sidecar instances), a change that hits
  replica A's boot will not notify clients attached to replica B. Fixing this requires a cross-replica
  fanout (Postgres `LISTEN`/`NOTIFY`) — not yet built. The current data-plane runs as a single instance
  per app, so this boundary does not affect production today.
- **Zero clients at cold boot.** The startup broadcast fires immediately after `app.listen()`. At a
  clean cold boot there are no connected SSE sessions yet, so `notified` is almost always `0`. The value
  of the broadcast is for **rapid-reconnect** sessions: MCP clients that detect the endpoint is back and
  immediately re-open the `GET /mcp` SSE stream will receive the notification within milliseconds of
  the server being ready.
- **Requires a live SSE session.** `notifications/tools/list_changed` is a server-PUSH on the
  `GET /mcp` SSE stream. It only reaches a client that has the stream open at the moment the broadcast
  fires. A client that uses only `POST /mcp` (no SSE stream) will never receive the notification and
  must be triggered to re-fetch `tools/list` through another mechanism (manual reconnect, or a future
  polling mode).
- **Only helps spec-compliant clients.** The MCP spec says a client SHOULD re-fetch `tools/list` upon
  receiving `notifications/tools/list_changed`. Clients that ignore this notification (or that treat the
  capability advertisement `tools.listChanged: true` as advisory) will continue to serve their cached
  surface. The production fallback for those clients remains the directory-managed update path
  (operator guides the user to reconnect the connector).

---

## `/mcp/streams` — live session dashboard

`GET /mcp/streams` (service-token gated) returns a live snapshot of the SSE sessions currently
attached to `GET /mcp` for the app. The response is read directly from the in-process registry —
there is no cache, so `count: 0` is the honest answer when no AI is holding the push channel.

```json
{
  "count": 1,
  "observed_at": "2026-08-05T12:00:00.000Z",
  "streams": [
    {
      "client_name": "Claude",
      "user_agent": "Claude-User/1.0",
      "opened_at": "2026-08-05T11:55:00.000Z",
      "held_seconds": 300
    }
  ]
}
```

---

## No new secrets

C23 requires `AUTH_SESSION_SECRET` (the C10 JWS signing key) — which productionize already wires into
the data-plane for C10. No new secret, no new productionize step.

`FORGE_MCP_PUBLIC_URL` is an optional pin (default: derived from `X-Forwarded-Host`). Set it to the
machine-facing API host (`https://api.<your-domain>`) when the MCP endpoint and the app are on
separate hostnames (see 09-deployable-consumer.md § C23 env).

---

## Consuming the startup-diff result from agent code

After a `forge deploy` or a sidecar restart, an agent managing a consumer app can query whether the
tool surface was detected as changed at boot:

```bash
# The data-plane log line (always emitted at boot):
# forge data-plane: C23 manifest fingerprint — changed=true, notified=0
docker compose -f compose.prod.yaml logs data-plane 2>&1 | grep "C23 manifest fingerprint"
```

`changed=true` with `notified=0` is the normal "tools changed during deploy" outcome — the sidecar
saw the diff and would have notified clients, but no SSE sessions were open at the instant it booted.
`changed=false` confirms the tool surface was identical to the last recorded boot.
