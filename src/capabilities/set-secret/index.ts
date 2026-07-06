import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { Secret } from '../../resources/types';
import { resolveApp, baseResource } from '../_shared';
import { nowIso } from '../../shared/time';
import { setSecret as sealSecret, ALGO, IMPLEMENTATION } from '../../plugins/secrets-local/index';

const inputSchema = z.object({
  app: z.string().min(1).describe('Application name'),
  name: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'name must be a valid environment variable name')
    .describe('Secret name, e.g. ANTHROPIC_API_KEY'),
  value: z.string().min(1).describe('Secret value — stored encrypted; never logged, echoed, or returned'),
});
type Input = z.infer<typeof inputSchema>;

// SetSecret — declare and set a named secret for an Application. Forge stores the
// value ENCRYPTED (secrets-local Implementation) and injects it into the app's
// runtime at run time; it never lands in source, a compose file, or an image
// layer. The Secret Resource records only that the secret is set — never its
// material — so listing/inspecting secrets can never leak a value.
export const setSecretCapability: Capability<Input, Secret> = {
  name: 'SetSecret',
  slug: 'set-secret',
  description: 'Store an encrypted secret (e.g. an API key) for an Application; injected into its runtime, never persisted in source.',
  inputSchema,
  resourceType: 'Secret',
  events: ['SecretSet'],
  longRunning: false,
  requiresDocker: false,
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);

    // Encrypt + persist the material via the secrets backend — never in the Resource.
    await sealSecret(app.id, input.name, input.value);

    // Upsert the Secret Resource (metadata only: the name + that it is set).
    const existing = (await ctx.store.listResources({ type: 'Secret', app_id: app.id })).find(
      (r) => (r as Secret).name === input.name,
    ) as Secret | undefined;

    const resource: Secret = existing
      ? { ...existing, status: 'set', algo: ALGO, updated_at: nowIso() }
      : { ...baseResource('Secret', app.id), type: 'Secret', name: input.name, status: 'set', algo: ALGO };

    await ctx.store.saveResource(resource);

    // The fact carries the NAME only — never the value.
    await ctx.emit({
      type: 'SecretSet',
      resource_type: 'Secret',
      resource_id: resource.id,
      app_id: app.id,
      data: { name: input.name, implementation: IMPLEMENTATION },
    });

    return resource;
  },
};
