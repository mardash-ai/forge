import { randomBytes } from 'node:crypto';

// C36 — OTel-Langfuse export helper
//
// A thin, fire-and-forget OTLP/HTTP JSON exporter that sends spans to a
// self-hosted Langfuse stack.  Consumers call `initOtelLangfuse()` once at
// startup and then use `startSpan()` / `SpanContext.end()` to record work.
//
// Design goals (from the C36 contract):
//  • Non-blocking: a down or slow collector NEVER delays a tool call.
//  • Zero external OTel SDK deps: uses Node 22 built-in fetch + node:crypto.
//  • GenAI semantic conventions: span attributes follow the OTel GenAI spec.
//  • Graceful degrade: if Langfuse is unreachable every export silently no-ops.

// ── OTel GenAI semantic convention attribute names ─────────────────────────
export const ATTR = {
  GEN_AI_OPERATION_NAME: 'gen_ai.operation.name',
  GEN_AI_TOOL_NAME:       'gen_ai.tool.name',
  GEN_AI_TOOL_ARGS:       'gen_ai.tool.input',
  GEN_AI_TOOL_OUTPUT:     'gen_ai.tool.output',
  GEN_AI_USAGE_INPUT_TOKENS:  'gen_ai.usage.input_tokens',
  GEN_AI_USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  // Langfuse-native observation INPUT/OUTPUT. These are the ONLY keys here that Langfuse's OTel
  // ingest maps onto an observation's input/output panes (its highest-precedence mapping, per the
  // Langfuse property-mapping contract: langfuse.observation.input/output → observation I/O). The
  // `gen_ai.tool.*` keys above are NOT in that mapping — they ride along as plain attributes
  // (metadata), so a payload recorded only there never surfaces as observation input/output.
  // Values are (JSON) strings — serialize + size-cap with `capPayload()` before recording.
  LANGFUSE_OBSERVATION_INPUT:  'langfuse.observation.input',
  LANGFUSE_OBSERVATION_OUTPUT: 'langfuse.observation.output',
  // Langfuse-native trace USER id — groups traces per user in Langfuse's Users view. Verified against
  // Langfuse v3 (langfuse/langfuse v3.224.0, packages/shared/src/server/otel/OtelIngestionProcessor.ts):
  // `extractUserId()` checks `langfuse.user.id` FIRST (then `user.id`, metadata forms). Propagation is
  // NOT root-only: the key is in `hasTraceUpdates()`'s exact-match list, so a NON-root span carrying it
  // emits a trace-UPDATE event whose body sets the trace-level userId — which matters because
  // `mcp.tool_call` is not the trace root once it joins the edge trace via `traceparent`.
  LANGFUSE_USER_ID: 'langfuse.user.id',
  // Additional context
  MCP_CLIENT_USER:  'mcp.client.user',
  MCP_CLIENT_HOST:  'mcp.client.host',
  AUTHZ_DECISION:   'authz.decision',
  OUTCOME:          'outcome',
  ERROR_MESSAGE:    'error.message',
} as const;

// ── Internal types (OTLP/HTTP JSON schema subset) ──────────────────────────
type OtlpAttrValue =
  | { stringValue: string }
  | { intValue: number }
  | { boolValue: boolean };

interface OtlpAttr { key: string; value: OtlpAttrValue; }

interface OtlpSpan {
  traceId: string;       // 16-byte hex
  spanId: string;        // 8-byte hex
  parentSpanId?: string; // 8-byte hex
  name: string;
  kind: number;          // 1=internal 2=server 3=client
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttr[];
  status: { code: number }; // 1=unset 2=ok 3=error
}

// ── Module state ───────────────────────────────────────────────────────────
let _endpoint = '';
let _authHeader = '';
let _serviceName = 'forge';
let _enabled = false;

// ── Initialisation ─────────────────────────────────────────────────────────

export interface OtelLangfuseConfig {
  /**
   * OTLP endpoint. Defaults to OTEL_EXPORTER_OTLP_ENDPOINT env var, then
   * `http://langfuse-web:3000/api/public/otel`.
   */
  endpoint?: string;
  /** Langfuse project public key. Defaults to LANGFUSE_PUBLIC_KEY env var. */
  publicKey?: string;
  /** Langfuse project secret key. Defaults to LANGFUSE_SECRET_KEY env var. */
  secretKey?: string;
  /** OTel `service.name` resource attribute. Default: "forge". */
  serviceName?: string;
}

/**
 * Call once at process startup to wire up the OTLP exporter.
 * Returns `false` when keys are absent (tracing silently disabled).
 */
export function initOtelLangfuse(cfg: OtelLangfuseConfig = {}): boolean {
  const ep =
    cfg.endpoint ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
    'http://langfuse-web:3000/api/public/otel';
  const pub = cfg.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY ?? '';
  const sec = cfg.secretKey ?? process.env.LANGFUSE_SECRET_KEY ?? '';

  if (!pub || !sec) {
    // Keys absent → tracing disabled; tool calls are unaffected.
    _enabled = false;
    return false;
  }

  _endpoint = ep.replace(/\/$/, '') + '/v1/traces';
  _authHeader = 'Basic ' + Buffer.from(`${pub}:${sec}`).toString('base64');
  _serviceName = cfg.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'forge';
  _enabled = true;
  return true;
}

/** Returns true when the exporter has been initialised with valid keys. */
export function isEnabled(): boolean { return _enabled; }

// ── Helpers ────────────────────────────────────────────────────────────────

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function nowNano(): string {
  // Date.now() gives ms; OTLP wants nanoseconds as a decimal string.
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function toAttr(key: string, value: unknown): OtlpAttr | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') return { key, value: { intValue: value } };
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return { key, value: { stringValue: s } };
}

function buildPayload(spans: OtlpSpan[]): string {
  return JSON.stringify({
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: _serviceName } },
        ],
      },
      scopeSpans: [{
        scope: { name: '@forge/otel-langfuse', version: '1.0.0' },
        spans,
      }],
    }],
  });
}

/**
 * Fire-and-forget export: POST the OTLP JSON payload to Langfuse.
 * Errors are caught and discarded — a collector outage must never throw.
 */
function exportSpan(span: OtlpSpan): void {
  if (!_enabled) return;
  const body = buildPayload([span]);
  // Deliberately NOT awaited — fire-and-forget.
  fetch(_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': _authHeader,
    },
    body,
    signal: AbortSignal.timeout(5000), // 5 s hard cap — never blocks a tool call
  }).catch(() => { /* silently discard collector errors */ });
}

// ── Payload capture (tool-call arguments / results on the trace) ──────────

/** Per-side byte cap for a recorded payload (observation input or output). */
export const PAYLOAD_CAP_BYTES = 8192;

/**
 * Serialize a payload for span capture: strings pass through, everything else is
 * JSON-stringified, and the result is capped at `capBytes` UTF-8 bytes with a
 * `…[truncated]` suffix when cut. Never throws — an unserializable value records
 * as its String() form. Callers must pass ONLY application payloads (tool
 * arguments / results), never transport auth material.
 */
export function capPayload(value: unknown, capBytes: number = PAYLOAD_CAP_BYTES): string {
  let s: string;
  if (typeof value === 'string') s = value;
  else {
    try { s = JSON.stringify(value) ?? String(value); } catch { s = String(value); }
  }
  if (Buffer.byteLength(s, 'utf8') <= capBytes) return s;
  // Cut on the byte budget, then drop any multi-byte character broken by the cut.
  const cut = Buffer.from(s, 'utf8').subarray(0, capBytes).toString('utf8').replace(/�+$/, '');
  return `${cut}…[truncated]`;
}

// ── Public span API ────────────────────────────────────────────────────────

/** A remote parent extracted from a W3C `traceparent` header (cross-tier propagation). */
export interface RemoteParent {
  traceId: string;
  spanId: string;
}

/** OTel span kind: INTERNAL=1, SERVER=2 (default), CLIENT=3. */
export type SpanKind = 1 | 2 | 3;

export interface SpanOptions {
  /** Attributes to set at span creation. */
  attributes?: Record<string, unknown>;
  /** Parent span — a live local span or a remote parent from `parentFromTraceparent()`. */
  parent?: SpanContext | RemoteParent;
  /** OTel span kind (INTERNAL=1, SERVER=2 default, CLIENT=3). */
  kind?: SpanKind;
}

/** A live span. Call `end()` to finalise and export. */
export class SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  private readonly parentSpanId: string | undefined;
  private readonly _kind: SpanKind;
  private readonly _name: string;
  private readonly _startNano: string;
  private readonly _attrs: Record<string, unknown>;

  constructor(name: string, opts: SpanOptions = {}) {
    // Inherit the parent's trace or start a new one.
    this.traceId = opts.parent?.traceId ?? hex(16);
    this.spanId = hex(8);
    this.parentSpanId = opts.parent?.spanId;
    this._kind = opts.kind ?? 2;
    this._name = name;
    this._startNano = nowNano();
    this._attrs = { ...(opts.attributes ?? {}) };
  }

  /** Add or overwrite an attribute on this span. */
  setAttribute(key: string, value: unknown): this {
    this._attrs[key] = value;
    return this;
  }

  /** Finalise the span with outcome + optional error, then export it. */
  end(outcome: 'ok' | 'error' = 'ok', errorMessage?: string): void {
    if (errorMessage) this._attrs[ATTR.ERROR_MESSAGE] = errorMessage;
    this._attrs[ATTR.OUTCOME] = outcome;

    const attrs: OtlpAttr[] = Object.entries(this._attrs)
      .map(([k, v]) => toAttr(k, v))
      .filter((a): a is OtlpAttr => a !== null);

    const span: OtlpSpan = {
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      name: this._name,
      kind: this._kind,
      startTimeUnixNano: this._startNano,
      endTimeUnixNano: nowNano(),
      attributes: attrs,
      status: { code: outcome === 'ok' ? 2 : 3 },
    };
    exportSpan(span);
  }
}

/**
 * Start a new span.
 *
 * ```ts
 * const span = startSpan('mcp.tool_call', { parent });
 * span.setAttribute(ATTR.GEN_AI_TOOL_NAME, 'create_task');
 * span.end('ok');
 * ```
 */
export function startSpan(name: string, opts: SpanOptions = {}): SpanContext {
  return new SpanContext(name, opts);
}

/**
 * Wrap an async function in a span, automatically ending it on completion
 * or error. Returns the function's result.
 *
 * ```ts
 * const result = await withSpan('mcp.tool_call', { parent }, async (span) => {
 *   span.setAttribute(ATTR.GEN_AI_TOOL_NAME, toolName);
 *   return await handleTool(args);
 * });
 * ```
 */
export async function withSpan<T>(
  name: string,
  opts: SpanOptions,
  fn: (span: SpanContext) => Promise<T>,
): Promise<T> {
  const span = new SpanContext(name, opts);
  try {
    const result = await fn(span);
    span.end('ok');
    return result;
  } catch (err) {
    span.end('error', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

// ── W3C trace-context propagation (cross-tier) ──────────────────────────────
// The single trace that spans forge (transport) + the app (proxy edge + tool
// business logic) is stitched by carrying a W3C `traceparent` header across each
// HTTP hop. The exporter already mints trace/span IDs in the exact hex widths the
// spec wants (16-byte trace, 8-byte span), so propagation is a thin header codec.

const _TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;

/**
 * Produce a W3C `traceparent` header for THIS span, to inject into a downstream
 * call so the next tier's spans join this trace. Format `00-<trace>-<span>-01`.
 *
 * ```ts
 * const res = await fetch(url, { headers: { traceparent: traceparent(span) } });
 * ```
 */
export function traceparent(span: { traceId: string; spanId: string }): string {
  return `00-${span.traceId}-${span.spanId}-01`;
}

/**
 * Parse an incoming `traceparent` header into a parent you can pass as
 * `startSpan(name, { parent })`. Returns undefined when the header is missing or
 * malformed — the tier then roots a fresh trace. Never throws.
 */
export function parentFromTraceparent(header: string | string[] | undefined | null): RemoteParent | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const m = _TRACEPARENT_RE.exec(raw.trim());
  if (!m) return undefined;
  const traceId = m[1]!.toLowerCase();
  const spanId = m[2]!.toLowerCase();
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined; // all-zero IDs are invalid
  return { traceId, spanId };
}

/**
 * Probe the configured OTLP endpoint (GET /health or a HEAD to the traces
 * endpoint) to verify Langfuse is reachable. Returns true if reachable,
 * false otherwise. Never throws.
 */
export async function probeEndpoint(cfg?: OtelLangfuseConfig): Promise<boolean> {
  const ep =
    (cfg?.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://langfuse-web:3000/api/public/otel')
      .replace(/\/$/, '');
  const pub = cfg?.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY ?? '';
  const sec = cfg?.secretKey ?? process.env.LANGFUSE_SECRET_KEY ?? '';
  if (!pub || !sec) return false;
  try {
    const res = await fetch(`${ep}/v1/traces`, {
      method: 'HEAD',
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${pub}:${sec}`).toString('base64') },
      signal: AbortSignal.timeout(4000),
    });
    // Langfuse returns 405 Method Not Allowed or 200 for HEAD — both mean the
    // service is up and the credentials were parsed (auth failures → 401).
    return res.status !== 401 && res.status !== 0;
  } catch {
    return false;
  }
}
