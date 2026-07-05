import type { Actor } from '../shared/domain';
import { permissionDenied } from '../shared/errors';

// Permissions AUTHORIZE — they decide whether a Builder may use a Capability or
// access a Resource. Humans and agents use the SAME contracts; an agent is a
// Builder, not a special path.
//
// v1 is single-tenant local mode, so the model is permissive-by-default. The
// seam is real: every Capability execution passes through checkPermission, so
// tightening this later (multi-tenant service mode) touches one place.

export interface PermissionRequest {
  actor: Actor;
  capability: string;
  app_id?: string;
}

export function checkPermission(req: PermissionRequest): void {
  // Local mode: builder, agent, and system actors may all invoke Capabilities.
  const allowed: Array<Actor['type']> = ['builder', 'agent', 'system'];
  if (!allowed.includes(req.actor.type)) {
    throw permissionDenied(`Actor type "${req.actor.type}" may not invoke Capabilities.`);
  }
}
