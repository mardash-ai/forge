import { readdir } from 'node:fs/promises';
import { membershipDir } from '../../../shared/paths';
import type { MigratableMembershipBackend } from './types';

// C31 / P26 — the membership backfill (filesystem → Postgres). Copies each app's whole membership
// document verbatim (ids preserved). Idempotent per app (import replaces).
export async function listFsMembershipApps(): Promise<string[]> {
  try {
    const files = await readdir(membershipDir());
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

export interface BackfillMembershipResult {
  app: string;
  groups: number;
  members: number;
  invitations: number;
  roles: number;
}

export async function backfillMembership(
  from: MigratableMembershipBackend,
  to: MigratableMembershipBackend,
  appIds: string[],
): Promise<BackfillMembershipResult[]> {
  const results: BackfillMembershipResult[] = [];
  for (const app of appIds) {
    const state = await from.exportApp(app);
    await to.importApp(app, state);
    results.push({
      app,
      groups: Object.keys(state.groups).length,
      members: Object.keys(state.members).length,
      invitations: Object.keys(state.invitations).length,
      roles: state.roles.length,
    });
  }
  return results;
}
