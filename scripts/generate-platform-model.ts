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
};

const outPath = join(ROOT, 'platform-model.json');
writeFileSync(outPath, JSON.stringify(model, null, 2) + '\n');
// eslint-disable-next-line no-console
console.log(
  `platform-model.json written — v${pkg.version}, ` +
    `${model.capabilities.length} capabilities, ` +
    `${model.resource_types.length} resource types, ` +
    `${model.event_catalog.length} events`,
);
