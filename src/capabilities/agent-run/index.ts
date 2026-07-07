import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { AgentTask, Artifact } from '../../resources/types';
import { resolveApp, baseResource } from '../_shared';
import { invalidInput, dependencyUnavailable } from '../../shared/errors';
import {
  IMPLEMENTATION,
  DEFAULT_MODEL,
  MODEL_KEY,
  resolveModelKey,
  getModelInvoker,
} from '../../plugins/model-anthropic/index';

const inputSchema = z.object({
  // The Application NAME. Optional: defaults to the runtime's own app (data-plane:
  // FORGE_APP_NAME), so the running app usually needn't pass it, like C3/C4.
  app: z.string().min(1).optional(),
  // Owner (C11) — the opaque per-user id (C10's session `userId`) this run belongs to. Optional:
  // omit for an app-scoped run. When set, the AgentTask + its Artifact carry it, so a per-user
  // query (`/resources?type=AgentTask&owner=…`, `inspect agent-runs --owner …`) returns ONLY that
  // user's runs — user A can never read user B's runs/artifacts.
  owner: z.string().min(1).optional().describe('Opaque per-user owner id (C10 session userId)'),
  // Free-form label/kind for this run (e.g. "planner"). Generic — NOT a Forge Capability;
  // the consumer owns what the label means.
  capability: z.string().min(1).describe('Free-form label/kind for this run, e.g. "planner"'),
  system: z.string().min(1).describe('System prompt'),
  input: z
    .union([z.string(), z.record(z.unknown()), z.array(z.unknown())])
    .describe('User input passed to the model'),
  schema: z.record(z.unknown()).describe('JSON Schema the output must conform to (structured output)'),
  model: z.string().min(1).optional().describe('Model id; defaults to a current Claude model'),
  max_tokens: z.number().int().positive().max(64000).optional(),
});
type Input = z.infer<typeof inputSchema>;

const DEFAULT_MAX_TOKENS = 4096;

// AgentRun (C1) — the platform agent runtime. Invokes a model with a system prompt + user
// input + an ENFORCED output schema and returns the parsed structured result, persisting EVERY
// run (success AND failure) as a durable, inspectable AgentTask whose result is an Artifact.
// Behavior lives in the model-anthropic Implementation; this Capability is the stable contract.
// Generic by construction: no goal/task/planner domain concepts — just model-invocation-with-
// schema + run/artifact persistence.
export const agentRun: Capability<Input, AgentTask> = {
  name: 'AgentRun',
  slug: 'agent-run',
  description:
    'Invoke a model with a system prompt + input + enforced output schema; return the parsed result and persist the run (AgentTask) and its result (Artifact).',
  inputSchema,
  resourceType: 'AgentTask',
  events: ['AgentRunSucceeded', 'AgentRunFailed', 'ArtifactCreated'],
  longRunning: false,
  requiresDocker: false,
  plane: 'data', // the running app invokes the model at runtime (data plane); control plane inspects
  async execute(input, ctx) {
    const appName = input.app ?? process.env.FORGE_APP_NAME;
    if (!appName) {
      throw invalidInput('unknown app (pass `app` or set FORGE_APP_NAME).', { field: 'app' });
    }
    const app = await resolveApp(ctx.store, appName);
    const model = input.model ?? DEFAULT_MODEL;
    const maxTokens = input.max_tokens ?? DEFAULT_MAX_TOKENS;

    // (4) Detectable absence -> graceful degradation. When model access is unconfigured, fail
    // with a 503 dependency_unavailable ForgeError (NOT an unhandled throw) so the consuming app
    // can return 503 and never crash. No run is persisted — there was no model invocation.
    const apiKey = await resolveModelKey(app.id);
    if (!apiKey) {
      throw dependencyUnavailable(
        `Model access is unconfigured: no ${MODEL_KEY} for app "${app.name}". Set it: forge secrets set --app ${app.name} --name ${MODEL_KEY} --from-env`,
        { app: app.name, secret: MODEL_KEY, capability: 'AgentRun' },
      );
    }

    // Pre-allocate the AgentTask envelope so its id can be the Artifact's producer ref. The C11
    // `owner` rides on the envelope, so BOTH the failed and succeeded task carry it (and the
    // Artifact below), making every persisted run owner-scoped.
    const base = { ...baseResource('AgentTask', app.id), owner: input.owner };

    // (1)(3) Invoke the model with system + input + enforced schema; get the PARSED result. The
    // output is untrusted — we return it for the consumer to post-validate, we do not act on it.
    let result: unknown;
    try {
      result = await getModelInvoker()({
        apiKey,
        model,
        system: input.system,
        input: input.input,
        schema: input.schema,
        maxTokens,
      });
    } catch (err) {
      // (2) Persist the FAILED run — a model/API error or output that didn't conform to the
      // schema. Inspectable, survives restart. No Artifact is produced.
      const failed: AgentTask = {
        ...base,
        type: 'AgentTask',
        label: input.capability,
        status: 'failed',
        model,
        artifact: null,
        error: String((err as Error)?.message ?? err),
        implementation: IMPLEMENTATION,
      };
      await ctx.store.saveResource(failed);
      await ctx.emit({
        type: 'AgentRunFailed',
        resource_type: 'AgentTask',
        resource_id: failed.id,
        app_id: app.id,
        data: { label: input.capability, model, error: failed.error },
      });
      return failed;
    }

    // Success — persist the Artifact (first-class, inspectable RESULT) then the AgentTask that
    // references it. The AgentTask also carries the result inline, so a single response gives the
    // consumer the parsed result without a second fetch.
    const artifact: Artifact = {
      ...baseResource('Artifact', app.id),
      owner: input.owner,
      type: 'Artifact',
      kind: input.capability,
      produced_by: base.id,
      model,
      result,
      schema: input.schema,
    };
    await ctx.store.saveResource(artifact);
    await ctx.emit({
      type: 'ArtifactCreated',
      resource_type: 'Artifact',
      resource_id: artifact.id,
      app_id: app.id,
      data: { kind: input.capability, produced_by: base.id, model },
    });

    const task: AgentTask = {
      ...base,
      type: 'AgentTask',
      label: input.capability,
      status: 'succeeded',
      model,
      artifact_id: artifact.id,
      artifact: result,
      implementation: IMPLEMENTATION,
    };
    await ctx.store.saveResource(task);
    await ctx.emit({
      type: 'AgentRunSucceeded',
      resource_type: 'AgentTask',
      resource_id: task.id,
      app_id: app.id,
      data: { label: input.capability, model, artifact_id: artifact.id },
    });

    return task;
  },
};
