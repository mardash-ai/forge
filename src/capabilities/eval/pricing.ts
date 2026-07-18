import type { TokenUsage } from './models';

// Per-model list pricing in USD per 1,000,000 tokens (input / output). The dominant eval cost is the
// agent-under-test trajectory plus the LLM-judge call, so accuracy here is what makes the reported
// `cost_usd` meaningful. Update these as vendor prices change — or override WITHOUT a code change via
// the EVAL_PRICING_JSON env var (a JSON map of "provider:model" -> { "in": <num>, "out": <num> }).
export interface ModelPrice {
  in: number;
  out: number;
}

// Sourced from vendor list pricing (2026-07). Keep the judge model priced too — it's a real per-case cost.
const PRICING: Record<string, ModelPrice> = {
  'anthropic:claude-opus-4-8': { in: 5, out: 25 },
  'anthropic:claude-opus-4-7': { in: 5, out: 25 },
  'anthropic:claude-sonnet-5': { in: 3, out: 15 },
  'anthropic:claude-haiku-4-5': { in: 1, out: 5 },
  'openai:gpt-4o': { in: 2.5, out: 10 },
  'openai:gpt-4o-mini': { in: 0.15, out: 0.6 },
};

// Provider fallback when a model isn't in the table — priced at the provider's flagship so a cost is
// never silently zero, and flagged so the caller can mark the figure as an estimate.
const FALLBACK: Record<string, ModelPrice> = {
  anthropic: { in: 5, out: 25 },
  openai: { in: 2.5, out: 10 },
};

function loadOverrides(): Record<string, ModelPrice> {
  const raw = process.env.EVAL_PRICING_JSON;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, { in?: number; out?: number }>;
    const out: Record<string, ModelPrice> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v?.in === 'number' && typeof v?.out === 'number') out[k] = { in: v.in, out: v.out };
    }
    return out;
  } catch {
    return {};
  }
}

export function modelPrice(provider: string, model: string): { price: ModelPrice; known: boolean } {
  const key = `${provider}:${model}`;
  const overrides = loadOverrides();
  if (overrides[key]) return { price: overrides[key]!, known: true };
  if (PRICING[key]) return { price: PRICING[key]!, known: true };
  return { price: FALLBACK[provider] ?? { in: 0, out: 0 }, known: false };
}

/** USD cost of one token-usage total for a given model. `estimated` is true when the model isn't in
 * the pricing table (priced at the provider fallback), so the caller can flag the number. */
export function priceUsd(
  provider: string,
  model: string,
  usage: TokenUsage,
): { cost: number; estimated: boolean } {
  const { price, known } = modelPrice(provider, model);
  const cost = (usage.inputTokens / 1_000_000) * price.in + (usage.outputTokens / 1_000_000) * price.out;
  return { cost: Number(cost.toFixed(6)), estimated: !known };
}

/** Sum two usage totals (agent trajectory + judge call, or across cases). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}
