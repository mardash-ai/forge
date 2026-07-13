import { readdir } from 'node:fs/promises';
import { billingDir } from '../../../shared/paths';
import type { MigratableBillingBackend } from './types';

// C33 / P26 — the billing backfill (filesystem → Postgres). Copies each app's whole billing document
// verbatim (catalog + subscriptions + webhook-event dedupe). Idempotent per app (import replaces).
export async function listFsBillingApps(): Promise<string[]> {
  try {
    const files = await readdir(billingDir());
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

export interface BackfillBillingResult {
  app: string;
  plans: number;
  subscriptions: number;
  webhook_events: number;
}

export async function backfillBilling(
  from: MigratableBillingBackend,
  to: MigratableBillingBackend,
  appIds: string[],
): Promise<BackfillBillingResult[]> {
  const results: BackfillBillingResult[] = [];
  for (const app of appIds) {
    const state = await from.exportApp(app);
    await to.importApp(app, state);
    results.push({
      app,
      plans: state.catalog?.plans.length ?? 0,
      subscriptions: Object.keys(state.subscriptions).length,
      webhook_events: Object.keys(state.webhook_events).length,
    });
  }
  return results;
}
