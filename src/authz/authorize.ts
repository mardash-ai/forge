import {
  DEFAULT_HIGH_RISK,
  actionClass,
  type Actor,
  type Action,
  type PolicyRule,
  type PolicyMatch,
  type AuthzDecision,
  type HighRiskSpec,
  type Decision,
  type ResolvedMembership,
} from './types';

// C29 — the PURE, DETERMINISTIC enforcement point. No I/O, no model calls: given the same actor + action
// + policies it always returns the same decision. This is the mirrorable core (like `shared/session.ts`
// and `shared/health.ts`): a consumer app can copy it and evaluate locally, or call the platform's
// POST /authorize (which loads the policies + records the decision to C3). Recording + persistence are
// the caller's / the route's job — this function is a pure decision.

export interface AuthorizeOptions {
  // The high-risk class set (non-overridable by any policy). Configurable per app; defaults to the
  // shipped conservative set (external sends, spending, new contacts, irreversible, send/pay/… types).
  highRiskClasses?: HighRiskSpec;
  // The decision when NO policy matches and the action is not high-risk. Conservative default:
  // 'needs-approval' (progressive autonomy — grant autonomy explicitly via policies). Apps may set 'allow'.
  defaultDecision?: Decision;
  // Injectable clock (ISO). Defaults to action.at, then now — so decisions are reproducible in tests.
  now?: string;
  // C31 — the RESOLVED membership context (role/permissions/is_member/group_id), computed server-side from
  // the membership graph by the route. Its PRESENCE turns on the C31 rules (role override, not-a-member
  // deny, permission gating) + echoes the resolved fields. ABSENT (every pre-C31 caller) ⇒ byte-identical
  // to the legacy verdict — the request's `role` is honored and no new floor can fire.
  membership?: ResolvedMembership;
}

// True iff the action falls into a configured high-risk class. This is the SAFETY FLOOR input — its
// result forces `needs-approval` and cannot be downgraded by any policy.
export function isHighRisk(action: Action, spec: HighRiskSpec = DEFAULT_HIGH_RISK): boolean {
  if (spec.tools && action.tool !== undefined && spec.tools.includes(action.tool)) return true;
  if (spec.action_types && action.type !== undefined && spec.action_types.includes(action.type)) return true;
  if (spec.channels && action.channel !== undefined && spec.channels.includes(action.channel)) return true;
  if ((spec.irreversible ?? true) && action.reversibility === 'irreversible') return true;
  if ((spec.spending ?? true) && typeof action.amount === 'number' && action.amount > (spec.minAmount ?? 0)) return true;
  if ((spec.newContact ?? true) && action.contact !== undefined && action.contact !== '' && action.contact_known !== true) return true;
  return false;
}

// A list-dimension matches when the rule sets no constraint, or the action's value is present AND in the
// set. (An absent constraint never narrows; an absent action value fails a present constraint.)
function inSet(set: string[] | undefined, value: string | undefined): boolean {
  if (!set || set.length === 0) return true;
  return value !== undefined && set.includes(value);
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function inTimeWindow(win: NonNullable<PolicyMatch['time']>, nowIso: string): boolean {
  const d = new Date(nowIso);
  if (Number.isNaN(d.getTime())) return false;
  if (win.days && win.days.length > 0) {
    const dow = d.getUTCDay();
    const ok = win.days.some((entry) => {
      const e = String(entry).toLowerCase();
      return e === DAY_NAMES[dow] || e === String(dow);
    });
    if (!ok) return false;
  }
  if (win.start || win.end) {
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    const toMin = (s?: string): number | undefined => {
      if (!s) return undefined;
      const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
      return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
    };
    const start = toMin(win.start);
    const end = toMin(win.end);
    if (start !== undefined && mins < start) return false;
    if (end !== undefined && mins > end) return false;
  }
  return true;
}

// C31 — a permission gate on a rule is satisfied when EVERY listed token is in the caller's resolved
// permission set. Absent/empty = no constraint (so a pre-C31 policy, which has none, is unaffected).
function permissionsSatisfied(required: string[] | undefined, held: string[]): boolean {
  if (!required || required.length === 0) return true;
  return required.every((p) => held.includes(p));
}

// Whether a rule's conditions all hold for this actor + action (conditions are ANDed; empty match = all).
// C31: `effectiveRole` is the RESOLVED role (graph, not request) when membership was resolved, else the
// request role (legacy); `held` is the resolved permission set (empty when no membership was resolved).
function matchApplies(
  match: PolicyMatch,
  effectiveRole: string | undefined,
  held: string[],
  action: Action,
  nowIso: string,
): boolean {
  if (!inSet(match.tool, action.tool)) return false;
  if (!inSet(match.type, action.type)) return false;
  if (!inSet(match.contact, action.contact)) return false;
  if (!inSet(match.domain, action.domain)) return false;
  if (!inSet(match.channel, action.channel)) return false;
  if (!inSet(match.project, action.project)) return false;
  if (!inSet(match.location, action.location)) return false;
  if (!inSet(match.device, action.device)) return false;
  if (!inSet(match.data_sensitivity, action.data_sensitivity)) return false;
  if (!inSet(match.reversibility, action.reversibility)) return false;
  if (!inSet(match.role, effectiveRole)) return false;
  if (!permissionsSatisfied(match.permission, held)) return false;
  if (match.max_amount !== undefined) {
    if (typeof action.amount !== 'number' || action.amount > match.max_amount) return false;
  }
  if (match.time && !inTimeWindow(match.time, nowIso)) return false;
  return true;
}

// The actor's applicable policies, HIGHEST-PRIORITY first (deterministic id tiebreak). A policy applies
// when it is app-wide (no owner) OR belongs to the actor's owner, and its match holds. (A matching DENY
// is deny-overrides — handled in `authorize` before priority, so a low-priority deny still beats a
// high-priority allow.) `effectiveRole`/`held` carry the C31-resolved role + permission set.
export function applicablePolicies(
  actor: Actor,
  action: Action,
  policies: PolicyRule[],
  nowIso: string,
  effectiveRole?: string,
  held: string[] = [],
): PolicyRule[] {
  return policies
    .filter((p) => p.owner === undefined || p.owner === null || p.owner === actor.owner)
    .filter((p) => matchApplies(p.match, effectiveRole, held, action, nowIso))
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// C31 — the PRIVATE-LEAK FLOOR (pure): is `caller` NOT entitled to see the targeted resource, given its
// stored scope? Returns the deny rule id, or null when the caller is entitled / no scope was supplied.
//   - private: only the resource owner may act (deny anyone else).
//   - shared:  only the resource owner OR a listed `shared_with` identity may act.
//   - group:   visible to the whole targeted group (membership is gated by the not-a-member floor), so no
//              per-resource leak check here.
function privateLeak(caller: string, action: Action): 'private-resource' | null {
  const { visibility, resource_owner, shared_with } = action;
  if (visibility === 'private') {
    return resource_owner !== undefined && resource_owner !== caller ? 'private-resource' : null;
  }
  if (visibility === 'shared') {
    const inShare = (shared_with ?? []).includes(caller);
    return !inShare && resource_owner !== caller ? 'private-resource' : null;
  }
  return null;
}

// THE enforcement point. Deterministic. Order of precedence:
//   0. C31 STRUCTURAL FLOORS (only when membership was resolved / a resource scope was supplied):
//        a. NOT-A-MEMBER — a non-personal group you don't belong to → deny.
//        b. PRIVATE-LEAK — the targeted resource's scope excludes you → deny (a private/shared row can't
//           leak to another group member).
//   1. A matching DENY policy wins (strictest) — even over the safety floor.
//   2. SAFETY FLOOR: a high-risk action ALWAYS returns needs-approval — NON-OVERRIDABLE (an allow policy
//      can never downgrade it).
//   3. Otherwise the strongest matching policy's effect (allow | needs-approval) — priority-ordered.
//   4. No policy matched → the default posture (conservative 'needs-approval'; configurable to 'allow').
// Role matching + permission gating (step 3) use the RESOLVED role/permissions when membership is present,
// NEVER the request's `role`. With NO membership + NO resource scope this is byte-identical to pre-C31.
export function authorize(actor: Actor, action: Action, policies: PolicyRule[], opts: AuthorizeOptions = {}): AuthzDecision {
  const now = opts.now ?? action.at ?? new Date().toISOString();
  const spec = opts.highRiskClasses ?? DEFAULT_HIGH_RISK;
  const cls = actionClass(action);
  const highRisk = isHighRisk(action, spec);
  const m = opts.membership;
  // C31: the resolved role/permissions override the request when membership was resolved server-side.
  const effectiveRole = m ? m.role : actor.role;
  const held = m ? m.permissions : [];
  const applicable = applicablePolicies(actor, action, policies, now, effectiveRole, held);

  // The platform-resolved membership fields to echo — present ONLY when membership was resolved (so a
  // pre-C31 decision object is unchanged).
  const resolved: Pick<AuthzDecision, 'role' | 'permissions' | 'is_member' | 'group_id'> = m
    ? { role: m.role, permissions: m.permissions, is_member: m.is_member, group_id: m.group_id }
    : {};

  // 0a. NOT-A-MEMBER floor — targeting a group you don't belong to (personal group-of-one is exempt).
  if (m && !m.personal && !m.is_member) {
    return { decision: 'deny', rule: 'not-a-member', reason: 'caller is not a member of the targeted group', high_risk: highRisk, action_class: cls, ...resolved };
  }
  // 0b. PRIVATE-LEAK floor — the caller is not entitled to the targeted resource.
  const leak = privateLeak(actor.owner, action);
  if (leak) {
    return { decision: 'deny', rule: leak, reason: 'caller is not entitled to the targeted resource (private-leak floor)', high_risk: highRisk, action_class: cls, ...resolved };
  }

  const deny = applicable.find((p) => p.effect === 'deny');
  if (deny) {
    return { decision: 'deny', rule: deny.id, reason: deny.reason ?? 'denied by policy', high_risk: highRisk, action_class: cls, ...resolved };
  }
  if (highRisk) {
    return {
      decision: 'needs-approval',
      rule: `safety-floor:${cls}`,
      reason: 'high-risk action class always requires approval (non-overridable safety floor)',
      high_risk: true,
      action_class: cls,
      ...resolved,
    };
  }
  const governing = applicable[0];
  if (governing) {
    return {
      decision: governing.effect,
      rule: governing.id,
      reason: governing.reason ?? `governed by policy ${governing.id}`,
      high_risk: false,
      action_class: cls,
      ...resolved,
    };
  }
  return {
    decision: opts.defaultDecision ?? 'needs-approval',
    rule: 'default',
    reason: 'no policy matched; default posture',
    high_risk: false,
    action_class: cls,
    ...resolved,
  };
}
