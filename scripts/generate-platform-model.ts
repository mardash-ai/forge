#!/usr/bin/env node
// Build-time generator — reads the live capability registry, resource types, event catalog,
// error taxonomy, and server route tables; emits a version-stamped platform-model.json that
// is COMMITTED into the forge repo. Consumers fetch it by git tag.
//
// Run manually:  npm run generate:platform-model
// On version bump: the `version` npm lifecycle script in package.json runs this automatically
//   (`npm version <level>` → scripts.version → generate:platform-model → git add platform-model.json)
//   so the model is always regenerated and staged in the same commit as the version bump.
// CI:    ci.yml re-runs this and diffs; a divergence fails the build (drift guard).

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZodTypeAny } from 'zod';
import { capabilities } from '../src/capabilities/index.js';
import { RESOURCE_TYPES } from '../src/resources/types.js';
import { EVENT_TYPES } from '../src/events/catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Version stamp ─────────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };

// ── Error taxonomy ────────────────────────────────────────────────────────────
// Sourced from src/shared/errors.ts — every ForgeError variant the platform emits.
const ERROR_TAXONOMY = [
  {
    code: 'not_found',
    status: 404,
    retry: 'change-input',
    description: 'The requested resource or capability does not exist.',
  },
  {
    code: 'invalid_input',
    status: 422,
    retry: 'change-input',
    description: 'The request input failed schema validation.',
  },
  {
    code: 'policy_blocked',
    status: 403,
    retry: 'needs-human',
    description: 'A governance Policy blocked the operation.',
  },
  {
    code: 'permission_denied',
    status: 403,
    retry: 'needs-human',
    description: 'The Actor is not authorized to use this Capability or Resource.',
  },
  {
    code: 'dependency_unavailable',
    status: 503,
    retry: 'needs-human',
    description: 'A required dependency (Docker, secret, provider) is unavailable.',
  },
  { code: 'internal_error', status: 500, retry: 'no', description: 'An unexpected platform error occurred.' },
] as const;

// ── Zod → JSON Schema (minimal, no external dep) ─────────────────────────────
// Converts Forge's Zod input schemas to a JSON-serializable representation using
// Zod's internal _def API. Only handles the types that appear in capability schemas.
function zodToJsonSchema(schema: ZodTypeAny, depth = 0): Record<string, unknown> {
  if (depth > 10) return {}; // guard against runaway recursion
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._def as Record<string, any>;
  const typeName: string = def?.typeName ?? 'ZodUnknown';

  switch (typeName) {
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, val] of Object.entries(shape)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const innerTypeName: string = (val as any)._def?.typeName ?? '';
        const isOptional = innerTypeName === 'ZodOptional' || innerTypeName === 'ZodDefault';
        properties[key] = zodToJsonSchema(val, depth + 1);
        if (!isOptional) required.push(key);
      }
      return { type: 'object', properties, ...(required.length ? { required } : {}) };
    }
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodAny':
      return {};
    case 'ZodUnknown':
      return {};
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodUndefined':
      return { type: 'undefined' };
    case 'ZodLiteral':
      return { const: def.value as unknown };
    case 'ZodEnum':
      return { type: 'string', enum: def.values as string[] };
    case 'ZodNativeEnum':
      return { type: 'string', enum: Object.values(def.values as Record<string, unknown>) };
    case 'ZodArray':
      return { type: 'array', items: zodToJsonSchema(def.type as ZodTypeAny, depth + 1) };
    case 'ZodOptional': {
      const inner = zodToJsonSchema(def.innerType as ZodTypeAny, depth + 1);
      return { ...inner, optional: true };
    }
    case 'ZodDefault': {
      const inner = zodToJsonSchema(def.innerType as ZodTypeAny, depth + 1);
      let defaultVal: unknown;
      try {
        defaultVal = (def.defaultValue as () => unknown)();
      } catch {
        defaultVal = undefined;
      }
      return { ...inner, default: defaultVal };
    }
    case 'ZodNullable': {
      const inner = zodToJsonSchema(def.innerType as ZodTypeAny, depth + 1);
      return { ...inner, nullable: true };
    }
    case 'ZodUnion': {
      const options = (def.options as ZodTypeAny[]).map((o) => zodToJsonSchema(o, depth + 1));
      return { oneOf: options };
    }
    case 'ZodIntersection': {
      return {
        allOf: [
          zodToJsonSchema(def.left as ZodTypeAny, depth + 1),
          zodToJsonSchema(def.right as ZodTypeAny, depth + 1),
        ],
      };
    }
    case 'ZodRecord': {
      return {
        type: 'object',
        additionalProperties: zodToJsonSchema(def.valueType as ZodTypeAny, depth + 1),
      };
    }
    case 'ZodEffects': {
      // .refine() / .transform() / .preprocess() — unwrap to the inner schema
      return zodToJsonSchema(def.schema as ZodTypeAny, depth + 1);
    }
    case 'ZodPipeline': {
      return zodToJsonSchema(def.in as ZodTypeAny, depth + 1);
    }
    case 'ZodBranded': {
      return zodToJsonSchema(def.type as ZodTypeAny, depth + 1);
    }
    default: {
      // Unknown Zod type — emit the type name so the model is self-documenting.
      return { $zod: typeName };
    }
  }
}

// ── CLI surface ───────────────────────────────────────────────────────────────
// Static table of every `forge` verb, its arguments, and the route it calls.
// Keep in sync with src/cli/index.ts; the CI drift guard catches stale platform-model.json.
// Note: "local" routes run in-process inside the container (no HTTP call).
interface CliArg {
  flag: string;
  required: boolean;
  description: string;
}
interface CliVerb {
  verb: string;
  description: string;
  route: string;
  args: CliArg[];
}

const CLI_SURFACE: CliVerb[] = [
  {
    verb: 'forge init app',
    description: 'Initialize a Dockerized application (InitializeApp)',
    route: 'POST /capabilities/initialize-app',
    args: [
      { flag: '--name <name>', required: true, description: 'application name (kebab-case)' },
      { flag: '--platform <platform>', required: false, description: 'target platform' },
      { flag: '--framework <framework>', required: false, description: 'target framework' },
      { flag: '--template <template>', required: false, description: 'scaffold template' },
      { flag: '--package-manager <pm>', required: false, description: 'package manager' },
    ],
  },
  {
    verb: 'forge init-app',
    description: 'Alias for `forge init app` (back-compat)',
    route: 'POST /capabilities/initialize-app',
    args: [
      { flag: '--name <name>', required: true, description: 'application name (kebab-case)' },
      { flag: '--platform <platform>', required: false, description: 'target platform' },
      { flag: '--framework <framework>', required: false, description: 'target framework' },
      { flag: '--template <template>', required: false, description: 'scaffold template' },
    ],
  },
  {
    verb: 'forge provision',
    description: 'Provision a Docker environment (ProvisionEnvironment)',
    route: 'POST /capabilities/provision-environment',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--platform <platform>', required: false, description: 'target platform' },
      { flag: '--framework <framework>', required: false, description: 'target framework' },
      { flag: '--with-postgres', required: false, description: 'add a Postgres service' },
      { flag: '--with-redis', required: false, description: 'add a Redis service' },
      { flag: '--without-postgres', required: false, description: 'remove the Postgres service' },
      { flag: '--without-redis', required: false, description: 'remove the Redis service' },
      {
        flag: '--postgres-port <hostPort>',
        required: false,
        description: 'host port mapped to Postgres 5432',
      },
      { flag: '--redis-port <hostPort>', required: false, description: 'host port mapped to Redis 6379' },
      {
        flag: '--web-port <hostPort>',
        required: false,
        description: 'host port mapped to the web container',
      },
      { flag: '--force', required: false, description: 'allow dropping a service that owns a data volume' },
      { flag: '--secret <name>', required: false, description: 'declare a secret (repeatable)' },
    ],
  },
  {
    verb: 'forge install',
    description: 'Install dependencies in Docker (InstallDependencies)',
    route: 'POST /capabilities/install-dependencies',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--platform <platform>', required: false, description: 'target platform' },
      { flag: '--framework <framework>', required: false, description: 'target framework' },
    ],
  },
  {
    verb: 'forge dev',
    description: 'Start/stop/inspect the dev server (RunDevServer)',
    route: 'POST /capabilities/run-dev-server',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--platform <platform>', required: false, description: 'target platform' },
      { flag: '--framework <framework>', required: false, description: 'target framework' },
      { flag: '--stop', required: false, description: 'stop the dev server' },
      { flag: '--status', required: false, description: 'report status only' },
    ],
  },
  {
    verb: 'forge build',
    description: 'Run a reproducible build (Build)',
    route: 'POST /capabilities/build',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--platform <platform>', required: false, description: 'target platform' },
      { flag: '--framework <framework>', required: false, description: 'target framework' },
    ],
  },
  {
    verb: 'forge test',
    description: 'Run tests (Test)',
    route: 'POST /capabilities/test',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--platform <platform>', required: false, description: 'target platform' },
      { flag: '--framework <framework>', required: false, description: 'target framework' },
    ],
  },
  {
    verb: 'forge lint',
    description: 'Run lint (Lint)',
    route: 'POST /capabilities/lint',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--platform <platform>', required: false, description: 'target platform' },
      { flag: '--framework <framework>', required: false, description: 'target framework' },
    ],
  },
  {
    verb: 'forge deploy',
    description: 'Zero-downtime deploy of the production stack (Deploy)',
    route: 'POST /capabilities/deploy',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--service <service>', required: false, description: 'public service rolled start-first' },
      { flag: '--context <context>', required: false, description: 'docker context for a remote target' },
      { flag: '--compose-file <file>', required: false, description: 'production compose manifest' },
      { flag: '--env-file <file>', required: false, description: 'env file for secret interpolation' },
      { flag: '--proxy-net <name>', required: false, description: 'reverse-proxy network' },
      { flag: '--no-pull', required: false, description: 'skip pulling images first' },
      { flag: '--drain-seconds <n>', required: false, description: 'seconds to settle in-flight requests' },
      {
        flag: '--timeout-seconds <n>',
        required: false,
        description: 'seconds to wait for new replica health',
      },
    ],
  },
  {
    verb: 'forge productionize',
    description: "Generate the app's canonical production artifacts (Productionize)",
    route: 'POST /capabilities/productionize',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--platform <platform>', required: false, description: 'target platform' },
      { flag: '--framework <framework>', required: false, description: 'target framework' },
      { flag: '--host <domain>', required: false, description: 'public host for the Traefik router' },
      { flag: '--readiness-path <path>', required: false, description: 'readiness path for healthcheck' },
      { flag: '--web-image <ref>', required: false, description: 'digest-pinned production web image (R1)' },
      {
        flag: '--data-plane-image <ref>',
        required: false,
        description: 'digest-pinned Forge data-plane image',
      },
      { flag: '--cert-resolver <name>', required: false, description: 'Traefik TLS cert resolver name' },
      { flag: '--blobs-backend <kind>', required: false, description: 'blob backend: filesystem or s3' },
      { flag: '--mcp-mtls-host <host>', required: false, description: 'dedicated mTLS MCP host' },
      {
        flag: '--mcp-mtls-tls-options <ref>',
        required: false,
        description: 'Traefik tls.options ref for mTLS router',
      },
    ],
  },
  {
    verb: 'forge inspect',
    description: 'Compact structured inspection (Inspect)',
    route: 'POST /capabilities/inspect',
    args: [
      {
        flag: '[type]',
        required: false,
        description:
          'app | resources | events | notifications | routes | scripts | docker | secrets | jobs | agent-runs | email | auth | health',
      },
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--owner <id>', required: false, description: 'scope owner-aware views to one user id' },
    ],
  },
  {
    verb: 'forge verify',
    description: 'Post-deploy contract smoke test (Verify)',
    route: 'POST /capabilities/verify',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--host <host>', required: true, description: 'public host or base URL of the deployed app' },
      {
        flag: '--page-path <path>',
        required: false,
        description: 'unauthenticated page for the C10 page gate',
      },
      { flag: '--health-path <path>', required: false, description: 'C6 health/readiness path' },
      { flag: '--api-path <path>', required: false, description: 'protected API path (repeatable)' },
      {
        flag: '--cron-path <path>',
        required: false,
        description: 'cron path expected to 403 without service token',
      },
      {
        flag: '--expect <list>',
        required: false,
        description: 'comma list of auth methods: google,email,password-signup',
      },
      { flag: '--expect-google', required: false, description: 'assert Google sign-in is enabled' },
      { flag: '--expect-email', required: false, description: 'assert email delivery is configured' },
      {
        flag: '--expect-password-signup',
        required: false,
        description: 'assert email/password sign-up is enabled',
      },
      {
        flag: '--check-refresh',
        required: false,
        description: 'assert POST /auth/refresh with no cookies yields 401',
      },
      { flag: '--timeout-ms <n>', required: false, description: 'per-request timeout in milliseconds' },
      {
        flag: '--readiness-timeout-ms <n>',
        required: false,
        description: 'post-deploy warm-up poll budget (ms)',
      },
      {
        flag: '--readiness-interval-ms <n>',
        required: false,
        description: 'base interval between readiness polls (ms)',
      },
    ],
  },
  {
    verb: 'forge release',
    description: 'Full production deploy pipeline end-to-end (Release)',
    route: 'POST /capabilities/release',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--host <host>', required: false, description: 'public host for the post-deploy verify gate' },
      {
        flag: '--publish-mode <mode>',
        required: false,
        description: 'ci | build — how the image reaches GHCR',
      },
      {
        flag: '--dry-run',
        required: false,
        description: 'plan without publishing, repinning, deploying, or verifying',
      },
      { flag: '--timeout <seconds>', required: false, description: 'GHCR poll budget in CI mode' },
      { flag: '--poll-interval <seconds>', required: false, description: 'GHCR poll interval in CI mode' },
      { flag: '--commit <sha>', required: false, description: 'commit to release' },
      { flag: '--image-ref <ref>', required: false, description: 'full tagged image ref to release' },
      { flag: '--owner <org>', required: false, description: 'GHCR owner for the default image ref' },
      { flag: '--registry <host>', required: false, description: 'registry host for the default image ref' },
      {
        flag: '--image-suffix <suffix>',
        required: false,
        description: 'repo suffix for the default image ref',
      },
      {
        flag: '--context <context>',
        required: false,
        description: 'docker context for a remote deploy target',
      },
      { flag: '--service <service>', required: false, description: 'public service rolled start-first' },
      { flag: '--compose-file <file>', required: false, description: 'production compose manifest' },
      { flag: '--env-file <file>', required: false, description: 'env file for secret interpolation' },
      {
        flag: '--allow-dirty',
        required: false,
        description: 'release even with an uncommitted working tree',
      },
      { flag: '--api-path <path>', required: false, description: 'verify: protected API path (repeatable)' },
      { flag: '--cron-path <path>', required: false, description: 'verify: cron path expected to 403' },
      {
        flag: '--page-path <path>',
        required: false,
        description: 'verify: unauthenticated page expected to 302',
      },
      { flag: '--health-path <path>', required: false, description: 'verify: C6 health/readiness path' },
      { flag: '--expect <list>', required: false, description: 'verify: comma list of auth methods' },
      {
        flag: '--check-refresh',
        required: false,
        description: 'verify: assert POST /auth/refresh with no cookies yields 401',
      },
      {
        flag: '--verify-readiness-timeout-ms <n>',
        required: false,
        description: 'verify: deploy-to-verify warm-up wait (ms)',
      },
    ],
  },
  {
    verb: 'forge explain',
    description: 'Explain a failure without dumping logs (ExplainFailure)',
    route: 'POST /capabilities/explain-failure',
    args: [
      { flag: '--resource <id>', required: false, description: 'resource id (build_/test_/check_/dep_…)' },
      { flag: '--log-path <path>', required: false, description: 'analyze a specific log file' },
    ],
  },
  {
    verb: 'forge plan',
    description: 'Generate a feature plan for a Goal (GenerateFeaturePlan)',
    route: 'POST /capabilities/generate-feature-plan',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--goal <goal>', required: true, description: 'desired outcome / feature goal' },
    ],
  },
  {
    verb: 'forge secrets set',
    description: 'Store an encrypted secret for an app (SetSecret)',
    route: 'POST /capabilities/set-secret',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--name <name>', required: true, description: 'secret name, e.g. ANTHROPIC_API_KEY' },
      { flag: '--value <value>', required: false, description: 'secret value' },
      {
        flag: '--from-env [envName]',
        required: false,
        description: 'read value from env var (defaults to --name)',
      },
    ],
  },
  {
    verb: 'forge secrets list',
    description: 'List secret names set for an app (Inspect)',
    route: 'POST /capabilities/inspect',
    args: [{ flag: '--app <app>', required: true, description: 'application name' }],
  },
  {
    verb: 'forge secrets unset',
    description: 'Remove/revoke a secret from an app (UnsetSecret)',
    route: 'POST /capabilities/unset-secret',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--name <name>', required: true, description: 'secret name to remove' },
    ],
  },
  {
    verb: 'forge schedule',
    description: 'Register or remove a scheduled job (ScheduleJob)',
    route: 'POST /capabilities/schedule-job',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--name <name>', required: true, description: 'job name (kebab-case), unique per app' },
      { flag: '--target <path>', required: false, description: 'app path to call when it fires' },
      { flag: '--method <method>', required: false, description: 'GET or POST' },
      { flag: '--every <dur>', required: false, description: 'recurring interval, e.g. 30m / 1h / 24h' },
      { flag: '--cron <expr>', required: false, description: 'recurring 5-field cron in UTC' },
      { flag: '--at <iso>', required: false, description: 'one-shot ISO timestamp' },
      { flag: '--disabled', required: false, description: 'register but leave disabled' },
      { flag: '--remove', required: false, description: 'remove the job' },
    ],
  },
  {
    verb: 'forge jobs',
    description: 'List scheduled jobs for an app (Inspect)',
    route: 'POST /capabilities/inspect',
    args: [{ flag: '--app <app>', required: true, description: 'application name' }],
  },
  {
    verb: 'forge email send',
    description: 'Send a transactional email (SendEmail)',
    route: 'POST /capabilities/send-email',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--to <addr>', required: true, description: 'recipient email address' },
      { flag: '--subject <s>', required: false, description: 'subject (required for inline body)' },
      { flag: '--text <t>', required: false, description: 'plain-text body' },
      { flag: '--html <h>', required: false, description: 'HTML body' },
      {
        flag: '--template <name>',
        required: false,
        description: 'built-in template: verify-email | reset-password',
      },
      { flag: '--data <json>', required: false, description: 'template data as JSON' },
    ],
  },
  {
    verb: 'forge email list',
    description: 'List transactional-email sends for an app (Inspect)',
    route: 'POST /capabilities/inspect',
    args: [{ flag: '--app <app>', required: true, description: 'application name' }],
  },
  {
    verb: 'forge auth users',
    description: 'List users for an app (Inspect)',
    route: 'POST /capabilities/inspect',
    args: [{ flag: '--app <app>', required: true, description: 'application name' }],
  },
  {
    verb: 'forge auth seed-owner',
    description: 'Designate/seed the owner user — the migration cutover hook',
    route: 'POST /auth/admin/seed-owner',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--email <email>', required: true, description: 'owner email address' },
      {
        flag: '--password <password>',
        required: false,
        description: 'initial password (else use reset/Google)',
      },
    ],
  },
  {
    verb: 'forge owner claim-legacy',
    description: 'Assign every owner-less shared-store record to an owner (C11 cutover migration)',
    route: 'POST /owner/claim-legacy',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      {
        flag: '--owner <id>',
        required: true,
        description: 'opaque owner user id to claim legacy records for',
      },
    ],
  },
  {
    verb: 'forge status incident create',
    description: 'Declare a new incident on the public status page (C15)',
    route: 'POST /status/incidents',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--title <title>', required: true, description: 'short incident title' },
      {
        flag: '--status <status>',
        required: true,
        description: 'investigating | identified | monitoring | resolved',
      },
      { flag: '--impact <impact>', required: true, description: 'none | minor | major | critical' },
      { flag: '--component <key>', required: false, description: 'affected component key (repeatable)' },
      { flag: '--body <text>', required: false, description: 'initial update note' },
    ],
  },
  {
    verb: 'forge status incident update',
    description: 'Append an update to an incident, moving its status (C15)',
    route: 'POST /status/incidents/update',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--incident <id>', required: true, description: 'incident id (from create/list)' },
      {
        flag: '--status <status>',
        required: true,
        description: 'investigating | identified | monitoring | resolved',
      },
      { flag: '--body <text>', required: false, description: 'update note' },
    ],
  },
  {
    verb: 'forge status incident resolve',
    description: 'Resolve an incident — sets status:resolved and appends a final update (C15)',
    route: 'POST /status/incidents/resolve',
    args: [
      { flag: '--app <app>', required: true, description: 'application name' },
      { flag: '--incident <id>', required: true, description: 'incident id (from create/list)' },
      { flag: '--body <text>', required: false, description: 'final update note' },
    ],
  },
  {
    verb: 'forge status incident list',
    description: 'List incidents for an app (C15)',
    route: 'GET /status/incidents',
    args: [{ flag: '--app <app>', required: true, description: 'application name' }],
  },
  {
    verb: 'forge capabilities',
    description: 'Discover available Capabilities',
    route: 'GET /capabilities',
    args: [],
  },
  {
    verb: 'forge resources',
    description: 'List Resources',
    route: 'GET /resources',
    args: [
      { flag: '--app <app_id>', required: false, description: 'filter by app id' },
      { flag: '--type <type>', required: false, description: 'filter by resource type' },
      { flag: '--owner <id>', required: false, description: 'scope per-user resources to one owner id' },
    ],
  },
  {
    verb: 'forge events',
    description: 'List Events (facts)',
    route: 'GET /events',
    args: [
      { flag: '--app <app_id>', required: false, description: 'filter by app id' },
      { flag: '--resource <id>', required: false, description: 'filter by resource id' },
      { flag: '--limit <n>', required: false, description: 'max events' },
    ],
  },
  {
    verb: 'forge logs',
    description: 'Show a resource log',
    route: 'GET /logs/:id',
    args: [
      { flag: '<resourceId>', required: true, description: 'resource id' },
      { flag: '--full', required: false, description: 'print the full log' },
      { flag: '--max-lines <n>', required: false, description: 'tail lines when not --full' },
    ],
  },
  {
    verb: 'forge storage migrate',
    description: 'Backfill a platform store from filesystem into Postgres (P26)',
    route: 'local',
    args: [
      {
        flag: '--store <name>',
        required: false,
        description:
          'store to migrate: identity | search | events | notifications | secrets | resources | policy | mcp | blobs',
      },
      { flag: '--app <name>', required: false, description: 'migrate only this app (default: every app)' },
    ],
  },
  {
    verb: 'forge policy list',
    description: "List an app's policies (C29)",
    route: 'GET /policies',
    args: [
      { flag: '--app <name>', required: false, description: 'app name' },
      {
        flag: '--owner <owner>',
        required: false,
        description: "owner id (returns that owner's plus app-wide policies)",
      },
    ],
  },
  {
    verb: 'forge policy set',
    description: 'Create or update a policy (C29)',
    route: 'POST /policies',
    args: [
      { flag: '--effect <effect>', required: true, description: 'allow | needs-approval | deny' },
      { flag: '--app <name>', required: false, description: 'app name' },
      { flag: '--id <id>', required: false, description: 'policy id (omit to create)' },
      { flag: '--owner <owner>', required: false, description: 'owner id (omit for app-wide policy)' },
      { flag: '--priority <n>', required: false, description: 'priority (higher wins)' },
      { flag: '--match <json>', required: false, description: 'match conditions as JSON' },
      { flag: '--reason <text>', required: false, description: 'human-readable reason' },
    ],
  },
  {
    verb: 'forge policy delete',
    description: 'Delete a policy by id (C29)',
    route: 'DELETE /policies/:id',
    args: [
      { flag: '<id>', required: true, description: 'policy id' },
      { flag: '--app <name>', required: false, description: 'app name' },
      {
        flag: '--owner <owner>',
        required: false,
        description: 'remove only if the rule belongs to this owner',
      },
    ],
  },
  {
    verb: 'forge mcp list-tools',
    description: "List an app's registered MCP tools (C23)",
    route: 'GET /mcp/tools',
    args: [{ flag: '--app <name>', required: false, description: 'app name' }],
  },
  {
    verb: 'forge mcp register-tool',
    description: 'Register or update an MCP tool (C23)',
    route: 'POST /mcp/tools',
    args: [
      { flag: '--name <name>', required: true, description: 'tool name (a-zA-Z0-9_-)' },
      { flag: '--handler-path <path>', required: true, description: 'app path the call dispatches to' },
      { flag: '--app <name>', required: false, description: 'app name' },
      { flag: '--description <text>', required: false, description: 'tool description' },
      { flag: '--scope <scope>', required: false, description: 'OAuth scope required to call it' },
      { flag: '--family <family>', required: false, description: 'read | write | action' },
      { flag: '--high-risk', required: false, description: 'flag as a high-risk class (C29 seam hint)' },
      { flag: '--input-schema <json>', required: false, description: 'input JSON Schema' },
      { flag: '--output-schema <json>', required: false, description: 'output JSON Schema' },
    ],
  },
  {
    verb: 'forge mcp delete-tool',
    description: 'Unregister an MCP tool by name (C23)',
    route: 'DELETE /mcp/tools/:name',
    args: [
      { flag: '<name>', required: true, description: 'tool name' },
      { flag: '--app <name>', required: false, description: 'app name' },
    ],
  },
  {
    verb: 'forge mcp set-instructions',
    description: 'Append a new versioned instruction/training block (C23)',
    route: 'POST /mcp/instructions',
    args: [
      { flag: '--text <text>', required: true, description: 'connector description / tool preamble' },
      { flag: '--app <name>', required: false, description: 'app name' },
      { flag: '--label <label>', required: false, description: 'optional A/B label' },
    ],
  },
  {
    verb: 'forge mcp get-instructions',
    description: 'Show the latest (or a specific) instruction block (C23)',
    route: 'GET /mcp/instructions',
    args: [
      { flag: '--app <name>', required: false, description: 'app name' },
      { flag: '--version <n>', required: false, description: 'a specific version (default: latest)' },
    ],
  },
  {
    verb: 'forge mcp proactive',
    description: 'Schedule (or remove) a proactive prompt for an MCP tool (C23)',
    route: 'POST /mcp/proactive',
    args: [
      { flag: '--tool <name>', required: true, description: 'the tool to nudge toward' },
      { flag: '--app <name>', required: false, description: 'app name' },
      { flag: '--target-path <path>', required: false, description: 'app cron path the fire calls back' },
      { flag: '--every <dur>', required: false, description: 'recurring interval, e.g. 6h' },
      { flag: '--cron <expr>', required: false, description: 'recurring 5-field cron (UTC)' },
      { flag: '--remove', required: false, description: 'remove the proactive job' },
    ],
  },
  {
    verb: 'forge eval',
    description: "Run an eval suite against an app's MCP surface (Eval, C30)",
    route: 'POST /capabilities/eval',
    args: [
      { flag: '<suite-file>', required: true, description: 'path to the suite JSON file' },
      { flag: '--app <app>', required: true, description: 'the forge app whose MCP surface to drive' },
      { flag: '--mcp-url <url>', required: true, description: 'the app MCP endpoint' },
      { flag: '--run-name <name>', required: false, description: 'name for this run' },
      {
        flag: '--model <spec>',
        required: false,
        description: 'agent-under-test as provider:model (repeatable)',
      },
    ],
  },
  {
    verb: 'forge provision-monitoring',
    description: 'Generate and deploy the metrics+logging stack (ProvisionMonitoring)',
    route: 'POST /capabilities/provision-monitoring',
    args: [
      { flag: '--dir <dir>', required: false, description: 'target directory for the stack files' },
      { flag: '--project-name <name>', required: false, description: 'compose project name' },
      {
        flag: '--public-host <host>',
        required: false,
        description: 'front grafana via Traefik at this host',
      },
      { flag: '--ui-port <port>', required: false, description: 'host port grafana is published on' },
      { flag: '--network <name>', required: false, description: 'shared external network' },
      { flag: '--proxy-network <name>', required: false, description: 'external Traefik network' },
      { flag: '--alert-email <email>', required: false, description: 'alert contact-point email' },
      {
        flag: '--log-scope-regex <re>',
        required: false,
        description: 'promtail keep-regex over container names',
      },
      {
        flag: '--langfuse-otlp-b64 <b64>',
        required: false,
        description: 'base64(pk:sk) Langfuse pair for collector trace auth',
      },
      {
        flag: '--smtp-host <hostport>',
        required: false,
        description: 'SMTP host:port for Grafana alert email',
      },
      { flag: '--smtp-user <user>', required: false, description: 'SMTP user' },
      { flag: '--smtp-password <pass>', required: false, description: 'SMTP password' },
      { flag: '--smtp-from <addr>', required: false, description: 'SMTP from address' },
      {
        flag: '--langfuse-public-url <url>',
        required: false,
        description: 'PUBLIC Langfuse UI base for deep links',
      },
      {
        flag: '--langfuse-project-id <id>',
        required: false,
        description: 'Langfuse project id for deep links',
      },
      {
        flag: '--app-db-network <name>',
        required: false,
        description: 'app stack network for the postgres container',
      },
      { flag: '--app-db-host <host>', required: false, description: 'postgres container name/host' },
      { flag: '--app-db-port <port>', required: false, description: 'postgres port' },
      {
        flag: '--app-db-database <db>',
        required: false,
        description: 'database holding forge_identity_users',
      },
      { flag: '--app-db-user <user>', required: false, description: 'SELECT-only role' },
      { flag: '--app-db-app-id <id>', required: false, description: 'app_id scoping the user picker query' },
      { flag: '--app-db-password <pass>', required: false, description: 'password of the SELECT-only role' },
      { flag: '--env-file <name>', required: false, description: 'env filename inside the stack dir' },
      { flag: '--context <ctx>', required: false, description: 'docker --context for a remote daemon' },
      { flag: '--skip-deploy', required: false, description: 'generate files only; do not pull/up' },
      {
        flag: '--regenerate-secrets',
        required: false,
        description: 'force new secrets even if env file exists',
      },
    ],
  },
];

// ── Route table extraction ────────────────────────────────────────────────────
// Regex-extracts inline Fastify route registrations from a server source file.
// Returns method + path pairs for routes registered directly on `app`.
function extractInlineRoutes(src: string): Array<{ method: string; path: string }> {
  const routes: Array<{ method: string; path: string }> = [];
  // Match: app.get('/foo', ...) / app.post('/foo/:bar', ...) — single or double quoted
  const re = /\bapp\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const method = m[1];
    const path = m[2];
    if (method && path) routes.push({ method: method.toUpperCase(), path });
  }
  return routes;
}

// Extract the route-module names imported from the api/ directory.
function extractApiModuleNames(src: string): string[] {
  const names: string[] = [];
  // Match: from '../api/foo-routes' or from './foo-routes'
  const re = /from '(?:\.\.\/api\/|\.\/)([\w-]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const modName = m[1];
    if (modName && modName.endsWith('-routes')) names.push(modName);
  }
  return [...new Set(names)]; // dedupe
}

function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

const cpSrc = readSrc('src/api/server.ts');
const dpSrc = readSrc('src/data-plane/server.ts');

// ── Assemble the platform model ───────────────────────────────────────────────
const model = {
  $schema: 'https://forge.build/platform-model/v1',
  // Version stamp — consumers resolve a specific commit via `git tag vX.Y.Z`.
  version: pkg.version,

  // Every capability the platform exposes — the authoritative discovery surface.
  capabilities: capabilities.map((c) => ({
    name: c.name,
    slug: c.slug,
    description: c.description,
    // 'control' = dev/orchestration only; 'data' = runtime app; 'both' = both planes.
    // Absent in the Capability definition → defaults to 'control'.
    plane: c.plane ?? 'control',
    resource_type: c.resourceType,
    events: c.events,
    long_running: c.longRunning,
    requires_docker: c.requiresDocker,
    input_schema: zodToJsonSchema(c.inputSchema),
    endpoint: `POST /capabilities/${c.slug}`,
  })),

  // The closed Resource type set — every durable state shape the platform manages.
  resource_types: [...RESOURCE_TYPES],

  // The closed Event catalog — every immutable fact the platform emits.
  event_catalog: [...EVENT_TYPES],

  // Error taxonomy — every ForgeError variant, with retry semantics for agents.
  error_taxonomy: ERROR_TAXONOMY,

  // Per-server route tables — sourced from the server files.
  route_tables: {
    control_plane: {
      base_port: 3717,
      inline_routes: extractInlineRoutes(cpSrc),
      api_modules: extractApiModuleNames(cpSrc),
    },
    data_plane: {
      base_port: 3718,
      inline_routes: extractInlineRoutes(dpSrc),
      api_modules: extractApiModuleNames(dpSrc),
    },
  },

  // CLI surface — every `forge` verb, its arguments, and the route it calls.
  // Derived from src/cli/index.ts; keep this table in sync with the CLI source.
  cli_surface: CLI_SURFACE,
};

const outPath = join(ROOT, 'platform-model.json');
writeFileSync(outPath, JSON.stringify(model, null, 2) + '\n');

// ── Generate docs/architecture/PLATFORM_MODEL.md ──────────────────────────────
// A human-readable rendering of platform-model.json for readers who prefer Markdown.
// Regenerated deterministically by this same script — do NOT hand-edit.

function mdRow(cells: string[]): string {
  return '| ' + cells.join(' | ') + ' |';
}

function mdTable(headers: string[], rows: string[][]): string {
  const sep = headers.map(() => '---');
  return [mdRow(headers), mdRow(sep), ...rows.map((r) => mdRow(r))].join('\n');
}

const capRows = model.capabilities.map((c) => [
  `**${c.name}**`,
  `\`${c.slug}\``,
  c.plane,
  `\`${c.endpoint}\``,
  c.resource_type,
  c.events.map((e) => `\`${e}\``).join(', '),
]);

const errRows = model.error_taxonomy.map((e) => [
  `\`${e.code}\``,
  String(e.status),
  `\`${e.retry}\``,
  e.description,
]);

function routeTable(routes: Array<{ method: string; path: string }>): string {
  return mdTable(
    ['Method', 'Path'],
    routes.map((r) => [`\`${r.method}\``, `\`${r.path}\``]),
  );
}

const cliRows = model.cli_surface.map((v) => [
  `\`${v.verb}\``,
  `\`${v.route}\``,
  v.args
    .filter((a) => a.required)
    .map((a) => `\`${a.flag}\``)
    .join(', ') || '—',
  v.description,
]);

const md = `# Platform model — v${model.version}

<!-- DO NOT EDIT — generated by \`npm run generate:platform-model\`. Run it to regenerate. -->
<!-- Source: platform-model.json (committed, CI-drift-guarded). -->

The platform model is the authoritative reference for everything Forge exposes: capabilities,
resource types, event catalog, error taxonomy, HTTP route tables, and CLI surface. It is generated
from the live capability registry and committed so consumers can fetch it by git tag.

**Regenerate:** \`npm run generate:platform-model\` · **Source:** [\`platform-model.json\`](../../platform-model.json)

---

## Capabilities

${mdTable(['Name', 'Slug', 'Plane', 'Endpoint', 'Resource type', 'Events emitted'], capRows)}

## Resource types

${model.resource_types.map((t) => `- \`${t}\``).join('\n')}

## Event catalog

${model.event_catalog.map((e) => `- \`${e}\``).join('\n')}

## Error taxonomy

All errors use the envelope \`{ error: { code, message, retry } }\`.

${mdTable(['Code', 'HTTP status', 'Retry', 'Description'], errRows)}

## Route tables

### Control plane (port ${model.route_tables.control_plane.base_port})

${routeTable(model.route_tables.control_plane.inline_routes)}

Route modules mounted: ${model.route_tables.control_plane.api_modules.map((m) => `\`${m}\``).join(', ')}

### Data plane (port ${model.route_tables.data_plane.base_port})

${routeTable(model.route_tables.data_plane.inline_routes)}

Route modules mounted: ${model.route_tables.data_plane.api_modules.map((m) => `\`${m}\``).join(', ')}

## CLI surface

Every \`forge\` verb, the route it calls, and its required arguments.
Full argument lists (including optional flags) are in \`platform-model.json\` under \`cli_surface\`.

${mdTable(['Verb', 'Route', 'Required args', 'Description'], cliRows)}
`;

const mdOutPath = join(ROOT, 'docs/architecture/PLATFORM_MODEL.md');
writeFileSync(mdOutPath, md);

// eslint-disable-next-line no-console
console.log(
  `platform-model.json written — v${pkg.version}, ` +
    `${model.capabilities.length} capabilities, ` +
    `${model.resource_types.length} resource types, ` +
    `${model.event_catalog.length} events, ` +
    `${model.cli_surface.length} CLI verbs`,
);
// eslint-disable-next-line no-console
console.log(`docs/architecture/PLATFORM_MODEL.md written`);
