import { z } from 'zod';
import type { Capability } from '../../core/types';
import type { EvalRun, EvalCaseResult } from '../../resources/types';
import { resolveApp, baseResource } from '../_shared';
import { nowIso } from '../../shared/time';
import { resolveModelKey } from '../../plugins/model-anthropic/index';
import { readSecrets } from '../../plugins/secrets-local/index';
import { suiteSchema } from './suite';
import { runAgent } from './models';
import { seedEvalTenant, provisionTenantGroup } from './seed';
import { mintAccessToken, mcpClient } from './mcp-client';
import { gradeDeterministic, gradeJudge, dimensionAverage } from './graders';
import { resolveLangfuse, makeReporter } from './report';

// Eval (C30) — the generic AI-eval runner. Drives a REAL model (Claude / GPT) as an MCP client
// through the app's live tool surface, grades the trajectory (deterministic asserts + LLM-judge),
// and writes a Langfuse dataset run. Control-plane; long-running. The agent-under-test is the model
// API as a faithful MCP client (real connector UIs can't be scripted in CI). Eval tenants are
// throwaway + subscription-seeded so write tools don't 402; the whole path traces through C36.

const modelSchema = z.object({ provider: z.enum(['anthropic', 'openai']), model: z.string() });

const inputSchema = z.object({
  // The forge app whose MCP surface to drive.
  app: z.string(),
  // The parsed suite object (the CLI loads the suite FILE and passes it here) — validated below.
  suite: z.unknown(),
  // The app's MCP endpoint the eval client POSTs JSON-RPC to (e.g. https://api.dorinda.ai/mcp).
  mcp_url: z.string(),
  // Agents-under-test. Default: Claude + GPT (both from day one).
  models: z
    .array(modelSchema)
    .default([
      { provider: 'anthropic', model: 'claude-opus-4-8' },
      { provider: 'openai', model: 'gpt-4o' },
    ]),
  // The judge model (Claude, via forge's structured invoker).
  judge_model: z.string().default('claude-opus-4-8'),
  // Optional override of the run name (defaults to suite + timestamp) + Langfuse config.
  run_name: z.string().optional(),
  langfuse: z
    .object({ baseUrl: z.string().optional(), publicKey: z.string().optional(), secretKey: z.string().optional() })
    .partial()
    .optional(),
});

type Input = z.infer<typeof inputSchema>;

const AGENT_SYSTEM =
  "You are the user's personal assistant, operating their own tools on their behalf. Use the available tools to fulfil the user's request directly and completely; do not ask for confirmation when the request is clear.";

// Opt-in eval-tenant membership provisioning (app-specific). When the app gates write tools on the
// platform membership graph (like dorinda-api's C29), set EVAL_APP_DB_URL so the harness warms up the
// tenant's local group-of-one then ensures it with the platform. Unset ⇒ skipped (generic apps).
const APP_DB_URL = process.env.EVAL_APP_DB_URL;
const WARMUP_TOOL = process.env.EVAL_WARMUP_TOOL || 'whats_next';

async function resolveOpenaiKey(appId: string): Promise<string | null> {
  try {
    const s = await readSecrets(appId);
    if (s.OPENAI_API_KEY?.trim()) return s.OPENAI_API_KEY.trim();
  } catch {
    /* vault unreadable → env */
  }
  return process.env.OPENAI_API_KEY?.trim() || null;
}

export const evalCapability: Capability<Input, EvalRun> = {
  name: 'Eval',
  slug: 'eval',
  description:
    "Run an eval suite: drive a real model (Claude/GPT) as an MCP client against the app's tools, grade the trajectory (deterministic asserts + LLM-judge), and report a Langfuse dataset run.",
  inputSchema,
  resourceType: 'EvalRun',
  events: ['EvalRunCompleted'],
  longRunning: true,
  requiresDocker: false,
  plane: 'control',
  async execute(input, ctx) {
    const app = await resolveApp(ctx.store, input.app);
    const appId = app.id!;
    const suite = suiteSchema.parse(input.suite);
    const runName = input.run_name ?? `${suite.name}-${nowIso().replace(/[:.]/g, '-')}`;

    // Keys: Claude drives + judges (via forge's C1 resolver, vault→env); GPT via OPENAI_API_KEY.
    const anthropicKey = await resolveModelKey(appId);
    const openaiKey = await resolveOpenaiKey(appId);
    if (!anthropicKey) throw new Error('eval needs ANTHROPIC_API_KEY (the LLM-judge runs on Claude) — set it in the vault or env.');

    // Best-effort Langfuse reporting (the eval still runs + returns results if Langfuse is absent).
    const lf = resolveLangfuse(input.langfuse);
    const reporter = lf ? makeReporter(lf) : null;
    if (reporter) await reporter.ensureDataset(suite.name, suite.description);

    const results: EvalCaseResult[] = [];

    for (const m of input.models) {
      const modelLabel = `${m.provider}:${m.model}`;
      const key = m.provider === 'anthropic' ? anthropicKey : openaiKey;
      if (!key) {
        for (const c of suite.cases) {
          results.push({ model: modelLabel, case_id: c.id, passed: false, deterministic_passed: false, dimension_avg: 0, trace_id: '', note: `skipped: no API key for ${m.provider}` });
        }
        continue;
      }

      for (const c of suite.cases) {
        const itemId = `${suite.name}:${c.id}`;
        const traceId = reporter?.newTraceId() ?? '';
        if (reporter) await reporter.ensureItem(suite.name, itemId, { prompt: c.prompt }, { asserts: c.asserts });

        // Isolated tenant → minted MCP token → drive the model through the real transport.
        const tenant = await seedEvalTenant(appId, { suite: suite.name, caseId: c.id, runId: runName });
        const token = await mintAccessToken(appId, tenant.ownerId);
        const client = mcpClient({ mcpUrl: input.mcp_url, appName: app.name, token });
        // Provision the tenant's platform membership (opt-in) so write tools aren't denied
        // 'not-a-member': warm up the local group-of-one with a read, then ensure it with the platform.
        if (APP_DB_URL) {
          await client.callTool(WARMUP_TOOL, {}).catch(() => undefined);
          await provisionTenantGroup(appId, tenant.ownerId, APP_DB_URL).catch(() => null);
        }
        const tools = await client.listTools();
        const trajectory = await runAgent({
          provider: m.provider, apiKey: key, model: m.model, system: AGENT_SYSTEM, prompt: c.prompt,
          tools, callTool: (name, args) => client.callTool(name, args),
        });

        // Grade.
        const det = gradeDeterministic(trajectory, c);
        const dims = await gradeJudge({ apiKey: anthropicKey, model: input.judge_model, case: c, trajectory });
        const avg = dimensionAverage(dims);
        const passed = det.passed && avg >= suite.threshold && !trajectory.error;
        const note = trajectory.error
          ? `loop error: ${trajectory.error}`
          : det.passed
            ? `dims avg ${avg.toFixed(2)}`
            : `failed: ${det.checks.find((x) => !x.ok)?.name ?? 'assert'}`;
        results.push({ model: modelLabel, case_id: c.id, passed, deterministic_passed: det.passed, dimension_avg: avg, trace_id: traceId, note });

        // Report (best-effort).
        if (reporter && traceId) {
          await reporter.createTrace(
            traceId, `eval:${suite.name}/${c.id}/${m.provider}`,
            { prompt: c.prompt },
            { final_reply: trajectory.finalText, tool_calls: trajectory.toolCalls.map((t) => ({ name: t.name, args: t.args, ok: t.ok, result: t.result })) },
            { model: modelLabel, deterministic: det, loop_error: trajectory.error ?? null },
          );
          await reporter.score(traceId, 'passed', passed ? 1 : 0, 'BOOLEAN');
          await reporter.score(traceId, 'deterministic', det.passed ? 1 : 0, 'BOOLEAN');
          for (const d of dims) await reporter.score(traceId, `dim.${d.name}`, d.score, 'NUMERIC', d.reason);
          await reporter.linkRun(runName, itemId, traceId, { model: modelLabel, passed });
        }
      }
    }

    const passedCount = results.filter((r) => r.passed).length;
    const resource: EvalRun = {
      ...baseResource('EvalRun', appId),
      type: 'EvalRun',
      suite: suite.name,
      app_name: app.name,
      models: input.models.map((m) => `${m.provider}:${m.model}`),
      dataset: suite.name,
      run_name: runName,
      passed: results.length > 0 && passedCount === results.length,
      total: results.length,
      passed_count: passedCount,
      results,
      finished_at: nowIso(),
    };
    await ctx.store.saveResource(resource);
    await ctx.emit({
      type: 'EvalRunCompleted', resource_type: 'EvalRun', resource_id: resource.id, app_id: appId,
      data: { suite: suite.name, run_name: runName, passed: resource.passed, passed_count: passedCount, total: results.length },
    });
    return resource;
  },
};
