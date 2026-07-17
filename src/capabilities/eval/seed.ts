// Isolated eval-tenant seeding (C30).
//
// Each eval case runs as a THROWAWAY user so evals never touch real data. The `owner` id "just
// works" as a dorinda tenant — the group-of-one is auto-created on first tool use — so all we seed
// on the platform side is (1) the login identity and (2) an ACTIVE subscription, because dorinda's
// MCP surface hard-gates every tool on `assertActiveAccess` (→ 402 otherwise). No Stripe involved:
// we write the canonical subscription record directly, the same idempotent upsert the webhook uses.

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { createUser } from '../../plugins/auth-identity/store';
import { applyCanonicalSubscription } from '../../billing/service';
import { emptyProviderRefs } from '../../billing/types';
import { getBackends } from '../../storage/backends';
import { provisionGroup } from '../../membership/service';
import { newId } from '../../shared/ids';
import { nowIso } from '../../shared/time';

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
  // A random suffix guarantees a unique login per EXECUTION (each model × case × run seeds its own
  // throwaway user) — without it, two models in one run collide on the same email.
  const label = `${opts.suite}-${opts.caseId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 40);
  const email = `eval-${label}-${randomBytes(5).toString('hex')}@eval.forge.local`;
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

/**
 * Provision the tenant's group with the platform membership graph so write-tool C29 governance
 * passes. Apps that keep a local group model synced to the platform (like dorinda-api) key the
 * platform group by `external_id = <local group id>`; a group-of-one created after boot is never
 * synced, so the C29 gate denies with "not a member of the targeted group". This reads the local
 * group id the warm-up call just created (from the app's own DB) and ensures the platform group
 * under that id — exactly what the app's boot backfill does. Opt-in: only runs when the caller
 * passes the app DB URL (generic apps that don't gate on membership skip it entirely). Returns the
 * ensured group id, or null when the app has no local group for the owner (nothing to sync).
 */
export async function provisionTenantGroup(appId: string, ownerId: string, appDbUrl: string): Promise<string | null> {
  const db = new Client({ connectionString: appDbUrl });
  let groupId: string | null = null;
  try {
    await db.connect();
    const r = await db.query('SELECT group_id FROM group_members WHERE person_id = $1 ORDER BY added_at ASC LIMIT 1', [ownerId]);
    groupId = r.rows[0] ? String((r.rows[0] as { group_id: unknown }).group_id) : null;
  } finally {
    await db.end().catch(() => {});
  }
  if (!groupId) return null;
  await (await getBackends()).membership.mutate(appId, (s) =>
    provisionGroup(s, { owner: ownerId, external_id: groupId!, now: nowIso(), newGroupId: newId('grp'), dedupeOwnerSingleton: true }),
  );
  return groupId;
}
