import { describe, it, expect } from 'vitest';
import {
  aggregateHealth,
  httpStatusFor,
  parseHealthResponse,
} from '../src/shared/health';
import { scaffold } from '../src/plugins/scaffold-nextjs-npm/index';

// C6 — the standard health / telemetry contract. The platform owns the schema, the
// check-aggregation rollup, and the readiness → HTTP-code convention.
describe('aggregateHealth (the platform-owned rollup)', () => {
  const at = new Date('2026-01-01T00:00:00.000Z');

  it('all checks pass -> ok / HTTP 200', () => {
    const { body, httpStatus } = aggregateHealth(
      'svc',
      [
        { name: 'db', status: 'ok' },
        { name: 'cache', status: 'ok', required: false },
      ],
      at,
    );
    expect(body.status).toBe('ok');
    expect(httpStatus).toBe(200);
    expect(body.service).toBe('svc');
    expect(body.time).toBe('2026-01-01T00:00:00.000Z');
    expect(body.checks.map((c) => c.name)).toEqual(['db', 'cache']);
  });

  it('no checks (liveness-only) -> ok / HTTP 200', () => {
    const { body, httpStatus } = aggregateHealth('svc', [], at);
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual([]);
    expect(httpStatus).toBe(200);
  });

  it('a required check unavailable -> unavailable / HTTP 503', () => {
    const { body, httpStatus } = aggregateHealth(
      'svc',
      [
        { name: 'db', status: 'unavailable', detail: 'ECONNREFUSED' },
        { name: 'cache', status: 'ok', required: false },
      ],
      at,
    );
    expect(body.status).toBe('unavailable');
    expect(httpStatus).toBe(503);
    expect(body.checks.find((c) => c.name === 'db')).toMatchObject({ status: 'unavailable', detail: 'ECONNREFUSED' });
  });

  it('only a NON-required check fails -> degraded / still HTTP 200', () => {
    const { body, httpStatus } = aggregateHealth(
      'svc',
      [
        { name: 'db', status: 'ok' },
        { name: 'cache', status: 'unavailable', required: false },
      ],
      at,
    );
    expect(body.status).toBe('degraded');
    expect(httpStatus).toBe(200);
  });

  it('a required failure wins over a non-required one (unavailable, not degraded)', () => {
    const { body, httpStatus } = aggregateHealth(
      'svc',
      [
        { name: 'db', status: 'unavailable' },
        { name: 'cache', status: 'unavailable', required: false },
      ],
      at,
    );
    expect(body.status).toBe('unavailable');
    expect(httpStatus).toBe(503);
  });
});

describe('httpStatusFor (the 200/503 convention)', () => {
  it('maps ok and degraded to 200, unavailable to 503', () => {
    expect(httpStatusFor('ok')).toBe(200);
    expect(httpStatusFor('degraded')).toBe(200);
    expect(httpStatusFor('unavailable')).toBe(503);
  });
});

describe('parseHealthResponse (schema recognition)', () => {
  it('accepts a well-formed standard response', () => {
    const r = parseHealthResponse({ status: 'ok', service: 'svc', time: '2026-01-01T00:00:00.000Z', checks: [] });
    expect(r.ok).toBe(true);
  });

  it('accepts a response with checks (and optional detail)', () => {
    const r = parseHealthResponse({
      status: 'unavailable',
      service: 'svc',
      time: '2026-01-01T00:00:00.000Z',
      checks: [{ name: 'db', status: 'unavailable', detail: 'down' }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.checks[0]?.name).toBe('db');
  });

  it('rejects a liveness-only-but-non-conforming payload with a reason', () => {
    const r = parseHealthResponse({ status: 'ok' }); // missing service/time/checks
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/service|time|checks/);
  });

  it('rejects an unknown status value', () => {
    const r = parseHealthResponse({ status: 'green', service: 'svc', time: 't', checks: [] });
    expect(r.ok).toBe(false);
  });

  it('round-trips: aggregateHealth output is recognized by parseHealthResponse', () => {
    const { body } = aggregateHealth('svc', [{ name: 'db', status: 'ok' }]);
    const r = parseHealthResponse(body);
    expect(r.ok).toBe(true);
  });
});

// The scaffold materializes the reference handler (distribution (A)) — assert it emits
// the standard contract, not the retired always-`ok` liveness payload.
describe('scaffold reference health handler (C6)', () => {
  it('emits a buildHealth-based handler with 200/503 readiness, not the old always-ok payload', () => {
    const { files } = scaffold({ name: 'demo-app', port: 3000 });
    const lib = files['lib/health.ts'] ?? '';
    const route = files['app/api/health/route.ts'] ?? '';
    expect(lib).toContain('buildHealth');
    expect(lib).toContain("'unavailable'");
    expect(lib).not.toContain('healthPayload'); // retired
    expect(route).toContain('status: httpStatus'); // returns 503 on not-ready
  });
});
