import type {
  Catalog,
  EntitlementMap,
  EntitlementValue,
  PlanDef,
  SubscriptionRecord,
  SubscriptionStatus,
} from './types';

// C33 — the PLATFORM-OWNED derivation of the flat entitlement map from the subscription-of-record + the
// app catalog. Consumers check an entitlement KEY; they never see a price id / receipt. The rules:
//   active | trialing            → the ACTIVE plan's entitlement map
//   past_due | incomplete        → GRACE: keep the paid entitlements THROUGH current_period_end, then free
//   canceled | none              → the free/default plan's entitlements
// Values are boolean|number|string; keys are app-defined and the platform copies them through verbatim.

export function defaultPlan(catalog: Catalog | null): PlanDef | null {
  if (!catalog) return null;
  return catalog.plans.find((p) => p.is_default) ?? null;
}

export function planByKey(catalog: Catalog | null, planKey: string | null): PlanDef | null {
  if (!catalog || !planKey) return null;
  return catalog.plans.find((p) => p.plan_key === planKey) ?? null;
}

// Whether the record's status grants the subscriber their OWN (paid) plan right now — accounting for the
// grace window on past_due / incomplete.
export function grantsPaidPlan(record: SubscriptionRecord, now: Date = new Date()): boolean {
  switch (record.status) {
    case 'active':
    case 'trialing':
      return true;
    case 'past_due':
    case 'incomplete':
      // GRACE: paid entitlements persist until the paid-through boundary; then the subscriber falls to free.
      if (!record.current_period_end) return false;
      return new Date(record.current_period_end).getTime() > now.getTime();
    case 'paused':   // §1D: trial ended with no card; read-only grace, no entitlements, not terminal
    case 'canceled':
    case 'none':
    default:
      return false;
  }
}

// The plan whose entitlement map is IN EFFECT for this record right now (the paid plan while entitled,
// otherwise the free/default plan). Returns null when neither resolves (no catalog / empty catalog).
export function effectivePlan(
  record: SubscriptionRecord,
  catalog: Catalog | null,
  now: Date = new Date(),
): { plan: PlanDef | null; fromPaidPlan: boolean } {
  const paid = planByKey(catalog, record.plan_key);
  if (paid && grantsPaidPlan(record, now)) return { plan: paid, fromPaidPlan: true };
  return { plan: defaultPlan(catalog), fromPaidPlan: false };
}

// The flat, derived entitlement map for a subscriber (the `GET /billing/entitlements` payload body).
export function deriveEntitlements(
  record: SubscriptionRecord,
  catalog: Catalog | null,
  now: Date = new Date(),
): { plan_key: string | null; source: SubscriptionRecord['source']; status: SubscriptionStatus; entitlements: EntitlementMap } {
  const { plan } = effectivePlan(record, catalog, now);
  return {
    plan_key: plan?.plan_key ?? null,
    source: record.source,
    status: record.status,
    entitlements: plan ? { ...plan.entitlements } : {},
  };
}

// A single entitlement KEY: its typed value + whether it came from the subscriber's own plan or the free
// default. An undefined key resolves to value:null (the app treats null/absent as "not entitled").
export function deriveEntitlement(
  record: SubscriptionRecord,
  catalog: Catalog | null,
  key: string,
  now: Date = new Date(),
): { key: string; value: EntitlementValue | null; source: 'plan' | 'default'; plan_key: string | null } {
  const { plan, fromPaidPlan } = effectivePlan(record, catalog, now);
  const value = plan && key in plan.entitlements ? plan.entitlements[key]! : null;
  return {
    key,
    value,
    source: fromPaidPlan ? 'plan' : 'default',
    plan_key: plan?.plan_key ?? null,
  };
}
