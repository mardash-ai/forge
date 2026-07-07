import { readSecrets } from '../secrets-local/index';

// Plugin: model-anthropic.
//
// The first Implementation of Forge's agent runtime (capability C1) — a real technology
// boundary (a model provider) that a future model-openai / model-bedrock Implementation
// can replace WITHOUT touching the AgentRun Capability contract. It does exactly two
// provider-specific things: resolve the model credential, and perform a structured model
// invocation (system prompt + user input + enforced output schema -> parsed result).
//
// Structured output is enforced with a FORCED tool: we declare one tool whose input_schema
// is the caller's JSON Schema, force the model to call it (tool_choice), and read the
// tool_use.input as the parsed structured result. This is provider-native structured output
// over the plain Messages API — no SDK dependency, so both the control-plane and the slim
// data-plane image stay dependency-clean (Node's global fetch does the transport).

export const IMPLEMENTATION = 'model-anthropic';
// A current Claude model. The caller MAY override per-run (AgentRun `model`).
export const DEFAULT_MODEL = 'claude-opus-4-8';
export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSION = '2023-06-01';
// The secret name the C5 vault injects — "key absent -> detectable -> 503" is the (4) contract.
export const MODEL_KEY = 'ANTHROPIC_API_KEY';

// The forced tool the model must call. Its input becomes the structured result.
const RESULT_TOOL = 'emit_result';

// Resolve the model API key for an app. Prefer the C5 encrypted vault (the documented path:
// Forge injects `ANTHROPIC_API_KEY` from its vault into the runtime), then fall back to the
// Forge process env (an operator may inject it into the data-plane container directly).
// Returns null when ABSENT — that null is what makes the capability's absence DETECTABLE, so
// the consuming app can degrade to 503 and never crash.
export async function resolveModelKey(appId: string): Promise<string | null> {
  try {
    const secrets = await readSecrets(appId);
    const fromVault = secrets[MODEL_KEY];
    if (fromVault && fromVault.trim()) return fromVault.trim();
  } catch {
    // Vault unreadable (no master key, corrupt file) -> treat as absent, never fatal.
  }
  const fromEnv = process.env[MODEL_KEY];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return null;
}

// Ensure the caller's schema is a usable JSON Schema object for a tool input_schema. Anthropic
// requires an object at the top with a `properties` map; default those if the caller omits
// them so a bare `{ "type": "object", "properties": {...} }` and looser shapes both work.
function normalizeSchema(schema: unknown): Record<string, unknown> {
  const s = (schema && typeof schema === 'object' ? { ...(schema as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if (s.type === undefined) s.type = 'object';
  if (s.type === 'object' && s.properties === undefined) s.properties = {};
  return s;
}

// Build the Messages API request body for a structured invocation. Pure + exported so it is
// unit-testable without a network call.
export function buildRequest(opts: {
  model: string;
  system: string;
  input: unknown;
  schema: unknown;
  maxTokens: number;
}): Record<string, unknown> {
  const userText = typeof opts.input === 'string' ? opts.input : JSON.stringify(opts.input);
  return {
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: opts.system,
    tools: [
      {
        name: RESULT_TOOL,
        description: 'Return the result as a single structured object conforming to the schema.',
        input_schema: normalizeSchema(opts.schema),
      },
    ],
    // Force the model to produce the structured result via the tool (structured output).
    tool_choice: { type: 'tool', name: RESULT_TOOL },
    messages: [{ role: 'user', content: userText }],
  };
}

// Extract the parsed structured result from a Messages API response. Throws when the model did
// not produce the forced tool call — the output is UNTRUSTED, so we never assume its shape.
// A throw here is a run FAILURE the capability records, not a crash.
export function parseResult(body: unknown): unknown {
  const b = body as { content?: unknown; stop_reason?: unknown } | null;
  const blocks = Array.isArray(b?.content) ? (b!.content as Array<Record<string, unknown>>) : [];
  const toolUse = blocks.find((blk) => blk?.type === 'tool_use' && blk?.name === RESULT_TOOL);
  if (!toolUse || toolUse.input === undefined) {
    throw new Error(
      `model did not return structured output (stop_reason=${String(b?.stop_reason ?? 'unknown')})`,
    );
  }
  return toolUse.input;
}

export interface InvokeInput {
  apiKey: string;
  model: string;
  system: string;
  input: unknown;
  schema: unknown;
  maxTokens: number;
}

export type ModelInvoker = (input: InvokeInput) => Promise<unknown>;

// The real invoker: POST the Messages API with native fetch, then parse the forced tool call.
export const invokeStructured: ModelInvoker = async (input) => {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': input.apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify(
      buildRequest({
        model: input.model,
        system: input.system,
        input: input.input,
        schema: input.schema,
        maxTokens: input.maxTokens,
      }),
    ),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`model request failed: ${msg}`);
  }
  return parseResult(body);
};

// The invoker is swappable so tests can inject a deterministic fake (no network / no key) and a
// future Implementation can slot in — the capability calls getModelInvoker(), never a hard import.
let invoker: ModelInvoker = invokeStructured;
export function setModelInvoker(fn: ModelInvoker): void {
  invoker = fn;
}
export function resetModelInvoker(): void {
  invoker = invokeStructured;
}
export function getModelInvoker(): ModelInvoker {
  return invoker;
}
