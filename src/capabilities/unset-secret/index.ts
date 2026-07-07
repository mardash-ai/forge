import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { Secret } from '../../resources/types';
import { resolveApp, baseResource } from '../_shared';
import { nowIso } from '../../shared/time';
import { unsetSecret as revokeSecret, ALGO, IMPLEMENTATION } from '../../plugins/secrets-local/index';

const inputSchema = z.object({
  app: z.string().min(1).describe('Application name'),
  name: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'name must be a valid environment variable name')
    .describe('Secret name to remove, e.g. ANTHROPIC_API_KEY'),
});
type Input = z.infer<typeof inputSchema>;

// UnsetSecret — remove/revoke a named secret for an Application (the C5 SetSecret follow-up). Forge
// deletes the ENCRYPTED entry from the app's vault so the app stops receiving it at run time (its
// next lookup sees the value absent and degrades — e.g. AgentRun returns 503). Idempotent: unsetting
// a secret that isn't set still succeeds. Never reads, logs, echoes, or returns the value.
export const unsetSecretCapability: Capability<Input, Secret> = {
  name: 'UnsetSecret',
  slug: 'unset-secret',
  description: 'Remove/revoke an encrypted secret from an Application\'s vault (idempotent). Never returns the value.',
  inputSchema,
  resourceType: 'Secret',
  events: ['SecretUnset'],
  longRunning: false,
  requiresDocker: false,
  plane: 'both', // control-plane CLI (`forge secrets unset`) + data-plane management, like SetSecret (C5)
  async execute(input, ctx) {
    // 404 not_found for an unknown app; 422 invalid_input for a bad name (both via the runtime).
    const app = await resolveApp(ctx.store, input.app);

    // Remove the encrypted material. Idempotent — `removed` is false when nothing was there.
    const removed = await revokeSecret(app.id, input.name);

    // Retire the Secret Resource metadata too, so listing/inspecting no longer shows it as set.
    const existing = (await ctx.store.listResources({ type: 'Secret', app_id: app.id })).find(
      (r) => (r as Secret).name === input.name,
    ) as Secret | undefined;
    if (existing) await ctx.store.deleteResource('Secret', existing.id);

    // Record the fact (name only — never the value).
    await ctx.emit({
      type: 'SecretUnset',
      resource_type: 'Secret',
      resource_id: existing?.id ?? input.name,
      app_id: app.id,
      data: { name: input.name, removed, implementation: IMPLEMENTATION },
    });

    // Return the retired Secret (status 'unset'). Synthesize one when nothing was set, so an
    // idempotent unset still returns a coherent Resource shape — the value is never involved.
    const resource: Secret = existing
      ? { ...existing, status: 'unset', updated_at: nowIso() }
      : { ...baseResource('Secret', app.id), type: 'Secret', name: input.name, status: 'unset', algo: ALGO };

    return resource;
  },
};
