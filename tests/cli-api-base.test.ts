import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { DEFAULT_LOCAL_API_URL, resolveApiBaseUrl } from '../src/cli/api-base';

// P20 — the CLI (run in-container by the ./forge wrapper) must dial the API over the
// IPv4 loopback LITERAL, not the name `localhost`. The API binds IPv4 `0.0.0.0`, but on
// the base image `localhost` resolves to IPv6 `::1` first, so `fetch('http://localhost')`
// dials `[::1]` and is refused by the IPv4-only server (ECONNREFUSED) with no timely
// Happy-Eyeballs fallback. These tests lock the IPv4 default and prove the mismatch.

describe('CLI local API base URL (P20)', () => {
  it('defaults to the IPv4 loopback literal, never the `localhost` name', () => {
    expect(DEFAULT_LOCAL_API_URL).toBe('http://127.0.0.1:3717');
    const host = new URL(DEFAULT_LOCAL_API_URL).hostname;
    expect(host).toBe('127.0.0.1');
    expect(host).not.toBe('localhost');
  });

  it('resolveApiBaseUrl defaults to 127.0.0.1 and honors FORGE_API_URL', () => {
    expect(resolveApiBaseUrl({})).toBe('http://127.0.0.1:3717');
    expect(resolveApiBaseUrl({ FORGE_API_URL: 'http://api.example.com' })).toBe('http://api.example.com');
  });
});

// Reproduce the real failure with IP literals (portable — no /etc/hosts dependency):
// a server bound to IPv4 `0.0.0.0` is reachable at 127.0.0.1 but NOT at the IPv6
// loopback `::1` that `localhost` would select — which is exactly why the fix dials
// 127.0.0.1 to match the bind.
describe('IPv4 `0.0.0.0` bind vs loopback dial (P20 root cause)', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function startIPv4Server(): Promise<number> {
    server = createServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    await new Promise<void>((resolve) => server!.listen(0, '0.0.0.0', () => resolve()));
    return (server!.address() as AddressInfo).port;
  }

  it('reaches the IPv4-bound server at 127.0.0.1 (the fix host)', async () => {
    const port = await startIPv4Server();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });

  it('does NOT reach the IPv4-bound server at [::1] (why `localhost`→::1 broke release)', async () => {
    const port = await startIPv4Server();
    // The IPv4-only bind never listens on the IPv6 loopback, so a `::1` dial is refused
    // (or unreachable where IPv6 is disabled) — in all cases it throws, never 200.
    await expect(fetch(`http://[::1]:${port}/health`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  });
});
