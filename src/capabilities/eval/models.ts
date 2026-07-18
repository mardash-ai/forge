// Provider-agnostic agent tool-loop for the eval harness (C30).
//
// Drives a REAL model as an MCP client: given the app's tool surface + a `callTool` fn (which
// POSTs a JSON-RPC `tools/call` to the forge MCP transport), it runs the model's native tool-use
// loop and returns the full trajectory. Two providers, ONE contract:
//   - Anthropic (Claude) via the Messages API   (tools + `stop_reason: 'tool_use'`)
//   - OpenAI   (GPT)    via Chat Completions      (tools + `finish_reason: 'tool_calls'`)
// Native `fetch`, no SDKs — the slim data-plane image stays dependency-clean (same rule as
// model-anthropic C1). The agent-under-test is the model API as a faithful MCP client: the real
// ChatGPT/Claude connector UIs can't be scripted in CI, so this is the honest proxy.

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_API_VERSION = '2023-06-01';
export const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

export interface EvalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolInvocation {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result: unknown;
}

export interface TokenUsage {
  /** Summed across every model↔tool round-trip. Each step re-sends the growing history, so this is
   * the REAL billed input (context is re-charged per call), not the unique prompt size. */
  inputTokens: number;
  outputTokens: number;
}

export interface Trajectory {
  provider: 'anthropic' | 'openai';
  model: string;
  toolCalls: ToolInvocation[];
  finalText: string;
  steps: number;
  /** Token usage across the whole loop — the basis for the per-run cost. */
  usage: TokenUsage;
  /** Set when the loop itself failed (model HTTP error, malformed response) — distinct from a
   * tool call returning an error, which is a legitimate part of a trajectory. */
  error?: string;
}

/** Executes one tool call against the MCP transport. Returns the tool result; `ok` is false when
 * the tool errored (e.g. a 402/403 surfaced as an MCP `isError`), which the model may react to. */
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; result: unknown }>;

export interface RunAgentOpts {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
  tools: EvalTool[];
  callTool: CallTool;
  /** Hard cap on model↔tool round-trips so a looping model can never hang an eval. */
  maxSteps?: number;
  maxTokens?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_TOKENS = 1024;

// Both providers reject certain JSON-Schema keywords at the TOP level of a tool schema: Anthropic
// rejects oneOf/allOf/anyOf; OpenAI (strict) also rejects enum/const/not and requires type:'object'.
// MCP tool schemas can carry any of these, so strip them at the top and guarantee an object shape —
// the app still validates the real call, so a looser model-facing schema is safe for both.
function sanitizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const s: Record<string, unknown> = { ...schema };
  for (const k of ['oneOf', 'allOf', 'anyOf', 'enum', 'const', 'not']) delete s[k];
  if (s.type !== 'object') return { type: 'object', properties: (s.properties as Record<string, unknown>) ?? {} };
  if (s.properties === undefined) s.properties = {};
  return s;
}

function resultText(result: unknown): string {
  // The MCP tool result is `{ content: [{type:'text', text}], structuredContent }`. Feed the model
  // the text rendering (what a real client shows the model), falling back to JSON.
  const r = result as { content?: Array<{ type?: string; text?: string }> } | null;
  const textBlock = Array.isArray(r?.content) ? r!.content.find((c) => c?.type === 'text') : undefined;
  if (textBlock?.text) return textBlock.text;
  return typeof result === 'string' ? result : JSON.stringify(result ?? {});
}

// ── Anthropic (Claude) ──────────────────────────────────────────────────────

async function runAnthropic(opts: RunAgentOpts): Promise<Trajectory> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const toolCalls: ToolInvocation[] = [];
  const finalTextParts: string[] = [];
  const messages: Array<Record<string, unknown>> = [{ role: 'user', content: opts.prompt }];
  const tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: sanitizeToolSchema(t.inputSchema) }));
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (let step = 0; step < maxSteps; step++) {
    const res = await doFetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey, 'anthropic-version': ANTHROPIC_API_VERSION },
      body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS, system: opts.system, tools, messages }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      content?: Array<Record<string, unknown>>; stop_reason?: string; error?: { message?: string };
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    usage.inputTokens += Number(body?.usage?.input_tokens ?? 0);
    usage.outputTokens += Number(body?.usage?.output_tokens ?? 0);
    if (!res.ok) {
      return { provider: 'anthropic', model: opts.model, toolCalls, finalText: finalTextParts.join('\n'), steps: step, usage,
        error: `anthropic HTTP ${res.status}: ${body?.error?.message ?? ''}`.trim() };
    }
    const blocks = Array.isArray(body.content) ? body.content : [];
    for (const b of blocks) if (b.type === 'text' && typeof b.text === 'string') finalTextParts.push(b.text as string);
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (body.stop_reason !== 'tool_use' || toolUses.length === 0) {
      return { provider: 'anthropic', model: opts.model, toolCalls, finalText: finalTextParts.join('\n').trim(), steps: step + 1, usage };
    }
    messages.push({ role: 'assistant', content: blocks });
    const toolResults: Array<Record<string, unknown>> = [];
    for (const tu of toolUses) {
      const name = String(tu.name);
      const args = (tu.input as Record<string, unknown>) ?? {};
      const { ok, result } = await opts.callTool(name, args);
      toolCalls.push({ name, args, ok, result });
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: resultText(result), is_error: !ok });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return { provider: 'anthropic', model: opts.model, toolCalls, finalText: finalTextParts.join('\n').trim(), steps: maxSteps, usage,
    error: `reached maxSteps (${maxSteps}) without finishing` };
}

// ── OpenAI (GPT) ────────────────────────────────────────────────────────────

async function runOpenai(opts: RunAgentOpts): Promise<Trajectory> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const toolCalls: ToolInvocation[] = [];
  const finalTextParts: string[] = [];
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.prompt },
  ];
  const tools = opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: sanitizeToolSchema(t.inputSchema) } }));
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (let step = 0; step < maxSteps; step++) {
    const res = await doFetch(OPENAI_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({ model: opts.model, max_completion_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS, tools, messages }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      choices?: Array<{ message?: Record<string, unknown>; finish_reason?: string }>; error?: { message?: string };
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    usage.inputTokens += Number(body?.usage?.prompt_tokens ?? 0);
    usage.outputTokens += Number(body?.usage?.completion_tokens ?? 0);
    if (!res.ok) {
      return { provider: 'openai', model: opts.model, toolCalls, finalText: finalTextParts.join('\n'), steps: step, usage,
        error: `openai HTTP ${res.status}: ${body?.error?.message ?? ''}`.trim() };
    }
    const choice = body.choices?.[0];
    const msg = choice?.message ?? {};
    if (typeof msg.content === 'string' && msg.content) finalTextParts.push(msg.content);
    const calls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as Array<Record<string, unknown>>) : [];
    if (calls.length === 0) {
      return { provider: 'openai', model: opts.model, toolCalls, finalText: finalTextParts.join('\n').trim(), steps: step + 1, usage };
    }
    messages.push(msg);
    for (const c of calls) {
      const fn = (c.function as { name?: string; arguments?: string }) ?? {};
      const name = String(fn.name);
      let args: Record<string, unknown> = {};
      try { args = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch { args = {}; }
      const { ok, result } = await opts.callTool(name, args);
      toolCalls.push({ name, args, ok, result });
      messages.push({ role: 'tool', tool_call_id: c.id, content: resultText(result) });
    }
  }
  return { provider: 'openai', model: opts.model, toolCalls, finalText: finalTextParts.join('\n').trim(), steps: maxSteps, usage,
    error: `reached maxSteps (${maxSteps}) without finishing` };
}

/** Drive a real model as an MCP client through its tool-use loop. Never throws — a provider error
 * is captured in `trajectory.error` so a bad model call fails the CASE, not the whole run. */
export async function runAgent(opts: RunAgentOpts): Promise<Trajectory> {
  try {
    return opts.provider === 'anthropic' ? await runAnthropic(opts) : await runOpenai(opts);
  } catch (e) {
    return { provider: opts.provider, model: opts.model, toolCalls: [], finalText: '', steps: 0,
      usage: { inputTokens: 0, outputTokens: 0 }, error: `agent loop threw: ${(e as Error)?.message ?? String(e)}` };
  }
}
