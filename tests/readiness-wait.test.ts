import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  waitForHealthReady,
  READINESS_INTERVAL_MS,
  type HealthProbeResult,
} from '../src/shared/health-probe';
import { runContractChecks } from '../src/shared/contract-checks';
import { verify } from '../src/capabilities/verify/index';
import { releaseCapability } from '../src/capabilities/release/index';

// P28 — the post-deploy WARM-UP readiness gate. `waitForHealthReady` polls a health URL with a
// bounded, backed-off retry until it answers a clean C6 200, so a start-first roll's warm-up window
// can't false-red a `verify`/`release`. These are deterministic: an in-process fake app returns a
// scripted sequence of health responses (per health-path hit), and the wait's INJECTABLE clock/sleep
// make timing exact with no real waiting — so budget/backoff/no-overrun are asserted precisely.

const C6_OK = { status: 'ok', service: 'demo', time: '2026-01-01T00:00:00.000Z', checks: [{ name: 'db', status: 'ok' }] };

let server: http.Server | undefined;

// A fake "deployed app" whose /api/health answers a SCRIPTED sequence keyed on the health-hit index
// (0-based), so non-health probes (page/api/…) never consume a health response. Everything else 404s.
async function startApp(healthResponder: (healthHit: number) => [number, unknown]): Promise<string> {
  let h = 0;
  server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url === '/api/health') {
      const [status, body] = healthResponder(h++);
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(body));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found' } }));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

// A deterministic virtual clock: `now` reads it, `sleep` advances it (and records the amount), so a
// test never actually waits and can assert the exact sleep sequence + total waited.
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

describe('P28 waitForHealthReady — the readiness poll', () => {
  it('(a) returns ready on the FIRST clean C6 200, with no waiting', async () => {
    const base = await startApp(() => [200, C6_OK]);
    const clk = fakeClock();
    const attempts: number[] = [];
    const res = await waitForHealthReady(`${base}/api/health`, {
      timeoutMs: 30_000,
      now: clk.now,
      sleep: clk.sleep,
      onAttempt: (n) => attempts.push(n),
    });
    expect(res.ready).toBe(true);
    expect(res.attempts).toBe(1);
    expect(res.waitedMs).toBe(0);
    expect(clk.sleeps).toHaveLength(0); // a ready app is never slept on
    expect(attempts).toEqual([1]);
  });

  it('(b) backs off and retries through transient misses until a clean 200', async () => {
    // hit 0: unreachable-style 503; hit 1: reachable 200 but NON-conforming; hit 2: clean C6 200.
    const base = await startApp((i) =>
      i === 0 ? [503, { error: 'warming up' }] : i === 1 ? [200, { status: 'ok' }] : [200, C6_OK],
    );
    const clk = fakeClock();
    const readySeen: boolean[] = [];
    const res = await waitForHealthReady(`${base}/api/health`, {
      timeoutMs: 30_000,
      intervalMs: 2_000,
      now: clk.now,
      sleep: clk.sleep,
      onAttempt: (_n, p: HealthProbeResult) =>
        readySeen.push(p.reachable === true && p.httpStatus === 200 && p.conforms === true),
    });
    expect(res.ready).toBe(true);
    expect(res.attempts).toBe(3);
    // two backed-off sleeps between the three attempts: 2000, then 2000*1.5 = 3000.
    expect(clk.sleeps).toEqual([2_000, 3_000]);
    expect(res.waitedMs).toBe(5_000);
    // the 503 and the non-conforming 200 both read as "not ready"; only the third is ready.
    expect(readySeen).toEqual([false, false, true]);
  });

  it('(c) respects the time budget: returns not-ready WITHOUT overrunning the deadline', async () => {
    const base = await startApp(() => [503, { error: 'never ready' }]); // always a miss
    const clk = fakeClock();
    const res = await waitForHealthReady(`${base}/api/health`, {
      timeoutMs: 2_500,
      intervalMs: 2_000,
      now: clk.now,
      sleep: clk.sleep,
    });
    expect(res.ready).toBe(false);
    // the final sleep is CLAMPED to the remaining budget (500), not the 3000 backoff, so the
    // total waited lands exactly on — and never past — the 2500ms deadline.
    expect(clk.sleeps).toEqual([2_000, 500]);
    expect(res.waitedMs).toBe(2_500);
    expect(res.waitedMs).toBeLessThanOrEqual(2_500);
    expect(res.attempts).toBe(3);
  });

  it('(d) is a true no-op at timeoutMs <= 0 — one probe, no waiting', async () => {
    const base = await startApp(() => [503, { error: 'down' }]);
    const clk = fakeClock();
    const res = await waitForHealthReady(`${base}/api/health`, {
      timeoutMs: 0,
      now: clk.now,
      sleep: clk.sleep,
    });
    expect(res.ready).toBe(false);
    expect(res.attempts).toBe(1); // exactly one probe
    expect(clk.sleeps).toHaveLength(0); // and it never sleeps/retries
    expect(res.waitedMs).toBe(0);
  });

  it('never turns a real failure green: an app that never warms up ends not-ready', async () => {
    const base = await startApp(() => [200, { nope: true }]); // reachable, 200, but never conforms
    const clk = fakeClock();
    const res = await waitForHealthReady(`${base}/api/health`, {
      timeoutMs: 6_000,
      intervalMs: 2_000,
      now: clk.now,
      sleep: clk.sleep,
    });
    expect(res.ready).toBe(false);
    expect(res.last.conforms).toBe(false);
  });

  it('exposes a sane default poll interval', () => {
    expect(READINESS_INTERVAL_MS).toBeGreaterThan(0);
  });
});

describe('P28 the gate is wired into runContractChecks (C14 verify path)', () => {
  it('(e) waits out a warm-up miss so a briefly-not-ready app is NOT a false red', async () => {
    // health is a 503 on the first hit, a clean C6 200 afterward.
    const base = await startApp((i) => (i === 0 ? [503, { error: 'warming' }] : [200, C6_OK]));
    const report = await runContractChecks({
      baseUrl: base,
      readinessTimeoutMs: 2_000, // opt the gate ON (real, tiny interval)
      readinessIntervalMs: 5,
    });
    expect(report.assertions.find((a) => a.name === 'health')!.status).toBe('pass');
  });

  it('(e) WITHOUT the gate, the same warm-up miss is a health FAIL (proving the gate is what saves it)', async () => {
    const base = await startApp((i) => (i === 0 ? [503, { error: 'warming' }] : [200, C6_OK]));
    const report = await runContractChecks({ baseUrl: base }); // readinessTimeoutMs defaults to off
    expect(report.assertions.find((a) => a.name === 'health')!.status).toBe('fail');
  });
});

describe('P28 the readiness inputs are threaded through the capabilities', () => {
  it('(e) verify defaults readiness_timeout_ms to 0 (off for a standalone verify)', () => {
    const shape = (verify.inputSchema as unknown as {
      shape: { readiness_timeout_ms: { parse: (v: unknown) => unknown } };
    }).shape;
    expect(shape.readiness_timeout_ms.parse(undefined)).toBe(0);
  });

  it('(e) release defaults verify_readiness_timeout_ms to 30000 (on for the deploy→verify handoff)', () => {
    const shape = (releaseCapability.inputSchema as unknown as {
      shape: { verify_readiness_timeout_ms: { parse: (v: unknown) => unknown } };
    }).shape;
    expect(shape.verify_readiness_timeout_ms.parse(undefined)).toBe(30_000);
  });
});
