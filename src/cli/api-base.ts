// Resolve the base URL the Forge CLI uses to reach the co-located control-plane API.
//
// P20 — the CLI runs INSIDE the control-plane container (see the ./forge wrapper,
// `docker compose exec … src/cli/index.ts`) and dials the API over loopback. It MUST
// use the IPv4 literal `127.0.0.1`, NOT the name `localhost`:
//   - The API binds IPv4 `0.0.0.0` (see src/api/server.ts → app.listen({ host: '0.0.0.0' })).
//   - On the base image `localhost` resolves to IPv6 `::1` FIRST
//     (`getent hosts localhost` → `::1  localhost …`), and Node 22 keeps DNS results in
//     resolver order by default (`dns.setDefaultResultOrder('verbatim')`).
//   - So `fetch('http://localhost:3717')` dials `[::1]:3717`, which the IPv4-only server
//     refuses (ECONNREFUSED). Happy-Eyeballs' IPv4 fallback did not fire within the
//     release fetch's window, so `forge release` reported "Cannot reach Forge API" even
//     though a healthy API was listening on 127.0.0.1.
// Dialing `127.0.0.1` matches the bind with no `::1` detour and no reliance on fallback.
import { Agent } from 'undici';

export const DEFAULT_LOCAL_API_URL = 'http://127.0.0.1:3717';

// FORGE_API_URL wins when set (e.g. a remote control plane); otherwise default to the
// co-located API over the IPv4 loopback literal.
export function resolveApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.FORGE_API_URL ?? DEFAULT_LOCAL_API_URL;
}

// P22 — a LONG-RUNNING capability request (the only one today is `forge release`) blocks the
// HTTP response while the server does real work: publish POLLS GHCR for the commit's image up
// to `--timeout` (default 600s), then repin → deploy → verify. Node's global `fetch` (undici)
// applies a DEFAULT `headersTimeout`/`bodyTimeout` of 300s to EVERY request, so a real release
// whose server work runs past 300s before it can send response headers has its fetch ABORTED
// with `UND_ERR_HEADERS_TIMEOUT` — which the CLI's `api()` catch reports as
// "Cannot reach Forge API ... TypeError: fetch failed", even though the API is perfectly
// healthy. The `--dry-run` path assesses + prints the plan and returns in ~1s, so it NEVER
// approaches the ceiling: that wait-time gap is the ENTIRE dry-vs-real divergence (and why the
// failure is box-specific — a box where the commit's image is already resolvable skips the
// publish poll and finishes fast).
//
// The fix keeps real on the SAME connection dry-run already uses successfully — same
// `resolveApiBaseUrl` (127.0.0.1), same global `fetch` — and only removes the premature
// client-side ceiling by dispatching through an Agent with `headersTimeout`/`bodyTimeout` = 0
// (unlimited). No alternate client, no global dispatcher swap, no re-derived URL. The CLI
// still waits exactly as long as the server legitimately needs (the server keeps its OWN
// bounded budget via `--timeout`).
type FetchDispatcher = NonNullable<RequestInit['dispatcher']>;

// Build a fresh no-timeout dispatcher. Exposed for tests; the CLI uses the shared singleton.
export function makeLongRunningDispatcher(): FetchDispatcher {
  return new Agent({ headersTimeout: 0, bodyTimeout: 0 }) as unknown as FetchDispatcher;
}

// The dispatcher the CLI attaches to a long-running capability request. Shared by BOTH the
// dry-run and the real release call, so their connection is byte-for-byte identical.
export const longRunningDispatcher: FetchDispatcher = makeLongRunningDispatcher();
