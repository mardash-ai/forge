import { randomBytes } from 'node:crypto';

// Plugin: observability-stack.
//
// Forge owns the canonical self-hosted Langfuse v3 stack definition (C37). This emits the standalone
// compose + the .env that the ProvisionObservability capability brings up — the same way productionize
// (productionize-nextjs-compose) emits an app's compose.prod.yaml. Every fix discovered standing the
// box stack up by hand is baked in so the stack comes up green on the first provision:
//   - single-node ClickHouse (CLICKHOUSE_CLUSTER_ENABLED=false) on web+worker — else they crashloop.
//   - S3/MinIO region + force-path-style on web+worker — else OTLP event uploads 500 "Region is missing".
//   - HOSTNAME=0.0.0.0 on web — else Next.js binds only the FIRST network's IP and a fronting proxy 502s.
//   - optional Traefik fronting (publicHost) — proxy network + labels + HTTPS via a cert resolver.
// The shared `observability` network is EXTERNAL (stable name) so consumers (dorinda-api, …) attach to
// it by name and export OTel to http://langfuse-web:3000/api/public/otel.

export const IMPLEMENTATION = 'observability-stack';

/** Langfuse serves an unauthenticated readiness probe here — 200 once web is up. */
export const OBSERVABILITY_HEALTH_PATH = '/api/public/health';

/** Internal OTLP ingest endpoint consumers export to (Basic-auth with the project key pair). */
export const OBSERVABILITY_OTLP_PATH = '/api/public/otel';

export interface ObservabilityStackOptions {
  /** Compose project name. Default 'dorinda-monitor'. */
  projectName?: string;
  /** Public hostname to front langfuse-web via a Traefik proxy (e.g. 'monitor.dorinda.ai').
   *  When set: adds the proxy network + Traefik labels + HOSTNAME=0.0.0.0 + an HTTPS NEXTAUTH_URL. */
  publicHost?: string;
  /** Host port langfuse-web is published on for operator/local access. Default 3100. */
  uiPort?: number;
  /** The shared, EXTERNAL network consumers join to reach langfuse-web. Default 'observability'. */
  network?: string;
  /** The external Traefik network (only used when publicHost is set). Default 'proxy'. */
  proxyNetwork?: string;
  /** Traefik cert resolver name (only used when publicHost is set). Default 'letsencrypt'. */
  certResolver?: string;
  /** MinIO/S3 region the Langfuse v3 client requires (any non-empty value works for MinIO). Default 'us-east-1'. */
  s3Region?: string;
  /** Langfuse bootstrap identity — seeds the org/project that owns the OTLP key pair on first boot. */
  orgId?: string;
  orgName?: string;
  projectId?: string;
  projectDisplayName?: string;
  adminName?: string;
  /** When set, reference EXISTING named volumes under this prefix instead of the default
   *  `<projectName>_langfuse-*-data` — used to ADOPT an already-running stack's data (e.g.
   *  preserveVolumesFrom:'observability' keeps the box's traces + wired keys across a rename). */
  preserveVolumesFrom?: string;
}

interface Resolved extends Required<Omit<ObservabilityStackOptions, 'publicHost' | 'preserveVolumesFrom'>> {
  publicHost?: string;
  preserveVolumesFrom?: string;
}

function resolve(opts: ObservabilityStackOptions): Resolved {
  return {
    projectName: opts.projectName ?? 'dorinda-monitor',
    publicHost: opts.publicHost,
    uiPort: opts.uiPort ?? 3100,
    network: opts.network ?? 'observability',
    proxyNetwork: opts.proxyNetwork ?? 'proxy',
    certResolver: opts.certResolver ?? 'letsencrypt',
    s3Region: opts.s3Region ?? 'us-east-1',
    orgId: opts.orgId ?? 'forge',
    orgName: opts.orgName ?? 'Forge',
    projectId: opts.projectId ?? 'forge-default',
    projectDisplayName: opts.projectDisplayName ?? 'Forge Default',
    adminName: opts.adminName ?? 'Forge Admin',
    preserveVolumesFrom: opts.preserveVolumesFrom,
  };
}

// The S3/MinIO block Langfuse v3 needs on BOTH web and worker. The region + force-path-style are the
// fix for the OTLP 500 "Region is missing" — the v3 AWS SDK client refuses to upload events without
// them even against MinIO. `${VAR}` are compose interpolation refs resolved from the .env at up time.
function s3Env(r: Resolved): string {
  const lines: string[] = [];
  for (const kind of ['EVENT', 'MEDIA'] as const) {
    lines.push(
      `      LANGFUSE_S3_${kind}_UPLOAD_REGION: ${r.s3Region}`,
      `      LANGFUSE_S3_${kind}_UPLOAD_ENDPOINT: http://langfuse-minio:9000`,
      `      LANGFUSE_S3_${kind}_UPLOAD_BUCKET: langfuse`,
      `      LANGFUSE_S3_${kind}_UPLOAD_PREFIX: ${kind === 'EVENT' ? 'events/' : 'media/'}`,
      `      LANGFUSE_S3_${kind}_UPLOAD_ACCESS_KEY_ID: \${LANGFUSE_MINIO_ACCESS_KEY}`,
      `      LANGFUSE_S3_${kind}_UPLOAD_SECRET_ACCESS_KEY: \${LANGFUSE_MINIO_SECRET_KEY}`,
      `      LANGFUSE_S3_${kind}_UPLOAD_FORCE_PATH_STYLE: "true"`,
    );
  }
  return lines.join('\n');
}

// ClickHouse connection env, shared by web + worker. CLUSTER_ENABLED=false is required for a
// single-node ClickHouse — the default (true) makes Langfuse issue ON CLUSTER DDL that never
// completes, crashlooping web + worker on boot.
function clickhouseEnv(): string {
  return [
    '      CLICKHOUSE_MIGRATION_URL: clickhouse://langfuse-clickhouse:9000',
    '      CLICKHOUSE_URL: http://langfuse-clickhouse:8123',
    '      CLICKHOUSE_USER: clickhouse',
    '      CLICKHOUSE_PASSWORD: ${LANGFUSE_CLICKHOUSE_PASSWORD}',
    '      CLICKHOUSE_CLUSTER_ENABLED: "false"',
  ].join('\n');
}

function redisMinioEnv(): string {
  return [
    '      REDIS_HOST: langfuse-redis',
    '      REDIS_PORT: "6379"',
    '      REDIS_AUTH: ${LANGFUSE_REDIS_PASSWORD}',
    '      MINIO_ACCESS_KEY_ID: ${LANGFUSE_MINIO_ACCESS_KEY}',
    '      MINIO_SECRET_ACCESS_KEY: ${LANGFUSE_MINIO_SECRET_KEY}',
    '      MINIO_ENDPOINT: langfuse-minio',
    '      MINIO_PORT: "9000"',
    '      MINIO_SSL: "false"',
    '      MINIO_BUCKET_NAME: langfuse',
  ].join('\n');
}

/**
 * Generate the canonical standalone Langfuse compose. Deterministic (no secrets inside — those live in
 * the sibling .env), so a re-generate against an unchanged stack is a diff-clean no-op and `up -d`
 * doesn't recreate anything.
 */
export function generateObservabilityCompose(opts: ObservabilityStackOptions = {}): string {
  const r = resolve(opts);
  const fronted = Boolean(r.publicHost);

  // langfuse-web network membership + the Traefik fronting labels (only when publicHost is set).
  const webNetworks = fronted ? `      - ${r.network}\n      - ${r.proxyNetwork}` : `      - ${r.network}`;
  const traefikLabels = fronted
    ? `    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=${r.proxyNetwork}"
      - "traefik.http.routers.langfuse.rule=Host(\`${r.publicHost}\`)"
      - "traefik.http.routers.langfuse.entrypoints=websecure"
      - "traefik.http.routers.langfuse.tls=true"
      - "traefik.http.routers.langfuse.tls.certresolver=${r.certResolver}"
      - "traefik.http.services.langfuse.loadbalancer.server.port=3000"\n`
    : '';
  // Bind Next.js to ALL interfaces when fronted — the image otherwise binds only the first network's
  // IP (observability), so the proxy on the `proxy` network gets connection-refused (502).
  const webHostname = fronted ? '      HOSTNAME: "0.0.0.0"\n' : '';
  const nextauthDefault = fronted ? `https://${r.publicHost}` : `http://localhost:${r.uiPort}`;

  const depends = `    depends_on:
      langfuse-postgres: {condition: service_healthy}
      langfuse-redis: {condition: service_healthy}
      langfuse-clickhouse: {condition: service_healthy}
      langfuse-minio: {condition: service_healthy}`;

  // Volume declarations. Default: compose-managed (`<project>_langfuse-*-data`). With
  // preserveVolumesFrom: reference the existing named volumes so an already-running stack's data is
  // adopted in place rather than replaced with empty volumes.
  const vol = (name: string) =>
    r.preserveVolumesFrom
      ? `  langfuse-${name}-data:\n    name: ${r.preserveVolumesFrom}_langfuse-${name}-data`
      : `  langfuse-${name}-data:`;

  const networksBlock = fronted
    ? `networks:\n  ${r.network}:\n    external: true\n  ${r.proxyNetwork}:\n    external: true`
    : `networks:\n  ${r.network}:\n    external: true`;

  return `# Generated by Forge — ProvisionObservability (observability-stack). Do NOT hand-edit; reprovision.
# Standalone self-hosted Langfuse v3 stack. Consumers join the external \`${r.network}\` network and
# export OTel to http://langfuse-web:3000${OBSERVABILITY_OTLP_PATH}. Secrets live in the sibling .env.
name: ${r.projectName}

services:
  langfuse-postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: langfuse
      POSTGRES_PASSWORD: \${LANGFUSE_PG_PASSWORD}
      POSTGRES_DB: langfuse
    volumes:
      - langfuse-postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U langfuse -d langfuse"]
      interval: 5s
      timeout: 5s
      retries: 20
    networks: [${r.network}]
    restart: unless-stopped

  langfuse-redis:
    image: valkey/valkey:8-alpine
    command: >
      valkey-server --requirepass \${LANGFUSE_REDIS_PASSWORD} --loglevel warning
    volumes:
      - langfuse-redis-data:/data
    healthcheck:
      test: ["CMD-SHELL", "valkey-cli -a \${LANGFUSE_REDIS_PASSWORD} ping | grep PONG"]
      interval: 5s
      timeout: 5s
      retries: 20
    networks: [${r.network}]
    restart: unless-stopped

  langfuse-clickhouse:
    image: clickhouse/clickhouse-server:24.12-alpine
    environment:
      CLICKHOUSE_USER: clickhouse
      CLICKHOUSE_PASSWORD: \${LANGFUSE_CLICKHOUSE_PASSWORD}
      CLICKHOUSE_DB: default
    volumes:
      - langfuse-clickhouse-data:/var/lib/clickhouse
    healthcheck:
      test: ["CMD-SHELL", "clickhouse-client --user clickhouse --password \${LANGFUSE_CLICKHOUSE_PASSWORD} --query 'SELECT 1'"]
      interval: 5s
      timeout: 5s
      retries: 20
    networks: [${r.network}]
    restart: unless-stopped

  langfuse-minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: \${LANGFUSE_MINIO_ACCESS_KEY}
      MINIO_ROOT_PASSWORD: \${LANGFUSE_MINIO_SECRET_KEY}
    volumes:
      - langfuse-minio-data:/data
    healthcheck:
      test: ["CMD-SHELL", "mc ready local || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 20
    networks: [${r.network}]
    restart: unless-stopped

  langfuse-web:
    image: langfuse/langfuse:3
${depends}
    ports:
      - "\${LANGFUSE_UI_PORT:-${r.uiPort}}:3000"
${traefikLabels}    environment:
${webHostname}      DATABASE_URL: postgresql://langfuse:\${LANGFUSE_PG_PASSWORD}@langfuse-postgres:5432/langfuse
      NEXTAUTH_URL: \${LANGFUSE_NEXTAUTH_URL:-${nextauthDefault}}
      NEXTAUTH_SECRET: \${LANGFUSE_NEXTAUTH_SECRET}
      SALT: \${LANGFUSE_SALT}
      ENCRYPTION_KEY: \${LANGFUSE_ENCRYPTION_KEY}
${clickhouseEnv()}
${redisMinioEnv()}
${s3Env(r)}
      LANGFUSE_INIT_ORG_ID: ${r.orgId}
      LANGFUSE_INIT_ORG_NAME: ${r.orgName}
      LANGFUSE_INIT_PROJECT_ID: ${r.projectId}
      LANGFUSE_INIT_PROJECT_NAME: ${r.projectDisplayName}
      LANGFUSE_INIT_PROJECT_PUBLIC_KEY: \${LANGFUSE_PUBLIC_KEY}
      LANGFUSE_INIT_PROJECT_SECRET_KEY: \${LANGFUSE_SECRET_KEY}
      LANGFUSE_INIT_USER_EMAIL: \${LANGFUSE_ADMIN_EMAIL}
      LANGFUSE_INIT_USER_PASSWORD: \${LANGFUSE_ADMIN_PASSWORD}
      LANGFUSE_INIT_USER_NAME: ${r.adminName}
      TELEMETRY_ENABLED: "false"
      LANGFUSE_TELEMETRY_ENABLED: "false"
    networks:
${webNetworks}
    restart: unless-stopped

  langfuse-worker:
    image: langfuse/langfuse-worker:3
${depends}
    environment:
      DATABASE_URL: postgresql://langfuse:\${LANGFUSE_PG_PASSWORD}@langfuse-postgres:5432/langfuse
      SALT: \${LANGFUSE_SALT}
      ENCRYPTION_KEY: \${LANGFUSE_ENCRYPTION_KEY}
${clickhouseEnv()}
${redisMinioEnv()}
${s3Env(r)}
      TELEMETRY_ENABLED: "false"
      LANGFUSE_TELEMETRY_ENABLED: "false"
    networks: [${r.network}]
    restart: unless-stopped

${networksBlock}

volumes:
${vol('postgres')}
${vol('redis')}
${vol('clickhouse')}
${vol('minio')}
`;
}

// ── Secrets ──────────────────────────────────────────────────────────────────

export interface ObservabilitySecrets {
  LANGFUSE_PG_PASSWORD: string;
  LANGFUSE_REDIS_PASSWORD: string;
  LANGFUSE_CLICKHOUSE_PASSWORD: string;
  LANGFUSE_MINIO_ACCESS_KEY: string;
  LANGFUSE_MINIO_SECRET_KEY: string;
  LANGFUSE_NEXTAUTH_SECRET: string;
  LANGFUSE_SALT: string;
  LANGFUSE_ENCRYPTION_KEY: string;
  LANGFUSE_PUBLIC_KEY: string;
  LANGFUSE_SECRET_KEY: string;
  LANGFUSE_ADMIN_PASSWORD: string;
}

/** Every secret var the .env carries — the source of truth for the .env.example + the env renderer. */
export const OBSERVABILITY_SECRET_KEYS: ReadonlyArray<keyof ObservabilitySecrets> = [
  'LANGFUSE_PG_PASSWORD',
  'LANGFUSE_REDIS_PASSWORD',
  'LANGFUSE_CLICKHOUSE_PASSWORD',
  'LANGFUSE_MINIO_ACCESS_KEY',
  'LANGFUSE_MINIO_SECRET_KEY',
  'LANGFUSE_NEXTAUTH_SECRET',
  'LANGFUSE_SALT',
  'LANGFUSE_ENCRYPTION_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_ADMIN_PASSWORD',
];

/** Non-secret config vars the .env also carries (host-specific, safe to show). */
export const OBSERVABILITY_CONFIG_KEYS = [
  'LANGFUSE_ADMIN_EMAIL',
  'LANGFUSE_NEXTAUTH_URL',
  'LANGFUSE_UI_PORT',
] as const;

/**
 * Generate a fresh, self-consistent set of stack secrets. This is the FIRST forge path that writes
 * real secret values to a file (productionize deliberately emits placeholders) — necessary because
 * Langfuse's own bootstrap reads them from the container env, and the project key pair must be a
 * stable, known value so consumers can wire it into their OTLP Basic-auth header. Notes:
 *   - ENCRYPTION_KEY MUST be exactly 64 hex chars (32 bytes) or Langfuse refuses to boot.
 *   - The project keys mimic Langfuse's own `pk-lf-…` / `sk-lf-…` shape.
 */
export function generateObservabilitySecrets(): ObservabilitySecrets {
  const hex = (bytes: number) => randomBytes(bytes).toString('hex');
  const b64 = (bytes: number) => randomBytes(bytes).toString('base64url');
  return {
    LANGFUSE_PG_PASSWORD: hex(24),
    LANGFUSE_REDIS_PASSWORD: hex(24),
    LANGFUSE_CLICKHOUSE_PASSWORD: hex(24),
    LANGFUSE_MINIO_ACCESS_KEY: `minio-${hex(8)}`,
    LANGFUSE_MINIO_SECRET_KEY: hex(24),
    LANGFUSE_NEXTAUTH_SECRET: b64(32),
    LANGFUSE_SALT: b64(32),
    LANGFUSE_ENCRYPTION_KEY: hex(32), // exactly 64 hex chars
    LANGFUSE_PUBLIC_KEY: `pk-lf-${hex(16)}`,
    LANGFUSE_SECRET_KEY: `sk-lf-${hex(24)}`,
    LANGFUSE_ADMIN_PASSWORD: b64(18),
  };
}

export interface RenderEnvOptions {
  adminEmail?: string;
  nextauthUrl?: string;
  uiPort?: number;
}

/** Render the real .env (secrets + host config) the stack is brought up with. Mode 0600 at write. */
export function renderObservabilityEnv(secrets: ObservabilitySecrets, opts: RenderEnvOptions = {}): string {
  const lines: string[] = [
    '# Generated by Forge — ProvisionObservability. Real secrets — gitignore this file, never commit.',
    `LANGFUSE_ADMIN_EMAIL=${opts.adminEmail ?? 'admin@forge.local'}`,
    `LANGFUSE_NEXTAUTH_URL=${opts.nextauthUrl ?? `http://localhost:${opts.uiPort ?? 3100}`}`,
    `LANGFUSE_UI_PORT=${opts.uiPort ?? 3100}`,
    '',
  ];
  for (const k of OBSERVABILITY_SECRET_KEYS) lines.push(`${k}=${secrets[k]}`);
  return lines.join('\n') + '\n';
}

/** Render the committable .env.example — documents every var, never a real value. */
export function renderObservabilityEnvExample(): string {
  const lines: string[] = [
    '# ProvisionObservability .env — copy to .env and fill in, or let `forge provision-observability`',
    '# generate real values on first provision. Values are read by Langfuse at container boot.',
    'LANGFUSE_ADMIN_EMAIL=admin@forge.local',
    'LANGFUSE_NEXTAUTH_URL=http://localhost:3100',
    'LANGFUSE_UI_PORT=3100',
    '',
  ];
  for (const k of OBSERVABILITY_SECRET_KEYS) lines.push(`${k}=`);
  return lines.join('\n') + '\n';
}
