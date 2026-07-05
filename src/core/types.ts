import type { z } from 'zod';
import type { Actor } from '../shared/domain';
import type { Store } from '../storage/store';
import type { AnyResource, ResourceType } from '../resources/types';
import type { EventType } from '../events/catalog';

// The context every Capability receives. It gives access to state (the Store),
// facts (emit), and identity (actor) — but Capabilities own the behavior.
export interface CapabilityContext {
  store: Store;
  actor: Actor;
  // Emit an immutable fact.
  emit(input: {
    type: EventType;
    resource_type: string;
    resource_id: string;
    app_id?: string;
    data?: Record<string, unknown>;
  }): Promise<void>;
}

// A Capability is a STABLE CONTRACT that exposes behavior. It declares the
// Resource it produces, the Events it may emit, and selects an Implementation.
export interface Capability<I = unknown, O extends AnyResource | AnyResource[] = AnyResource> {
  // Canonical Capability name (e.g. "Build") — never technology-specific.
  name: string;
  // URL/CLI slug (e.g. "build").
  slug: string;
  description: string;
  // The Zod schema whose PARSED output is I. Typed loosely (ZodTypeAny) because
  // schemas with `.default()` have an input type that differs from I; `execute`
  // below still receives the precise parsed type I.
  inputSchema: z.ZodTypeAny;
  resourceType: ResourceType;
  events: EventType[];
  // Whether the work is long-running (build/test) vs immediate (inspect).
  longRunning: boolean;
  // Whether this Capability needs the Docker daemon (drives a Policy check).
  requiresDocker: boolean;
  execute(input: I, ctx: CapabilityContext): Promise<O>;
}

// What the API returns for a Capability execution.
export interface CapabilityResult {
  capability: string;
  resource: AnyResource | AnyResource[];
}
