import { describe, it, expect } from 'vitest';
import { convergeProduction } from '../src/capabilities/productionize/converge';
import {
  generateProdCompose,
  generateProdDockerfile,
  generateProdDockerignore,
  generateEnvProdExample,
  applyStandaloneOutput,
  defaultNextConfig,
  isDigestPinned,
  normalizeReadinessPath,
  type ProdComposeOptions,
} from '../src/plugins/productionize-nextjs-compose/index';
import { ForgeError } from '../src/shared/errors';
import { deployCapability } from '../src/capabilities/deploy/index';

// C8 Productionize: generation + idempotency + the R1 digest-pin requirement.

const WEB = 'ghcr.io/mardash-ai/acme-web:1.2.3@sha256:' + 'a'.repeat(64);
const DP = 'ghcr.io/mardash-ai/forge-data-plane:0.11.0@sha256:' + 'b'.repeat(64);

// Slice one 2-space-indented service block out of the generated compose (up to the
// next top-level `services:`-child key), so env/volume assertions can be scoped to a
// specific service rather than matched loosely across the whole file.
function serviceBlock(yaml: string, name: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) throw new Error(`service "${name}" not found in compose`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^  \S/.test(line) || /^\S/.test(line)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('convergeProduction — required inputs + digest pins (R1) + convergence', () => {
  const ok = { host: 'app.example.com', web_image: WEB, data_plane_image: DP };

  it('requires --host on the first run', () => {
    expect(() => convergeProduction({}, { web_image: WEB, data_plane_image: DP })).toThrow(ForgeError);
  });

  it('requires a web image', () => {
    expect(() => convergeProduction({}, { host: 'app.example.com', data_plane_image: DP })).toThrow(ForgeError);
  });

  it('rejects a non-digest-pinned web image (R1 — no bare tag/latest)', () => {
    expect(() =>
      convergeProduction({}, { host: 'app.example.com', web_image: 'ghcr.io/o/app:latest', data_plane_image: DP }),
    ).toThrow(ForgeError);
  });

  it('requires a data-plane image', () => {
    expect(() => convergeProduction({}, { host: 'app.example.com', web_image: WEB })).toThrow(ForgeError);
  });

  it('rejects a non-digest-pinned data-plane image (R1)', () => {
    expect(() =>
      convergeProduction({}, { host: 'app.example.com', web_image: WEB, data_plane_image: 'ghcr.io/o/dp:0.11.0' }),
    ).toThrow(ForgeError);
  });

  it('applies defaults for readiness path and cert resolver', () => {
    const c = convergeProduction({}, ok);
    expect(c.readiness_path).toBe('/api/health');
    expect(c.cert_resolver).toBe('letsencrypt');
    expect(c.host).toBe('app.example.com');
    expect(c.web_image).toBe(WEB);
    expect(c.data_plane_image).toBe(DP);
  });

  it('normalizes a readiness path missing its leading slash', () => {
    expect(convergeProduction({}, { ...ok, readiness_path: 'healthz' }).readiness_path).toBe('/healthz');
  });

  it('a flag-less re-run recovers host/images/readiness/cert from the persisted block (convergent)', () => {
    const prev = {
      host: 'app.example.com',
      readiness_path: '/api/ready',
      web_image: WEB,
      data_plane_image: DP,
      cert_resolver: 'myresolver',
    };
    const c = convergeProduction(prev, {}); // no flags at all
    expect(c).toEqual(prev);
  });

  it('a flag overrides the persisted value', () => {
    const prev = { host: 'old.example.com', web_image: WEB, data_plane_image: DP };
    expect(convergeProduction(prev, { host: 'new.example.com' }).host).toBe('new.example.com');
  });

  it('falls back to the platform env default for the data-plane image', () => {
    const c = convergeProduction({}, { host: 'app.example.com', web_image: WEB, data_plane_image_env: DP });
    expect(c.data_plane_image).toBe(DP);
  });

  it('isDigestPinned accepts a real digest and rejects a bare tag / latest', () => {
    expect(isDigestPinned(WEB)).toBe(true);
    expect(isDigestPinned('ghcr.io/o/app:1.2.3')).toBe(false);
    expect(isDigestPinned('ghcr.io/o/app:latest')).toBe(false);
    expect(normalizeReadinessPath('x')).toBe('/x');
  });
});

const base: ProdComposeOptions = {
  appName: 'acme',
  port: 3000,
  host: 'app.example.com',
  readinessPath: '/api/health',
  webImage: WEB,
  dataPlaneImage: DP,
  withPostgres: true,
  withRedis: false,
  secrets: [],
  certResolver: 'letsencrypt',
};

describe('generateProdCompose — Traefik + healthcheck + stop_grace + data-plane + DB, digest-pinned', () => {
  it('pins both delivered images by digest and never uses latest (R1)', () => {
    const yaml = generateProdCompose(base);
    expect(yaml).toContain(WEB);
    expect(yaml).toContain(DP);
    expect(yaml).toContain('@sha256:');
    expect(yaml).not.toMatch(/:latest\b/);
    expect(yaml).not.toMatch(/image:\s+\S+:latest/);
  });

  it('emits the Traefik host rule + loadbalancer healthcheck the roll gates on', () => {
    const yaml = generateProdCompose(base);
    expect(yaml).toContain('traefik.enable=true');
    expect(yaml).toContain('traefik.http.routers.acme.rule=Host(`app.example.com`)');
    expect(yaml).toContain('traefik.http.services.acme.loadbalancer.server.port=3000');
    expect(yaml).toContain('traefik.http.services.acme.loadbalancer.healthcheck.path=/api/health');
    expect(yaml).toContain('traefik.http.routers.acme.tls.certresolver=letsencrypt');
  });

  it('uses the same C7 deploy conventions: proxy network (external) + stop_grace_period + container healthcheck', () => {
    const yaml = generateProdCompose(base);
    expect(yaml).toMatch(/proxy:\n\s+external: true/);
    expect(yaml).toContain('stop_grace_period: 30s');
    expect(yaml).toContain("fetch('http://localhost:3000/api/health')");
    expect(yaml).toContain('- proxy'); // web joined to the proxy network
  });

  it('wires the data-plane sidecar (C3/C4) and points the web app at it', () => {
    const yaml = generateProdCompose(base);
    expect(yaml).toContain('data-plane:');
    expect(yaml).toContain(`image: ${DP}`);
    expect(yaml).toContain('FORGE_DATA_PLANE_URL=http://data-plane:3718');
    expect(yaml).toContain('FORGE_APP_NAME=acme');
    expect(yaml).toContain('forge_state:/forge-state');
    expect(yaml).toContain("fetch('http://localhost:3718/health')");
  });

  it('emits the DB service from infra, naming the db in its healthcheck', () => {
    const yaml = generateProdCompose({ ...base, appName: 'forge-os' });
    expect(yaml).toContain('postgres:16-alpine');
    expect(yaml).toContain('POSTGRES_DB=forge_os');
    expect(yaml).toContain('pg_isready -U forge -d forge_os');
    expect(yaml).toContain('postgres_data:/var/lib/postgresql/data');
    // prod db password comes from .env.prod, never hardcoded
    expect(yaml).toContain('POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?');
  });

  it('omits the DB service when infra declares no postgres', () => {
    const yaml = generateProdCompose({ ...base, withPostgres: false });
    expect(yaml).not.toContain('postgres:16-alpine');
    expect(yaml).not.toContain('DATABASE_URL=');
  });

  it('adds a redis service when infra declares redis', () => {
    const yaml = generateProdCompose({ ...base, withRedis: true });
    expect(yaml).toContain('redis:7-alpine');
    expect(yaml).toContain('REDIS_URL=redis://redis:6379');
  });

  it('renders declared secrets as defined-but-empty interpolation lines (no value in the file)', () => {
    const yaml = generateProdCompose({ ...base, secrets: ['ANTHROPIC_API_KEY'] });
    expect(yaml).toContain('- ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}');
  });

  // P7.1 — the shipped C1/C3/C4 app clients read FORGE_EVENTS_URL (the data-plane base).
  it('points the web app at the data-plane via FORGE_EVENTS_URL (the C3/C4 client contract) (P7.1)', () => {
    const web = serviceBlock(generateProdCompose(base), 'web');
    expect(web).toContain('FORGE_EVENTS_URL=http://data-plane:3718');
    // The compatible alias may remain, but FORGE_EVENTS_URL is the load-bearing one.
    expect(web).toContain('FORGE_DATA_PLANE_URL=http://data-plane:3718');
  });

  // P6 — the data-plane runs C1/C5, so it needs the vault key + the declared secrets.
  it('gives the data-plane sidecar FORGE_SECRETS_KEY so it can decrypt the C5 vault (P6)', () => {
    const dp = serviceBlock(generateProdCompose(base), 'data-plane');
    expect(dp).toContain('FORGE_SECRETS_KEY=${FORGE_SECRETS_KEY:-}');
  });

  it('injects the declared secrets into the data-plane too, not only web (P6)', () => {
    const yaml = generateProdCompose({ ...base, secrets: ['ANTHROPIC_API_KEY'] });
    const web = serviceBlock(yaml, 'web');
    const dp = serviceBlock(yaml, 'data-plane');
    expect(web).toContain('- ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}');
    expect(dp).toContain('- ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}');
  });

  // P7.3 — a declared jobs file must be mounted + pinned, else C2 never registers it.
  it('mounts the jobs file and pins FORGE_JOBS_FILE at it when jobs are declared (P7.3)', () => {
    const dp = serviceBlock(generateProdCompose({ ...base, withJobs: true }), 'data-plane');
    expect(dp).toContain('FORGE_JOBS_FILE=/app/forge.jobs.json');
    expect(dp).toContain('- ./forge.jobs.json:/app/forge.jobs.json:ro');
  });

  it('leaves FORGE_JOBS_FILE optional (no mount) when the app declares no jobs (P7.3)', () => {
    const dp = serviceBlock(generateProdCompose({ ...base, withJobs: false }), 'data-plane');
    expect(dp).toContain('FORGE_JOBS_FILE=${FORGE_JOBS_FILE:-}');
    expect(dp).not.toContain('forge.jobs.json:');
  });

  it('is deterministic — identical inputs produce identical bytes (idempotency)', () => {
    expect(generateProdCompose(base)).toBe(generateProdCompose({ ...base }));
    expect(generateProdCompose({ ...base, withJobs: true, secrets: ['ANTHROPIC_API_KEY'] })).toBe(
      generateProdCompose({ ...base, withJobs: true, secrets: ['ANTHROPIC_API_KEY'] }),
    );
  });
});

describe('generateProdDockerfile / .dockerignore — slim Next standalone image', () => {
  it('is a multi-stage build off Next standalone output, non-root, no build tooling in the runner', () => {
    const df = generateProdDockerfile({ appName: 'acme', port: 3000 });
    expect(df).toContain('AS deps');
    expect(df).toContain('AS build');
    expect(df).toContain('AS runner');
    expect(df).toContain('RUN mkdir -p public && npm run build');
    expect(df).toContain('COPY --from=build /app/.next/standalone ./');
    expect(df).toContain('COPY --from=build /app/.next/static ./.next/static');
    expect(df).toContain('USER nextjs');
    expect(df).toContain('CMD ["node", "server.js"]');
    expect(df).toContain('EXPOSE 3000');
  });

  it('keeps build tooling, state, and env files out of the image context', () => {
    const di = generateProdDockerignore();
    for (const p of ['node_modules', '.next', '.git', 'compose.prod.yaml', '.env.prod', '.forge']) {
      expect(di).toContain(p);
    }
  });
});

describe('applyStandaloneOutput — idempotent Next config patch', () => {
  const scaffold = `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
`;

  it('injects output: standalone into the scaffold config', () => {
    const r = applyStandaloneOutput(scaffold);
    expect(r.changed).toBe(true);
    expect(r.action).toBe('injected');
    expect(r.content).toContain("output: 'standalone',");
    expect(r.content).toContain('reactStrictMode: true');
  });

  it('is idempotent — re-applying to already-patched content changes nothing', () => {
    const once = applyStandaloneOutput(scaffold).content;
    const twice = applyStandaloneOutput(once);
    expect(twice.changed).toBe(false);
    expect(twice.action).toBe('already-standalone');
    expect(twice.content).toBe(once);
  });

  it('respects a hand-set different output value (no clobber) but warns', () => {
    const custom = "const nextConfig = { output: 'export' };\nexport default nextConfig;\n";
    const r = applyStandaloneOutput(custom);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(custom);
    expect(r.warning).toMatch(/standalone/);
  });

  it('injects into an inline default export', () => {
    const r = applyStandaloneOutput('export default {\n  reactStrictMode: true,\n};\n');
    expect(r.changed).toBe(true);
    expect(r.content).toContain("output: 'standalone',");
  });

  it('reports unmanaged when there is no recognizable config object', () => {
    const r = applyStandaloneOutput('// empty config\n');
    expect(r.action).toBe('unmanaged');
    expect(r.changed).toBe(false);
  });

  it('the default config already declares standalone output', () => {
    expect(defaultNextConfig()).toContain("output: 'standalone',");
    expect(applyStandaloneOutput(defaultNextConfig()).changed).toBe(false);
  });
});

describe('generateEnvProdExample — documents .env.prod without real values', () => {
  it('lists the postgres password and declared secrets as blanks', () => {
    const env = generateEnvProdExample({
      appName: 'acme',
      host: 'app.example.com',
      withPostgres: true,
      withRedis: false,
      secrets: ['ANTHROPIC_API_KEY'],
    });
    expect(env).toContain('POSTGRES_PASSWORD=');
    expect(env).toContain('ANTHROPIC_API_KEY=');
    expect(env).toContain('app.example.com');
    expect(env).toContain('FORGE_JOBS_FILE');
  });

  it('documents the C5 vault master key the data-plane needs (P6)', () => {
    const env = generateEnvProdExample({
      appName: 'acme',
      host: 'app.example.com',
      withPostgres: false,
      withRedis: false,
      secrets: ['ANTHROPIC_API_KEY'],
    });
    expect(env).toContain('FORGE_SECRETS_KEY=');
  });

  it('states jobs auto-wire (no FORGE_JOBS_FILE env) when the app declares them (P7.3)', () => {
    const env = generateEnvProdExample({
      appName: 'acme',
      host: 'app.example.com',
      withPostgres: false,
      withRedis: false,
      secrets: [],
      withJobs: true,
    });
    expect(env).toContain('forge.jobs.json');
    expect(env).not.toContain('# FORGE_JOBS_FILE=');
  });
});

// P7.2 — `forge productionize` writes app/compose.prod.yaml; `forge deploy` must find
// it by default. Deploy runs from the workspace dir and the app repo is ./app (the
// single-app layout `provision` uses), so the default must resolve into ./app.
describe('deploy ⇄ productionize compose path agree by default (P7.2)', () => {
  it('forge deploy defaults --compose-file to what forge productionize writes (app/compose.prod.yaml)', () => {
    const parsed = deployCapability.inputSchema.parse({ app: 'acme' });
    expect(parsed.compose_file).toBe('app/compose.prod.yaml');
  });
});

// P10 — three names for one thing must agree: the example productionize emits
// (.env.prod.example → .env.prod), the compose interpolation hint (`${VAR:?… in
// .env.prod}`), and the env-file `forge deploy` interpolates from. Before the fix,
// deploy passed no --env-file, so Compose read only app/.env and the documented
// secrets were silently ignored (the deploy then aborted at a `${VAR:?}`).
describe('deploy ⇄ productionize env-file agree by default (P10)', () => {
  it('forge deploy defaults --env-file to the productionized .env.prod (app/.env.prod)', () => {
    const parsed = deployCapability.inputSchema.parse({ app: 'acme' });
    expect(parsed.env_file).toBe('app/.env.prod');
  });

  it('the deploy env-file, the compose interpolation hint, and the emitted example all name .env.prod', () => {
    const parsed = deployCapability.inputSchema.parse({ app: 'acme' });
    // deploy default resolves to the `.env.prod` copy of the example.
    expect(parsed.env_file.endsWith('.env.prod')).toBe(true);
    // compose interpolation hint points at .env.prod (the `${VAR:?}` fail message).
    const yaml = generateProdCompose(base);
    expect(yaml).toContain('POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env.prod}');
    // the emitted example documents .env.prod as the copy target + the deploy consumer.
    const env = generateEnvProdExample({
      appName: 'acme',
      host: 'app.example.com',
      withPostgres: true,
      withRedis: false,
      secrets: [],
    });
    expect(env).toContain('Copy to .env.prod');
    expect(env).toContain('--env-file .env.prod');
  });
});
