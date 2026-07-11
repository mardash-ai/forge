// C29 — the deterministic authorization / policy engine (GENERIC, product-agnostic). The platform owns
// the enforcement point + the policy store; the CONSUMER app owns the meaning of its role names and any
// plain-language policy-authoring UX. Nothing here is app-specific.
//
// The model: an ACTOR performs an ACTION (described by structured DIMENSIONS); the pure, deterministic
// `authorize()` (src/authz/authorize.ts) evaluates the actor's POLICIES against the action and returns a
// DECISION (`allow` | `needs-approval` | `deny`) plus the governing rule + a human "why". There are NO
// model calls — same inputs always yield the same decision (mirrorable in-process, like the C6 health
// schema + the C10 session verifier). A non-overridable SAFETY FLOOR forces high-risk action classes to
// `needs-approval` regardless of any policy.

export type PolicyEffect = 'allow' | 'needs-approval' | 'deny';
export type Decision = PolicyEffect;
export type Reversibility = 'reversible' | 'irreversible';
export type Visibility = 'private' | 'shared';

// WHO is acting. `owner` (C11) is the per-user id; `role` is an app-defined string (never a fixed enum).
export interface Actor {
  owner: string;
  group_id?: string;
  role?: string;
}

// WHAT is being done + its structured dimensions. All optional so an app supplies only what's relevant;
// policies + the safety floor match on whichever are present.
export interface Action {
  tool?: string; // e.g. 'send_email', 'transfer_funds'
  type?: string; // action type: 'read' | 'write' | 'send' | 'pay' | 'delete' | … (app-defined)
  contact?: string; // recipient identifier
  contact_known?: boolean; // the app asserts this contact is already known/trusted (else treated as new)
  domain?: string; // e.g. an email domain or URL host
  amount?: number; // monetary amount (app-normalized; any currency)
  currency?: string;
  channel?: string; // 'email' | 'sms' | 'push' | 'webhook' | … (external message sends)
  data_sensitivity?: string; // 'public' | 'internal' | 'confidential' | 'secret' | … (app-defined)
  reversibility?: Reversibility;
  project?: string;
  location?: string;
  device?: string;
  at?: string; // ISO-8601 time of the action; defaults to now
}

// Extra free-form context a policy or the caller may carry (rarely needed — dimensions live on Action).
export type AuthzContext = Record<string, unknown>;

// A structured policy rule. `match` conditions are ANDed; a list/string dimension matches if the action's
// value is IN the rule's set; `max_amount`/`time` are range checks. An empty `match` matches everything.
export interface PolicyMatch {
  tool?: string[];
  type?: string[];
  contact?: string[];
  domain?: string[];
  channel?: string[];
  project?: string[];
  location?: string[];
  device?: string[];
  data_sensitivity?: string[];
  reversibility?: Reversibility[];
  role?: string[]; // the actor's role
  max_amount?: number; // matches when action.amount <= max_amount
  // Time window (all fields optional): days = weekday names/numbers, start/end = 'HH:MM' local wall time.
  time?: { days?: string[]; start?: string; end?: string };
}

export interface PolicyRule {
  id: string;
  // Scope (C11 + O4). `owner` absent = an APP-WIDE rule (applies to every actor); set = that owner's rule.
  owner?: string;
  group_id?: string;
  visibility?: Visibility;
  effect: PolicyEffect;
  priority: number; // higher wins on conflict (default 0)
  match: PolicyMatch;
  reason?: string;
  created_at: string;
  updated_at: string;
}

// The decision the enforcement point returns.
export interface AuthzDecision {
  decision: Decision;
  rule?: string; // governing rule id, or a synthetic 'safety-floor:<class>' / 'default'
  reason: string; // human-readable "why" the consumer can render
  high_risk: boolean; // whether the action hit the non-overridable safety floor
  action_class: string; // canonical class key (for the audit trail + progressive-autonomy counts)
}

// The high-risk classes that ALWAYS stage (`needs-approval`), non-overridable by any policy. The app
// configures the SET; a policy can never downgrade a member of the set to auto-allow.
export interface HighRiskSpec {
  action_types?: string[]; // action.type values that are high-risk (e.g. send/pay/delete/transfer)
  channels?: string[]; // any external message send (email/sms/push/…) is high-risk
  tools?: string[]; // specific tools flagged high-risk
  irreversible?: boolean; // an irreversible action is high-risk (default true)
  spending?: boolean; // spending money (amount > minAmount) is high-risk (default true)
  minAmount?: number; // the spend threshold (default 0 — any positive amount)
  newContact?: boolean; // contacting a not-known recipient is high-risk (default true)
}

// The shipped default high-risk set: external message sends, spending money, contacting a new recipient,
// irreversible actions, and the send/pay/transfer/delete/purchase action types. Apps override per-call.
export const DEFAULT_HIGH_RISK: HighRiskSpec = {
  action_types: ['send', 'pay', 'transfer', 'delete', 'purchase', 'wire'],
  channels: ['email', 'sms', 'push', 'webhook', 'call'],
  irreversible: true,
  spending: true,
  minAmount: 0,
  newContact: true,
};

// A canonical, deterministic class key for an action — the audit-trail subject + the progressive-autonomy
// grouping key. Stable given the same action shape.
export function actionClass(action: Action): string {
  const head = action.tool ?? action.type ?? 'action';
  return action.channel ? `${head}:${action.channel}` : head;
}
