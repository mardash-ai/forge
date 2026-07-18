import { describe, it, expect, afterEach } from 'vitest';
import { priceUsd, modelPrice, addUsage } from '../src/capabilities/eval/pricing';
import { runAgent } from '../src/capabilities/eval/models';

// C30 cost recording: token usage flows out of the tool-loop, gets priced per model, and rolls up to
// a per-run cost. These tests pin the pricing math + that both providers' `usage` is actually captured.

describe('pricing', () => {
  afterEach(() => {
    delete process.env.EVAL_PRICING_JSON;
  });

  it('prices a known model from the table (opus-4-8 = $5/$25 per 1M)', () => {
    const { cost, estimated } = priceUsd('anthropic', 'claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(30, 6); // 5 + 25
    expect(estimated).toBe(false);
  });

  it('prices gpt-4o at $2.50/$10 per 1M', () => {
    const { cost } = priceUsd('openai', 'gpt-4o', { inputTokens: 2_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(2.5 * 2 + 10, 6); // 15
  });

  it('falls back to the provider flagship for an unknown model and flags it estimated', () => {
    const { cost, estimated } = priceUsd('anthropic', 'claude-some-future-model', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(cost).toBeCloseTo(5, 6); // anthropic fallback input price
    expect(estimated).toBe(true);
  });

  it('honors an EVAL_PRICING_JSON override without a code change', () => {
    process.env.EVAL_PRICING_JSON = JSON.stringify({ 'openai:gpt-4o': { in: 1, out: 2 } });
    const { price, known } = modelPrice('openai', 'gpt-4o');
    expect(price).toEqual({ in: 1, out: 2 });
    expect(known).toBe(true);
  });

  it('sums usage totals', () => {
    expect(addUsage({ inputTokens: 10, outputTokens: 3 }, { inputTokens: 5, outputTokens: 7 })).toEqual({
      inputTokens: 15,
      outputTokens: 10,
    });
  });
});

// A fetch fake that returns a fixed sequence of JSON bodies, so we can drive the tool-loop offline.
function fakeFetch(bodies: unknown[]): typeof fetch {
  let i = 0;
  return (async () => {
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

describe('usage capture in the tool-loop', () => {
  it('sums Anthropic usage across every model round-trip', async () => {
    const traj = await runAgent({
      provider: 'anthropic', apiKey: 'k', model: 'claude-opus-4-8', system: 's', prompt: 'p', tools: [],
      callTool: async () => ({ ok: true, result: {} }),
      fetchImpl: fakeFetch([
        // step 1: a tool_use turn (usage billed) ...
        { stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20 },
          content: [{ type: 'tool_use', id: 't1', name: 'whats_next', input: {} }] },
        // step 2: final turn (more usage) — history is re-sent, so input is re-charged
        { stop_reason: 'end_turn', usage: { input_tokens: 150, output_tokens: 30 },
          content: [{ type: 'text', text: 'done' }] },
      ]),
    });
    expect(traj.usage).toEqual({ inputTokens: 250, outputTokens: 50 });
    expect(traj.error).toBeUndefined();
  });

  it('sums OpenAI usage (prompt/completion tokens)', async () => {
    const traj = await runAgent({
      provider: 'openai', apiKey: 'k', model: 'gpt-4o', system: 's', prompt: 'p', tools: [],
      callTool: async () => ({ ok: true, result: {} }),
      fetchImpl: fakeFetch([
        { usage: { prompt_tokens: 200, completion_tokens: 40 },
          choices: [{ finish_reason: 'stop', message: { content: 'done', tool_calls: [] } }] },
      ]),
    });
    expect(traj.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
  });
});
