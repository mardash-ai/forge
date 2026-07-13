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
// C31 — the stored visibility of a TARGETED resource, supplied by the consumer from its own row. Wider
// than the policy-scope `Visibility` above: adds `group` (visible to the whole targeted group). Drives the
// private-leak floor in `authorize`.
export type ResourceVisibility = 'private' | 'group' | 'shared';

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
  // C31 — the stored scope of the TARGETED single resource (supplied by the consumer from its own DB row).
  // These drive the PRIVATE-LEAK FLOOR: `authorize` denies a caller who is not entitled to the row, so a
  // private/shared row can never leak to another group member. All optional (absence = no scope check).
  resource_owner?: string; // who owns the targeted row
  visibility?: ResourceVisibility; // how the row is scoped
  shared_with?: string[]; // for visibility='shared': the identities it is shared to
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
  role?: string[]; // the actor's role (C31: matched against the RESOLVED role, never the request's)
  // C31 — gate a rule on a PERMISSION the resolved role must hold. Matches when EVERY listed permission
  // token is in the caller's resolved permission set (expanded server-side from the role registry). Absent =
  // no permission constraint (so every pre-C31 policy is unaffected — additive).
  permission?: string[];
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
  rule?: string; // governing rule id, or a synthetic 'safety-floor:<class>' / 'default' / 'not-a-member' / 'private-resource'
  reason: string; // human-readable "why" the consumer can render
  high_risk: boolean; // whether the action hit the non-overridable safety floor
  action_class: string; // canonical class key (for the audit trail + progressive-autonomy counts)
  // C31 — the platform-RESOLVED membership context (present only when a group/role was resolved server-side;
  // absent on a pre-C31 call so the legacy verdict is byte-identical). Authoritative — resolved from the
  // membership graph, NEVER the request.
  role?: string; // the caller's resolved role in the targeted group
  permissions?: string[]; // the role's expanded (opaque) permission set
  is_member?: boolean; // whether the caller is a member of the targeted group
  group_id?: string; // the group the action was evaluated against (personal group-of-one if none targeted)
}

// C31 — the resolved membership context the ROUTE computes from the graph and hands the pure `authorize`.
// Its presence turns on the C31 enforcement rules (role override, not-a-member deny, permission gating) and
// the resolved-field echo. `role`/`permissions`/`is_member`/`group_id` are authoritative (graph, not request).
export interface ResolvedMembership {
  group_id: string;
  role?: string;
  permissions: string[];
  is_member: boolean;
  // Whether this is the caller's personal group-of-one (no explicit group_id targeted). A personal group
  // never triggers the not-a-member deny (you are always a member of your own group-of-one).
  personal: boolean;
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
