---
bump: minor
---

### Added

- **Per-IP + per-account rate limiting** on all public OAuth/auth/MCP endpoints (`POST /oauth/register`, `POST /oauth/token`, `GET`+`POST /oauth/authorize`, `POST /auth/login`, `POST /auth/signup`, `POST /auth/forgot`, `/mcp`). Default mode is **log-only / dry-run** (never rejects); set `FORGE_RATE_LIMIT_MODE=enforce` to activate 429 responses with `Retry-After` headers. All ceilings are env-configurable via `FORGE_RATE_LIMIT_*` variables.
- **Per-account login escalation**: failed login attempts trigger growing backoff (3 failures → 5 s, 5 → 30 s, 10 → 5 min). Keyed on the target email so rotating source IPs can't bypass it. Thresholds and durations are env-overridable.
- **SSE concurrency cap** (`FORGE_RATE_LIMIT_SSE_PER_CLIENT`, default 5) per `(appId, clientId)` — prevents a single connector from exhausting server-sent-event slots.
- `src/shared/rate-limit.ts` — standalone sliding-window rate-limit module; no Fastify dependency; both modes fully unit-tested in `tests/rate-limit.test.ts`.
- **DCR garbage collection** (`gcStaleClients`): deletes OAuth clients that were registered but never consented to (i.e., abandoned flows) after `DCR_GC_MAX_AGE_DAYS` days (default 30). Consented clients are **never** touched regardless of age. Operator-facing GC surface added to MCP backend: `GET /mcp/clients` (client summary) and `POST /mcp/clients/gc` (trigger GC), both service-token gated.
- `src/shared/dcr-gc.ts` — DCR GC implementation; proven on seeded stale clients in `tests/dcr-gc.test.ts`.
- `listClients`, `deleteClient`, `listConsentedClientIds` added to `McpBackend` interface and implemented on `FsMcpBackend`, `PgMcpBackend`, and `DualWriteMcpBackend`.

### Fixed

- **redirect_uri silent-filter bug**: `POST /oauth/register` previously used `Array.filter()` to silently drop non-`http(s)://` URIs, causing a 201 whose stored `redirect_uris` differed from the sent list — leading to a 400 at the `/oauth/authorize` step. The fix: if ANY URI in the request is non-`http(s)://`, the whole registration is rejected with `400 invalid_redirect_uri`. Proven with a register→authorize round-trip guard and RED-first tests in `tests/redirect-uri-fix.test.ts`.
