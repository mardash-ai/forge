import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { ObservabilityStack } from '../../resources/types';
import { baseResource } from '../_shared';
import { nowIso } from '../../shared/time';
import { probeEndpoint } from '../../plugins/otel-langfuse/index';

const inputSchema = z.object({
  // OTLP endpoint. Defaults to the platform default (langfuse-web internal address).
  endpoint: z
    .string()
    .url()
    .default('http://langfuse-web:3000/api/public/otel')
    .describe('OTLP ingest endpoint exposed by the Langfuse web service'),
  // Langfuse project public key used for OTLP Basic-auth.
  public_key: z
    .string()
    .min(1)
    .describe('Langfuse project public key (from LANGFUSE_PUBLIC_KEY / the bootstrapped key pair)'),
  // Secret key is accepted for the probe but NEVER stored in the Resource or any log.
  secret_key: z
    .string()
    .min(1)
    .describe('Langfuse project secret key — used only for the reachability probe, never stored'),
  // Skip the live connectivity probe (useful for offline/CI registration).
  skip_probe: z.boolean().default(false).describe('Skip the live reachability probe'),
});

type Input = z.infer<typeof inputSchema>;

// SetupObservability (C36) — register the platform's self-hosted Langfuse OTel stack.
//
// Validates that the OTLP endpoint + API keys are present, optionally probes
// the endpoint for reachability, and persists an ObservabilityStack Resource
// so other parts of the platform can discover the configuration.  The secret key
// is NEVER stored — only the public key is written to the Resource.
//
// The Langfuse compose services are in the platform compose.yaml behind the
// "observability" profile; this capability records the configuration once they
// are running.  Consumers import the forge OTel helper (plugins/otel-langfuse)
// and call initOtelLangfuse() — the Resource gives them the endpoint + public key.
export const setupObservability: Capability<Input, ObservabilityStack> = {
  name: 'SetupObservability',
  slug: 'setup-observability',
  description:
    'Register the platform self-hosted Langfuse OTel stack: validate keys, probe endpoint, persist ObservabilityStack resource.',
  inputSchema,
  resourceType: 'ObservabilityStack',
  events: ['ObservabilityConfigured'],
  longRunning: false,
  requiresDocker: false,
  plane: 'both', // control-plane management surface + data-plane runtime reads
  async execute(input, ctx) {
    const checked_at = nowIso();

    // Probe the endpoint for reachability unless the caller opted out.
    let reachable = true;
    if (!input.skip_probe) {
      reachable = await probeEndpoint({
        endpoint: input.endpoint,
        publicKey: input.public_key,
        secretKey: input.secret_key,
      });
    }
    const status: ObservabilityStack['status'] = reachable ? 'configured' : 'unreachable';

    // Upsert: there is at most ONE platform ObservabilityStack.
    const existing = (
      await ctx.store.listResources({ type: 'ObservabilityStack' })
    )[0] as ObservabilityStack | undefined;

    const resource: ObservabilityStack = existing
      ? {
          ...existing,
          endpoint: input.endpoint,
          public_key: input.public_key,
          status,
          checked_at,
          updated_at: nowIso(),
        }
      : {
          ...baseResource('ObservabilityStack'),
          type: 'ObservabilityStack',
          endpoint: input.endpoint,
          public_key: input.public_key,
          status,
          checked_at,
        };

    await ctx.store.saveResource(resource);

    // Emit the fact — carries endpoint + public key only, never the secret.
    await ctx.emit({
      type: 'ObservabilityConfigured',
      resource_type: 'ObservabilityStack',
      resource_id: resource.id,
      data: {
        endpoint: input.endpoint,
        public_key: input.public_key,
        status,
        probe_skipped: input.skip_probe,
      },
    });

    return resource;
  },
};
