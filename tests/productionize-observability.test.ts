import { describe, it, expect } from 'vitest';
import {
  generateProdCompose,
  generateEnvProdExample,
  type ProdComposeOptions,
} from '../src/plugins/productionize-nextjs-compose/index';
import { convergeProduction } from '../src/capabilities/productionize/converge';

// C36 — the compose/env wiring the `production.observability` opt-in emits: the app + sidecar join the
// shared external `observability` network and get the OTLP→Langfuse export env. Pure string generation;
// keys are empty-default so observability can NEVER take the app down.

const base: ProdComposeOptions = {
  appName: 'demo', port: 3000, host: 'demo.example.com', readinessPath: '/api/health',
  webImage: 'ghcr.io/x/demo-app@sha256:' + 'a'.repeat(64),
  dataPlaneImage: 'ghcr.io/mardash-ai/forge-data-plane@sha256:' + 'b'.repeat(64),
  withPostgres: false, withRedis: false, secrets: [], certResolver: 'letsencrypt',
};

function webBlock(compose: string): string {
  const m = compose.match(/\n {2}web:\n([\s\S]*?)(?=\n {2}\w|\nvolumes:)/);
  return m ? m[0] : '';
}
function dataPlaneBlock(compose: string): string {
  const m = compose.match(/\n {2}data-plane:\n([\s\S]*?)(?=\n {2}\w|\nvolumes:)/);
  return m ? m[0] : '';
}

describe('C36 productionize observability wiring', () => {
  it('default (observability off) emits NO OTLP env and no observability network', () => {
    const c = generateProdCompose(base);
    expect(c).not.toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(c).not.toContain('LANGFUSE_PUBLIC_KEY');
    expect(c).not.toContain('observability');
  });

  it('observability on: BOTH tiers get OTLP env + join the observability network; the app is unaffected if keys empty', () => {
    const c = generateProdCompose({ ...base, observability: true });

    // the shared network is declared external and both services join it
    expect(c).toMatch(/networks:\n {2}proxy:\n {4}external: true\n {2}internal:\n {4}driver: bridge\n {2}observability:\n {4}external: true/);

    const web = webBlock(c);
    expect(web).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT:-http://langfuse-web:3000/api/public/otel}');
    expect(web).toContain('OTEL_SERVICE_NAME=demo'); // app tier → the app's service name
    // empty-default keys — a missing key disables tracing, never fails the deploy (no `:?`)
    expect(web).toContain('LANGFUSE_PUBLIC_KEY=${LANGFUSE_PUBLIC_KEY:-}');
    expect(web).toContain('LANGFUSE_SECRET_KEY=${LANGFUSE_SECRET_KEY:-}');
    expect(web).toMatch(/networks:\n\s+- proxy\n\s+- internal\n\s+- observability/);

    const dp = dataPlaneBlock(c);
    expect(dp).toContain('OTEL_SERVICE_NAME=forge-data-plane'); // transport tier
    expect(dp).toContain('LANGFUSE_PUBLIC_KEY=${LANGFUSE_PUBLIC_KEY:-}');
    expect(dp).toMatch(/networks:\n\s+- internal\n\s+- observability/);
  });

  it('.env.prod.example documents the Langfuse OTLP key pair only when observability is on', () => {
    const off = generateEnvProdExample({ appName: 'demo', host: 'h', withPostgres: false, withRedis: false, secrets: [] });
    expect(off).not.toContain('LANGFUSE_PUBLIC_KEY');

    const on = generateEnvProdExample({ appName: 'demo', host: 'h', withPostgres: false, withRedis: false, secrets: [], observability: true });
    expect(on).toContain('MCP observability (C36)');
    expect(on).toContain('LANGFUSE_PUBLIC_KEY=');
    expect(on).toContain('LANGFUSE_SECRET_KEY=');
  });

  it('convergeProduction carries observability forward (flag > persisted > off) like the other config', () => {
    const need = { web_image: base.webImage, data_plane_image: base.dataPlaneImage, host: 'h' };
    // default off
    expect(convergeProduction({}, { ...need }).observability).toBe(false);
    // flag on
    expect(convergeProduction({}, { ...need, observability: true }).observability).toBe(true);
    // persisted on, no flag → carried forward (idempotent re-run)
    expect(convergeProduction({ observability: true }, { ...need }).observability).toBe(true);
    // flag can turn it back off explicitly
    expect(convergeProduction({ observability: true }, { ...need, observability: false }).observability).toBe(false);
  });
});
