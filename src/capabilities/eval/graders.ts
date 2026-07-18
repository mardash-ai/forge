// Graders for the eval harness (C30): deterministic asserts (the load-bearing, reproducible checks)
// + an LLM-judge that scores per-dimension quality. A case PASSES only when every deterministic
// assert holds AND the judge's dimension average clears the suite threshold.

import { invokeStructured } from '../../plugins/model-anthropic/index';
import type { Trajectory, ToolInvocation, TokenUsage } from './models';
import type { EvalCase } from './suite';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
export interface DeterministicResult {
  passed: boolean;
  checks: Check[];
}
export interface DimensionScore {
  name: string;
  score: number; // 0..1
  reason: string;
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

function structuredContent(tc: ToolInvocation | undefined): Record<string, unknown> {
  const sc = (tc?.result as { structuredContent?: Record<string, unknown> })?.structuredContent ?? {};
  // The forge transport double-wraps: the app returns a full McpToolResult ({content, structuredContent}),
  // which the transport sets as the OUTER structuredContent. Unwrap to the inner structured object so
  // asserts target the app's real structured payload (e.g. { id, status, delegation }).
  const inner = (sc as { structuredContent?: Record<string, unknown> }).structuredContent;
  return inner && typeof inner === 'object' ? inner : sc;
}

/** Run the case's deterministic asserts against the trajectory. Pure + synchronous. */
export function gradeDeterministic(traj: Trajectory, c: EvalCase): DeterministicResult {
  const checks: Check[] = [];
  const a = c.asserts;

  let matched: ToolInvocation | undefined;
  if (a.tool_called) {
    matched = traj.toolCalls.find((t) => t.name === a.tool_called);
    const called = traj.toolCalls.map((t) => t.name).join(', ') || 'none';
    checks.push({ name: `tool_called:${a.tool_called}`, ok: Boolean(matched), detail: matched ? 'called' : `not called (called: ${called})` });
  }
  if (a.structured_contains) {
    const sc = structuredContent(matched);
    for (const [k, v] of Object.entries(a.structured_contains)) {
      const ok = eq(sc[k], v);
      checks.push({ name: `structured.${k}`, ok, detail: ok ? 'match' : `got ${JSON.stringify(sc[k])}, want ${JSON.stringify(v)}` });
    }
  }
  if (a.args_contains && matched) {
    for (const [k, v] of Object.entries(a.args_contains)) {
      const got = matched.args[k];
      const ok = typeof v === 'string' ? String(got ?? '').toLowerCase().includes(v.toLowerCase()) : eq(got, v);
      checks.push({ name: `args.${k}`, ok, detail: ok ? 'match' : `got ${JSON.stringify(got)}, want ${JSON.stringify(v)}` });
    }
  } else if (a.args_contains && !matched) {
    checks.push({ name: 'args_contains', ok: false, detail: 'expected tool was not called, so args cannot match' });
  }
  if (a.final_text_contains) {
    const text = traj.finalText.toLowerCase();
    for (const s of a.final_text_contains) {
      const ok = text.includes(s.toLowerCase());
      checks.push({ name: `final_text~"${s}"`, ok, detail: ok ? 'found' : 'missing' });
    }
  }
  return { passed: checks.length === 0 ? true : checks.every((c) => c.ok), checks };
}

// ── LLM-judge ────────────────────────────────────────────────────────────────

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          score: { type: 'number', description: '0.0 (fails the dimension) to 1.0 (ideal)' },
          reason: { type: 'string', description: 'one concise sentence justifying the score' },
        },
        required: ['name', 'score', 'reason'],
      },
    },
  },
  required: ['dimensions'],
} as const;

function summarizeResult(result: unknown): unknown {
  const r = result as { structuredContent?: unknown; content?: Array<{ text?: string }> } | null;
  if (r?.structuredContent !== undefined) return r.structuredContent;
  const text = Array.isArray(r?.content) ? r!.content.find((c) => c?.text)?.text : undefined;
  return text ?? result;
}

/** Score the trajectory on the case's dimensions with an LLM judge (Claude, via forge's structured
 * invoker). Never throws — a judge failure returns zeroed dimensions with the error as the reason,
 * so a flaky judge fails the case loudly rather than crashing the run. */
export async function gradeJudge(opts: {
  apiKey: string;
  model?: string;
  case: EvalCase;
  trajectory: Trajectory;
  invoke?: typeof invokeStructured;
  /** Called with the judge call's token usage so the run cost can include it. */
  onUsage?: (usage: TokenUsage) => void;
}): Promise<DimensionScore[]> {
  const invoke = opts.invoke ?? invokeStructured;
  const system =
    `You are a rigorous evaluator of an AI assistant that operates a user's personal-assistant tools over MCP. ` +
    `Given the user's request and the assistant's full trajectory (the tool calls it made, their arguments and results, and its final reply), ` +
    `score EACH of these dimensions from 0.0 (fails) to 1.0 (ideal): ${opts.case.dimensions.join(', ')}. ` +
    `Be strict and specific; a correct tool call with the right arguments and a grounded, appropriately-scoped reply is 1.0. Return one object per dimension.`;
  const input = {
    user_request: opts.case.prompt,
    dimensions: opts.case.dimensions,
    trajectory: {
      tool_calls: opts.trajectory.toolCalls.map((t) => ({ name: t.name, arguments: t.args, ok: t.ok, result: summarizeResult(t.result) })),
      final_reply: opts.trajectory.finalText,
      loop_error: opts.trajectory.error ?? null,
    },
  };
  try {
    const out = await invoke({ apiKey: opts.apiKey, model: opts.model ?? 'claude-opus-4-8', system, input, schema: JUDGE_SCHEMA, maxTokens: 1024, onUsage: opts.onUsage });
    const dims = (out as { dimensions?: Array<{ name?: unknown; score?: unknown; reason?: unknown }> })?.dimensions ?? [];
    const byName = new Map(dims.map((d) => [String(d.name), d]));
    // Return exactly the requested dimensions, in order (defensive against a judge that drops/renames one).
    return opts.case.dimensions.map((name) => {
      const d = byName.get(name);
      return { name, score: clamp01(Number(d?.score)), reason: d?.reason ? String(d.reason) : 'no score returned' };
    });
  } catch (e) {
    return opts.case.dimensions.map((name) => ({ name, score: 0, reason: `judge failed: ${(e as Error)?.message ?? String(e)}` }));
  }
}

export function dimensionAverage(scores: DimensionScore[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((s, d) => s + d.score, 0) / scores.length;
}
