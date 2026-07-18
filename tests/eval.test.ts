import { describe, it, expect } from 'vitest';
import { runAgent } from '../src/capabilities/eval/models';
import { gradeDeterministic, dimensionAverage } from '../src/capabilities/eval/graders';
import { suiteSchema } from '../src/capabilities/eval/suite';
import { resolveLangfuse } from '../src/capabilities/eval/report';
import { mcpClient } from '../src/capabilities/eval/mcp-client';
import type { Trajectory } from '../src/capabilities/eval/models';
import type { EvalCase } from '../src/capabilities/eval/suite';

// C30 — offline unit tests for the eval harness. The model calls, MCP transport, and Langfuse
// reporting all take an injected `fetch`, so the whole loop is exercised with zero network.

const jsonRes = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response);

const trackResult = {
  content: [{ type: 'text', text: 'Created delegation d1' }],
  structuredContent: { id: 'd1', status: 'inbox', delegation: { request: 'the Q3 budget from Dana' } },
};

// ── the model tool-loop (Claude + GPT) ───────────────────────────────────────

describe('runAgent — Anthropic (Claude) tool-loop', () => {
  it('calls a tool, feeds the result back, then finishes — capturing the trajectory', async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      return call === 1
        ? jsonRes({ content: [{ type: 'tool_use', id: 't1', name: 'track', input: { request: 'the Q3 budget from Dana' } }], stop_reason: 'tool_use' })
        : jsonRes({ content: [{ type: 'text', text: 'Done — I tracked it.' }], stop_reason: 'end_turn' });
    }) as unknown as typeof fetch;
    const seen: Array<{ name: string; args: unknown }> = [];
    const traj = await runAgent({
      provider: 'anthropic', apiKey: 'k', model: 'claude-x', system: 's', prompt: 'track the Q3 budget',
      tools: [{ name: 'track', description: 'track', inputSchema: { type: 'object' } }],
      callTool: async (name, args) => { seen.push({ name, args }); return { ok: true, result: trackResult }; },
      fetchImpl,
    });
    expect(traj.error).toBeUndefined();
    expect(traj.toolCalls).toHaveLength(1);
    expect(traj.toolCalls[0]!.name).toBe('track');
    expect(traj.toolCalls[0]!.args).toEqual({ request: 'the Q3 budget from Dana' });
    expect(traj.finalText).toContain('Done');
    expect(seen).toHaveLength(1);
  });

  it('captures a provider HTTP error in trajectory.error (never throws)', async () => {
    const fetchImpl = (async () => jsonRes({ error: { message: 'overloaded' } }, false, 529)) as unknown as typeof fetch;
    const traj = await runAgent({
      provider: 'anthropic', apiKey: 'k', model: 'claude-x', system: 's', prompt: 'x', tools: [],
      callTool: async () => ({ ok: true, result: {} }), fetchImpl,
    });
    expect(traj.error).toContain('anthropic HTTP 529');
    expect(traj.toolCalls).toHaveLength(0);
  });
});

describe('runAgent — OpenAI (GPT) tool-loop', () => {
  it('calls a function tool, feeds the result back, then finishes', async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      return call === 1
        ? jsonRes({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'track', arguments: '{"request":"the Q3 budget from Dana"}' } }] } }] })
        : jsonRes({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Tracked it for you.' } }] });
    }) as unknown as typeof fetch;
    const traj = await runAgent({
      provider: 'openai', apiKey: 'k', model: 'gpt-x', system: 's', prompt: 'track the Q3 budget',
      tools: [{ name: 'track', description: 'track', inputSchema: { type: 'object' } }],
      callTool: async () => ({ ok: true, result: trackResult }), fetchImpl,
    });
    expect(traj.error).toBeUndefined();
    expect(traj.toolCalls).toHaveLength(1);
    expect(traj.toolCalls[0]!.args).toEqual({ request: 'the Q3 budget from Dana' });
    expect(traj.finalText).toContain('Tracked it');
  });
});

// ── deterministic grader ─────────────────────────────────────────────────────

const caseOf = (asserts: EvalCase['asserts']): EvalCase => ({
  id: 'c', prompt: 'p', asserts, dimensions: ['grounding'],
});
const trajOf = (toolCalls: Trajectory['toolCalls'], finalText = ''): Trajectory => ({
  provider: 'anthropic', model: 'm', toolCalls, finalText, steps: 1, usage: { inputTokens: 0, outputTokens: 0 },
});

describe('gradeDeterministic', () => {
  it('passes when the expected tool ran with the right structured status + arg substring', () => {
    const traj = trajOf([{ name: 'track', args: { request: 'the Q3 budget from Dana' }, ok: true, result: trackResult }], 'Tracked it.');
    const r = gradeDeterministic(traj, caseOf({ tool_called: 'track', structured_contains: { status: 'inbox' }, args_contains: { request: 'Q3 budget' }, final_text_contains: ['tracked'] }));
    expect(r.passed).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it('fails when the expected tool was not called', () => {
    const r = gradeDeterministic(trajOf([]), caseOf({ tool_called: 'track', structured_contains: { status: 'inbox' } }));
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.name.startsWith('tool_called'))?.ok).toBe(false);
  });

  it('fails when the structured status differs', () => {
    const traj = trajOf([{ name: 'track', args: {}, ok: true, result: { structuredContent: { status: 'done' } } }]);
    const r = gradeDeterministic(traj, caseOf({ tool_called: 'track', structured_contains: { status: 'inbox' } }));
    expect(r.passed).toBe(false);
  });

  it('empty asserts ⇒ passes vacuously', () => {
    expect(gradeDeterministic(trajOf([]), caseOf({})).passed).toBe(true);
  });
});

describe('dimensionAverage', () => {
  it('averages scores, empty ⇒ 0', () => {
    expect(dimensionAverage([{ name: 'a', score: 1, reason: '' }, { name: 'b', score: 0.5, reason: '' }])).toBeCloseTo(0.75);
    expect(dimensionAverage([])).toBe(0);
  });
});

// ── suite schema ─────────────────────────────────────────────────────────────

describe('suiteSchema', () => {
  it('parses a minimal suite + applies defaults', () => {
    const s = suiteSchema.parse({ name: 'track_something_new', cases: [{ id: 'basic', prompt: 'Track the Q3 budget from Dana.' }] });
    expect(s.threshold).toBe(0.7);
    expect(s.cases[0]!.dimensions).toContain('tool_selection');
    expect(s.cases[0]!.asserts).toEqual({});
  });
  it('rejects a suite with no cases', () => {
    expect(() => suiteSchema.parse({ name: 'x', cases: [] })).toThrow();
  });
});

// ── Langfuse config resolution ───────────────────────────────────────────────

describe('resolveLangfuse', () => {
  it('returns null when keys are absent', () => {
    expect(resolveLangfuse({ baseUrl: 'https://x', publicKey: '', secretKey: '' })).toBeNull();
  });
  it('strips the OTLP suffix to derive the host base', () => {
    const cfg = resolveLangfuse({ baseUrl: 'https://monitor.dorinda.ai/api/public/otel', publicKey: 'pk', secretKey: 'sk' });
    expect(cfg?.baseUrl).toBe('https://monitor.dorinda.ai');
  });
});

// ── MCP client (JSON-RPC over injected fetch) ────────────────────────────────

describe('mcpClient', () => {
  it('lists tools and dispatches tools/call with the bearer + X-Forge-App', async () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const method = (JSON.parse(init.body) as { method: string }).method;
      if (method === 'tools/list') return jsonRes({ result: { tools: [{ name: 'track', description: 'd', inputSchema: { type: 'object' } }] } });
      return jsonRes({ result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { id: 'd1', status: 'inbox' } } });
    }) as unknown as typeof fetch;

    const client = mcpClient({ mcpUrl: 'https://api.dorinda.ai/mcp', appName: 'dorinda-api', token: 'tok', fetchImpl });
    const tools = await client.listTools();
    expect(tools).toEqual([{ name: 'track', description: 'd', inputSchema: { type: 'object' } }]);
    const r = await client.callTool('track', { request: 'x' });
    expect(r.ok).toBe(true);
    expect(seen[0]!.headers.authorization).toBe('Bearer tok');
    expect(seen[0]!.headers['X-Forge-App']).toBe('dorinda-api');
  });

  it('marks a tool result with isError as not-ok', async () => {
    const fetchImpl = (async () => jsonRes({ result: { isError: true, content: [{ type: 'text', text: 'subscription_required' }] } })) as unknown as typeof fetch;
    const client = mcpClient({ mcpUrl: 'u', appName: 'a', token: 't', fetchImpl });
    const r = await client.callTool('track', {});
    expect(r.ok).toBe(false);
  });
});
