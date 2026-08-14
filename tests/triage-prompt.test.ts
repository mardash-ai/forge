import { describe, it, expect } from 'vitest';
import {
  buildE2eTriagePrompt,
  bucketOf,
  truncate,
  DEFAULT_TRIAGE_LIMITS,
  type TriageRun,
  type TriageWorkflow,
  type TriageWorkflowEvidence,
} from '../console/src/lib/triage-prompt';

/**
 * The E2E triage brief.
 *
 * These tests exist because the brief is a set of CLAIMS made to another agent, and two of those
 * claims can cost real engineering time when they are wrong:
 *
 *   1. "this workflow failed" — said about a WITHHELD workflow, it sends an engineer to debug
 *      product code that was never executed. The store has already been bitten by exactly this
 *      (UNARMED/INFRA-FAIL collapsed into `error`, rendered by the console as "✗ rejected"), so the
 *      brief must keep the three outcomes in three separate sections and say the rule out loud.
 *
 *   2. "here is the evidence" — said about a block that was truncated or never fetched, it makes
 *      the reader conclude from a fragment. Every cut this module makes must therefore be VISIBLE
 *      in the output, and an unfetched drilldown must read as "we did not look", never as an empty
 *      result.
 *
 * The prior implementation (buildE2eTriagePrompt in App.tsx) would fail nearly every assertion
 * below: it emitted `failing bar`-less one-liners for anything with verdict fail|error under a
 * single "Failures to triage:" heading — which put withheld rows (verdict `error` pre-migration)
 * into the failure list with no section boundary and no warning at all.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

const RUN: TriageRun = {
  run_id: '2026-08-14T02-00',
  tenant_id: 'dorinda-prod',
  canonical_url: 'https://console.forge.dev/?s=evals&run=2026-08-14T02-00',
  provider: 'openai',
  trigger_source: 'nightly',
  workflows_attempted: 75,
  workflows_passed: 57,
  workflows_failed: 12,
  pass_rate: 0.76,
  withheld_count: 6,
  rejected_count: 12,
  spend_cents: 214,
  p50_duration_ms: 14_000,
  p99_duration_ms: 222_000,
  total_input_tokens: 2_900_000,
  total_output_tokens: 41_000,
  status: 'completed',
  started_at: '2026-08-14T02:00:00Z',
  completed_at: '2026-08-14T02:41:00Z',
  meta: { api_version: 'v1.28.6', withheld_breakdown: { 'deploy-window': 4, UNARMED: 2 } },
};

function rejectedWf(over: Partial<TriageWorkflow> = {}): TriageWorkflow {
  return {
    id: 'row-rej-1',
    workflow_id: 'h5-teen-share-up',
    verdict: 'fail',
    integrity_class: 'clean',
    prompt: 'Share my calendar with my teenager so she can see when I am free.',
    duration_ms: 38_000,
    provider: 'openai',
    lanes: ['openai'],
    trials_total: 3,
    trials_passed: 1,
    failing_bar: 'calendar.acl contains teen@example.com with role=reader',
    meta: {},
    ...over,
  };
}

function withheldWf(over: Partial<TriageWorkflow> = {}): TriageWorkflow {
  return {
    id: 'row-wh-1',
    workflow_id: 'h5-morning-brief',
    verdict: 'withheld',
    integrity_class: 'corrupted',
    prompt: 'What is on my plate this morning?',
    duration_ms: null,
    provider: 'openai',
    lanes: ['openai'],
    trials_total: 0,
    trials_passed: 0,
    failing_bar: null,
    meta: { withheld_reason: 'INFRA-FAIL(deploy-window)' },
    ...over,
  };
}

const FULL_EVIDENCE: TriageWorkflowEvidence = {
  workflow: { id: 'row-rej-1', workflow_id: 'h5-teen-share-up' },
  scenes: [
    {
      scene_index: 0,
      scene_name: 'grant',
      passed: false,
      assertions: [{ name: 'acl_role', expected: 'reader', operator: 'eq' }],
      observed_values: [
        { name: 'acl_role', value: 'writer' },
        { name: 'acl_count', value: 2 },
      ],
    },
  ],
  turns: [
    {
      turn_index: 0,
      attempt: 2,
      scene: 'grant',
      prompt: 'Share my calendar with teen@example.com so she can see when I am free.',
      reply: 'Done — I shared your calendar with teen@example.com.',
      tool_calls: [{ tool: 'share_calendar', ok: true, summary: 'role=writer' }],
      tool_trace_unreadable: false,
    },
  ],
  mcp_calls: [
    {
      call_index: 0,
      tool_name: 'share_calendar',
      request: { email: 'teen@example.com', role: 'writer' },
      response: { ok: true },
      duration_ms: 812,
      error: null,
    },
  ],
  claims: [
    {
      claim_index: 0,
      claim_type: 'calendar',
      claim_text: 'Calendar shared with teen@example.com as reader',
      verdict: 'refuted',
      evidence: { actual_role: 'writer' },
    },
  ],
};

// ── bucketOf — the load-bearing classification ──────────────────────────────

describe('bucketOf — the rejected / withheld distinction', () => {
  it("routes verdict 'fail' to rejected", () => {
    expect(bucketOf(rejectedWf())).toBe('rejected');
  });

  it("routes verdict 'withheld' and its legacy spelling 'skip' to withheld", () => {
    expect(bucketOf(withheldWf({ verdict: 'withheld' }))).toBe('withheld');
    expect(bucketOf(withheldWf({ verdict: 'skip', integrity_class: null }))).toBe('withheld');
  });

  it("routes a 'fail' carrying integrity_class=corrupted to withheld, not rejected", () => {
    // The canonical triage protocol is explicit: corrupted means eval-infrastructure failure, NOT a
    // product bug — do not file, do not re-run, do not alert. That overrides the verdict column.
    expect(bucketOf(rejectedWf({ integrity_class: 'corrupted' }))).toBe('withheld');
  });

  it("routes verdict 'error' to unresolved rather than guessing", () => {
    // Post-migration 'error' means "unrecognised word"; pre-migration rows used it for
    // UNARMED/INFRA-FAIL. Neither bucket is safe, so it gets its own.
    expect(bucketOf(rejectedWf({ verdict: 'error' }))).toBe('unresolved');
  });

  it('routes pass to accepted', () => {
    expect(bucketOf(rejectedWf({ verdict: 'pass' }))).toBe('accepted');
  });
});

// ── A rejected workflow ─────────────────────────────────────────────────────

describe('a rejected workflow carries its evidence inline', () => {
  const out = buildE2eTriagePrompt(RUN, [rejectedWf()], { evidence: [FULL_EVIDENCE] });

  it('names the run context: id, provider, canonical url, timing, counters', () => {
    expect(out).toContain('2026-08-14T02-00');
    expect(out).toContain('openai');
    expect(out).toContain('https://console.forge.dev/?s=evals&run=2026-08-14T02-00');
    expect(out).toContain('2026-08-14T02:00:00Z');
    expect(out).toContain('75 attempted · 57 accepted · 12 rejected · 6 withheld');
    expect(out).toContain('v1.28.6');
  });

  it('puts the workflow under REJECTED with its slug and a human name', () => {
    expect(out).toMatch(/## 3 · REJECTED — product failed a bar \(1\)/);
    expect(out).toContain('h5-teen-share-up');
    expect(out).toContain('Teen share up');
  });

  it('carries the failing bar inline rather than telling the agent to go and fetch it', () => {
    expect(out).toContain('FAILING BAR: calendar.acl contains teen@example.com with role=reader');
  });

  it('carries expected vs observed for the failing scene', () => {
    expect(out).toContain('expected (eq): "reader"');
    expect(out).toContain('observed:            "writer"');
  });

  it('reports the trial shape — flaky is a different finding from deterministic', () => {
    expect(out).toContain('trials: 1/3 passed');
    expect(out).toContain('FLAKY — 2 of 3 trials failed, 1 passed');
    // Which conversations were actually captured, derived from turn.attempt — not invented.
    expect(out).toContain('transcript captured for attempt(s) 2');
  });

  it('carries duration, the tool calls actually made, the visible reply, and the claims', () => {
    expect(out).toContain('duration:  38.0 s');
    expect(out).toContain('share_calendar');
    expect(out).toContain('"role":"writer"'); // the request payload, verbatim from the store
    expect(out).toContain('assistant: Done — I shared your calendar with teen@example.com.');
    expect(out).toContain('[REFUTED] calendar: Calendar shared with teen@example.com as reader');
    expect(out).toContain('integrity: clean');
  });

  it('keeps the four classifications and the standing guardrail line', () => {
    expect(out).toContain('product');
    expect(out).toContain('harness');
    expect(out).toContain('workflow-translation');
    expect(out).toContain('environment');
    // This line is doing real work — it is the one instruction that survives every rewrite.
    expect(out).toContain('Never lower a bar to make a run green');
  });

  it('does not mislabel a rejected workflow as withheld', () => {
    expect(out).toContain('## 4 · WITHHELD — the RIG failed, no verdict exists (0)');
    expect(out).toContain('None — every workflow in this brief produced a real verdict.');
  });
});

// ── A withheld workflow ─────────────────────────────────────────────────────

describe('a withheld workflow is quarantined from the failure list', () => {
  const out = buildE2eTriagePrompt(RUN, [withheldWf()]);

  it('reports zero rejected — a withheld workflow is not a failure', () => {
    expect(out).toContain('## 3 · REJECTED — product failed a bar (0)');
    expect(out).toContain('No workflow in this brief produced a product-level rejection.');
  });

  it('lists it under WITHHELD with the rig reason', () => {
    expect(out).toContain('## 4 · WITHHELD — the RIG failed, no verdict exists (1)');
    expect(out).toContain('⊘ h5-morning-brief — INFRA-FAIL(deploy-window)');
  });

  it('explicitly forbids filing a product bug for it', () => {
    expect(out).toContain('⛔ NOT PRODUCT BUGS.');
    expect(out).toContain('Do not file product findings from this');
    expect(out).toMatch(/DO NOT file a product bug[\s\S]{0,200}WITHHELD section/);
  });

  it('states the three-outcome rule before any failure detail', () => {
    const ruleAt = out.indexOf('rejected is NOT the same as withheld');
    const rejectedAt = out.indexOf('## 3 · REJECTED');
    expect(ruleAt).toBeGreaterThan(-1);
    expect(ruleAt).toBeLessThan(rejectedAt);
    expect(out).toContain('NO VERDICT EXISTS');
  });

  it('surfaces the run-level withheld breakdown the runner reported', () => {
    expect(out).toContain('4 × deploy-window');
    expect(out).toContain('2 × UNARMED');
  });
});

// ── Both together ───────────────────────────────────────────────────────────

describe('rejected and withheld together stay in separate sections', () => {
  const out = buildE2eTriagePrompt(
    RUN,
    [
      rejectedWf(),
      withheldWf(),
      rejectedWf({ id: 'row-rej-2', workflow_id: 'h3-reschedule-dentist' }),
      withheldWf({ id: 'row-wh-2', workflow_id: 'h2-inbox-sweep', verdict: 'skip' }),
      rejectedWf({ id: 'row-err-1', workflow_id: 'h4-unknown-word', verdict: 'error' }),
      rejectedWf({ id: 'row-pass-1', workflow_id: 'h1-happy-path', verdict: 'pass' }),
    ],
    { evidence: [FULL_EVIDENCE] },
  );

  it('counts each bucket separately and never sums them into one "failures" number', () => {
    expect(out).toContain('## 3 · REJECTED — product failed a bar (2)');
    expect(out).toContain('## 4 · WITHHELD — the RIG failed, no verdict exists (2)');
    expect(out).toContain('1 accepted · 2 rejected · 2 withheld · 1 unresolved');
  });

  it('places every workflow in exactly one section, in section order', () => {
    const rejIdx = out.indexOf('## 3 · REJECTED');
    const whIdx = out.indexOf('## 4 · WITHHELD');
    const unIdx = out.indexOf('## 5 · UNRESOLVED');
    expect(rejIdx).toBeLessThan(whIdx);
    expect(whIdx).toBeLessThan(unIdx);

    // The withheld slugs must appear only AFTER the withheld heading — never inside §3.
    expect(out.indexOf('h5-morning-brief')).toBeGreaterThan(whIdx);
    expect(out.indexOf('h2-inbox-sweep')).toBeGreaterThan(whIdx);
    // ...and the rejected slugs only inside §3.
    expect(out.indexOf('h3-reschedule-dentist')).toBeGreaterThan(rejIdx);
    expect(out.indexOf('h3-reschedule-dentist')).toBeLessThan(whIdx);
  });

  it("gives the ambiguous 'error' row its own section with an instruction not to guess", () => {
    expect(out).toContain('## 5 · UNRESOLVED VERDICT (1)');
    expect(out).toContain('? h4-unknown-word');
    expect(out).toContain('Resolve which BEFORE filing');
    expect(out).toContain('an unresolved row is not a licence to guess');
  });
});

// ── Missing drilldown evidence ──────────────────────────────────────────────

describe('missing drilldown evidence degrades honestly', () => {
  // The console fetches the drilldown per-workflow, only for the row the operator expanded. On a
  // run-wide triage most failures have NO evidence loaded — the common case, not the edge case.
  const out = buildE2eTriagePrompt(
    RUN,
    [rejectedWf(), rejectedWf({ id: 'row-rej-2', workflow_id: 'h3-x' })],
    {
      evidence: [FULL_EVIDENCE], // covers row-rej-1 only
    },
  );

  it('says the evidence was not loaded and hands over the exact fetch call', () => {
    expect(out).toContain('evidence:  NOT LOADED in the console when this brief was copied.');
    expect(out).toContain('get_workflow_result("row-rej-2")');
  });

  it('never renders an unfetched workflow as though its evidence were empty', () => {
    // "we did not look" and "there was nothing" are opposite facts. The block for the unloaded
    // workflow must not contain the loaded-and-empty phrasings at all.
    const start = out.indexOf('h3-x');
    const end = out.indexOf('## 4 ·');
    const block = out.slice(start, end);
    expect(block).not.toContain('the product called nothing');
    expect(block).not.toContain('drilldown loaded and contains no');
    expect(block).toContain('Absence here means "we did not look", NOT "there was nothing"');
  });

  it('still carries the summary-level evidence it does have for the unloaded workflow', () => {
    // failing_bar, trials and duration live on the workflow row itself — no drilldown required, so
    // an unloaded workflow is still triage-able at the bar level.
    expect(out).toContain('FAILING BAR: calendar.acl contains teen@example.com with role=reader');
    expect(out).toContain('trials: 1/3 passed');
  });

  it('distinguishes a store with no turns table from a loaded-but-empty transcript', () => {
    const noTurns = buildE2eTriagePrompt(RUN, [rejectedWf()], {
      evidence: [{ workflow: { id: 'row-rej-1' }, scenes: [], mcp_calls: [], claims: [] }],
    });
    expect(noTurns).toContain('this store returned no `turns` collection');

    const emptyTurns = buildE2eTriagePrompt(RUN, [rejectedWf()], {
      evidence: [{ workflow: { id: 'row-rej-1' }, scenes: [], turns: [], mcp_calls: [], claims: [] }],
    });
    expect(emptyTurns).toContain('no conversation was captured');
  });

  it('renders an unreadable tool trace as withheld, never as "called nothing"', () => {
    const out2 = buildE2eTriagePrompt(RUN, [rejectedWf()], {
      evidence: [
        {
          workflow: { id: 'row-rej-1' },
          turns: [
            {
              turn_index: 0,
              attempt: 1,
              prompt: 'Share my calendar.',
              reply: 'Done.',
              tool_calls: [],
              tool_trace_unreadable: true,
            },
          ],
        },
      ],
    });
    expect(out2).toContain('TOOL TRACE UNREADABLE');
    expect(out2).toContain('Treat tool expectations as WITHHELD');
    expect(out2).not.toContain('none called (trace readable and empty)');
  });
});

// ── Truncation is always visible ────────────────────────────────────────────

describe('every cut this brief makes announces itself', () => {
  it('truncate() leaves a marker naming how many characters went', () => {
    expect(truncate('abcdefghij', 4)).toBe('abcd… [+6 chars truncated]');
    expect(truncate('abc', 10)).toBe('abc'); // under the cap: untouched, no marker
  });

  it('marks a truncated assistant reply', () => {
    const longReply = 'X'.repeat(4000);
    const out = buildE2eTriagePrompt(RUN, [rejectedWf()], {
      evidence: [
        {
          workflow: { id: 'row-rej-1' },
          turns: [{ turn_index: 0, attempt: 1, prompt: 'hi', reply: longReply, tool_calls: [] }],
        },
      ],
    });
    expect(out).toContain(`chars truncated]`);
    expect(out).toContain(`[+${4000 - DEFAULT_TRIAGE_LIMITS.replyChars} chars truncated]`);
    // The whole reply must NOT be present — the bound has to actually bind.
    expect(out).not.toContain(longReply);
  });

  it('marks a truncated MCP payload', () => {
    const out = buildE2eTriagePrompt(RUN, [rejectedWf()], {
      evidence: [
        {
          workflow: { id: 'row-rej-1' },
          mcp_calls: [
            {
              call_index: 0,
              tool_name: 'list_events',
              request: { q: 'x' },
              response: { events: Array.from({ length: 200 }, (_, i) => ({ id: i, title: 'meeting' })) },
              duration_ms: 40,
              error: null,
            },
          ],
        },
      ],
    });
    expect(out).toMatch(/response: .*\[\+\d+ chars truncated\]/);
  });

  it('names how many failures were left undetailed, and still lists them with their bar', () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      rejectedWf({ id: `row-${i}`, workflow_id: `h5-case-${i}` }),
    );
    const out = buildE2eTriagePrompt(RUN, many);
    expect(out).toContain('## 3 · REJECTED — product failed a bar (14)');
    expect(out).toContain(
      `[${14 - DEFAULT_TRIAGE_LIMITS.maxDetailedFailures} further rejected workflow(s) not detailed`,
    );
    // Capped, but never dropped: the undetailed ones are still named with their bar + fetch call.
    expect(out).toContain('× h5-case-13 — bar: calendar.acl contains');
    expect(out).toContain('get_workflow_result("row-13")');
  });

  it('drops the middle of a long transcript, from both ends, with a count', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      turn_index: i,
      attempt: 1,
      prompt: `p${i}`,
      reply: `r${i}`,
      tool_calls: [],
    }));
    const out = buildE2eTriagePrompt(RUN, [rejectedWf()], {
      evidence: [{ workflow: { id: 'row-rej-1' }, turns }],
    });
    expect(out).toContain('middle turn(s) omitted');
    expect(out).toContain('user:      p0'); // head kept
    expect(out).toContain('user:      p19'); // tail kept
    expect(out).not.toContain('user:      p9'); // middle gone — and said so
  });

  it('keeps every errored MCP call even past the cap, and says how many were dropped', () => {
    const calls = Array.from({ length: 40 }, (_, i) => ({
      call_index: i,
      tool_name: i === 39 ? 'send_email' : 'list_events',
      request: { i },
      response: { ok: true },
      duration_ms: 10,
      error: i === 39 ? 'upstream 503 from gmail' : null,
    }));
    const out = buildE2eTriagePrompt(RUN, [rejectedWf()], {
      evidence: [{ workflow: { id: 'row-rej-1' }, mcp_calls: calls }],
    });
    // The one line that matters survived BOTH bounds — the count cap and the character budget.
    // It survives because errored calls are emitted first; if they were merged back into index
    // order, the exemption from the count cap would be silently undone by the budget cut.
    expect(out).toContain('upstream 503 from gmail');
    expect(out).toContain('ERRORED call(s), shown first');
    // ...and whichever bound bit, it said so.
    expect(out).toMatch(/tool calls omitted — every errored call is kept|more tool call\(s\) cut/);
  });

  it('an errored call at the very end of a long trace is not lost to the budget', () => {
    // Regression guard for the exact shape above: the errored call is index 39 of 40. Rendered in
    // index order it would be the last line of the section and the first thing any cut removes.
    const calls = Array.from({ length: 40 }, (_, i) => ({
      call_index: i,
      tool_name: 'list_events',
      request: { i },
      response: { ok: true },
      duration_ms: 10,
      error: i === 39 ? 'boom' : null,
    }));
    const out = buildE2eTriagePrompt(RUN, [rejectedWf()], {
      evidence: [{ workflow: { id: 'row-rej-1' }, mcp_calls: calls }],
      limits: { maxEvidenceCharsPerWorkflow: 600 }, // brutally tight — errors must still survive
    });
    expect(out).toContain('#39 list_events');
    expect(out).toContain('error:    boom');
  });

  it('announces the whole-brief ceiling rather than ending mid-sentence', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      rejectedWf({ id: `row-${i}`, workflow_id: `h5-case-${i}`, failing_bar: 'B'.repeat(300) }),
    );
    const out = buildE2eTriagePrompt(RUN, many, { limits: { hardCapChars: 2000 } });
    expect(out.length).toBeLessThan(2400);
    expect(out).toContain('BRIEF TRUNCATED');
    expect(out).toContain('chars cut at the 2000-char clipboard ceiling');
  });

  it('stays within a pasteable size for a realistic worst case', () => {
    // 14 rejected workflows, every one with fully loaded, oversized evidence. Raw, this is ~500 KB.
    const wfs = Array.from({ length: 14 }, (_, i) =>
      rejectedWf({ id: `row-${i}`, workflow_id: `h5-case-${i}` }),
    );
    const evidence: TriageWorkflowEvidence[] = wfs.map((w) => ({
      workflow: { id: w.id },
      scenes: Array.from({ length: 12 }, (_, s) => ({
        scene_index: s,
        scene_name: `scene-${s}`,
        passed: false,
        assertions: Array.from({ length: 12 }, (_, a) => ({
          name: `a${a}`,
          expected: 'Y'.repeat(2000),
          operator: 'eq',
        })),
        observed_values: [],
      })),
      turns: Array.from({ length: 25 }, (_, t) => ({
        turn_index: t,
        attempt: 1,
        prompt: 'P'.repeat(3000),
        reply: 'R'.repeat(9000),
        tool_calls: [],
      })),
      mcp_calls: Array.from({ length: 60 }, (_, c) => ({
        call_index: c,
        tool_name: 'list_events',
        request: { blob: 'Q'.repeat(3000) },
        response: { blob: 'Z'.repeat(9000) },
        duration_ms: 5,
        error: null,
      })),
      claims: Array.from({ length: 30 }, (_, c) => ({
        claim_index: c,
        claim_text: 'C'.repeat(2000),
        verdict: 'refuted',
        evidence: {},
      })),
    }));
    const out = buildE2eTriagePrompt(RUN, wfs, { evidence });
    expect(out.length).toBeLessThanOrEqual(DEFAULT_TRIAGE_LIMITS.hardCapChars + 400);
    // And it is still a real brief, not a stub: the guardrails survive the bounding.
    expect(out).toContain('Never lower a bar to make a run green');
  });

  it('⛔ the FIXED sections survive a run that rejects everything — evidence yields, protocol does not', () => {
    // The invariant that took three attempts to get right. §3 is the only section that grows with
    // the run; §2's withheld rule, §4's quarantine, "never lower a bar" and the fetch instructions
    // are fixed and must be present in EVERY brief. Building §3 first and trimming at a global
    // ceiling cut from the end of the string and produced a 60 KB brief containing neither the
    // withheld warning nor the guardrail — all evidence, no protocol. Measured, twice.
    const wfs = Array.from({ length: 75 }, (_, i) => ({
      id: `row-${i}`,
      workflow_id: `h5-a-deliberately-long-workflow-slug-case-${i}`,
      verdict: 'fail' as const,
      integrity_class: 'clean',
      prompt: 'P'.repeat(2000),
      duration_ms: 5000,
      provider: 'openai',
      lanes: ['openai', 'anthropic'],
      trials_total: 3,
      trials_passed: 0,
      failing_bar: 'B'.repeat(3000),
      meta: {},
    }));
    const evidence: TriageWorkflowEvidence[] = wfs.map((w) => ({
      workflow: { id: w.id },
      scenes: Array.from({ length: 20 }, (_, s) => ({
        scene_index: s,
        scene_name: 's'.repeat(200),
        passed: false,
        assertions: Array.from({ length: 20 }, (_, a) => ({
          name: `a${a}`,
          expected: 'Y'.repeat(9000),
          operator: 'eq',
        })),
        observed_values: Array.from({ length: 20 }, (_, a) => ({ name: `a${a}`, value: 'Z'.repeat(9000) })),
      })),
      turns: Array.from({ length: 60 }, (_, t) => ({
        turn_index: t,
        attempt: 1,
        prompt: 'P'.repeat(9000),
        reply: 'R'.repeat(30000),
        tool_calls: [{ tool: 'x'.repeat(500) }],
      })),
      mcp_calls: Array.from({ length: 200 }, (_, c) => ({
        call_index: c,
        tool_name: 'list_events',
        request: { b: 'Q'.repeat(9000) },
        response: { b: 'Z'.repeat(30000) },
        duration_ms: 5,
        error: c % 5 === 0 ? 'E'.repeat(3000) : null,
      })),
      claims: Array.from({ length: 80 }, (_, c) => ({
        claim_index: c,
        claim_text: 'C'.repeat(9000),
        verdict: 'refuted',
        evidence: { b: 'W'.repeat(9000) },
      })),
    }));
    const out = buildE2eTriagePrompt(RUN, wfs, { evidence });

    expect(out.length).toBeLessThanOrEqual(DEFAULT_TRIAGE_LIMITS.hardCapChars);
    expect(out).toContain('rejected is NOT the same as withheld'); // §2
    expect(out).toContain('DO NOT file a product bug'); // §2
    expect(out).toContain('## 4 · WITHHELD'); // §4 quarantine heading
    expect(out).toContain('⛔ NOT PRODUCT BUGS.'); // §4 warning
    expect(out).toContain('workflow-translation'); // the four classifications
    expect(out).toContain('Never lower a bar to make a run green'); // the guardrail
    expect(out).toContain('If you have the forge e2e MCP tools'); // §7
    // ...and it says how much evidence it gave up to keep them.
    expect(out).toMatch(/further rejected workflow\(s\) not (detailed|named individually)/);
  });
});

// ── Degenerate inputs ───────────────────────────────────────────────────────

describe('degenerate inputs never produce a confident-looking lie', () => {
  it('an all-green run says so plainly', () => {
    const out = buildE2eTriagePrompt(RUN, [rejectedWf({ verdict: 'pass' })]);
    expect(out).toContain('## 3 · REJECTED — product failed a bar (0)');
    expect(out).toContain('None. No workflow in this brief produced a product-level rejection.');
    expect(out).not.toContain('## 5 · UNRESOLVED');
  });

  it('numbers sections contiguously whether or not the unresolved section exists', () => {
    // A brief that runs 1,2,3,4,6 reads like a section went missing, and sends the reader looking
    // for evidence that was never withheld from them.
    const withUnresolved = buildE2eTriagePrompt(RUN, [rejectedWf({ verdict: 'error' })]);
    expect(withUnresolved).toContain('## 5 · UNRESOLVED');
    expect(withUnresolved).toContain('## 6 · What to do');
    expect(withUnresolved).toContain('## 7 · If you have the forge e2e MCP tools');

    const without = buildE2eTriagePrompt(RUN, [rejectedWf()]);
    expect(without).toContain('## 5 · What to do');
    expect(without).toContain('## 6 · If you have the forge e2e MCP tools');
    expect(without).not.toContain('## 7');
  });

  it('an empty workflow list does not claim anything about the run', () => {
    const out = buildE2eTriagePrompt(RUN, []);
    expect(out).toContain('This brief covers 0 workflow row(s)');
  });

  it('a run row with nothing recorded says "not recorded" rather than rendering null', () => {
    const bare: TriageRun = { run_id: 'r1' };
    const out = buildE2eTriagePrompt(bare, [rejectedWf({ failing_bar: null, prompt: null })]);
    expect(out).not.toMatch(/\bnull\b(?!")/); // no raw JS null leaking into operator-facing text
    expect(out).toContain('not recorded');
    expect(out).toContain('(no failing bar recorded)');
  });

  it('zero trials reads as "nothing was measured", not as a 0/0 pass rate', () => {
    const out = buildE2eTriagePrompt(RUN, [rejectedWf({ trials_total: 0, trials_passed: 0 })]);
    expect(out).toContain('trials: none ran (0 trials recorded — nothing was measured)');
  });
});
