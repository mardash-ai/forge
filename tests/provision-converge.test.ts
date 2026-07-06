import { describe, it, expect } from 'vitest';
import { convergeInfra, parseComposeInfra } from '../src/capabilities/provision-environment/converge';
import { generateCompose } from '../src/plugins/runtime-docker-compose/index';
import { ForgeError } from '../src/shared/errors';

// P1: provision must CONVERGE, not replace-from-flags. A flag-less re-provision
// must never silently drop a service or reset a host-port remap, and a data-volume
// service must never be dropped without --force.
describe('convergeInfra — additive, non-destructive', () => {
  it('a flag-less re-provision preserves existing services AND host ports', () => {
    const prev = { postgres: true, redis: false, secrets: ['ANTHROPIC_API_KEY'], ports: { web: 3000, postgres: 5433 } };
    const d = convergeInfra(prev, {}, 3000);
    expect(d.postgres).toBe(true); // NOT dropped
    expect(d.ports.postgres).toBe(5433); // remap preserved
    expect(d.secrets).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('adding a secret keeps Postgres (the C5-adoption footgun)', () => {
    const d = convergeInfra({ postgres: true }, { secrets: ['ANTHROPIC_API_KEY'] }, 3000);
    expect(d.postgres).toBe(true);
    expect(d.secrets).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('a fresh app with --with-postgres enables it with the default port', () => {
    const d = convergeInfra({}, { with_postgres: true }, 3000);
    expect(d.postgres).toBe(true);
    expect(d.ports.postgres).toBe(5432);
  });

  it('refuses to drop Postgres (owns a data volume) without --force', () => {
    expect(() => convergeInfra({ postgres: true }, { without_postgres: true }, 3000)).toThrow(ForgeError);
  });

  it('drops Postgres with --force', () => {
    const d = convergeInfra({ postgres: true }, { without_postgres: true, force: true }, 3000);
    expect(d.postgres).toBe(false);
    expect(d.ports.postgres).toBeUndefined();
  });

  it('drops Redis freely (no data volume)', () => {
    const d = convergeInfra({ postgres: true, redis: true }, { without_redis: true }, 3000);
    expect(d.redis).toBe(false);
    expect(d.postgres).toBe(true);
  });

  it('an explicit port override wins and is retained', () => {
    expect(convergeInfra({ postgres: true }, { postgres_port: 5433 }, 3000).ports.postgres).toBe(5433);
  });

  it('secrets are a de-duplicated union of persisted + legacy + flags', () => {
    const d = convergeInfra({ secrets: ['A'] }, { secrets: ['A', 'B'] }, 3000, ['LEGACY']);
    expect(d.secrets.sort()).toEqual(['A', 'B', 'LEGACY']);
  });
});

describe('parseComposeInfra — recover infra from a pre-fix compose.yaml', () => {
  it('detects services, host-port remap, and declared secrets', () => {
    const compose = generateCompose({
      appName: 'demo',
      port: 3000,
      withPostgres: true,
      withRedis: false,
      devCommand: 'npm run dev',
      secrets: ['ANTHROPIC_API_KEY'],
      ports: { web: 3000, postgres: 5433 },
    });
    const prev = parseComposeInfra(compose, 3000);
    expect(prev.postgres).toBe(true);
    expect(prev.redis).toBe(false);
    expect(prev.ports?.postgres).toBe(5433);
    expect(prev.secrets).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('returns empty for a blank compose', () => {
    expect(parseComposeInfra('', 3000)).toEqual({});
  });
});

describe('generateCompose — host-port overrides', () => {
  const base = { appName: 'demo', port: 3000, withPostgres: true, withRedis: false, devCommand: 'npm run dev' };

  it('maps the overridden host port to the fixed container port', () => {
    const yaml = generateCompose({ ...base, ports: { web: 3000, postgres: 5433 } });
    expect(yaml).toContain('- "5433:5432"');
  });

  it('defaults to the canonical port when no override is given', () => {
    const yaml = generateCompose({ ...base });
    expect(yaml).toContain('- "5432:5432"');
  });
});
