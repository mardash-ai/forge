import { readdir } from 'node:fs/promises';
import { policiesDir } from '../../../shared/paths';
import type { MigratablePolicyBackend } from './types';

// C29 / P26 — the policy backfill (filesystem → Postgres). Copies each app's policies verbatim (ids
// preserved). Idempotent per app (import replaces).
export async function listFsPolicyApps(): Promise<string[]> {
  try {
    const files = await readdir(policiesDir());
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

export interface BackfillPoliciesResult {
  app: string;
  policies: number;
}

export async function backfillPolicies(
  from: MigratablePolicyBackend,
  to: MigratablePolicyBackend,
  appIds: string[],
): Promise<BackfillPoliciesResult[]> {
  const results: BackfillPoliciesResult[] = [];
  for (const app of appIds) {
    const policies = await from.exportApp(app);
    await to.importApp(app, policies);
    results.push({ app, policies: policies.length });
  }
  return results;
}
