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
import { Agent, fetch as undiciFetch } from 'undici';

export const DEFAULT_LOCAL_API_URL = 'http://127.0.0.1:3717';

// FORGE_API_URL wins when set (e.g. a remote control plane); otherwise default to the
// co-located API over the IPv4 loopback literal.
export function resolveApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.FORGE_API_URL ?? DEFAULT_LOCAL_API_URL;
}

// P22 — a LONG-RUNNING capability request (the only one today is `forge release`) blocks the
// HTTP response while the server does real work: publish POLLS GHCR for the commit's image up
// to `--timeout` (default 600s), then repin → deploy → verify. Node's global `fetch` (which in
// Node ≥ 22 uses an internal undici, not the standalone package) applies a DEFAULT
// `headersTimeout`/`bodyTimeout` of 300s to EVERY request, so a real release whose server work
// runs past 300s before it can send response headers has its fetch ABORTED with
// `UND_ERR_HEADERS_TIMEOUT` — which the CLI's `api()` catch reports as
// "Cannot reach Forge API ... TypeError: fetch failed", even though the API is perfectly
// healthy. The `--dry-run` path assesses + prints the plan and returns in ~1s, so it NEVER
// approaches the ceiling: that wait-time gap is the ENTIRE dry-vs-real divergence (and why the
// failure is box-specific — a box where the commit's image is already resolvable skips the
// publish poll and finishes fast).
//
// The fix: use undici's OWN fetch (not the global) with an Agent that has no timeout. The
// global `fetch` in Node.js v22+ is backed by an INTERNAL undici that ignores the `dispatcher`
// option from the standalone undici package — so passing a standalone Agent to the global fetch
// results in `InvalidArgumentError: invalid onError method` on Node.js v26+. Calling undici's
// own `fetch` directly avoids this version-skew. Same URL, same IP, no timeout ceiling.
// The CLI still waits exactly as long as the server legitimately needs (the server keeps its
// own bounded budget via `--timeout`).

// Build a fresh no-timeout undici Agent. Exposed for tests; the CLI uses the shared singleton.
export function makeLongRunningDispatcher(): Agent {
  return new Agent({ headersTimeout: 0, bodyTimeout: 0 });
}

// The Agent the CLI uses for long-running capability requests.
export const longRunningDispatcher: Agent = makeLongRunningDispatcher();

// A fetch that bypasses the global fetch's 300 s ceiling by using undici's own fetch directly
// with the no-timeout dispatcher. The CLI uses this for `forge release` (and any future
// long-running capability); tests can use it to verify the dispatcher behaviour.
export async function longRunningFetch(
  url: string,
  init?: Omit<RequestInit, 'dispatcher'>,
): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher: longRunningDispatcher }) as unknown as Promise<Response>;
}
