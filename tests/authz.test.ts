import { describe, it, expect } from 'vitest';
import { authorize, isHighRisk } from '../src/authz/authorize';
import { actionClass, DEFAULT_HIGH_RISK, type PolicyRule, type Actor, type Action } from '../src/authz/types';

// C29 — the pure, DETERMINISTIC enforcement point. No I/O, no model calls: same inputs → same decision.
// These tests are backend-agnostic (they call the pure function directly), so they run on both backends.

const actor = (over: Partial<Actor> = {}): Actor => ({ owner: 'A', ...over });
const NOW = '2026-03-04T12:00:00.000Z'; // a Wednesday, 12:00 UTC — pinned for determinism

let seq = 0;
const rule = (over: Partial<PolicyRule>): PolicyRule => ({
  id: over.id ?? `p${seq++}`,
  effect: 'allow',
  priority: 0,
  match: {},
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

// A benign, non-high-risk action (a read) so policy effects are visible without the safety floor firing.
const read = (over: Partial<Action> = {}): Action => ({ tool: 'get_note', type: 'read', reversibility: 'reversible', ...over });

describe('C29 — actionClass + isHighRisk', () => {
  it('actionClass is a stable tool[:channel] key', () => {
    expect(actionClass({ tool: 'send_email', channel: 'email' })).toBe('send_email:email');
    expect(actionClass({ type: 'read' })).toBe('read');
    expect(actionClass({})).toBe('action');
  });

  it('classifies the high-risk set: sends, spending, new contacts, irreversible', () => {
    expect(isHighRisk({ channel: 'email' })).toBe(true); // external message send
    expect(isHighRisk({ type: 'pay' })).toBe(true); // spending action type
    expect(isHighRisk({ amount: 5 })).toBe(true); // spends money
    expect(isHighRisk({ amount: 0 })).toBe(false); // zero isn't a spend
    expect(isHighRisk({ contact: 'x@new.com' })).toBe(true); // unknown contact
    expect(isHighRisk({ contact: 'x@new.com', contact_known: true })).toBe(false); // known contact
    expect(isHighRisk({ reversibility: 'irreversible' })).toBe(true);
    expect(isHighRisk(read())).toBe(false); // a plain reversible read is not high-risk
  });

  it('the high-risk set is configurable by the app', () => {
    // Turn OFF new-contact + spending, and only flag a custom tool.
    const spec = { tools: ['dangerous_tool'], channels: [], action_types: [], irreversible: false, spending: false, newContact: false };
    expect(isHighRisk({ contact: 'x@new.com' }, spec)).toBe(false);
    expect(isHighRisk({ amount: 100 }, spec)).toBe(false);
    expect(isHighRisk({ tool: 'dangerous_tool' }, spec)).toBe(true);
  });
});

describe('C29 — deterministic decisions', () => {
  it('a matching allow policy on a non-high-risk action → allow, naming the rule', () => {
    const policies = [rule({ id: 'allow_reads', effect: 'allow', match: { type: ['read'] } })];
    const d = authorize(actor(), read(), policies, { now: NOW });
    expect(d).toMatchObject({ decision: 'allow', rule: 'allow_reads', high_risk: false });
  });

  it('no policy + non-high-risk → the conservative default (needs-approval); overridable to allow', () => {
    expect(authorize(actor(), read(), [], { now: NOW }).decision).toBe('needs-approval');
    expect(authorize(actor(), read(), [], { now: NOW, defaultDecision: 'allow' }).decision).toBe('allow');
  });

  it('a matching deny policy wins (strictest)', () => {
    const policies = [
      rule({ id: 'allow_all', effect: 'allow', priority: 100, match: {} }),
      rule({ id: 'deny_secret', effect: 'deny', priority: 1, match: { data_sensitivity: ['secret'] } }),
    ];
    const d = authorize(actor(), read({ data_sensitivity: 'secret' }), policies, { now: NOW });
    expect(d).toMatchObject({ decision: 'deny', rule: 'deny_secret' });
  });

  it('higher priority wins among matching allow/needs-approval policies', () => {
    const policies = [
      rule({ id: 'low', effect: 'needs-approval', priority: 1, match: { type: ['read'] } }),
      rule({ id: 'high', effect: 'allow', priority: 10, match: { type: ['read'] } }),
    ];
    expect(authorize(actor(), read(), policies, { now: NOW }).rule).toBe('high');
  });

  it('is deterministic — identical inputs yield an identical decision', () => {
    const policies = [rule({ id: 'r', effect: 'allow', match: { type: ['read'] } })];
    const a = authorize(actor(), read(), policies, { now: NOW });
    const b = authorize(actor(), read(), policies, { now: NOW });
    expect(a).toEqual(b);
  });
});

describe('C29 — the non-overridable safety floor', () => {
  it('a high-risk action ALWAYS returns needs-approval, even with a matching allow policy', () => {
    const send: Action = { tool: 'send_email', type: 'send', channel: 'email', contact: 'user@x.com' };
    const allowEverything = [rule({ id: 'allow_sends', effect: 'allow', priority: 999, match: { tool: ['send_email'] } })];
    const d = authorize(actor(), send, allowEverything, { now: NOW });
    expect(d.decision).toBe('needs-approval'); // the allow policy CANNOT downgrade it
    expect(d.high_risk).toBe(true);
    expect(d.rule).toMatch(/^safety-floor:/);
  });

  it('a deny policy still overrides the safety floor (deny is stricter than needs-approval)', () => {
    const pay: Action = { tool: 'pay', type: 'pay', amount: 100 };
    const d = authorize(actor(), pay, [rule({ id: 'deny_pay', effect: 'deny', match: { type: ['pay'] } })], { now: NOW });
    expect(d.decision).toBe('deny');
  });

  it('spending / new-contact / irreversible each hit the floor regardless of policy', () => {
    const allow = [rule({ id: 'yolo', effect: 'allow', priority: 100, match: {} })];
    for (const action of [{ amount: 1 } as Action, { contact: 'new@x.com' } as Action, { reversibility: 'irreversible' } as Action]) {
      expect(authorize(actor(), action, allow, { now: NOW }).decision).toBe('needs-approval');
    }
    // …but the same allow policy DOES auto-allow a plain reversible read.
    expect(authorize(actor(), read(), allow, { now: NOW }).decision).toBe('allow');
  });
});

describe('C29 — dimensions + scope', () => {
  it('max_amount matches only spends at or under the ceiling (and only spend actions)', () => {
    // A read (no amount) never matches a max_amount rule.
    const capped = [rule({ id: 'cap', effect: 'allow', match: { type: ['transfer'], max_amount: 50 } })];
    const spec = { spending: false, newContact: false, action_types: [], channels: [], irreversible: false }; // disable the floor to isolate the rule
    expect(authorize(actor(), { type: 'transfer', amount: 30 }, capped, { now: NOW, highRiskClasses: spec }).decision).toBe('allow');
    expect(authorize(actor(), { type: 'transfer', amount: 80 }, capped, { now: NOW, highRiskClasses: spec }).decision).toBe('needs-approval'); // over cap → no match → default
  });

  it('role, domain, and time-window conditions gate a rule', () => {
    const spec = { spending: false, newContact: false, action_types: [], channels: [], irreversible: false };
    const rules = [
      rule({ id: 'admin_only', effect: 'allow', match: { role: ['admin'], domain: ['example.com'], time: { days: ['wed'], start: '09:00', end: '17:00' } } }),
    ];
    const act: Action = { type: 'read', domain: 'example.com' };
    // Wednesday 12:00 UTC, role admin → allow.
    expect(authorize(actor({ role: 'admin' }), act, rules, { now: NOW, highRiskClasses: spec }).decision).toBe('allow');
    // Wrong role → rule doesn't apply → default needs-approval.
    expect(authorize(actor({ role: 'member' }), act, rules, { now: NOW, highRiskClasses: spec }).decision).toBe('needs-approval');
    // Outside the time window (20:00 UTC) → doesn't apply.
    expect(authorize(actor({ role: 'admin' }), act, rules, { now: '2026-03-04T20:00:00Z', highRiskClasses: spec }).decision).toBe('needs-approval');
  });

  it('an app-wide policy (no owner) applies to any actor; an owner policy only to that owner', () => {
    const appWide = [rule({ id: 'appwide', effect: 'allow', match: { type: ['read'] } })]; // no owner
    expect(authorize(actor({ owner: 'anybody' }), read(), appWide, { now: NOW }).decision).toBe('allow');

    const ownerOnly = [rule({ id: 'a_only', owner: 'A', effect: 'allow', match: { type: ['read'] } })];
    expect(authorize(actor({ owner: 'A' }), read(), ownerOnly, { now: NOW }).decision).toBe('allow');
    expect(authorize(actor({ owner: 'B' }), read(), ownerOnly, { now: NOW }).decision).toBe('needs-approval'); // B can't use A's policy
  });
});
