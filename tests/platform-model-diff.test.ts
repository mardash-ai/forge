import { describe, test, expect } from 'vitest';
import { computeDiff, renderMarkdown } from '../scripts/diff-platform-model.js';
import type { PlatformModel } from '../scripts/diff-platform-model.js';

// ── Minimal fixture models ────────────────────────────────────────────────────
// Two lightweight snapshots that exercise every diff dimension without importing
// the full live registries. The diff result must be byte-for-byte identical on
// repeated calls (determinism contract).

const baseModel: PlatformModel = {
  version: '1.0.0',
  capabilities: [
    {
      name: 'Build',
      slug: 'build',
      description: 'Run a reproducible build.',
      plane: 'control',
      resource_type: 'Build',
      events: ['BuildStarted', 'BuildSucceeded'],
      long_running: false,
      requires_docker: true,
      input_schema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
      endpoint: 'POST /capabilities/build',
    },
    {
      name: 'Test',
      slug: 'test',
      description: 'Run tests.',
      plane: 'control',
      resource_type: 'TestRun',
      events: ['TestRunStarted', 'TestRunSucceeded'],
      long_running: false,
      requires_docker: true,
      input_schema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
      endpoint: 'POST /capabilities/test',
    },
    {
      name: 'Lint',
      slug: 'lint',
      description: 'Run lint.',
      plane: 'control',
      resource_type: 'CheckRun',
      events: ['CheckRunStarted', 'CheckRunSucceeded'],
      long_running: false,
      requires_docker: true,
      input_schema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
      endpoint: 'POST /capabilities/lint',
    },
  ],
  resource_types: ['Build', 'TestRun', 'CheckRun', 'Workspace'],
  event_catalog: ['BuildStarted', 'BuildSucceeded', 'TestRunStarted', 'TestRunSucceeded', 'CheckRunStarted'],
  error_taxonomy: [
    { code: 'not_found', status: 404, retry: 'change-input', description: 'Resource not found.' },
    { code: 'invalid_input', status: 422, retry: 'change-input', description: 'Input failed validation.' },
    { code: 'internal_error', status: 500, retry: 'no', description: 'Unexpected platform error.' },
  ],
  route_tables: {
    control_plane: {
      base_port: 3717,
      inline_routes: [
        { method: 'GET', path: '/health' },
        { method: 'POST', path: '/capabilities/:slug' },
        { method: 'GET', path: '/capabilities' },
      ],
      api_modules: ['build-routes', 'test-routes'],
    },
    data_plane: {
      base_port: 3718,
      inline_routes: [{ method: 'GET', path: '/health' }],
      api_modules: [],
    },
  },
  cli_surface: [
    {
      verb: 'forge build',
      description: 'Run a reproducible build (Build)',
      route: 'POST /capabilities/build',
      args: [
        { flag: '--app <app>', required: true, description: 'application name' },
        { flag: '--platform <platform>', required: false, description: 'target platform' },
      ],
    },
    {
      verb: 'forge test',
      description: 'Run tests (Test)',
      route: 'POST /capabilities/test',
      args: [{ flag: '--app <app>', required: true, description: 'application name' }],
    },
  ],
};

// changedModel:
//  - lint capability removed
//  - build capability description changed
//  - deploy capability added
//  - Artifact resource type added, Workspace removed
//  - DeploymentStarted event added
//  - internal_error error code description changed
//  - a new route added in control plane
//  - forge lint verb removed, forge deploy added
const changedModel: PlatformModel = {
  version: '1.1.0',
  capabilities: [
    {
      name: 'Build',
      slug: 'build',
      description: 'Run a fast, reproducible build.', // changed
      plane: 'control',
      resource_type: 'Build',
      events: ['BuildStarted', 'BuildSucceeded'],
      long_running: false,
      requires_docker: true,
      input_schema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
      endpoint: 'POST /capabilities/build',
    },
    {
      name: 'Test',
      slug: 'test',
      description: 'Run tests.',
      plane: 'control',
      resource_type: 'TestRun',
      events: ['TestRunStarted', 'TestRunSucceeded'],
      long_running: false,
      requires_docker: true,
      input_schema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
      endpoint: 'POST /capabilities/test',
    },
    // lint removed
    {
      name: 'Deploy', // added
      slug: 'deploy',
      description: 'Zero-downtime deploy.',
      plane: 'control',
      resource_type: 'Deployment',
      events: ['DeploymentStarted'],
      long_running: true,
      requires_docker: true,
      input_schema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
      endpoint: 'POST /capabilities/deploy',
    },
  ],
  resource_types: ['Build', 'TestRun', 'CheckRun', 'Artifact', 'Deployment'], // Workspace removed, Artifact+Deployment added
  event_catalog: [
    'BuildStarted',
    'BuildSucceeded',
    'TestRunStarted',
    'TestRunSucceeded',
    'CheckRunStarted',
    'DeploymentStarted', // added
  ],
  error_taxonomy: [
    { code: 'not_found', status: 404, retry: 'change-input', description: 'Resource not found.' },
    { code: 'invalid_input', status: 422, retry: 'change-input', description: 'Input failed validation.' },
    {
      code: 'internal_error',
      status: 500,
      retry: 'no',
      description: 'An unexpected platform error occurred.', // changed
    },
  ],
  route_tables: {
    control_plane: {
      base_port: 3717,
      inline_routes: [
        { method: 'GET', path: '/health' },
        { method: 'POST', path: '/capabilities/:slug' },
        { method: 'GET', path: '/capabilities' },
        { method: 'GET', path: '/resources' }, // added
      ],
      api_modules: ['build-routes', 'test-routes'],
    },
    data_plane: {
      base_port: 3718,
      inline_routes: [{ method: 'GET', path: '/health' }],
      api_modules: [],
    },
  },
  cli_surface: [
    {
      verb: 'forge build',
      description: 'Run a reproducible build (Build)',
      route: 'POST /capabilities/build',
      args: [
        { flag: '--app <app>', required: true, description: 'application name' },
        { flag: '--platform <platform>', required: false, description: 'target platform' },
      ],
    },
    {
      verb: 'forge test',
      description: 'Run tests (Test)',
      route: 'POST /capabilities/test',
      args: [{ flag: '--app <app>', required: true, description: 'application name' }],
    },
    // forge test removed
    {
      verb: 'forge deploy', // added
      description: 'Zero-downtime deploy (Deploy)',
      route: 'POST /capabilities/deploy',
      args: [
        { flag: '--app <app>', required: true, description: 'application name' },
        { flag: '--service <service>', required: false, description: 'service to roll' },
      ],
    },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('computeDiff', () => {
  test('empty diff for identical models — empty:true, all arrays length 0', () => {
    const diff = computeDiff(baseModel, baseModel);
    expect(diff.empty).toBe(true);
    expect(diff.capabilities.added).toHaveLength(0);
    expect(diff.capabilities.removed).toHaveLength(0);
    expect(diff.capabilities.changed).toHaveLength(0);
    expect(diff.resource_types.added).toHaveLength(0);
    expect(diff.resource_types.removed).toHaveLength(0);
    expect(diff.event_catalog.added).toHaveLength(0);
    expect(diff.event_catalog.removed).toHaveLength(0);
    expect(diff.error_codes.added).toHaveLength(0);
    expect(diff.error_codes.removed).toHaveLength(0);
    expect(diff.error_codes.changed).toHaveLength(0);
    expect(diff.routes.control_plane.added).toHaveLength(0);
    expect(diff.routes.control_plane.removed).toHaveLength(0);
    expect(diff.cli_verbs.added).toHaveLength(0);
    expect(diff.cli_verbs.removed).toHaveLength(0);
    expect(diff.cli_verbs.changed).toHaveLength(0);
  });

  test('first-release diff (from=null) marks all items as added', () => {
    const diff = computeDiff(null, baseModel);
    expect(diff.from_version).toBe('(none)');
    expect(diff.to_version).toBe('1.0.0');
    expect(diff.empty).toBe(false);
    expect(diff.capabilities.added).toHaveLength(baseModel.capabilities.length);
    expect(diff.capabilities.removed).toHaveLength(0);
    expect(diff.resource_types.added).toHaveLength(baseModel.resource_types.length);
    expect(diff.event_catalog.added).toHaveLength(baseModel.event_catalog.length);
    expect(diff.cli_verbs.added).toHaveLength(baseModel.cli_surface.length);
  });

  test('detects added capability', () => {
    const diff = computeDiff(baseModel, changedModel);
    const addedSlugs = diff.capabilities.added.map((c) => c.slug);
    expect(addedSlugs).toContain('deploy');
  });

  test('detects removed capability', () => {
    const diff = computeDiff(baseModel, changedModel);
    const removedSlugs = diff.capabilities.removed.map((c) => c.slug);
    expect(removedSlugs).toContain('lint');
  });

  test('detects changed capability fields', () => {
    const diff = computeDiff(baseModel, changedModel);
    const buildChange = diff.capabilities.changed.find((c) => c.slug === 'build');
    expect(buildChange).toBeDefined();
    expect(buildChange!.changed_fields).toContain('description');
  });

  test('detects added/removed resource types', () => {
    const diff = computeDiff(baseModel, changedModel);
    expect(diff.resource_types.added).toContain('Artifact');
    expect(diff.resource_types.added).toContain('Deployment');
    expect(diff.resource_types.removed).toContain('Workspace');
  });

  test('detects added event', () => {
    const diff = computeDiff(baseModel, changedModel);
    expect(diff.event_catalog.added).toContain('DeploymentStarted');
  });

  test('detects changed error code fields', () => {
    const diff = computeDiff(baseModel, changedModel);
    const changed = diff.error_codes.changed.find((e) => e.code === 'internal_error');
    expect(changed).toBeDefined();
    expect(changed!.changed_fields).toContain('description');
  });

  test('detects added route in control plane', () => {
    const diff = computeDiff(baseModel, changedModel);
    expect(diff.routes.control_plane.added).toContain('GET /resources');
  });

  test('detects added CLI verb', () => {
    const diff = computeDiff(baseModel, changedModel);
    const addedVerbs = diff.cli_verbs.added.map((v) => v.verb);
    expect(addedVerbs).toContain('forge deploy');
  });

  test('diff is not empty when models differ', () => {
    const diff = computeDiff(baseModel, changedModel);
    expect(diff.empty).toBe(false);
  });

  test('output arrays are sorted deterministically', () => {
    const diff = computeDiff(baseModel, changedModel);
    const addedRt = diff.resource_types.added;
    expect([...addedRt].sort()).toEqual(addedRt);
    const removedRt = diff.resource_types.removed;
    expect([...removedRt].sort()).toEqual(removedRt);
  });
});

describe('determinism', () => {
  test('computeDiff produces identical JSON bytes on repeated calls', () => {
    const diff1 = computeDiff(baseModel, changedModel);
    const diff2 = computeDiff(baseModel, changedModel);
    expect(JSON.stringify(diff1, null, 2)).toBe(JSON.stringify(diff2, null, 2));
  });

  test('renderMarkdown produces identical bytes on repeated calls', () => {
    const diff = computeDiff(baseModel, changedModel);
    expect(renderMarkdown(diff)).toBe(renderMarkdown(diff));
    // Call computeDiff again to prove rendering of an independently computed diff is also identical
    const diff2 = computeDiff(baseModel, changedModel);
    expect(renderMarkdown(diff2)).toBe(renderMarkdown(diff));
  });

  test('empty diff rendered as explicit "no changes" (not an error)', () => {
    const diff = computeDiff(baseModel, baseModel);
    const md = renderMarkdown(diff);
    expect(md).toContain('No changes');
  });
});

describe('renderMarkdown', () => {
  test('includes version header', () => {
    const diff = computeDiff(baseModel, changedModel);
    const md = renderMarkdown(diff);
    expect(md).toContain('1.0.0 → 1.1.0');
  });

  test('lists added capabilities', () => {
    const diff = computeDiff(baseModel, changedModel);
    const md = renderMarkdown(diff);
    expect(md).toContain('deploy');
  });

  test('lists added CLI verbs', () => {
    const diff = computeDiff(baseModel, changedModel);
    const md = renderMarkdown(diff);
    expect(md).toContain('forge deploy');
  });

  test('empty diff Markdown contains "no changes" message, no error', () => {
    const diff = computeDiff(baseModel, baseModel);
    const md = renderMarkdown(diff);
    expect(md).not.toContain('##'); // no sections for empty diff
    expect(md).toContain('No changes');
  });
});
