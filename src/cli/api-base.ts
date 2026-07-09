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
export const DEFAULT_LOCAL_API_URL = 'http://127.0.0.1:3717';

// FORGE_API_URL wins when set (e.g. a remote control plane); otherwise default to the
// co-located API over the IPv4 loopback literal.
export function resolveApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.FORGE_API_URL ?? DEFAULT_LOCAL_API_URL;
}
