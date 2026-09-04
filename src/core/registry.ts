import type { Capability } from './types';
import { capabilities } from '../capabilities/index';
import { notFound } from '../shared/errors';

// The core owns Capability routing. The registry is the single index of every
// Capability the platform exposes. It knows nothing about specific providers.
//
// Lazy initialization: the bySlug map is built on first access rather than at
// module evaluation time. This avoids a circular ESM initialization hazard:
//
//   capabilities/index → eval/seed → billing/service → notifications/delivery
//     → core/runtime → core/registry → capabilities/index  (circular!)
//
// Deferring the loop until first call lets all modules finish evaluating before
// the map is built — no behavioral change for callers.
let _bySlug: Map<string, Capability<any, any>> | null = null;

function lazyBySlug(): Map<string, Capability<any, any>> {
  if (_bySlug) return _bySlug;
  _bySlug = new Map<string, Capability<any, any>>();
  for (const cap of capabilities) {
    _bySlug.set(cap.slug, cap);
  }
  return _bySlug;
}

export function getCapability(slug: string): Capability<any, any> {
  const map = lazyBySlug();
  const cap = map.get(slug);
  if (!cap) {
    throw notFound(`Unknown capability: "${slug}".`, {
      available: [...map.keys()],
    });
  }
  return cap;
}

export function listCapabilities(): Capability<any, any>[] {
  return [...lazyBySlug().values()];
}

// Discovery payload — agents must be able to discover Forge (API philosophy).
// `plane` tells callers which deployment plane serves the capability:
//   'control' = dev/orchestration only (build/test/lint/provision);
//   'data'    = the running production app needs it;
//   'both'    = a management surface on the control plane AND a runtime surface on the data plane.
// The data-plane image exposes only data/both capabilities; absent → 'control'.
export function describeCapabilities() {
  return listCapabilities().map((c) => ({
    name: c.name,
    slug: c.slug,
    description: c.description,
    plane: c.plane ?? 'control',
    resource_type: c.resourceType,
    events: c.events,
    long_running: c.longRunning,
    requires_docker: c.requiresDocker,
    endpoint: `POST /capabilities/${c.slug}`,
  }));
}
