import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { Plan } from '../../resources/types';
import { resolveApp, baseResource } from '../_shared';

const inputSchema = z.object({
  app: z.string().min(1),
  goal: z.string().min(1),
});
type Input = z.infer<typeof inputSchema>;

// Turn a free-text goal into candidate Resource/entity names (very light NLP —
// deterministic, no model call). e.g. "Add projects and tasks" -> [projects, tasks]
function extractEntities(goal: string): string[] {
  const stop = new Set([
    'add', 'create', 'build', 'make', 'implement', 'support', 'to', 'a', 'an', 'the',
    'and', 'for', 'with', 'of', 'in', 'on', 'feature', 'features', 'page', 'pages',
    'forge', 'os', 'app',
  ]);
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
  return Array.from(new Set(words)).slice(0, 4);
}

// GenerateFeaturePlan — translate a Goal into a capability sequence and file
// plan, framed in the Domain Model. This is where Forge differentiates from raw
// Claude: Forge frames the work; Claude executes within that frame.
export const generateFeaturePlan: Capability<Input, Plan> = {
  name: 'GenerateFeaturePlan',
  slug: 'generate-feature-plan',
  description: 'Produce a deterministic Plan (resources, files, capability sequence, validation, risks) for a Goal.',
  inputSchema,
  resourceType: 'Plan',
  events: ['PlanCreated'],
  longRunning: false,
  requiresDocker: false,
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);
    const entities = extractEntities(input.goal);
    const nice = entities.length ? entities : ['feature'];

    const proposed_files = nice.flatMap((e) => [
      `app/${e}/page.tsx`,
      `app/api/${e}/route.ts`,
      `lib/${e}.ts`,
      `tests/${e}.test.ts`,
    ]);

    const resource: Plan = {
      ...baseResource('Plan', app.id),
      type: 'Plan',
      goal: input.goal,
      proposed_resources: nice.map((e) => `${e} (domain entity for ${app.name})`),
      proposed_files,
      capability_sequence: [
        'GenerateFeaturePlan (this)',
        'Lint',
        'Build',
        'Test',
        'Inspect routes',
      ],
      validation_steps: [
        `forge lint --app ${app.name}`,
        `forge build --app ${app.name}`,
        `forge test --app ${app.name}`,
        `forge inspect routes --app ${app.name}`,
      ],
      risks: [
        {
          risk: 'New routes may need data persistence (reprovision with --with-postgres).',
          severity: nice.length > 1 ? 'medium' : 'low',
        },
        { risk: 'Type errors across new modules can fail the build.', severity: 'low' },
      ],
    };
    await ctx.store.saveResource(resource);
    await ctx.emit({
      type: 'PlanCreated',
      resource_type: 'Plan',
      resource_id: resource.id,
      app_id: app.id,
      data: { goal: input.goal, entities: nice },
    });

    return resource;
  },
};
