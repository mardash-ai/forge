// C33 — Billing health-deep checks. Run by the /health/deep endpoint on both planes.
// Returns a list of CheckResult entries for aggregateHealth to roll up.
// When no apps have billing configured this is effectively a no-op (empty list → 'ok').

import { store } from '../storage/store';
import { getCatalog } from '../billing/service';
import { checkStripeModeConsistency } from '../billing/mode-guard';
import type { CheckResult } from './health';
import type { Application } from '../resources/types';
import type { PlanDef } from '../billing/types';

/**
 * Run the billing deep-health checks for every Application in the store.
 * For each app that has a Stripe secret key configured, retrieve one catalog price
 * and verify that its livemode matches the key prefix. A mismatch makes the check
 * `unavailable` (required:true → 503 on the /health/deep response).
 */
export async function runBillingDeepChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  let apps: Application[];
  try {
    const all = await store.listResources({ type: 'Application' });
    apps = all.filter((r): r is Application => r.type === 'Application');
  } catch {
    // Store unreadable — report as unavailable.
    results.push({
      name: 'billing-mode',
      status: 'unavailable',
      required: true,
      detail: 'Could not list apps from store to run billing mode check.',
    });
    return results;
  }

  if (apps.length === 0) {
    return results; // no apps yet → no billing → no check needed
  }

  for (const app of apps) {
    let catalog: { plans: PlanDef[] } | null = null;
    try {
      catalog = await getCatalog(app.id);
    } catch {
      catalog = null;
    }
    try {
      const check = await checkStripeModeConsistency(app.id, catalog);
      if (!check.configured) continue; // billing not configured for this app → skip
      results.push({
        name: `billing-mode:${app.name}`,
        status: check.ok ? 'ok' : 'unavailable',
        required: true,
        ...(check.detail && !check.ok ? { detail: check.detail } : {}),
      });
    } catch (err) {
      results.push({
        name: `billing-mode:${app.name}`,
        status: 'unavailable',
        required: true,
        detail: `Billing mode check failed: ${(err as Error)?.message ?? String(err)}`,
      });
    }
  }
  return results;
}
