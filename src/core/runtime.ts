import type { Actor } from '../shared/domain';
import { store } from '../storage/store';
import { getCapability } from './registry';
import { evaluatePolicies } from '../policies/policies';
import { checkPermission } from '../permissions/permissions';
import { invalidInput, ForgeError } from '../shared/errors';
import type { CapabilityContext, CapabilityResult } from './types';
import type { AnyResource } from '../resources/types';

// The core Capability Runtime. Every Capability execution flows through here:
//
//   validate input -> check Permissions -> evaluate Policies -> execute -> audit
//
// This is the boring, stable center. It knows nothing about Bazel, npm, Docker,
// or any provider — Implementations (in plugins/) do the work.
export async function executeCapability(
  slug: string,
  rawInput: unknown,
  actor: Actor,
): Promise<CapabilityResult> {
  const cap = getCapability(slug);

  // 1. Validate input against the Capability contract.
  const parsed = cap.inputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw invalidInput(`Invalid input for capability "${slug}".`, parsed.error.flatten());
  }
  const input = parsed.data as Record<string, unknown>;

  // 2. Permissions authorize (before any work).
  checkPermission({ actor, capability: cap.name, app_id: input.app_id as string | undefined });

  // 3. Policies govern (platform/framework support, Docker availability).
  await evaluatePolicies({
    capability: cap.name,
    platform: input.platform as string | undefined,
    framework: input.framework as string | undefined,
    requiresDocker: cap.requiresDocker,
  });

  // 4. Execute the Capability. It creates/modifies Resources and emits Events.
  const ctx: CapabilityContext = {
    store,
    actor,
    emit: async (e) => {
      await store.appendEvent({ ...e, actor });
    },
  };

  const resource = await cap.execute(input, ctx);
  return { capability: cap.name, resource: resource as AnyResource | AnyResource[] };
}

export { ForgeError };
