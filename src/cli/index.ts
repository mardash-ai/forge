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

// Render a Verification (C14 `forge verify`) result. JSON/raw modes emit the machine
// report; otherwise a human-readable pass/fail list. The caller sets the exit code.
function renderVerify(v: any): void {
  if (globalOpts.json || globalOpts.raw) {
    process.stdout.write(JSON.stringify(v, null, globalOpts.raw ? 2 : 0) + '\n');
    return;
  }
  const mark = (s: string) => (s === 'pass' ? 'PASS' : s === 'fail' ? 'FAIL' : 'SKIP');
  const lines: string[] = [];
  lines.push(`Verify ${v.host}  —  ${v.passed ? 'PASSED' : 'FAILED'} (${v.total - v.skipped - v.failed}/${v.total - v.skipped} passed${v.skipped ? `, ${v.skipped} skipped` : ''}${v.failed ? `, ${v.failed} failed` : ''})`);
  for (const a of v.assertions ?? []) {
    lines.push(`  ${mark(a.status)}  ${a.title} — ${a.target} — ${a.actual}`);
    if (a.detail) lines.push(`        ↳ ${a.detail}`);
  }
  lines.push(v.summary);
  process.stdout.write(lines.join('\n') + '\n');
}

// Render a Release (C18 `forge release`) result. JSON/raw modes emit the machine report;
// otherwise a human-readable per-phase progress list. The caller sets the exit code.
function renderRelease(r: any): void {
  if (globalOpts.json || globalOpts.raw) {
    process.stdout.write(JSON.stringify(r, null, globalOpts.raw ? 2 : 0) + '\n');
    return;
  }
  const mark = (s: string) => (s === 'ran' ? ' ok ' : s === 'skipped' ? 'skip' : 'FAIL');
  const lines: string[] = [];
  const head = r.dry_run ? 'Release (dry-run)' : 'Release';
  lines.push(`${head} ${r.app}${r.commit ? ` @ ${String(r.commit).slice(0, 12)}` : ''} — ${r.status === 'succeeded' ? 'SUCCEEDED' : 'FAILED'}${r.failed_phase ? ` at ${r.failed_phase}` : ''}`);
  for (const p of r.phases ?? []) {
    lines.push(`  [${mark(p.status)}] ${p.phase} — ${p.detail}`);
  }
  if (r.web_image_pin) lines.push(`  pin: ${r.web_image_pin}`);
  if (r.error_summary) lines.push(`  error: ${r.error_summary}`);
  process.stdout.write(lines.join('\n') + '\n');
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
  .option('--compose-file <file>', 'production compose manifest (default: what `forge productionize` writes, app/compose.prod.yaml)', 'app/compose.prod.yaml')
  .option('--env-file <file>', 'env file Compose interpolates secrets from (default: what `forge productionize` documents, app/.env.prod)', 'app/.env.prod')
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
      env_file: opts.envFile,
      proxy_net: opts.proxyNet,
      pull: opts.pull,
      drain_seconds: Number.parseInt(opts.drainSeconds, 10),
      timeout_seconds: Number.parseInt(opts.timeoutSeconds, 10),
    });
  });

// --- productionize ---------------------------------------------------------
program
  .command('productionize')
  .description('Generate the app’s canonical production artifacts (Productionize)')
  .requiredOption('--app <app>')
  .option('--platform <platform>', 'target platform', 'web')
  .option('--framework <framework>', 'target framework', 'nextjs')
  .option('--host <domain>', 'public host for the Traefik router (remembered after first run)')
  .option('--readiness-path <path>', 'readiness path Traefik + the healthcheck probe (default /api/health)')
  .option('--web-image <ref>', 'digest-pinned production web image, e.g. ghcr.io/owner/app@sha256:… (R1)')
  .option('--data-plane-image <ref>', 'digest-pinned Forge data-plane image (default: FORGE_DATA_PLANE_IMAGE)')
  .option('--cert-resolver <name>', 'Traefik TLS cert resolver name (default letsencrypt)')
  .action(async (opts) => {
    await runCapability('productionize', {
      app: opts.app,
      platform: opts.platform,
      framework: opts.framework,
      ...(opts.host ? { host: opts.host } : {}),
      ...(opts.readinessPath ? { readiness_path: opts.readinessPath } : {}),
      ...(opts.webImage ? { web_image: opts.webImage } : {}),
      ...(opts.dataPlaneImage ? { data_plane_image: opts.dataPlaneImage } : {}),
      ...(opts.certResolver ? { cert_resolver: opts.certResolver } : {}),
    });
  });

// --- inspect ---------------------------------------------------------------
program
  .command('inspect')
  .description('Compact structured inspection (Inspect)')
  .argument('[type]', 'app | resources | events | app-events | notifications | routes | scripts | docker | secrets | jobs | agent-runs | email | auth | health', 'app')
  .requiredOption('--app <app>')
  .option('--owner <id>', 'scope owner-aware views (app-events | notifications | agent-runs) to one opaque user id (C11)')
  .action(async (type, opts) => {
    await runCapability('inspect', { app: opts.app, type, ...(opts.owner ? { owner: opts.owner } : {}) });
  });

// --- verify (C14) ----------------------------------------------------------
program
  .command('verify')
  .description('Post-deploy contract smoke: check a deployed app honors the platform contracts it adopted — C6 health + C10 auth gates + /auth/config. Read-only; exits non-zero on any failed assertion (Verify).')
  .requiredOption('--app <app>')
  .requiredOption('--host <host>', 'public host or base URL of the deployed app, e.g. app.example.com (https assumed)')
  .option('--page-path <path>', 'unauthenticated page to probe for the C10 page gate (302 → /auth/login)', '/')
  .option('--health-path <path>', 'C6 health/readiness path', '/api/health')
  .option('--api-path <path>', 'protected API path expected to 401 unauthenticated (C10 API gate); repeatable', collect, [])
  .option('--cron-path <path>', 'cron/service path expected to 403 with no service token (C10 service gate)')
  .option('--expect <list>', 'comma list of auth methods expected enabled in /auth/config: google,email,password-signup')
  .option('--expect-google', 'assert Google sign-in is enabled in /auth/config')
  .option('--expect-email', 'assert email delivery is configured in /auth/config')
  .option('--expect-password-signup', 'assert email/password sign-up is enabled in /auth/config')
  .option('--check-refresh', 'also assert POST /auth/refresh with no cookies → 401')
  .option('--timeout-ms <n>', 'per-request timeout in milliseconds')
  .action(async (opts) => {
    const expectList = String(opts.expect ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const body = {
      app: opts.app,
      host: opts.host,
      page_path: opts.pagePath,
      health_path: opts.healthPath,
      api_paths: opts.apiPath,
      ...(opts.cronPath ? { cron_path: opts.cronPath } : {}),
      expect_google: Boolean(opts.expectGoogle) || expectList.includes('google'),
      expect_email: Boolean(opts.expectEmail) || expectList.includes('email'),
      expect_password_signup:
        Boolean(opts.expectPasswordSignup) || expectList.includes('password-signup') || expectList.includes('password_signup'),
      check_refresh: Boolean(opts.checkRefresh),
      ...(opts.timeoutMs ? { timeout_ms: Number.parseInt(opts.timeoutMs, 10) } : {}),
    };
    const result = await api('POST', '/capabilities/verify', body);
    const v = result.resource ?? result;
    renderVerify(v);
    // Non-zero exit on any failed assertion — the CI post-deploy gate.
    process.exit(v.passed ? 0 : 1);
  });

// --- release (C18) ---------------------------------------------------------
program
  .command('release')
  .description('Run the full production deploy pipeline end-to-end, idempotently and fail-safe: publish/await the commit’s image → repin (C8) → deploy (C7 + P14 drift gate) → verify (C14). Resumable; leaves prod on the last-good version on any failure. Exits non-zero on failure (Release).')
  .requiredOption('--app <app>')
  .option('--host <host>', 'public host for the post-deploy verify gate (recovered from productionize config if omitted)')
  .option('--publish-mode <mode>', "how the commit's image reaches GHCR: ci (wait for the app's publish workflow) | build (build+push a multi-arch image here)", 'ci')
  .option('--dry-run', 'assess + print the plan without publishing, repinning, deploying, or verifying')
  .option('--timeout <seconds>', 'GHCR poll budget in CI mode (seconds)', '600')
  .option('--poll-interval <seconds>', 'GHCR poll interval in CI mode (seconds)', '10')
  .option('--commit <sha>', 'commit to release (default: the app repo HEAD)')
  .option('--image-ref <ref>', 'full tagged image ref to release (default: ghcr.io/<owner>/<app>-app:sha-<commit>)')
  .option('--owner <org>', 'GHCR owner for the default image ref (default: the repo origin remote)')
  .option('--registry <host>', 'registry host for the default image ref (default: ghcr.io)')
  .option('--image-suffix <suffix>', 'repo suffix for the default image ref (default: -app)')
  .option('--context <context>', 'docker context for a remote deploy target (default: local daemon)')
  .option('--service <service>', 'public service rolled start-first (default: web)')
  .option('--compose-file <file>', 'production compose manifest (default: app/compose.prod.yaml)')
  .option('--env-file <file>', 'env file Compose interpolates secrets from (default: app/.env.prod)')
  .option('--allow-dirty', 'release even with an uncommitted working tree (normally refused)')
  .option('--api-path <path>', 'verify: protected API path expected to 401 unauthenticated; repeatable', collect, [])
  .option('--cron-path <path>', 'verify: cron/service path expected to 403 with no service token')
  .option('--page-path <path>', 'verify: unauthenticated page expected to 302 → /auth/login')
  .option('--health-path <path>', 'verify: C6 health/readiness path')
  .option('--expect <list>', 'verify: comma list of auth methods expected enabled: google,email,password-signup')
  .option('--check-refresh', 'verify: also assert POST /auth/refresh with no cookies → 401')
  .action(async (opts) => {
    const expectList = String(opts.expect ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const body = {
      app: opts.app,
      ...(opts.host ? { host: opts.host } : {}),
      publish_mode: opts.publishMode,
      dry_run: Boolean(opts.dryRun),
      timeout_seconds: Number.parseInt(opts.timeout, 10),
      poll_interval_seconds: Number.parseInt(opts.pollInterval, 10),
      ...(opts.commit ? { commit: opts.commit } : {}),
      ...(opts.imageRef ? { image_ref: opts.imageRef } : {}),
      ...(opts.owner ? { owner: opts.owner } : {}),
      ...(opts.registry ? { registry: opts.registry } : {}),
      ...(opts.imageSuffix ? { image_suffix: opts.imageSuffix } : {}),
      ...(opts.context ? { context: opts.context } : {}),
      ...(opts.service ? { service: opts.service } : {}),
      ...(opts.composeFile ? { compose_file: opts.composeFile } : {}),
      ...(opts.envFile ? { env_file: opts.envFile } : {}),
      allow_dirty: Boolean(opts.allowDirty),
      ...(opts.apiPath && opts.apiPath.length ? { api_paths: opts.apiPath } : {}),
      ...(opts.cronPath ? { cron_path: opts.cronPath } : {}),
      ...(opts.pagePath ? { page_path: opts.pagePath } : {}),
      ...(opts.healthPath ? { health_path: opts.healthPath } : {}),
      ...(expectList.includes('google') ? { expect_google: true } : {}),
      ...(expectList.includes('email') ? { expect_email: true } : {}),
      ...(expectList.includes('password-signup') || expectList.includes('password_signup') ? { expect_password_signup: true } : {}),
      ...(opts.checkRefresh ? { check_refresh: true } : {}),
    };
    const result = await api('POST', '/capabilities/release', body);
    const r = result.resource ?? result;
    renderRelease(r);
    // Non-zero exit on a failed release — the deploy-safety gate.
    process.exit(r.status === 'succeeded' ? 0 : 1);
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
secrets
  .command('unset')
  .description('Remove/revoke a secret from an app (UnsetSecret; idempotent, never returns the value)')
  .requiredOption('--app <app>')
  .requiredOption('--name <name>', 'secret name to remove, e.g. ANTHROPIC_API_KEY')
  .action(async (opts) => {
    await runCapability('unset-secret', { app: opts.app, name: opts.name });
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

// --- email (C12) -----------------------------------------------------------
const email = program.command('email').description('Send + inspect transactional email (SendEmail)');
email
  .command('send')
  .description('Send a transactional email (inline body or a built-in verify/reset template)')
  .requiredOption('--app <app>')
  .requiredOption('--to <addr>', 'recipient email address')
  .option('--subject <s>', 'subject (required for an inline body)')
  .option('--text <t>', 'plain-text body')
  .option('--html <h>', 'HTML body')
  .option('--template <name>', 'built-in template: verify-email | reset-password')
  .option('--data <json>', 'template data as JSON, e.g. \'{"url":"https://…","product":"Acme"}\'')
  .action(async (opts) => {
    let data: unknown;
    if (opts.data) {
      try {
        data = JSON.parse(opts.data);
      } catch (e) {
        fail(`--data is not valid JSON: ${String(e)}`);
      }
    }
    await runCapability('send-email', {
      app: opts.app,
      to: opts.to,
      ...(opts.subject ? { subject: opts.subject } : {}),
      ...(opts.text ? { text: opts.text } : {}),
      ...(opts.html ? { html: opts.html } : {}),
      ...(opts.template ? { template: opts.template } : {}),
      ...(data !== undefined ? { data } : {}),
    });
  });
email
  .command('list')
  .description('List transactional-email sends for an app (redacted recipient + subject + status)')
  .requiredOption('--app <app>')
  .action(async (opts) => {
    await runCapability('inspect', { app: opts.app, type: 'email' });
  });

// --- auth (C10) ------------------------------------------------------------
const auth = program.command('auth').description('Inspect identity/auth + seed the owner user (Identity/Auth)');
auth
  .command('users')
  .description('List users for an app (redacted email + verified + provider; never hashes)')
  .requiredOption('--app <app>')
  .action(async (opts) => {
    await runCapability('inspect', { app: opts.app, type: 'auth' });
  });
auth
  .command('seed-owner')
  .description('Designate/seed the owner (first) user — the migration cutover hook (§8)')
  .requiredOption('--app <app>')
  .requiredOption('--email <email>', 'owner email address')
  .option('--password <password>', 'set an initial password (else owner uses reset/Google)')
  .action(async (opts) => {
    const data = await api('POST', '/auth/admin/seed-owner', {
      app: opts.app,
      email: opts.email,
      ...(opts.password ? { password: opts.password } : {}),
    });
    process.stdout.write(JSON.stringify(data) + '\n');
  });

// --- owner (C11) -----------------------------------------------------------
const owner = program.command('owner').description('Per-user ownership of the shared stores (Permissions / access control)');
owner
  .command('claim-legacy')
  .description('Assign every owner-less shared-store record (app-events + notifications + agent-runs) to an owner — the C11 cutover migration (pairs with `auth seed-owner`)')
  .requiredOption('--app <app>')
  .requiredOption('--owner <id>', 'opaque owner user id to claim legacy records for (e.g. the seeded owner)')
  .action(async (opts) => {
    const data = await api('POST', '/owner/claim-legacy', { app: opts.app, owner: opts.owner });
    process.stdout.write(JSON.stringify(data) + '\n');
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
  .option('--owner <id>', 'scope per-user resources (e.g. agent-runs) to one opaque owner id (C11)')
  .action(async (opts) => {
    const params = new URLSearchParams();
    if (opts.app) params.set('app_id', opts.app);
    if (opts.type) params.set('type', opts.type);
    if (opts.owner) params.set('owner', opts.owner);
    const data = await api('GET', `/resources?${params.toString()}`);
    process.stdout.write(JSON.stringify(data.resources.map((r: any) => ({ id: r.id, type: r.type, status: r.status, owner: r.owner, created_at: r.created_at }))) + '\n');
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
