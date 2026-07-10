import { describe, it, expect } from 'vitest';
import {
  generateProdCompose,
  generateEnvProdExample,
  generatePlatformDbInitSh,
  platformDbUrl,
  PLATFORM_DB_INIT_FILE,
  PLATFORM_DB_NAME,
  PLATFORM_DB_ROLE,
  type ProdComposeOptions,
} from '../src/plugins/productionize-nextjs-compose/index';

// P26 — the compose wiring that makes the data-plane sidecar datastore-aware: FORGE_DB_URL pointing at
// a SEPARATE forge_platform database with its own least-privilege role, co-located on the app's Postgres
// (or a dedicated one when the app has no DB). Pure string generation — runs on both backends.

const base: ProdComposeOptions = {
  appName: 'demo', port: 3000, host: 'demo.example.com', readinessPath: '/api/health',
  webImage: 'ghcr.io/x/demo-app@sha256:' + 'a'.repeat(64),
  dataPlaneImage: 'ghcr.io/mardash-ai/forge-data-plane@sha256:' + 'b'.repeat(64),
  withPostgres: false, withRedis: false, secrets: [], certResolver: 'letsencrypt',
};

// Extract the `data-plane:` service block for focused assertions.
function dataPlaneBlock(compose: string): string {
  const m = compose.match(/\n {2}data-plane:\n([\s\S]*?)(?=\n {2}\w|\nvolumes:)/);
  return m ? m[0] : '';
}
function postgresBlock(compose: string): string {
  const m = compose.match(/\n {2}postgres:\n([\s\S]*?)(?=\n {2}\w|\nvolumes:)/);
  return m ? m[0] : '';
}

describe('P26 platform-db compose wiring', () => {
  it('default (platformDb off) leaves the sidecar on the filesystem backend — no FORGE_DB_URL', () => {
    const c = generateProdCompose(base);
    expect(c).not.toContain('FORGE_DB_URL');
    expect(c).not.toContain('FORGE_STORE_BACKEND');
    expect(c).not.toContain('postgres:'); // no DB service when neither app-db nor platform-db
  });

  it('platformDb + app has its OWN postgres: sidecar dials forge_platform, init script mounted, least-priv role', () => {
    const c = generateProdCompose({ ...base, withPostgres: true, platformDb: true });
    const dp = dataPlaneBlock(c);
    expect(dp).toContain('FORGE_STORE_BACKEND=postgres');
    expect(dp).toContain(`FORGE_DB_URL=${platformDbUrl()}`);
    expect(dp).toContain(`@postgres:5432/${PLATFORM_DB_NAME}`);
    // sidecar waits for postgres to be healthy
    expect(dp).toContain('depends_on:');
    expect(dp).toMatch(/postgres:\n\s+condition: service_healthy/);

    const pg = postgresBlock(c);
    // the app's own role/db stays; the platform role/db is created by the mounted first-init script
    expect(pg).toContain('POSTGRES_USER=forge');
    expect(pg).toContain('FORGE_PLATFORM_DB_PASSWORD=${FORGE_PLATFORM_DB_PASSWORD:?set FORGE_PLATFORM_DB_PASSWORD in .env.prod}');
    expect(pg).toContain(`/docker-entrypoint-initdb.d/${PLATFORM_DB_INIT_FILE}:ro`);
  });

  it('platformDb + app has NO postgres: a DEDICATED platform postgres (role/db = forge_platform), no init script', () => {
    const c = generateProdCompose({ ...base, withPostgres: false, platformDb: true });
    const pg = postgresBlock(c);
    expect(pg).toContain(`POSTGRES_USER=${PLATFORM_DB_ROLE}`);
    expect(pg).toContain(`POSTGRES_DB=${PLATFORM_DB_NAME}`);
    expect(pg).toContain('POSTGRES_PASSWORD=${FORGE_PLATFORM_DB_PASSWORD:?set FORGE_PLATFORM_DB_PASSWORD in .env.prod}');
    expect(pg).not.toContain(PLATFORM_DB_INIT_FILE); // no script — entrypoint initializes it directly
    // web still depends on postgres being healthy
    expect(c).toMatch(/web:[\s\S]*?depends_on:[\s\S]*?postgres:\n\s+condition: service_healthy/);
  });

  it('.env.prod.example documents FORGE_PLATFORM_DB_PASSWORD when platformDb', () => {
    const env = generateEnvProdExample({ appName: 'demo', host: 'demo.example.com', withPostgres: true, withRedis: false, secrets: [], platformDb: true });
    expect(env).toContain('FORGE_PLATFORM_DB_PASSWORD=change-me');
    expect(env).toContain(PLATFORM_DB_NAME);
    // off by default
    const envOff = generateEnvProdExample({ appName: 'demo', host: 'demo.example.com', withPostgres: true, withRedis: false, secrets: [] });
    expect(envOff).not.toContain('FORGE_PLATFORM_DB_PASSWORD');
  });

  it('the first-init script creates the least-privilege role + its own database, idempotently', () => {
    const sh = generatePlatformDbInitSh();
    expect(sh).toContain(`CREATE ROLE ${PLATFORM_DB_ROLE} LOGIN PASSWORD`);
    expect(sh).toContain(`CREATE DATABASE ${PLATFORM_DB_NAME} OWNER ${PLATFORM_DB_ROLE}`);
    expect(sh).toContain('IF NOT EXISTS'); // idempotent role create
    expect(sh).toContain('FORGE_PLATFORM_DB_PASSWORD'); // password comes from the container env, not the committed file
  });
});
