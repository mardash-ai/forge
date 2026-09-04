import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilities } from '../src/capabilities/index';
import { describeCapabilities, listCapabilities } from '../src/core/registry';
import { RESOURCE_TYPES } from '../src/resources/types';
import { EVENT_TYPES } from '../src/events/catalog';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const VALID_PLANES = ['control', 'data', 'both'] as const;

// ── GET /capabilities — plane field ──────────────────────────────────────────

describe('describeCapabilities() — plane field (registry.ts:27+)', () => {
  const described = describeCapabilities();

  it('every described capability includes a plane field', () => {
    for (const cap of described) {
      expect(cap, `${cap.slug} is missing plane`).toHaveProperty('plane');
    }
  });

  it('every plane value is one of the valid literals', () => {
    for (const cap of described) {
      expect(
        VALID_PLANES as readonly string[],
        `${cap.slug} has invalid plane "${cap.plane as string}"`,
      ).toContain(cap.plane);
    }
  });

  it('capabilities without an explicit plane default to "control"', () => {
    // Capabilities that have NO plane set on their definition should resolve to 'control'
    // in the discovery payload.
    for (const raw of listCapabilities()) {
      if (raw.plane === undefined) {
        const described = describeCapabilities().find((c) => c.slug === raw.slug)!;
        expect(described.plane, `${raw.slug} should default plane to "control"`).toBe('control');
      }
    }
  });

  it('plane values are consistent between the registry source and the describe output', () => {
    for (const raw of listCapabilities()) {
      const d = described.find((c) => c.slug === raw.slug)!;
      const expected = raw.plane ?? 'control';
      expect(d.plane, `${raw.slug} plane mismatch`).toBe(expected);
    }
  });

  it('known data-plane capabilities are marked correctly', () => {
    // agent-run, send-email, send-message live on the data plane.
    const dataPlane = described.filter((c) => c.plane === 'data').map((c) => c.slug);
    expect(dataPlane).toContain('agent-run');
    expect(dataPlane).toContain('send-email');
    expect(dataPlane).toContain('send-message');
  });

  it('known both-plane capabilities are marked correctly', () => {
    // set-secret, schedule-job, inspect live on both planes.
    const bothPlane = described.filter((c) => c.plane === 'both').map((c) => c.slug);
    expect(bothPlane).toContain('set-secret');
    expect(bothPlane).toContain('schedule-job');
    expect(bothPlane).toContain('inspect');
  });

  it('returns slug, name, description, resource_type, events, long_running, requires_docker, endpoint', () => {
    const required = ['slug', 'name', 'description', 'plane', 'resource_type', 'events', 'long_running', 'requires_docker', 'endpoint'];
    for (const cap of described) {
      for (const field of required) {
        expect(cap, `${cap.slug} missing ${field}`).toHaveProperty(field);
      }
    }
  });
});

// ── platform-model.json structural integrity ──────────────────────────────────

describe('platform-model.json', () => {
  const modelPath = join(ROOT, 'platform-model.json');

  it('is committed to the repo', () => {
    expect(existsSync(modelPath), 'platform-model.json must be committed').toBe(true);
  });

  const model = (() => {
    if (!existsSync(modelPath)) return null;
    return JSON.parse(readFileSync(modelPath, 'utf8')) as Record<string, unknown>;
  })();

  it('has a version stamp matching package.json', () => {
    if (!model) return;
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(model.version).toBe(pkg.version);
  });

  it('contains every capability slug from the registry', () => {
    if (!model) return;
    const modelSlugs = new Set((model.capabilities as Array<{ slug: string }>).map((c) => c.slug));
    for (const cap of capabilities) {
      expect(modelSlugs, `platform-model.json missing capability ${cap.slug}`).toContain(cap.slug);
    }
  });

  it('every capability in the model has a plane field', () => {
    if (!model) return;
    for (const cap of model.capabilities as Array<Record<string, unknown>>) {
      expect(cap, `model capability ${cap.slug as string} missing plane`).toHaveProperty('plane');
      expect(VALID_PLANES as readonly string[]).toContain(cap.plane);
    }
  });

  it('contains every resource type from RESOURCE_TYPES', () => {
    if (!model) return;
    const modelTypes = new Set(model.resource_types as string[]);
    for (const rt of RESOURCE_TYPES) {
      expect(modelTypes, `platform-model.json missing resource type ${rt}`).toContain(rt);
    }
  });

  it('contains every event type from EVENT_TYPES', () => {
    if (!model) return;
    const modelEvents = new Set(model.event_catalog as string[]);
    for (const et of EVENT_TYPES) {
      expect(modelEvents, `platform-model.json missing event type ${et}`).toContain(et);
    }
  });

  it('has an error_taxonomy array with known codes', () => {
    if (!model) return;
    const taxonomy = model.error_taxonomy as Array<{ code: string }>;
    const codes = new Set(taxonomy.map((e) => e.code));
    expect(codes).toContain('not_found');
    expect(codes).toContain('invalid_input');
    expect(codes).toContain('policy_blocked');
    expect(codes).toContain('permission_denied');
    expect(codes).toContain('dependency_unavailable');
    expect(codes).toContain('internal_error');
  });

  it('has route_tables for both planes', () => {
    if (!model) return;
    const rt = model.route_tables as Record<string, unknown>;
    expect(rt).toHaveProperty('control_plane');
    expect(rt).toHaveProperty('data_plane');
  });

  it('control_plane route table includes the /capabilities route', () => {
    if (!model) return;
    const cp = (model.route_tables as { control_plane: { inline_routes: Array<{ method: string; path: string }> } }).control_plane;
    const capRoute = cp.inline_routes.find((r) => r.path === '/capabilities');
    expect(capRoute, 'GET /capabilities missing from control_plane route table').toBeDefined();
    expect(capRoute?.method).toBe('GET');
  });

  it('data_plane route table includes the /capabilities route', () => {
    if (!model) return;
    const dp = (model.route_tables as { data_plane: { inline_routes: Array<{ method: string; path: string }> } }).data_plane;
    const capRoute = dp.inline_routes.find((r) => r.path === '/capabilities');
    expect(capRoute, 'GET /capabilities missing from data_plane route table').toBeDefined();
  });

  it('model plane values match the live registry', () => {
    if (!model) return;
    const live = new Map(describeCapabilities().map((c) => [c.slug, c.plane]));
    for (const cap of model.capabilities as Array<{ slug: string; plane: string }>) {
      const liveVal = live.get(cap.slug);
      expect(cap.plane, `${cap.slug}: model plane "${cap.plane}" ≠ live plane "${liveVal}"`).toBe(liveVal);
    }
  });
});
