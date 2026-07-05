import type { Capability } from './types';
import { capabilities } from '../capabilities/index';
import { notFound } from '../shared/errors';

// The core owns Capability routing. The registry is the single index of every
// Capability the platform exposes. It knows nothing about specific providers.
const bySlug = new Map<string, Capability<any, any>>();
for (const cap of capabilities) {
  bySlug.set(cap.slug, cap);
}

export function getCapability(slug: string): Capability<any, any> {
  const cap = bySlug.get(slug);
  if (!cap) {
    throw notFound(`Unknown capability: "${slug}".`, {
      available: [...bySlug.keys()],
    });
  }
  return cap;
}

export function listCapabilities(): Capability<any, any>[] {
  return [...bySlug.values()];
}

// Discovery payload — agents must be able to discover Forge (API philosophy).
export function describeCapabilities() {
  return listCapabilities().map((c) => ({
    name: c.name,
    slug: c.slug,
    description: c.description,
    resource_type: c.resourceType,
    events: c.events,
    long_running: c.longRunning,
    requires_docker: c.requiresDocker,
    endpoint: `POST /capabilities/${c.slug}`,
  }));
}
