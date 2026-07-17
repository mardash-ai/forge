import { z } from 'zod';

// The platform-defined eval suite format (C30). The APP authors suites in this shape (e.g.
// dorinda-api/evals/track_something_new.json); `forge eval` loads + validates them here, so a
// suite that drifts from the contract is a clean 422, not a mid-run surprise.

export const assertSchema = z.object({
  // The tool the model is expected to call at least once (the load-bearing deterministic check).
  tool_called: z.string().optional(),
  // Subset-equality checks on that tool call's structuredContent (e.g. { status: 'inbox' }).
  structured_contains: z.record(z.unknown()).optional(),
  // Per-arg checks on what the model passed: string value ⇒ case-insensitive substring, else equality.
  args_contains: z.record(z.unknown()).optional(),
  // The final assistant text must contain each of these (case-insensitive).
  final_text_contains: z.array(z.string()).optional(),
});

export const caseSchema = z.object({
  id: z.string(),
  prompt: z.string(), // the happy-path user message the model receives
  setup: z.record(z.unknown()).optional(), // reserved: per-case seed data for the eval tenant
  asserts: assertSchema.default({}),
  // Which LLM-judge dimensions to score (default: the five the C30 spec names).
  dimensions: z
    .array(z.string())
    .default(['grounding', 'tool_selection', 'permission_compliance', 'follow_through', 'tone']),
});

export const suiteSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  app: z.string().optional(), // the forge app whose MCP surface to drive (CLI/flag may override)
  cases: z.array(caseSchema).min(1),
  // Pass bar for the LLM-judge dimension average (0-1). Deterministic asserts must ALSO all pass.
  threshold: z.number().min(0).max(1).default(0.7),
});

export type EvalAssert = z.infer<typeof assertSchema>;
export type EvalCase = z.infer<typeof caseSchema>;
export type EvalSuite = z.infer<typeof suiteSchema>;
