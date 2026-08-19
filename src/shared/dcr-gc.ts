// src/shared/dcr-gc.ts
//
// DCR (Dynamic Client Registration) garbage collection.
// Removes OAuth clients that were registered (POST /oauth/register) but NEVER consented to —
// i.e., the user never completed the authorize → consent flow. These are typically probing
// registrations, abandoned auth flows, or connector-side errors that orphaned the client record.
//
// SAFETY RULE: ONLY clients with NO consent record AND older than maxAgeDays are deleted.
// A consented client is NEVER touched, regardless of age — it has a live user session.

import type { McpBackend } from '../storage/backends/mcp/types';

function _envInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export interface GcResult {
  checked: number;
  deleted: number;
  skipped_consented: number;
  skipped_too_recent: number;
  max_age_days: number;
}

/**
 * Delete never-consented OAuth clients older than `maxAgeDays` (default: `DCR_GC_MAX_AGE_DAYS`
 * env var, or 30 days). Consented clients are ALWAYS preserved regardless of age.
 *
 * Returns a summary useful for logging / operator dashboards.
 */
export async function gcStaleClients(
  appId: string,
  backend: McpBackend,
  opts: { maxAgeDays?: number } = {},
): Promise<GcResult> {
  const maxAgeDays = opts.maxAgeDays ?? _envInt('DCR_GC_MAX_AGE_DAYS', 30);
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;

  const [clients, consentedIds] = await Promise.all([
    backend.listClients(appId),
    backend.listConsentedClientIds(appId),
  ]);
  const consented = new Set(consentedIds);

  let deleted = 0;
  let skipped_consented = 0;
  let skipped_too_recent = 0;

  for (const client of clients) {
    if (consented.has(client.client_id)) {
      skipped_consented++;
      continue;
    }
    const createdMs = new Date(client.created_at).getTime();
    if (createdMs >= cutoff) {
      skipped_too_recent++;
      continue;
    }
    await backend.deleteClient(appId, client.client_id);
    deleted++;
  }

  return {
    checked: clients.length,
    deleted,
    skipped_consented,
    skipped_too_recent,
    max_age_days: maxAgeDays,
  };
}
