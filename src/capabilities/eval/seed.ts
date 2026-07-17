// Isolated eval-tenant seeding (C30).
//
// Each eval case runs as a THROWAWAY user so evals never touch real data. The `owner` id "just
// works" as a dorinda tenant — the group-of-one is auto-created on first tool use — so all we seed
// on the platform side is (1) the login identity and (2) an ACTIVE subscription, because dorinda's
// MCP surface hard-gates every tool on `assertActiveAccess` (→ 402 otherwise). No Stripe involved:
// we write the canonical subscription record directly, the same idempotent upsert the webhook uses.

import { createUser } from '../../plugins/auth-identity/store';
import { applyCanonicalSubscription } from '../../billing/service';
import { emptyProviderRefs } from '../../billing/types';

export interface EvalTenant {
  ownerId: string;
  email: string;
}

/** Seed a throwaway user + active subscription for one eval case. A unique email per
 * (suite, case, run) keeps eval tenants isolated from each other and from real users. */
export async function seedEvalTenant(
  appId: string,
  opts: { suite: string; caseId: string; runId: string },
): Promise<EvalTenant> {
  const slug = `${opts.suite}-${opts.caseId}-${opts.runId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 60);
  const email = `eval+${slug}@eval.forge.local`;
  const user = await createUser(appId, {
    email,
    email_verified: true,
    name: `Eval ${opts.suite}/${opts.caseId}`,
  });
  // Grant active access so write tools don't 402. `subscriber = owner` (payer for a group-of-one);
  // version = wall-clock so this is always the newest snapshot for a brand-new subscriber.
  await applyCanonicalSubscription(
    appId,
    {
      subscriber: user.id,
      app: appId,
      plan_key: null,
      status: 'active',
      source: 'stripe',
      current_period_end: null,
      cancel_at_period_end: false,
      trial_end: null,
      currency: null,
      scope_ref: null,
      provider_refs: emptyProviderRefs(),
    },
    Date.now(),
  );
  return { ownerId: user.id, email };
}
