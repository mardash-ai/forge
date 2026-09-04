#!/usr/bin/env node
// Compute the semantic diff between two platform-model.json snapshots.
//
// Usage (git tags):
//   npm run diff:platform-model -- v1.57.0 v1.58.0
//   npm run diff:platform-model -- none v1.58.0   # first release — all items "added"
//
// Usage (file paths, for testing / local inspection):
//   npm run diff:platform-model -- --from-file old.json --to-file new.json
//
// Outputs platform-changes.json and platform-changes.md in the CWD.
// The core computeDiff() and renderMarkdown() functions are exported for unit tests.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PlatformModel {
  $schema?: string;
  version: string;
  capabilities: CapabilityEntry[];
  resource_types: string[];
  event_catalog: string[];
  error_taxonomy: ErrorEntry[];
  route_tables: RouteTables;
  cli_surface: CliVerbEntry[];
}

export interface CapabilityEntry {
  name: string;
  slug: string;
  description: string;
  plane: string;
  resource_type: string;
  events: string[];
  long_running?: boolean;
  requires_docker?: boolean;
  input_schema: Record<string, unknown>;
  endpoint: string;
}

export interface ErrorEntry {
  code: string;
  status: number;
  retry: string;
  description: string;
}

export interface RouteTables {
  control_plane: RouteTable;
  data_plane: RouteTable;
}

export interface RouteTable {
  base_port: number;
  inline_routes: Route[];
  api_modules: string[];
}

export interface Route {
  method: string;
  path: string;
}

export interface CliArg {
  flag: string;
  required: boolean;
  description: string;
}

export interface CliVerbEntry {
  verb: string;
  description: string;
  route: string;
  args: CliArg[];
}

// ── Diff result types ─────────────────────────────────────────────────────────

export interface SetDiff {
  added: string[];
  removed: string[];
}

export interface CapabilityDiff {
  added: CapabilityEntry[];
  removed: CapabilityEntry[];
  changed: Array<CapabilityEntry & { changed_fields: string[] }>;
}

export interface ErrorDiff {
  added: ErrorEntry[];
  removed: ErrorEntry[];
  changed: Array<ErrorEntry & { changed_fields: string[] }>;
}

export interface CliVerbDiff {
  added: CliVerbEntry[];
  removed: CliVerbEntry[];
  changed: Array<CliVerbEntry & { changed_fields: string[] }>;
}

export interface RoutesDiff {
  control_plane: SetDiff;
  data_plane: SetDiff;
}

export interface PlatformDiff {
  $schema: string;
  from_version: string;
  to_version: string;
  empty: boolean;
  capabilities: CapabilityDiff;
  resource_types: SetDiff;
  event_catalog: SetDiff;
  error_codes: ErrorDiff;
  routes: RoutesDiff;
  cli_verbs: CliVerbDiff;
}

// ── Core diff logic ───────────────────────────────────────────────────────────

function diffSet(fromArr: string[], toArr: string[]): SetDiff {
  const fromSet = new Set(fromArr);
  const toSet = new Set(toArr);
  return {
    added: [...toArr].filter((x) => !fromSet.has(x)).sort(),
    removed: [...fromArr].filter((x) => !toSet.has(x)).sort(),
  };
}

function diffCapabilities(from: CapabilityEntry[], to: CapabilityEntry[]): CapabilityDiff {
  const fromMap = new Map(from.map((c) => [c.slug, c]));
  const toMap = new Map(to.map((c) => [c.slug, c]));

  const added = [...to].filter((c) => !fromMap.has(c.slug)).sort((a, b) => a.slug.localeCompare(b.slug));
  const removed = [...from].filter((c) => !toMap.has(c.slug)).sort((a, b) => a.slug.localeCompare(b.slug));
  const changed: Array<CapabilityEntry & { changed_fields: string[] }> = [];

  const scalar: Array<keyof CapabilityEntry> = [
    'name',
    'description',
    'plane',
    'resource_type',
    'endpoint',
    'long_running',
    'requires_docker',
  ];

  for (const [slug, toC] of toMap) {
    const fromC = fromMap.get(slug);
    if (!fromC) continue;
    const changedFields: string[] = [];
    for (const field of scalar) {
      if (JSON.stringify(fromC[field]) !== JSON.stringify(toC[field])) {
        changedFields.push(field);
      }
    }
    if (JSON.stringify(fromC.events) !== JSON.stringify(toC.events)) changedFields.push('events');
    if (JSON.stringify(fromC.input_schema) !== JSON.stringify(toC.input_schema))
      changedFields.push('input_schema');
    if (changedFields.length > 0) {
      changed.push({ ...toC, changed_fields: changedFields.sort() });
    }
  }
  changed.sort((a, b) => a.slug.localeCompare(b.slug));
  return { added, removed, changed };
}

function diffErrors(from: ErrorEntry[], to: ErrorEntry[]): ErrorDiff {
  const fromMap = new Map(from.map((e) => [e.code, e]));
  const toMap = new Map(to.map((e) => [e.code, e]));

  const added = [...to].filter((e) => !fromMap.has(e.code)).sort((a, b) => a.code.localeCompare(b.code));
  const removed = [...from].filter((e) => !toMap.has(e.code)).sort((a, b) => a.code.localeCompare(b.code));
  const changed: Array<ErrorEntry & { changed_fields: string[] }> = [];

  for (const [code, toE] of toMap) {
    const fromE = fromMap.get(code);
    if (!fromE) continue;
    const changedFields: string[] = [];
    for (const field of ['status', 'retry', 'description'] as const) {
      if (JSON.stringify(fromE[field]) !== JSON.stringify(toE[field])) {
        changedFields.push(field);
      }
    }
    if (changedFields.length > 0) {
      changed.push({ ...toE, changed_fields: changedFields.sort() });
    }
  }
  changed.sort((a, b) => a.code.localeCompare(b.code));
  return { added, removed, changed };
}

function routeKey(r: Route): string {
  return `${r.method} ${r.path}`;
}

function diffRouteTable(from: Route[], to: Route[]): SetDiff {
  const fromKeys = from.map(routeKey);
  const toKeys = to.map(routeKey);
  return diffSet(fromKeys, toKeys);
}

function diffCliVerbs(from: CliVerbEntry[], to: CliVerbEntry[]): CliVerbDiff {
  const fromMap = new Map(from.map((v) => [v.verb, v]));
  const toMap = new Map(to.map((v) => [v.verb, v]));

  const added = [...to].filter((v) => !fromMap.has(v.verb)).sort((a, b) => a.verb.localeCompare(b.verb));
  const removed = [...from].filter((v) => !toMap.has(v.verb)).sort((a, b) => a.verb.localeCompare(b.verb));
  const changed: Array<CliVerbEntry & { changed_fields: string[] }> = [];

  for (const [verb, toV] of toMap) {
    const fromV = fromMap.get(verb);
    if (!fromV) continue;
    const changedFields: string[] = [];
    if (fromV.description !== toV.description) changedFields.push('description');
    if (fromV.route !== toV.route) changedFields.push('route');
    if (JSON.stringify(fromV.args) !== JSON.stringify(toV.args)) changedFields.push('args');
    if (changedFields.length > 0) {
      changed.push({ ...toV, changed_fields: changedFields.sort() });
    }
  }
  changed.sort((a, b) => a.verb.localeCompare(b.verb));
  return { added, removed, changed };
}

function isSetDiffEmpty(d: SetDiff): boolean {
  return d.added.length === 0 && d.removed.length === 0;
}

function isCapDiffEmpty(d: CapabilityDiff): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}

function isErrDiffEmpty(d: ErrorDiff): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}

function isCLIDiffEmpty(d: CliVerbDiff): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}

/**
 * Compute a semantic diff between two platform models.
 * Pass `null` as `from` to represent a first-release (all items will be "added").
 */
export function computeDiff(from: PlatformModel | null, to: PlatformModel): PlatformDiff {
  // When from is null (first release), use empty arrays so everything appears as "added".
  const f: PlatformModel = from ?? {
    version: '(none)',
    capabilities: [],
    resource_types: [],
    event_catalog: [],
    error_taxonomy: [],
    route_tables: {
      control_plane: { base_port: 0, inline_routes: [], api_modules: [] },
      data_plane: { base_port: 0, inline_routes: [], api_modules: [] },
    },
    cli_surface: [],
  };

  const capabilities = diffCapabilities(f.capabilities, to.capabilities);
  const resource_types = diffSet(f.resource_types, to.resource_types);
  const event_catalog = diffSet(f.event_catalog, to.event_catalog);
  const error_codes = diffErrors(f.error_taxonomy, to.error_taxonomy);
  const routes: RoutesDiff = {
    control_plane: diffRouteTable(
      f.route_tables.control_plane.inline_routes,
      to.route_tables.control_plane.inline_routes,
    ),
    data_plane: diffRouteTable(
      f.route_tables.data_plane.inline_routes,
      to.route_tables.data_plane.inline_routes,
    ),
  };
  const cli_verbs = diffCliVerbs(f.cli_surface ?? [], to.cli_surface ?? []);

  const empty =
    isCapDiffEmpty(capabilities) &&
    isSetDiffEmpty(resource_types) &&
    isSetDiffEmpty(event_catalog) &&
    isErrDiffEmpty(error_codes) &&
    isSetDiffEmpty(routes.control_plane) &&
    isSetDiffEmpty(routes.data_plane) &&
    isCLIDiffEmpty(cli_verbs);

  return {
    $schema: 'https://forge.build/platform-changes/v1',
    from_version: f.version,
    to_version: to.version,
    empty,
    capabilities,
    resource_types,
    event_catalog,
    error_codes,
    routes,
    cli_verbs,
  };
}

// ── Markdown rendering ────────────────────────────────────────────────────────

function mdRow(cells: string[]): string {
  return '| ' + cells.join(' | ') + ' |';
}

function mdTable(headers: string[], rows: string[][]): string {
  const sep = headers.map(() => '---');
  return [mdRow(headers), mdRow(sep), ...rows.map((r) => mdRow(r))].join('\n');
}

function badge(label: string, items: unknown[]): string {
  return items.length === 0 ? '' : `**${items.length} ${label}**`;
}

/**
 * Render a PlatformDiff as Markdown suitable for a GitHub release body.
 */
export function renderMarkdown(diff: PlatformDiff): string {
  const lines: string[] = [];

  lines.push(`# Platform changes — ${diff.from_version} → ${diff.to_version}`);
  lines.push('');
  lines.push(
    '<!-- Generated by `npm run diff:platform-model`. ' +
      'Source: platform-changes.json (attached to this release). -->',
  );
  lines.push('');

  if (diff.empty) {
    lines.push('_No changes to the platform model between these versions._');
    return lines.join('\n');
  }

  // ── Capabilities ──────────────────────────────────────────────────────────
  const { capabilities: cap } = diff;
  if (!isCapDiffEmpty(cap)) {
    lines.push('## Capabilities');
    lines.push('');
    if (cap.added.length > 0) {
      lines.push(`### Added ${badge('added', cap.added)}`);
      lines.push('');
      lines.push(
        mdTable(
          ['Slug', 'Name', 'Plane', 'Endpoint'],
          cap.added.map((c) => [`\`${c.slug}\``, c.name, c.plane, `\`${c.endpoint}\``]),
        ),
      );
      lines.push('');
    }
    if (cap.removed.length > 0) {
      lines.push(`### Removed ${badge('removed', cap.removed)}`);
      lines.push('');
      lines.push(cap.removed.map((c) => `- \`${c.slug}\``).join('\n'));
      lines.push('');
    }
    if (cap.changed.length > 0) {
      lines.push(`### Changed ${badge('changed', cap.changed)}`);
      lines.push('');
      lines.push(
        mdTable(
          ['Slug', 'Changed fields'],
          cap.changed.map((c) => [`\`${c.slug}\``, c.changed_fields.map((f) => `\`${f}\``).join(', ')]),
        ),
      );
      lines.push('');
    }
  }

  // ── Resource types ────────────────────────────────────────────────────────
  const { resource_types: rt } = diff;
  if (!isSetDiffEmpty(rt)) {
    lines.push('## Resource types');
    lines.push('');
    if (rt.added.length > 0) lines.push(`- **Added:** ${rt.added.map((x) => `\`${x}\``).join(', ')}`);
    if (rt.removed.length > 0) lines.push(`- **Removed:** ${rt.removed.map((x) => `\`${x}\``).join(', ')}`);
    lines.push('');
  }

  // ── Event catalog ─────────────────────────────────────────────────────────
  const { event_catalog: ec } = diff;
  if (!isSetDiffEmpty(ec)) {
    lines.push('## Event catalog');
    lines.push('');
    if (ec.added.length > 0) lines.push(`- **Added:** ${ec.added.map((x) => `\`${x}\``).join(', ')}`);
    if (ec.removed.length > 0) lines.push(`- **Removed:** ${ec.removed.map((x) => `\`${x}\``).join(', ')}`);
    lines.push('');
  }

  // ── Error codes ───────────────────────────────────────────────────────────
  const { error_codes: ec2 } = diff;
  if (!isErrDiffEmpty(ec2)) {
    lines.push('## Error codes');
    lines.push('');
    if (ec2.added.length > 0) lines.push(`- **Added:** ${ec2.added.map((e) => `\`${e.code}\``).join(', ')}`);
    if (ec2.removed.length > 0)
      lines.push(`- **Removed:** ${ec2.removed.map((e) => `\`${e.code}\``).join(', ')}`);
    if (ec2.changed.length > 0) {
      lines.push('- **Changed:**');
      for (const e of ec2.changed) {
        lines.push(`  - \`${e.code}\`: ${e.changed_fields.join(', ')}`);
      }
    }
    lines.push('');
  }

  // ── Routes ────────────────────────────────────────────────────────────────
  const { routes } = diff;
  const hasRouteChanges = !isSetDiffEmpty(routes.control_plane) || !isSetDiffEmpty(routes.data_plane);
  if (hasRouteChanges) {
    lines.push('## Routes');
    lines.push('');
    for (const [plane, rd] of [
      ['Control plane', routes.control_plane],
      ['Data plane', routes.data_plane],
    ] as const) {
      if (!isSetDiffEmpty(rd)) {
        lines.push(`### ${plane}`);
        lines.push('');
        if (rd.added.length > 0) lines.push(`- **Added:** ${rd.added.map((r) => `\`${r}\``).join(', ')}`);
        if (rd.removed.length > 0)
          lines.push(`- **Removed:** ${rd.removed.map((r) => `\`${r}\``).join(', ')}`);
        lines.push('');
      }
    }
  }

  // ── CLI verbs ─────────────────────────────────────────────────────────────
  const { cli_verbs: cli } = diff;
  if (!isCLIDiffEmpty(cli)) {
    lines.push('## CLI verbs');
    lines.push('');
    if (cli.added.length > 0) {
      lines.push(`### Added ${badge('added', cli.added)}`);
      lines.push('');
      lines.push(
        mdTable(
          ['Verb', 'Route', 'Description'],
          cli.added.map((v) => [`\`${v.verb}\``, `\`${v.route}\``, v.description]),
        ),
      );
      lines.push('');
    }
    if (cli.removed.length > 0) {
      lines.push(`### Removed ${badge('removed', cli.removed)}`);
      lines.push('');
      lines.push(cli.removed.map((v) => `- \`${v.verb}\``).join('\n'));
      lines.push('');
    }
    if (cli.changed.length > 0) {
      lines.push(`### Changed ${badge('changed', cli.changed)}`);
      lines.push('');
      lines.push(
        mdTable(
          ['Verb', 'Changed fields'],
          cli.changed.map((v) => [`\`${v.verb}\``, v.changed_fields.map((f) => `\`${f}\``).join(', ')]),
        ),
      );
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

// ── Model loading ─────────────────────────────────────────────────────────────

function loadModelFromFile(filePath: string): PlatformModel {
  return JSON.parse(readFileSync(filePath, 'utf8')) as PlatformModel;
}

function loadModelFromTag(tag: string): PlatformModel | null {
  if (!tag || tag === 'none' || tag === '') return null;
  try {
    const json = execSync(`git show ${tag}:platform-model.json`, { encoding: 'utf8' });
    return JSON.parse(json) as PlatformModel;
  } catch {
    // Tag doesn't exist or has no platform-model.json — treat as first release.
    return null;
  }
}

// ── CLI entry point ───────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);

  let fromModel: PlatformModel | null;
  let toModel: PlatformModel;

  const fromFileIdx = args.indexOf('--from-file');
  const toFileIdx = args.indexOf('--to-file');

  if (fromFileIdx !== -1 && toFileIdx !== -1) {
    // File-path mode (for testing / local inspection)
    const fromFile = args[fromFileIdx + 1];
    const toFile = args[toFileIdx + 1];
    if (!fromFile || !toFile) {
      process.stderr.write('Usage: --from-file <path> --to-file <path>\n');
      process.exit(1);
    }
    fromModel = fromFile === 'none' ? null : loadModelFromFile(fromFile);
    toModel = loadModelFromFile(toFile);
  } else if (args.length >= 2) {
    // Tag mode
    const [fromTag, toTag] = args;
    fromModel = loadModelFromTag(fromTag!);
    toModel = loadModelFromTag(toTag!) ?? loadModelFromFile(join(process.cwd(), 'platform-model.json'));
  } else {
    process.stderr.write(
      'Usage:\n' +
        '  diff-platform-model <fromTag> <toTag>\n' +
        '  diff-platform-model --from-file <path> --to-file <path>\n' +
        'Pass "none" as fromTag for a first-release diff (all items added).\n',
    );
    process.exit(1);
  }

  const diff = computeDiff(fromModel, toModel);

  const jsonOut = join(process.cwd(), 'platform-changes.json');
  const mdOut = join(process.cwd(), 'platform-changes.md');

  writeFileSync(jsonOut, JSON.stringify(diff, null, 2) + '\n');
  writeFileSync(mdOut, renderMarkdown(diff));

  const summary = diff.empty
    ? 'no changes'
    : [
        diff.capabilities.added.length ? `+${diff.capabilities.added.length} cap` : '',
        diff.capabilities.removed.length ? `-${diff.capabilities.removed.length} cap` : '',
        diff.capabilities.changed.length ? `~${diff.capabilities.changed.length} cap` : '',
        diff.cli_verbs.added.length ? `+${diff.cli_verbs.added.length} verb` : '',
        diff.cli_verbs.removed.length ? `-${diff.cli_verbs.removed.length} verb` : '',
      ]
        .filter(Boolean)
        .join(', ') || 'route/event/resource changes';

  // eslint-disable-next-line no-console
  console.log(`platform-changes.json written — ${diff.from_version} → ${diff.to_version} (${summary})`);
  // eslint-disable-next-line no-console
  console.log(`platform-changes.md written`);
}

// Only invoke the CLI when this file is the entry point, not when imported as a module.
// In ESM + tsx, process.argv[1] is the resolved script path when run directly.
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename || process.argv[1]?.endsWith('diff-platform-model.ts')) {
  main();
}
