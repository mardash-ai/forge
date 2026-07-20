import { describe, it, expect } from 'vitest';
import { convergeProduction } from '../src/capabilities/productionize/converge';
import {
  generateProdCompose,
  generateProdDockerfile,
  generateProdDockerignore,
  generateEnvProdExample,
  generateProvisioningRunbook,
  PROVISIONING_FILE,
  applyStandaloneOutput,
  defaultNextConfig,
  isDigestPinned,
  normalizeReadinessPath,
  type ProdComposeOptions,
} from '../src/plugins/productionize-nextjs-compose/index';
import { describeSecret, requirementLabel, SECRET_CATALOG } from '../src/plugins/productionize-nextjs-compose/secret-catalog';
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
      blobs_backend: 'filesystem' as const,
      observability: false,
    };
    const c = convergeProduction(prev, {}); // no flags at all
    expect(c).toEqual(prev);
  });

  // P33 — the blob backend converges like the rest: default filesystem, flag > persisted, remembered.
  it('defaults blobs_backend to filesystem and carries it convergently (P33)', () => {
    expect(convergeProduction({}, ok).blobs_backend).toBe('filesystem');
    expect(convergeProduction({}, { ...ok, blobs_backend: 's3' }).blobs_backend).toBe('s3');
    // persisted s3 survives a flag-less re-run
    expect(convergeProduction({ host: 'app.example.com', web_image: WEB, data_plane_image: DP, blobs_backend: 's3' }, {}).blobs_backend).toBe('s3');
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

  // Deploy-logout fix — the session-signing key must FAIL the deploy loudly when missing,
  // not silently default to empty (an empty AUTH_SESSION_SECRET means the data-plane can
  // neither mint nor verify a session, so every signed-in user is logged out on deploy while
  // the deploy still reports success). Same fail-loud shape as POSTGRES_PASSWORD.
  it('emits AUTH_SESSION_SECRET as a FAIL-LOUD `${VAR:?}` in BOTH tiers (never silently empty)', () => {
    const yaml = generateProdCompose({ ...base, secrets: ['AUTH_SESSION_SECRET'] });
    const web = serviceBlock(yaml, 'web');
    const dp = serviceBlock(yaml, 'data-plane');
    // Fail-loud (`:?`), NOT the silent empty default (`:-`), in both the app and the sidecar.
    expect(web).toContain('- AUTH_SESSION_SECRET=${AUTH_SESSION_SECRET:?');
    expect(dp).toContain('- AUTH_SESSION_SECRET=${AUTH_SESSION_SECRET:?');
    expect(web).not.toContain('AUTH_SESSION_SECRET=${AUTH_SESSION_SECRET:-}');
    expect(dp).not.toContain('AUTH_SESSION_SECRET=${AUTH_SESSION_SECRET:-}');
    // The abort message names the file and the consequence, so an operator can act.
    expect(yaml).toContain('AUTH_SESSION_SECRET:?set AUTH_SESSION_SECRET in .env.prod');
    expect(yaml).toContain('logs every signed-in user out on deploy');
  });

  it('keeps the optional sign-in ALTERNATIVES (Google/SMTP) defined-but-empty, not fail-loud', () => {
    const yaml = generateProdCompose({ ...base, secrets: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SMTP_URL', 'EMAIL_FROM'] });
    // Their absence only disables one method — they must NOT abort the deploy.
    for (const n of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SMTP_URL', 'EMAIL_FROM']) {
      expect(yaml).toContain(`- ${n}=\${${n}:-}`);
      expect(yaml).not.toContain(`${n}:?`);
    }
  });

  // Deploy-survival regression guard — the C10 auth/session/`forge_refresh` store lives on
  // the data-plane's state dir (/forge-state/auth/<appId>.json). A deploy recreates this
  // sidecar; only a DURABLE NAMED volume carries the store across that recreate. If this ever
  // regresses to an ephemeral fs (or a bind mount that isn't declared), every session +
  // refresh token is wiped on deploy and every user is logged out. Assert both halves: the
  // sidecar MOUNTS forge_state at the state dir AND the volume is DECLARED at the top level.
  it('persists the auth/session/refresh store on a durable named volume (deploy-survival guard)', () => {
    const yaml = generateProdCompose(base);
    const dp = serviceBlock(yaml, 'data-plane');
    // The whole state dir (which holds /forge-state/auth) is the durable named volume.
    expect(dp).toContain('FORGE_STATE_DIR=/forge-state');
    expect(dp).toContain('- forge_state:/forge-state');
    // The named volume is declared (not an anonymous/ephemeral mount that would be recreated).
    expect(yaml).toMatch(/^volumes:\n(?:.*\n)*?\s{2}forge_state:\s*$/m);
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

  // P34 — when the app uses hosted auth (declares AUTH_SESSION_SECRET), the OPTIONAL Google/SMTP provider
  // vars are wired into the DATA-PLANE (which hosts /auth/*) as defined-but-empty even if not separately
  // declared, so .env.prod is the single source of truth. They must NOT appear on the web tier.
  it('wires the optional auth-provider vars into the data-plane when the app uses auth (P34)', () => {
    const yaml = generateProdCompose({ ...base, secrets: ['AUTH_SESSION_SECRET'] });
    const dp = serviceBlock(yaml, 'data-plane');
    const web = serviceBlock(yaml, 'web');
    for (const n of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SMTP_URL', 'EMAIL_FROM']) {
      expect(dp).toContain(`- ${n}=\${${n}:-}`);
      expect(web).not.toContain(`- ${n}=`); // web proxies /auth/* to the sidecar; it doesn't read these
    }
  });

  it('does NOT auto-wire provider vars when the app does not use hosted auth (P34)', () => {
    const dp = serviceBlock(generateProdCompose({ ...base, secrets: ['ANTHROPIC_API_KEY'] }), 'data-plane');
    expect(dp).not.toContain('GOOGLE_CLIENT_ID');
    expect(dp).not.toContain('SMTP_URL');
  });

  it('does not double-emit a provider var the app also declared (P34 dedup)', () => {
    const dp = serviceBlock(generateProdCompose({ ...base, secrets: ['AUTH_SESSION_SECRET', 'GOOGLE_CLIENT_ID'] }), 'data-plane');
    const occurrences = dp.split('\n').filter((l) => l.includes('GOOGLE_CLIENT_ID=')).length;
    expect(occurrences).toBe(1);
  });

  // P38 — split-host auth: the data-plane gets FORGE_AUTH_PUBLIC_URL defined-but-empty (from .env.prod) so a
  // split-host app (UI on app.<domain>, API on api.<domain>) can pin the user-facing origin its auth URLs
  // target. Data-plane only (the web tier proxies /auth/* and never computes an auth URL). Empty-default =
  // today's request-host-derived behavior, so single-host apps are unaffected.
  it('wires FORGE_AUTH_PUBLIC_URL + FORGE_OAUTH_PUBLIC_URL into the data-plane (not web) when the app uses auth (P38)', () => {
    const yaml = generateProdCompose({ ...base, secrets: ['AUTH_SESSION_SECRET'] });
    const dp = serviceBlock(yaml, 'data-plane');
    expect(dp).toContain('- FORGE_AUTH_PUBLIC_URL=${FORGE_AUTH_PUBLIC_URL:-}');
    expect(dp).toContain('- FORGE_OAUTH_PUBLIC_URL=${FORGE_OAUTH_PUBLIC_URL:-}');
    const web = serviceBlock(yaml, 'web');
    expect(web).not.toContain('FORGE_AUTH_PUBLIC_URL');
    expect(web).not.toContain('FORGE_OAUTH_PUBLIC_URL');
  });

  it('does NOT wire the split-host public-URL vars when the app does not use hosted auth (P38)', () => {
    const dp = serviceBlock(generateProdCompose({ ...base, secrets: ['ANTHROPIC_API_KEY'] }), 'data-plane');
    expect(dp).not.toContain('FORGE_AUTH_PUBLIC_URL');
    expect(dp).not.toContain('FORGE_OAUTH_PUBLIC_URL');
  });

  // P36 — cron fires must be authenticated. When the app declares scheduled jobs, AUTH_SERVICE_TOKEN is
  // deploy-required (`${VAR:?…}`) in BOTH tiers so an unset token fails the deploy loudly instead of firing
  // bare, unauthenticated POSTs at publicly-routed /api/cron/*.
  it('makes AUTH_SERVICE_TOKEN deploy-required in BOTH tiers when jobs are declared (P36)', () => {
    const yaml = generateProdCompose({ ...base, withJobs: true });
    const web = serviceBlock(yaml, 'web');
    const dp = serviceBlock(yaml, 'data-plane');
    expect(web).toContain('- AUTH_SERVICE_TOKEN=${AUTH_SERVICE_TOKEN:?');
    expect(dp).toContain('- AUTH_SERVICE_TOKEN=${AUTH_SERVICE_TOKEN:?');
    expect(yaml).toContain('fire UNAUTHENTICATED');
  });

  it('does NOT force AUTH_SERVICE_TOKEN when the app declares no jobs (P36)', () => {
    const yaml = generateProdCompose({ ...base, withJobs: false });
    expect(yaml).not.toContain('AUTH_SERVICE_TOKEN');
  });

  it('forces AUTH_SERVICE_TOKEN deploy-required even when it was declared as an optional secret + jobs exist (P36)', () => {
    const dp = serviceBlock(generateProdCompose({ ...base, withJobs: true, secrets: ['AUTH_SERVICE_TOKEN'] }), 'data-plane');
    expect(dp).toContain('- AUTH_SERVICE_TOKEN=${AUTH_SERVICE_TOKEN:?');
    // exactly one line (declared + forced must not double-emit)
    expect(dp.split('\n').filter((l) => l.includes('AUTH_SERVICE_TOKEN=')).length).toBe(1);
  });

  // P33 — blobs ride the filesystem volume by default (decoupled from platform-store); only an explicit
  // blobsBackend:'s3' flips the sidecar to the object store + surfaces the FORGE_S3_* seam.
  it('keeps blobs on the filesystem by default — no FORGE_BLOBS_BACKEND (P33)', () => {
    expect(generateProdCompose(base)).not.toContain('FORGE_BLOBS_BACKEND');
    expect(generateProdCompose({ ...base, platformDb: true })).not.toContain('FORGE_BLOBS_BACKEND');
  });

  it('wires the S3 blob backend only when blobsBackend is s3 (P33)', () => {
    const dp = serviceBlock(generateProdCompose({ ...base, blobsBackend: 's3' }), 'data-plane');
    expect(dp).toContain('- FORGE_BLOBS_BACKEND=s3');
    expect(dp).toContain('- FORGE_S3_ENDPOINT=${FORGE_S3_ENDPOINT:-}');
    expect(dp).toContain('- FORGE_S3_BUCKET=${FORGE_S3_BUCKET:-}');
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

// C13 — the operator provisioning contract. A secret catalog (the single source of
// truth) annotates .env.prod.example and generates a per-app PROVISIONING.md runbook,
// so an operator knows what each value is, which capability needs it, and how to set it.
describe('secret catalog (C13) — every required value is described', () => {
  const REQUIRED_ROSTER = [
    'POSTGRES_PASSWORD', 'FORGE_SECRETS_KEY', 'ANTHROPIC_API_KEY',
    'AUTH_SESSION_SECRET', 'AUTH_SERVICE_TOKEN', 'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET', 'SMTP_URL', 'EMAIL_FROM',
  ];
  it('covers the whole required roster with capability + what + obtain', () => {
    for (const name of REQUIRED_ROSTER) {
      const spec = SECRET_CATALOG[name];
      expect(spec, name).toBeTruthy();
      expect(spec!.capability.length).toBeGreaterThan(0);
      expect(spec!.what.length).toBeGreaterThan(0);
      expect(spec!.obtain.length).toBeGreaterThan(0);
    }
  });
  it('binds Google/SMTP to C10/C12 and carries the OAuth redirect-URI shape', () => {
    expect(describeSecret('GOOGLE_CLIENT_ID').capability).toContain('C10');
    expect(describeSecret('GOOGLE_CLIENT_ID').obtain).toContain('/auth/google/callback');
    expect(describeSecret('SMTP_URL').capability).toContain('C12');
    expect(describeSecret('AUTH_SESSION_SECRET').generate).toContain('openssl');
  });
  it('synthesizes a neutral spec for an unknown/app-specific secret (never a bare NAME=)', () => {
    const spec = describeSecret('SOME_APP_THING');
    expect(spec.capability).toBe('App-specific');
    expect(spec.what.length).toBeGreaterThan(0);
    expect(requirementLabel(spec)).toBe('Conditional');
  });
});

describe('generateEnvProdExample — now annotates each secret (C13)', () => {
  it('precedes each declared secret with what-it-is + how-to-obtain, keeps the assignable line', () => {
    const env = generateEnvProdExample({
      appName: 'acme', host: 'app.example.com', withPostgres: true, withRedis: false,
      secrets: ['GOOGLE_CLIENT_ID', 'SMTP_URL'],
    });
    expect(env).toContain('# GOOGLE_CLIENT_ID —');
    expect(env).toContain('#   Obtain:');
    expect(env).toContain('GOOGLE_CLIENT_ID=');
    expect(env).toContain('# SMTP_URL —');
    expect(env).toContain('SMTP_URL=');
    // The C5 vault key still carries its generate hint, and it points at the runbook.
    expect(env).toContain('#   Generate: openssl rand -base64 32');
    expect(env).toContain(PROVISIONING_FILE);
  });
});

describe('generateProvisioningRunbook — per-app operator runbook (C13)', () => {
  const base = { appName: 'acme', host: 'app.example.com', withPostgres: true, withRedis: false };

  it('lists exactly this app’s secrets with capability + set commands', () => {
    const md = generateProvisioningRunbook({ ...base, secrets: ['ANTHROPIC_API_KEY'] });
    expect(md).toContain('# Provisioning — acme');
    expect(md).toContain('`FORGE_SECRETS_KEY`');
    expect(md).toContain('`POSTGRES_PASSWORD`'); // withPostgres
    expect(md).toContain('`ANTHROPIC_API_KEY`');
    // The exact dev + prod set paths.
    expect(md).toContain('./forge secrets set --app acme --name FORGE_SECRETS_KEY');
    expect(md).toContain('app/.env.prod');
    expect(md).toContain('./forge deploy --app acme');
  });

  it('when auth is used but neither Google nor SMTP is declared, spells out the unblock (P34 — no re-declare)', () => {
    const md = generateProvisioningRunbook({ ...base, secrets: ['AUTH_SESSION_SECRET'] });
    expect(md).toContain('Enabling a working sign-in method');
    expect(md).toContain('no way to sign in');
    // The precise redirect URI (host-substituted) an operator needs for Google.
    expect(md).toContain('https://app.example.com/auth/google/callback');
    // P34 — the provider vars are already wired into the data-plane, so the runbook says "just fill
    // .env.prod + redeploy" and NO LONGER tells the operator to `--secret`-declare + re-productionize.
    expect(md).toContain('already wired into the data-plane (P34)');
    expect(md).toContain('./forge deploy --app acme');
    expect(md).not.toContain('--secret GOOGLE_CLIENT_ID');
    expect(md).not.toContain('./forge productionize --app acme');
  });

  it('marks a declared method as configured (P34 wording)', () => {
    const md = generateProvisioningRunbook({ ...base, secrets: ['AUTH_SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] });
    expect(md).toContain('_(declared as a secret)_');
    // Google is declared; SMTP is not — but with P34 there is no `--secret` re-declare snippet at all.
    expect(md).not.toContain('--secret');
  });

  it('omits the sign-in section for an app that does not use auth', () => {
    const md = generateProvisioningRunbook({ ...base, secrets: [] });
    expect(md).not.toContain('Enabling a working sign-in method');
  });

  it('is deterministic — identical inputs produce identical bytes (convergent)', () => {
    const opts = { ...base, secrets: ['AUTH_SESSION_SECRET', 'SMTP_URL', 'EMAIL_FROM'] };
    expect(generateProvisioningRunbook(opts)).toBe(generateProvisioningRunbook(opts));
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
