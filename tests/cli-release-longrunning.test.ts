import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { resolveApiBaseUrl, longRunningDispatcher, makeLongRunningDispatcher } from '../src/cli/api-base';

// P22 — `forge release` is a LONG-RUNNING capability: the API request blocks while the server
// publishes (polls GHCR for the commit's image up to `--timeout`, default 600s), repins,
// deploys, and verifies. Node's global `fetch` (undici) applies a DEFAULT headers/body timeout
// of 300s to EVERY request, so a real release whose server work exceeds that ceiling before it
// can send response headers has its fetch ABORTED with `UND_ERR_HEADERS_TIMEOUT` — which the
// CLI reports as "Cannot reach Forge API at http://127.0.0.1:3717 ... TypeError: fetch failed",
// even though the API is healthy. `--dry-run` assesses + prints the plan and returns in ~1s, so
// it NEVER approaches the ceiling: that wait-time gap is the entire dry-vs-real divergence (and
// why the failure is box-specific — a box where the image is already resolvable skips the wait).
//
// The fix keeps real on the SAME connection dry-run already uses (same `resolveApiBaseUrl`, same
// global `fetch`) and only removes the premature client-side ceiling by dispatching through an
// Agent with `headersTimeout`/`bodyTimeout` = 0. These tests reproduce the abort against a
// deliberately slow server and prove the shared dispatcher lets the same response through.

describe('release long-running dispatcher (P22)', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  afterAll(async () => {
    // The CLI's shared singleton keeps a keep-alive pool; close it so the worker exits clean.
    await (longRunningDispatcher as unknown as Agent).close();
  });

  // A server that consumes the request then delays ALL response headers by `delayMs` — mimics
  // the platform holding the connection open while a real release's publish phase waits on GHCR.
  async function startSlowServer(delayMs: number): Promise<number> {
    server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () =>
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        }, delayMs),
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return (server!.address() as AddressInfo).port;
  }

  it('the no-timeout dispatcher is configured with headers/body timeout disabled', () => {
    // A distinct instance to introspect without touching the shared singleton's pool.
    const disp = makeLongRunningDispatcher() as unknown as { [k: symbol]: unknown };
    const opts = Object.getOwnPropertySymbols(disp)
      .map((s) => disp[s])
      .find((v): v is { headersTimeout: number; bodyTimeout: number } =>
        typeof v === 'object' && v !== null && 'headersTimeout' in v && 'bodyTimeout' in v,
      );
    expect(opts?.headersTimeout).toBe(0);
    expect(opts?.bodyTimeout).toBe(0);
  });

  it('a short client headers timeout ABORTS a slow release response — the exact `fetch failed` bug', async () => {
    const port = await startSlowServer(2500);
    // Stands in (scaled down) for undici's 300s default being shorter than the server's work.
    const ceiling = new Agent({ headersTimeout: 1000, bodyTimeout: 1000 });
    try {
      await expect(
        fetch(`http://127.0.0.1:${port}/capabilities/release`, {
          method: 'POST',
          body: JSON.stringify({ dry_run: false }),
          dispatcher: ceiling,
        }),
      ).rejects.toThrow(/fetch failed/);
    } finally {
      await ceiling.close();
    }
  });

  it('longRunningDispatcher lets the SAME slow release response through — the fix', async () => {
    const port = await startSlowServer(2500);
    const res = await fetch(`http://127.0.0.1:${port}/capabilities/release`, {
      method: 'POST',
      body: JSON.stringify({ dry_run: false }),
      dispatcher: longRunningDispatcher,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('dry-run and real both dial the release endpoint on resolveApiBaseUrl through the same dispatcher', async () => {
    const port = await startSlowServer(50);
    const url = `http://127.0.0.1:${port}/capabilities/release`;
    // Only the body differs between the two modes — same URL, same client, same dispatcher.
    for (const dry of [true, false]) {
      const res = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ dry_run: dry }),
        dispatcher: longRunningDispatcher,
      });
      expect(res.status).toBe(200);
    }
    // The CLI composes this endpoint from resolveApiBaseUrl (the P20 IPv4 loopback default).
    expect(`${resolveApiBaseUrl({})}/capabilities/release`).toBe('http://127.0.0.1:3717/capabilities/release');
  });
});
