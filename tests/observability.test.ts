import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { executeCapability } from '../src/core/runtime';
import { SYSTEM_ACTOR } from '../src/shared/domain';
import {
  initOtelLangfuse,
  isEnabled,
  startSpan,
  withSpan,
  SpanContext,
  ATTR,
  traceparent,
  parentFromTraceparent,
  capPayload,
  PAYLOAD_CAP_BYTES,
  recordToolCallMetric,
  recordMcpRegistrationMetric,
  isMetricsEnabled,
} from '../src/plugins/otel-langfuse/index';
import type { ObservabilityStack } from '../src/resources/types';

// C36 — SetupObservability capability + OTel-Langfuse helper.
// Exercises the capability round-trip (upsert + event) and the helper's
// public API.  No real HTTP calls are made — the capability runs with
// skip_probe: true, and the helper is tested at the module level.

let dir: string;
let prevState: string | undefined;

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-obs-'));
  process.env.FORGE_STATE_DIR = dir;
  await store.init();
});

afterEach(async () => {
  if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevState;
  await rm(dir, { recursive: true, force: true });
});

// ── SetupObservability capability ──────────────────────────────────────────

describe('SetupObservability capability', () => {
  const INPUT = {
    endpoint: 'http://langfuse-web:3000/api/public/otel',
    public_key: 'pk-lf-test-public',
    secret_key: 'sk-lf-test-secret',
    skip_probe: true,
  };

  it('creates an ObservabilityStack resource with status configured (probe skipped)', async () => {
    const result = await executeCapability('setup-observability', INPUT, SYSTEM_ACTOR);
    expect(result.capability).toBe('SetupObservability');
    const obs = result.resource as ObservabilityStack;
    expect(obs.type).toBe('ObservabilityStack');
    expect(obs.id).toMatch(/^obs_/);
    expect(obs.endpoint).toBe(INPUT.endpoint);
    expect(obs.public_key).toBe(INPUT.public_key);
    expect(obs.status).toBe('configured');
    expect(obs.checked_at).toBeTruthy();
    // Secret key must never appear in the resource
    expect(JSON.stringify(obs)).not.toContain(INPUT.secret_key);
  });

  it('upserts — a second call updates rather than duplicates the resource', async () => {
    await executeCapability('setup-observability', INPUT, SYSTEM_ACTOR);
    await executeCapability('setup-observability', {
      ...INPUT,
      endpoint: 'http://langfuse-web:3000/api/public/otel',
    }, SYSTEM_ACTOR);

    const all = await store.listResources({ type: 'ObservabilityStack' });
    expect(all).toHaveLength(1);
  });

  it('records ObservabilityConfigured event carrying endpoint + public_key', async () => {
    await executeCapability('setup-observability', INPUT, SYSTEM_ACTOR);
    const allEvents = await store.listEvents({});
    const events = allEvents.filter((e) => e.type === 'ObservabilityConfigured');
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[0]!;
    expect(ev.type).toBe('ObservabilityConfigured');
    expect(ev.data.endpoint).toBe(INPUT.endpoint);
    expect(ev.data.public_key).toBe(INPUT.public_key);
    // Secret key must NOT appear in the event
    expect(JSON.stringify(ev)).not.toContain(INPUT.secret_key);
  });

  it('marks status unreachable when probe fails (probe is NOT skipped, no server running)', async () => {
    const result = await executeCapability(
      'setup-observability',
      {
        ...INPUT,
        endpoint: 'http://127.0.0.1:19999/api/public/otel', // nothing listening here
        skip_probe: false,
      },
      SYSTEM_ACTOR,
    );
    const obs = result.resource as ObservabilityStack;
    expect(obs.status).toBe('unreachable');
  });

  it('rejects missing public_key', async () => {
    await expect(
      executeCapability('setup-observability', { ...INPUT, public_key: '' }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects missing secret_key', async () => {
    await expect(
      executeCapability('setup-observability', { ...INPUT, secret_key: '' }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

// ── OTel-Langfuse plugin unit tests ────────────────────────────────────────

describe('otel-langfuse plugin: initOtelLangfuse', () => {
  // Save / restore the module-level state between tests via the public API.
  const prevPub = process.env.LANGFUSE_PUBLIC_KEY;
  const prevSec = process.env.LANGFUSE_SECRET_KEY;
  const prevEp  = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  afterEach(() => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  it('returns false and disables tracing when keys are absent', () => {
    const ok = initOtelLangfuse({ publicKey: '', secretKey: '' });
    expect(ok).toBe(false);
    expect(isEnabled()).toBe(false);
  });

  it('returns true and enables tracing when keys are provided', () => {
    const ok = initOtelLangfuse({
      endpoint: 'http://localhost:3000/api/public/otel',
      publicKey: 'pk-test',
      secretKey: 'sk-test',
    });
    expect(ok).toBe(true);
    expect(isEnabled()).toBe(true);
  });

  it('reads keys from env vars when not supplied via cfg', () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
    process.env.LANGFUSE_SECRET_KEY = 'sk-env';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://env-endpoint:3000/api/public/otel';
    const ok = initOtelLangfuse();
    expect(ok).toBe(true);
    expect(isEnabled()).toBe(true);
  });

  // Restore after all init tests
  afterEach(() => {
    // disable again so other tests aren't affected by a stray enabled state
    initOtelLangfuse({ publicKey: '', secretKey: '' });
    if (prevPub !== undefined) process.env.LANGFUSE_PUBLIC_KEY = prevPub;
    if (prevSec !== undefined) process.env.LANGFUSE_SECRET_KEY = prevSec;
    if (prevEp  !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prevEp;
  });
});

describe('otel-langfuse plugin: SpanContext + startSpan', () => {
  it('creates a span with a valid 16-byte trace id and 8-byte span id', () => {
    const span = startSpan('test.op');
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('child span inherits parent trace id', () => {
    const parent = startSpan('parent.op');
    const child  = startSpan('child.op', { parent });
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
  });

  it('setAttribute is chainable and returns the span', () => {
    const span = startSpan('chain.op');
    const ret = span.setAttribute(ATTR.GEN_AI_TOOL_NAME, 'create_task');
    expect(ret).toBe(span);
  });

  it('end() does not throw whether tracing is enabled or disabled', () => {
    // disabled path
    initOtelLangfuse({ publicKey: '', secretKey: '' });
    expect(() => startSpan('noop.op').end('ok')).not.toThrow();

    // enabled path (no real network — exportSpan fires-and-forgets)
    initOtelLangfuse({ endpoint: 'http://127.0.0.1:19998/api/public/otel', publicKey: 'pk', secretKey: 'sk' });
    expect(() => startSpan('live.op').end('ok')).not.toThrow();

    // clean up
    initOtelLangfuse({ publicKey: '', secretKey: '' });
  });
});

describe('otel-langfuse plugin: W3C trace-context propagation (cross-tier)', () => {
  it('traceparent() renders a valid W3C header from a span', () => {
    const span = startSpan('root.op');
    const tp = traceparent(span);
    expect(tp).toBe(`00-${span.traceId}-${span.spanId}-01`);
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('round-trips: a span → traceparent → parentFromTraceparent → child joins the same trace', () => {
    const root = startSpan('transport.mcp.tool_call');
    const parent = parentFromTraceparent(traceparent(root));
    expect(parent).toEqual({ traceId: root.traceId, spanId: root.spanId });
    // A downstream tier starts its span with the extracted parent → SAME trace, linked to the root span.
    const child = startSpan('app.dispatch', { parent });
    expect(child.traceId).toBe(root.traceId);
    expect(child.spanId).not.toBe(root.spanId);
  });

  it('parentFromTraceparent() returns undefined for missing/malformed/all-zero headers', () => {
    expect(parentFromTraceparent(undefined)).toBeUndefined();
    expect(parentFromTraceparent('')).toBeUndefined();
    expect(parentFromTraceparent('garbage')).toBeUndefined();
    expect(parentFromTraceparent('00-xyz-abc-01')).toBeUndefined();
    // all-zero trace id is invalid per the spec
    expect(parentFromTraceparent(`00-${'0'.repeat(32)}-${'1'.repeat(16)}-01`)).toBeUndefined();
  });

  it('parentFromTraceparent() accepts a header array (Node lowercases + may array-wrap)', () => {
    const root = startSpan('root.op');
    const parent = parentFromTraceparent([traceparent(root)]);
    expect(parent?.traceId).toBe(root.traceId);
  });

  it('span kind is carried (CLIENT=3 for an outbound hop) without affecting behavior', () => {
    const span: SpanContext = startSpan('outbound', { kind: 3 });
    expect(() => span.end('ok')).not.toThrow();
  });
});

describe('otel-langfuse plugin: withSpan', () => {
  it('returns the wrapped function result on success', async () => {
    const result = await withSpan('wrap.op', {}, async (_span) => 42);
    expect(result).toBe(42);
  });

  it('propagates errors and does not swallow them', async () => {
    await expect(
      withSpan('error.op', {}, async (_span) => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
  });

  it('end() is called automatically even on error (no secondary throw from tracing)', async () => {
    // The end() call in withSpan must not produce a secondary throw when tracing
    // is disabled.
    initOtelLangfuse({ publicKey: '', secretKey: '' });
    let caught: Error | undefined;
    try {
      await withSpan('auto-end.op', {}, async () => { throw new Error('expected'); });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe('expected');
  });
});

describe('otel-langfuse plugin: ATTR constants', () => {
  it('exports all required GenAI semantic convention attribute names', () => {
    expect(ATTR.GEN_AI_OPERATION_NAME).toBe('gen_ai.operation.name');
    expect(ATTR.GEN_AI_TOOL_NAME).toBe('gen_ai.tool.name');
    expect(ATTR.GEN_AI_TOOL_ARGS).toBe('gen_ai.tool.input');
    expect(ATTR.GEN_AI_TOOL_OUTPUT).toBe('gen_ai.tool.output');
    expect(ATTR.GEN_AI_USAGE_INPUT_TOKENS).toBe('gen_ai.usage.input_tokens');
    expect(ATTR.GEN_AI_USAGE_OUTPUT_TOKENS).toBe('gen_ai.usage.output_tokens');
    expect(ATTR.MCP_CLIENT_USER).toBe('mcp.client.user');
    expect(ATTR.MCP_CLIENT_HOST).toBe('mcp.client.host');
    expect(ATTR.AUTHZ_DECISION).toBe('authz.decision');
    expect(ATTR.OUTCOME).toBe('outcome');
  });

  it('exports the Langfuse-NATIVE observation input/output keys (the ones its OTel ingest maps to observation I/O)', () => {
    // Load-bearing: Langfuse's ingest maps `langfuse.observation.input`/`.output` onto the observation's
    // input/output panes; it does NOT map `gen_ai.tool.input`/`.output` (those stay plain attributes).
    expect(ATTR.LANGFUSE_OBSERVATION_INPUT).toBe('langfuse.observation.input');
    expect(ATTR.LANGFUSE_OBSERVATION_OUTPUT).toBe('langfuse.observation.output');
  });

  it('exports the Langfuse-NATIVE trace user id key (Users view), honored on non-root spans too', () => {
    // Load-bearing (verified against langfuse/langfuse v3.224.0 OtelIngestionProcessor): extractUserId()
    // checks `langfuse.user.id` FIRST, and the key is in hasTraceUpdates()'s exact-match list — so a
    // NON-root span carrying it still sets the trace-level userId (mcp.tool_call is not the root once it
    // joins the edge trace).
    expect(ATTR.LANGFUSE_USER_ID).toBe('langfuse.user.id');
  });
});

describe('otel-langfuse plugin: capPayload (C36 payload capture)', () => {
  it('passes small strings through and JSON-stringifies everything else', () => {
    expect(capPayload('hello')).toBe('hello');
    expect(capPayload({ id: 'n1', n: 2 })).toBe('{"id":"n1","n":2}');
    expect(capPayload(undefined)).toBe('undefined'); // JSON.stringify(undefined) → String() fallback
  });

  it(`caps at ${PAYLOAD_CAP_BYTES} bytes with a …[truncated] suffix`, () => {
    const big = 'x'.repeat(PAYLOAD_CAP_BYTES * 3);
    const capped = capPayload(big);
    expect(capped.endsWith('…[truncated]')).toBe(true);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(PAYLOAD_CAP_BYTES + Buffer.byteLength('…[truncated]', 'utf8'));
    // Under the cap → untouched, no suffix.
    expect(capPayload('y'.repeat(100))).toBe('y'.repeat(100));
  });

  it('never splits a multi-byte character at the cut and never throws on circular payloads', () => {
    // 4-byte emoji straddling the byte budget — the broken tail is dropped, not emitted as U+FFFD junk.
    const emoji = '🚀'.repeat(PAYLOAD_CAP_BYTES); // 4 bytes each → way past the cap
    const capped = capPayload(emoji);
    expect(capped.endsWith('…[truncated]')).toBe(true);
    expect(capped).not.toContain('�');
    // Circular structure — JSON.stringify throws; capPayload must not.
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(() => capPayload(circ)).not.toThrow();
    expect(capPayload(circ)).toBe('[object Object]');
  });
});

// ── Metric label schema (0.76.0) — plain `tool` / `app`, matching consumer apps ─────────────
//
// The data-plane and consumer apps both emit `mcp.tool.calls`-family metrics into the SAME
// Prometheus metric names. Before 0.76.0 the plugin used `mcp.tool`/`mcp.app` attribute keys
// while apps used plain `tool`, so every transport datapoint collapsed into one unlabeled
// bucket under the dashboards' `sum by (tool)` (the live "(no-label)" series). These tests pin
// the unified schema; regressing the keys breaks per-tool visibility in Grafana.

describe('otel-langfuse plugin: RED metric attribute keys', () => {
  let bodies: string[];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    bodies = [];
    globalThis.fetch = ((url: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body ?? ''));
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch;
    initOtelLangfuse({
      endpoint: 'http://intercepted:3000/api/public/otel',
      publicKey: 'pk-test',
      secretKey: 'sk-test',
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    initOtelLangfuse({ publicKey: '', secretKey: '' });
  });

  function attrKeys(body: string): Set<string> {
    const keys = new Set<string>();
    const payload = JSON.parse(body) as {
      resourceMetrics: { scopeMetrics: { metrics: {
        sum?: { dataPoints: { attributes: { key: string }[] }[] };
        histogram?: { dataPoints: { attributes: { key: string }[] }[] };
        gauge?: { dataPoints: { attributes: { key: string }[] }[] };
      }[] }[] }[];
    };
    for (const rm of payload.resourceMetrics)
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics)
          for (const dp of (m.sum ?? m.histogram ?? m.gauge)?.dataPoints ?? [])
            for (const a of dp.attributes) keys.add(a.key);
    return keys;
  }

  it('tool-call counter + histogram carry plain `tool`/`app` keys (never `mcp.tool`/`mcp.app`)', () => {
    recordToolCallMetric({ tool: 'track', app: 'dorinda-api', outcome: 'ok', duration_ms: 12 });
    expect(bodies).toHaveLength(1);
    const keys = attrKeys(bodies[0]!);
    expect(keys).toContain('tool');
    expect(keys).toContain('app');
    expect(keys).toContain('outcome');
    expect(keys).not.toContain('mcp.tool');
    expect(keys).not.toContain('mcp.app');
  });

  it('error counter keeps the same schema plus error.class', () => {
    recordToolCallMetric({ tool: 'track', app: 'dorinda-api', outcome: 'error', duration_ms: 5, error_class: 'unknown_tool' });
    const keys = attrKeys(bodies[0]!);
    expect(keys).toContain('tool');
    expect(keys).toContain('error.class');
    expect(keys).not.toContain('mcp.tool');
  });

  it('registration gauges use the plain `app` key', () => {
    recordMcpRegistrationMetric({ app: 'dorinda-api', tools_count: 26, streams_count: 0 });
    const keys = attrKeys(bodies[0]!);
    expect(keys).toContain('app');
    expect(keys).not.toContain('mcp.app');
  });
});

// ── Metrics must SURVIVE the retirement of tracing ────────────────────────────────────────────
//
// Langfuse was retired 2026-07-28 (§5.1) and its keys went away. Because initOtelLangfuse() used
// to clear _metricsEnabled whenever the key pair was missing, EVERY metric export silently
// no-opped: Managed Prometheus held ZERO series for days while every health check stayed green.
// Metrics go to a plain OTLP collector that takes unauthenticated writes; they have nothing to do
// with Langfuse credentials. These tests exist so that coupling can never come back.
describe('metrics are independent of Langfuse credentials — 0.79.25', () => {
  const KEYS = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
                'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); });
  afterEach(() => { KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]!))); });

  it('enables METRICS with an endpoint and NO Langfuse keys (the exact production shape)', () => {
    const tracing = initOtelLangfuse({ endpoint: 'https://otel-collector.example.run.app' });
    expect(tracing).toBe(false);        // tracing correctly off — no keys
    expect(isEnabled()).toBe(false);
    expect(isMetricsEnabled()).toBe(true);  // ← metrics MUST still be on
  });

  it('reads the endpoint from the environment, as Cloud Run supplies it', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel-collector.example.run.app';
    initOtelLangfuse({ serviceName: 'dorinda-api' });
    expect(isMetricsEnabled()).toBe(true);
  });

  it('honours a metrics-only endpoint', () => {
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = 'https://collector.example/v1/metrics';
    initOtelLangfuse();
    expect(isMetricsEnabled()).toBe(true);
  });

  it('stays OFF when no endpoint is configured at all — there is nowhere to send', () => {
    initOtelLangfuse();
    expect(isMetricsEnabled()).toBe(false);
  });

  it('keeps tracing and metrics both on when keys AND endpoint are present', () => {
    expect(initOtelLangfuse({
      endpoint: 'https://collector.example', publicKey: 'pk', secretKey: 'sk',
    })).toBe(true);
    expect(isEnabled()).toBe(true);
    expect(isMetricsEnabled()).toBe(true);
  });
});

// The metrics POST must not carry an EMPTY Authorization header. `_authHeader` is the Langfuse
// Basic credential and is '' once tracing is retired; the collector needs no credential at all.
// Sending `Authorization: ` on every export is at best meaningless and at worst rejected — and
// because failures were swallowed, it would be invisible either way.
describe('metrics export sends no empty Authorization — 0.79.26', () => {
  const KEYS = ['OTEL_EXPORTER_OTLP_ENDPOINT', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'];
  const saved: Record<string, string | undefined> = {};
  let calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    calls = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]!)));
  });

  it('omits Authorization entirely when there are no Langfuse keys', async () => {
    const { initOtelLangfuse, recordMcpRegistrationMetric } = await import('../src/plugins/otel-langfuse/index');
    initOtelLangfuse({ endpoint: 'https://collector.example' });
    recordMcpRegistrationMetric({ app: 'dorinda-api', tools_count: 31 });
    await new Promise((r) => setTimeout(r, 10));

    expect(calls.length).toBe(1);
    const h = calls[0]!.headers;
    expect(Object.keys(h)).not.toContain('Authorization');
    expect(h['Authorization']).toBeUndefined();
  });

  it('still sends Authorization when Langfuse keys ARE present', async () => {
    const { initOtelLangfuse, recordMcpRegistrationMetric } = await import('../src/plugins/otel-langfuse/index');
    initOtelLangfuse({ endpoint: 'https://collector.example', publicKey: 'pk', secretKey: 'sk' });
    recordMcpRegistrationMetric({ app: 'dorinda-api', tools_count: 31 });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls[0]!.headers['Authorization']).toMatch(/^Basic /);
  });

  it('counts a successful export so health can distinguish enabled from WORKING', async () => {
    const { initOtelLangfuse, recordMcpRegistrationMetric, metricExportStats } =
      await import('../src/plugins/otel-langfuse/index');
    initOtelLangfuse({ endpoint: 'https://collector.example' });
    const before = metricExportStats().ok;
    recordMcpRegistrationMetric({ app: 'dorinda-api', tools_count: 31 });
    await new Promise((r) => setTimeout(r, 20));
    expect(metricExportStats().ok).toBeGreaterThan(before);
  });
});
