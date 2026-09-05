#!/usr/bin/env tsx
// Grafana datasource contract check — live /api/datasources vs the committed catalog.
//
// The same comparison ProvisionMonitoring runs post-provision, runnable standalone against ANY
// Grafana (notably production grafana.dorinda.ai, which is provisioned by dorinda-metrics, not
// by the compose stack). Exits 1 on drift in either direction:
//   · a declared datasource missing live (panels bound to it silently render the default DS)
//   · a live datasource the catalog does not declare
//   · uid present but type/name/database drifted (the "App DB (read-only) → forge_platform" lie)
//
// Usage:
//   npx tsx scripts/check-grafana-datasources.ts --origin https://grafana.dorinda.ai \
//     --user admin --password <pass>
//
// Environment fallbacks: GRAFANA_ORIGIN, GRAFANA_USER (default admin), GRAFANA_PASSWORD.

import { checkDatasources, fetchLiveDatasources } from '../src/plugins/monitoring-stack/datasource-check';
import { DATASOURCE_CATALOG } from '../src/console/datasource-catalog';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const origin = arg('--origin') ?? process.env.GRAFANA_ORIGIN;
  const user = arg('--user') ?? process.env.GRAFANA_USER ?? 'admin';
  const pass = arg('--password') ?? process.env.GRAFANA_PASSWORD;
  if (!origin || !pass) {
    console.error('usage: check-grafana-datasources --origin <url> [--user admin] --password <pass>');
    process.exit(2);
  }

  const live = await fetchLiveDatasources(origin, { user, pass });
  const result = checkDatasources(live, DATASOURCE_CATALOG);

  console.log(`datasource contract — ${origin} vs the committed catalog:`);
  for (const d of DATASOURCE_CATALOG) {
    const present = live.some((l) => l.uid === d.uid);
    console.log(`  ${present ? '·' : '✗'} ${d.uid.padEnd(18)} ${d.type.padEnd(32)} "${d.name}"`);
  }
  if (result.ok) {
    console.log(`✓ OK — ${live.length} live datasources match the catalog exactly`);
    return;
  }
  console.error('✗ DRIFT:');
  for (const p of result.problems) console.error(`  · ${p}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
