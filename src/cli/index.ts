import { Command } from 'commander';
import { compact, summarize } from './render';

// The Forge CLI is a THIN API client. It implements no Capability itself — it
// builds a request, calls the API, and renders a compact, token-conscious view.

const API = process.env.FORGE_API_URL ?? 'http://localhost:3717';

interface GlobalOpts {
  summary?: boolean;
  json?: boolean;
  raw?: boolean;
}

let globalOpts: GlobalOpts = {};

function fail(message: string, extra?: unknown): never {
  const payload = { error: { message }, ...(extra ? { details: extra } : {}) };
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(1);
}

// Accumulator for repeatable options (e.g. --secret A --secret B).
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forge-actor-type': 'builder',
        'x-forge-actor-id': 'cli',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return fail(`Cannot reach Forge API at ${API}. Is the platform running? (make up)`, String(err));
  }
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    process.stdout.write(JSON.stringify(data) + '\n');
    process.exit(1);
  }
  return data;
}

// Render a Capability result (single resource or array).
function output(result: { resource: any } | any): void {
  const resource = result.resource ?? result;
  if (globalOpts.raw) {
    process.stdout.write(JSON.stringify(resource, null, 2) + '\n');
    return;
  }
  const render = (r: any) => (globalOpts.summary ? summarize(r) : JSON.stringify(compact(r)));
  const out = Array.isArray(resource) ? resource.map(render).join(globalOpts.summary ? '\n\n' : '\n') : render(resource);
  process.stdout.write(out + '\n');
}

async function runCapability(slug: string, body: Record<string, unknown>): Promise<void> {
  const result = await api('POST', `/capabilities/${slug}`, body);
  output(result);
}

const program = new Command();
program
  .name('forge')
  .description('Forge — Docker-first, API-first software creation platform')
  .option('--summary', 'human-readable output')
  .option('--json', 'compact JSON output (default)')
  .option('--raw', 'full raw resource JSON')
  .hook('preAction', (thisCommand) => {
    globalOpts = thisCommand.opts();
  });

// --- init app --------------------------------------------------------------
const init = program.command('init').description('Initialize resources');
init
  .command('app')
  .description('Initialize a Dockerized application (InitializeApp)')
  .requiredOption('--name <name>', 'application name (kebab-case)')
  .option('--platform <platform>', 'target platform', 'web')
  .option('--framework <framework>', 'target framework', 'nextjs')
  .option('--template <template>', 'scaffold template', 'nextjs-web')
  .option('--package-manager <pm>', 'package manager', 'npm')
  .action(async (opts) => {
    await runCapability('initialize-app', {
      name: opts.name,
      platform: opts.platform,
      framework: opts.framework,
      template: opts.template,
      package_manager: opts.packageManager,
    });
  });

// Back-compat alias: `forge init-app`
program
  .command('init-app')
  .description('Alias for `init app`')
  .requiredOption('--name <name>')
  .option('--platform <platform>', 'target platform', 'web')
  .option('--framework <framework>', 'target framework', 'nextjs')
  .option('--template <template>', 'scaffold template', 'nextjs-web')
  .action(async (opts) => {
    await runCapability('initialize-app', {
      name: opts.name,
      platform: opts.platform,
      framework: opts.framework,
      template: opts.template,
    });
  });

// --- provision -------------------------------------------------------------
program
  .command('provision')
  .description('Provision a Docker environment (ProvisionEnvironment)')
  .requiredOption('--app <app>')
  .option('--platform <platform>', 'target platform', 'web')
  .option('--framework <framework>', 'target framework', 'nextjs')
  .option('--with-postgres', 'add a Postgres service')
  .option('--with-redis', 'add a Redis service')
  .option('--without-postgres', 'remove the Postgres service (needs --force if it holds data)')
  .option('--without-redis', 'remove the Redis service')
  .option('--postgres-port <hostPort>', 'host port to map to Postgres 5432')
  .option('--redis-port <hostPort>', 'host port to map to Redis 6379')
  .option('--web-port <hostPort>', 'host port to map to the web container')
  .option('--force', 'allow dropping a service that owns a data volume (e.g. Postgres)')
  .option('--secret <name>', 'declare a secret the app needs, e.g. ANTHROPIC_API_KEY (repeatable)', collect, [])
  .action(async (opts) => {
    await runCapability('provision-environment', {
      app: opts.app,
      platform: opts.platform,
      framework: opts.framework,
      with_postgres: Boolean(opts.withPostgres),
      with_redis: Boolean(opts.withRedis),
      without_postgres: Boolean(opts.withoutPostgres),
      without_redis: Boolean(opts.withoutRedis),
      ...(opts.postgresPort ? { postgres_port: opts.postgresPort } : {}),
      ...(opts.redisPort ? { redis_port: opts.redisPort } : {}),
      ...(opts.webPort ? { web_port: opts.webPort } : {}),
      force: Boolean(opts.force),
      secrets: opts.secret,
    });
  });

// --- install ---------------------------------------------------------------
program
  .command('install')
  .description('Install dependencies in Docker (InstallDependencies)')
  .requiredOption('--app <app>')
  .option('--platform <platform>', 'target platform', 'web')
  .option('--framework <framework>', 'target framework', 'nextjs')
  .action(async (opts) => {
    await runCapability('install-dependencies', { app: opts.app, platform: opts.platform, framework: opts.framework });
  });

// --- dev -------------------------------------------------------------------
program
  .command('dev')
  .description('Start/stop/inspect the dev server (RunDevServer)')
  .requiredOption('--app <app>')
  .option('--platform <platform>', 'target platform', 'web')
  .option('--framework <framework>', 'target framework', 'nextjs')
  .option('--stop', 'stop the dev server')
  .option('--status', 'report status only')
  .action(async (opts) => {
    const action = opts.stop ? 'stop' : opts.status ? 'status' : 'start';
    await runCapability('run-dev-server', { app: opts.app, platform: opts.platform, framework: opts.framework, action });
  });

// --- build / test / lint ---------------------------------------------------
for (const [cmd, slug, desc] of [
  ['build', 'build', 'Run a reproducible build (Build)'],
  ['test', 'test', 'Run tests (Test)'],
  ['lint', 'lint', 'Run lint (Lint)'],
] as const) {
  program
    .command(cmd)
    .description(desc)
    .requiredOption('--app <app>')
    .option('--platform <platform>', 'target platform', 'web')
    .option('--framework <framework>', 'target framework', 'nextjs')
    .action(async (opts) => {
      await runCapability(slug, { app: opts.app, platform: opts.platform, framework: opts.framework });
    });
}

// --- deploy ----------------------------------------------------------------
program
  .command('deploy')
  .description('Zero-downtime deploy of the app’s production stack (Deploy)')
  .requiredOption('--app <app>')
  .option('--service <service>', 'public service rolled start-first', 'web')
  .option('--context <context>', 'docker context for a remote target (default: local daemon)')
  .option('--compose-file <file>', 'production compose manifest (at the project root)', 'compose.prod.yaml')
  .option('--proxy-net <name>', 'reverse-proxy network to drain the old replica from', 'proxy')
  .option('--no-pull', 'skip pulling images first')
  .option('--drain-seconds <n>', 'seconds to let in-flight requests settle before removing the old', '3')
  .option('--timeout-seconds <n>', 'seconds to wait for the new replica to become healthy', '120')
  .action(async (opts) => {
    await runCapability('deploy', {
      app: opts.app,
      service: opts.service,
      context: opts.context,
      compose_file: opts.composeFile,
      proxy_net: opts.proxyNet,
      pull: opts.pull,
      drain_seconds: Number.parseInt(opts.drainSeconds, 10),
      timeout_seconds: Number.parseInt(opts.timeoutSeconds, 10),
    });
  });

// --- inspect ---------------------------------------------------------------
program
  .command('inspect')
  .description('Compact structured inspection (Inspect)')
  .argument('[type]', 'app | resources | events | routes | scripts | docker', 'app')
  .requiredOption('--app <app>')
  .action(async (type, opts) => {
    await runCapability('inspect', { app: opts.app, type });
  });

// --- explain ---------------------------------------------------------------
program
  .command('explain')
  .description('Explain a failure without dumping logs (ExplainFailure)')
  .option('--resource <id>', 'resource id (build_/test_/check_/dep_...)')
  .option('--log-path <path>', 'analyze a specific log file')
  .action(async (opts) => {
    await runCapability('explain-failure', { resource: opts.resource, log_path: opts.logPath });
  });

// --- plan ------------------------------------------------------------------
program
  .command('plan')
  .description('Generate a feature plan for a Goal (GenerateFeaturePlan)')
  .requiredOption('--app <app>')
  .requiredOption('--goal <goal>')
  .action(async (opts) => {
    await runCapability('generate-feature-plan', { app: opts.app, goal: opts.goal });
  });

// --- secrets ---------------------------------------------------------------
const secrets = program.command('secrets').description('Manage an app\'s encrypted secrets (SetSecret)');
secrets
  .command('set')
  .description('Store an encrypted secret for an app (SetSecret)')
  .requiredOption('--app <app>')
  .requiredOption('--name <name>', 'secret name, e.g. ANTHROPIC_API_KEY')
  .option('--value <value>', 'secret value (prefer --from-env to keep it out of shell history)')
  .option('--from-env [envName]', 'read the value from an env var (defaults to --name)')
  .action(async (opts) => {
    let value: string | undefined = opts.value;
    if (value === undefined && opts.fromEnv !== undefined) {
      const envName = typeof opts.fromEnv === 'string' ? opts.fromEnv : opts.name;
      value = process.env[envName];
      if (!value) fail(`Env var "${envName}" is empty or unset.`);
    }
    if (value === undefined) fail('Provide --value <v> or --from-env [ENV].');
    await runCapability('set-secret', { app: opts.app, name: opts.name, value });
  });
secrets
  .command('list')
  .description('List the secret NAMES set for an app (never the values)')
  .requiredOption('--app <app>')
  .action(async (opts) => {
    await runCapability('inspect', { app: opts.app, type: 'secrets' });
  });

// --- schedule / jobs -------------------------------------------------------
program
  .command('schedule')
  .description('Register or remove a scheduled job (ScheduleJob)')
  .requiredOption('--app <app>')
  .requiredOption('--name <name>', 'job name (kebab-case), unique per app')
  .option('--target <path>', 'app path to call when it fires, e.g. /api/cron/habits')
  .option('--method <method>', 'GET or POST', 'POST')
  .option('--every <dur>', 'recurring interval, e.g. 30m / 1h / 24h')
  .option('--cron <expr>', 'recurring 5-field cron in UTC, e.g. "0 0 * * *"')
  .option('--at <iso>', 'one-shot ISO timestamp')
  .option('--disabled', 'register but leave disabled')
  .option('--remove', 'remove the job')
  .action(async (opts) => {
    await runCapability('schedule-job', {
      app: opts.app,
      name: opts.name,
      ...(opts.target ? { target_path: opts.target } : {}),
      method: opts.method,
      ...(opts.every ? { every: opts.every } : {}),
      ...(opts.cron ? { cron: opts.cron } : {}),
      ...(opts.at ? { at: opts.at } : {}),
      disabled: Boolean(opts.disabled),
      remove: Boolean(opts.remove),
    });
  });

program
  .command('jobs')
  .description('List scheduled jobs for an app')
  .requiredOption('--app <app>')
  .action(async (opts) => {
    await runCapability('inspect', { app: opts.app, type: 'jobs' });
  });

// --- read-only surfaces ----------------------------------------------------
program
  .command('capabilities')
  .description('Discover available Capabilities')
  .action(async () => {
    const data = await api('GET', '/capabilities');
    process.stdout.write(JSON.stringify(globalOpts.summary ? data.capabilities.map((c: any) => `${c.name} — ${c.description}`) : data.capabilities, null, globalOpts.summary ? 2 : 0) + '\n');
  });

program
  .command('resources')
  .description('List Resources')
  .option('--app <app_id>', 'filter by app id')
  .option('--type <type>', 'filter by resource type')
  .action(async (opts) => {
    const params = new URLSearchParams();
    if (opts.app) params.set('app_id', opts.app);
    if (opts.type) params.set('type', opts.type);
    const data = await api('GET', `/resources?${params.toString()}`);
    process.stdout.write(JSON.stringify(data.resources.map((r: any) => ({ id: r.id, type: r.type, status: r.status, created_at: r.created_at }))) + '\n');
  });

program
  .command('events')
  .description('List Events (facts)')
  .option('--app <app_id>', 'filter by app id')
  .option('--resource <id>', 'filter by resource id')
  .option('--limit <n>', 'max events', '20')
  .action(async (opts) => {
    const params = new URLSearchParams();
    if (opts.app) params.set('app_id', opts.app);
    if (opts.resource) params.set('resource_id', opts.resource);
    params.set('limit', opts.limit);
    const data = await api('GET', `/events?${params.toString()}`);
    process.stdout.write(JSON.stringify(data.events.map((e: any) => ({ type: e.type, resource_id: e.resource_id, at: e.timestamp }))) + '\n');
  });

program
  .command('logs')
  .description('Show a resource log (full only with --full)')
  .argument('<resourceId>')
  .option('--full', 'print the full log')
  .option('--max-lines <n>', 'tail lines when not --full', '80')
  .action(async (resourceId, opts) => {
    const res = await fetch(`${API}/logs/${resourceId}`);
    if (!res.ok) fail(`No log for ${resourceId}.`);
    const text = await res.text();
    if (opts.full) {
      process.stdout.write(text);
      return;
    }
    const lines = text.split('\n');
    const max = Number(opts.maxLines);
    process.stdout.write(lines.slice(-max).join('\n') + '\n');
  });

program.parseAsync(process.argv).catch((err) => fail(String(err?.message ?? err)));
