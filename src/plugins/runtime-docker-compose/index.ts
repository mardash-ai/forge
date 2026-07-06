import { run, type RunResult } from '../../shared/exec';

// Plugin: runtime-docker-compose.
//
// Packages the Docker Compose Implementation used by the ProvisionEnvironment,
// InstallDependencies, RunDevServer, Build, Test, and Lint Capabilities. All app
// work runs here — in Docker — never on the local machine.

export const IMPLEMENTATION = 'runtime-docker-compose';

// Run a one-off command in a service container: `docker compose run --rm`.
// --no-deps so cheap checks (build/lint/test) don't spin up db/redis.
export function composeRun(
  appDir: string,
  service: string,
  command: string[],
  opts: { logFile?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return run(
    'docker',
    ['compose', 'run', '--rm', '--no-deps', '-T', service, ...command],
    { cwd: appDir, logFile: opts.logFile, timeoutMs: opts.timeoutMs ?? 20 * 60_000 },
  );
}

// Start the full environment detached (dependencies included). `env` carries
// decrypted secret values into the `docker compose` process so Compose can
// interpolate them into the container — they never touch a file on disk.
export function composeUp(
  appDir: string,
  service?: string,
  opts: { logFile?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const args = ['compose', 'up', '-d', ...(service ? [service] : [])];
  return run('docker', args, { cwd: appDir, env: opts.env, logFile: opts.logFile, timeoutMs: 10 * 60_000 });
}

export function composeDown(appDir: string): Promise<RunResult> {
  return run('docker', ['compose', 'down'], { cwd: appDir, timeoutMs: 2 * 60_000 });
}

export interface ServiceStatus {
  name: string;
  state: string;
  status: string;
  health?: string;
  id: string;
}

// Structured `docker compose ps` (JSON), tolerant of the two output shapes
// Compose has shipped (one JSON object per line, or a single JSON array).
export async function composePs(appDir: string): Promise<ServiceStatus[]> {
  const r = await run('docker', ['compose', 'ps', '--format', 'json'], {
    cwd: appDir,
    timeoutMs: 30_000,
  });
  const text = r.combined.trim();
  if (!text) return [];
  const parseOne = (obj: any): ServiceStatus => ({
    name: obj.Service ?? obj.Name ?? '',
    state: obj.State ?? '',
    status: obj.Status ?? '',
    health: obj.Health || undefined,
    id: obj.ID ?? obj.Id ?? '',
  });
  try {
    if (text.startsWith('[')) {
      return (JSON.parse(text) as any[]).map(parseOne);
    }
    return text
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => parseOne(JSON.parse(l)));
  } catch {
    return [];
  }
}

export interface ComposeOptions {
  appName: string;
  port: number;
  withPostgres: boolean;
  withRedis: boolean;
  devCommand: string;
  // Secret names the app declares it needs. Each becomes an interpolation line
  // (empty when unset), whose value Forge injects from its encrypted store at run
  // time — the value is never written into this file.
  secrets?: string[];
  // Host-port overrides (container ports are fixed). Defaults: web=port,
  // postgres=5432, redis=6379. Lets a re-provision preserve a custom remap
  // (e.g. host 5433 → postgres 5432) instead of resetting it.
  ports?: { web?: number; postgres?: number; redis?: number };
}

// Generate the app's compose.yaml. The `web` service uses the stock Node image
// with the source bind-mounted and node_modules in a named volume — so
// install/build/test/lint/dev all share one deterministic runtime with no
// per-app image build required.
export function generateCompose(opts: ComposeOptions): string {
  const services: string[] = [];
  const dependsOn: string[] = [];
  const volumes: string[] = ['  web_node_modules:'];

  // Host ports (container ports are fixed). Overrides preserve custom remaps.
  const webHost = opts.ports?.web ?? opts.port;
  const pgHost = opts.ports?.postgres ?? 5432;
  const redisHost = opts.ports?.redis ?? 6379;

  if (opts.withPostgres) {
    dependsOn.push('      - postgres');
    services.push(`  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=forge
      - POSTGRES_PASSWORD=forge
      - POSTGRES_DB=${opts.appName.replace(/[^a-z0-9_]/gi, '_')}
    ports:
      - "${pgHost}:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U forge"]
      interval: 10s
      timeout: 5s
      retries: 5`);
    volumes.push('  postgres_data:');
  }

  if (opts.withRedis) {
    dependsOn.push('      - redis');
    services.push(`  redis:
    image: redis:7-alpine
    ports:
      - "${redisHost}:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5`);
  }

  const dependsBlock = dependsOn.length ? `    depends_on:\n${dependsOn.join('\n')}\n` : '';

  // One interpolation line per declared secret. `${NAME:-}` keeps the var
  // DEFINED-but-empty when unset, so the app can detect absence and degrade
  // (e.g. return 503) instead of crashing — and no value is ever written here.
  const secretEnv = (opts.secrets ?? [])
    .map((name) => `      - ${name}=\${${name}:-}`)
    .join('\n');

  const web = `  web:
    image: node:22-bookworm-slim
    working_dir: /app
    command: ${opts.devCommand}
    # NODE_ENV is intentionally NOT pinned here: Next sets it per command
    # (dev -> development, build/start -> production). Forcing development
    # breaks \`next build\` prerendering.
    environment:
      - HOST=0.0.0.0
      - PORT=${opts.port}${secretEnv ? '\n' + secretEnv : ''}
${dependsBlock}    ports:
      - "${webHost}:${opts.port}"
    volumes:
      - .:/app
      - web_node_modules:/app/node_modules
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:${opts.port}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s`;

  return `# Generated by Forge — ProvisionEnvironment (runtime-docker-compose).
# Do not hand-edit service topology; reprovision instead.
name: forge-${opts.appName}

services:
${web}
${services.length ? '\n' + services.join('\n\n') + '\n' : ''}
volumes:
${volumes.join('\n')}
`;
}
