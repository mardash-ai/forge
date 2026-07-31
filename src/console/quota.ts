/**
 * Quota headroom. PURE — given what exists and what it peaked at, how close is it to a ceiling?
 *
 * The motivating case is not a cloud quota at all: forge's own service module hardcodes Cloud Run
 * `max_instances = 10`. Nobody chose 10 for Dorinda; it is a default that becomes a traffic cliff on
 * the first day it matters, and no dashboard anywhere mentions it.
 *
 * ⛔ A limit is never invented. `limit: null` renders as "no published ceiling" — a headroom
 * percentage computed against a guessed limit is worse than no percentage, because it looks precise.
 */
import type { InfraResource, QuotaGauge } from './domain';

export interface QuotaInput {
  resources: readonly InfraResource[];
  /** Peak observed value per Cloud Run service over the sample window. */
  peakInstances: ReadonlyMap<string, number>;
  /** Peak database connections, if the metric answered. */
  peakDbConnections: number | null;
  /** Whatever providers volunteered about their own limits (API rate, CI minutes). */
  providerGauges: readonly QuotaGauge[];
}

const pct = (used: number | null, limit: number | null): number | null =>
  used === null || limit === null || limit === 0 ? null : Math.round(((limit - used) / limit) * 100);

export function computeQuotas(input: QuotaInput): QuotaGauge[] {
  const out: QuotaGauge[] = [];

  for (const r of input.resources) {
    if (r.kind !== 'compute.service') continue;
    const limit = r.attributes['max_instances'] === null ? null : Number(r.attributes['max_instances']);
    const used = input.peakInstances.get(r.name) ?? null;
    out.push({
      name: `${r.name} instances`,
      scope: 'cloud-run',
      used: used === null ? null : Math.round(used * 100) / 100,
      limit,
      unit: 'instances',
      detail:
        limit === null
          ? 'no max_instances set — this service can scale until the project quota stops it'
          : `peak over the sample window against a ceiling of ${limit}`,
      headroom_percent: pct(used, limit),
    });
  }

  const db = input.resources.find((r) => r.kind === 'db.instance');
  if (db) {
    out.push({
      name: `${db.name} connections`,
      scope: 'cloud-sql',
      used: input.peakDbConnections,
      // Cloud SQL derives max_connections from the tier and does not publish it through the admin
      // API. Guessing the formula would produce a confident, wrong number.
      limit: null,
      unit: 'connections',
      detail: 'Cloud SQL does not publish max_connections through the API; shown as an absolute peak',
      headroom_percent: null,
    });
  }

  out.push(...input.providerGauges);

  // Tightest headroom first — that is the one about to bite. Unknown headroom sorts last rather
  // than being dropped, because "we cannot see this ceiling" is itself worth reading.
  return out.sort((a, b) => {
    if (a.headroom_percent === null && b.headroom_percent === null) return a.name.localeCompare(b.name);
    if (a.headroom_percent === null) return 1;
    if (b.headroom_percent === null) return -1;
    return a.headroom_percent - b.headroom_percent;
  });
}
