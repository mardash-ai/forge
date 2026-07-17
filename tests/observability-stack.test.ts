import { describe, it, expect } from 'vitest';
import {
  generateObservabilityCompose,
  generateObservabilitySecrets,
  renderObservabilityEnv,
  renderObservabilityEnvExample,
  OBSERVABILITY_SECRET_KEYS,
} from '../src/plugins/observability-stack/index';

// C37 — the canonical self-hosted Langfuse stack forge owns + provisions. Pure string generation; the
// point of these tests is that every fix discovered standing the box stack up by hand is baked in, so
// a fresh provision comes up green instead of crashlooping / 500ing on OTLP upload.

// Pull just the langfuse-web / langfuse-worker service blocks out of the compose (indented under the
// service key until the next top-level 2-space key).
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !/^  \S/.test(lines[end]!)) end++;
  return lines.slice(start, end).join('\n');
}

describe('generateObservabilityCompose — defaults', () => {
  const compose = generateObservabilityCompose();

  it('declares all six Langfuse services', () => {
    for (const svc of ['langfuse-postgres', 'langfuse-redis', 'langfuse-clickhouse', 'langfuse-minio', 'langfuse-web', 'langfuse-worker']) {
      expect(compose).toContain(`  ${svc}:`);
    }
  });

  it('pins single-node ClickHouse on BOTH web and worker (else they crashloop)', () => {
    expect(serviceBlock(compose, 'langfuse-web')).toContain('CLICKHOUSE_CLUSTER_ENABLED: "false"');
    expect(serviceBlock(compose, 'langfuse-worker')).toContain('CLICKHOUSE_CLUSTER_ENABLED: "false"');
  });

  it('sets the S3 region + force-path-style on BOTH web and worker (else OTLP uploads 500)', () => {
    for (const svc of ['langfuse-web', 'langfuse-worker']) {
      const block = serviceBlock(compose, svc);
      expect(block).toContain('LANGFUSE_S3_EVENT_UPLOAD_REGION: us-east-1');
      expect(block).toContain('LANGFUSE_S3_MEDIA_UPLOAD_REGION: us-east-1');
      expect(block).toContain('LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE: "true"');
      expect(block).toContain('LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE: "true"');
    }
  });

  it('joins the external observability network and has NO Traefik/HOSTNAME wiring by default', () => {
    expect(compose).toContain('name: dorinda-monitor');
    expect(compose).toMatch(/observability:\n    external: true/);
    expect(compose).not.toContain('traefik.enable');
    expect(serviceBlock(compose, 'langfuse-web')).not.toContain('HOSTNAME');
    // default NEXTAUTH points at localhost, not https
    expect(serviceBlock(compose, 'langfuse-web')).toContain('http://localhost:3100');
  });

  it('references default compose-managed volumes when not preserving', () => {
    expect(compose).toContain('  langfuse-postgres-data:');
    expect(compose).not.toContain('name: observability_langfuse-postgres-data');
  });
});

describe('generateObservabilityCompose — fronted by a public host', () => {
  const compose = generateObservabilityCompose({ publicHost: 'monitor.dorinda.ai' });
  const web = serviceBlock(compose, 'langfuse-web');

  it('adds Traefik labels routing the public host over HTTPS', () => {
    expect(web).toContain('traefik.enable=true');
    expect(web).toContain('traefik.http.routers.langfuse.rule=Host(`monitor.dorinda.ai`)');
    expect(web).toContain('traefik.http.routers.langfuse.tls.certresolver=letsencrypt');
    expect(web).toContain('traefik.http.services.langfuse.loadbalancer.server.port=3000');
  });

  it('binds Next.js to 0.0.0.0 and joins the proxy network (else the proxy 502s)', () => {
    expect(web).toContain('HOSTNAME: "0.0.0.0"');
    expect(web).toContain('- proxy');
    expect(compose).toMatch(/proxy:\n    external: true/);
  });

  it('defaults NEXTAUTH_URL to the HTTPS public host', () => {
    expect(web).toContain('https://monitor.dorinda.ai');
  });
});

describe('generateObservabilityCompose — data preservation', () => {
  it('references existing named volumes under the given prefix', () => {
    const compose = generateObservabilityCompose({ preserveVolumesFrom: 'observability' });
    for (const v of ['postgres', 'redis', 'clickhouse', 'minio']) {
      expect(compose).toContain(`name: observability_langfuse-${v}-data`);
    }
  });
});

describe('generateObservabilitySecrets', () => {
  const secrets = generateObservabilitySecrets();

  it('produces a value for every declared secret key', () => {
    for (const k of OBSERVABILITY_SECRET_KEYS) {
      expect(secrets[k], k).toBeTruthy();
    }
  });

  it('makes ENCRYPTION_KEY exactly 64 hex chars (Langfuse refuses to boot otherwise)', () => {
    expect(secrets.LANGFUSE_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
  });

  it('shapes the project key pair like Langfuse keys', () => {
    expect(secrets.LANGFUSE_PUBLIC_KEY).toMatch(/^pk-lf-/);
    expect(secrets.LANGFUSE_SECRET_KEY).toMatch(/^sk-lf-/);
  });

  it('is non-deterministic (fresh secrets per call)', () => {
    const other = generateObservabilitySecrets();
    expect(other.LANGFUSE_NEXTAUTH_SECRET).not.toBe(secrets.LANGFUSE_NEXTAUTH_SECRET);
    expect(other.LANGFUSE_ENCRYPTION_KEY).not.toBe(secrets.LANGFUSE_ENCRYPTION_KEY);
  });
});

describe('renderObservabilityEnv / example', () => {
  it('writes real values plus host config for the deployed .env', () => {
    const secrets = generateObservabilitySecrets();
    const env = renderObservabilityEnv(secrets, { adminEmail: 'mark@mardash.ai', nextauthUrl: 'https://monitor.dorinda.ai', uiPort: 3100 });
    expect(env).toContain('LANGFUSE_ADMIN_EMAIL=mark@mardash.ai');
    expect(env).toContain('LANGFUSE_NEXTAUTH_URL=https://monitor.dorinda.ai');
    expect(env).toContain(`LANGFUSE_ENCRYPTION_KEY=${secrets.LANGFUSE_ENCRYPTION_KEY}`);
    for (const k of OBSERVABILITY_SECRET_KEYS) expect(env).toContain(`${k}=${secrets[k]}`);
  });

  it('the committable example documents every secret as an empty placeholder', () => {
    const ex = renderObservabilityEnvExample();
    for (const k of OBSERVABILITY_SECRET_KEYS) expect(ex).toContain(`${k}=\n`);
  });
});
