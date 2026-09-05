import { describe, it, expect } from 'vitest';
import {
  DATASOURCE_CATALOG,
  GRAFANA_BUILTIN_UIDS,
  DS_FORGE_PLATFORM_DB,
  DS_DORINDA_APP_DB,
} from '../src/console/datasource-catalog';
import { generateMonitoringCompose } from '../src/plugins/monitoring-stack/index';

// The full provisioned stack, with every optional surface ON — datasources, alert rules and all
// dashboards travel inline in the compose, so scanning IT covers every panel that can ever ship
// (including ones added after this test was written — nothing reaches a container except through
// this string).
function fullCompose(): string {
  return generateMonitoringCompose({
    publicHost: 'grafana.dorinda.ai',
    gcpProject: 'dorinda-prod',
    appDb: {
      network: 'appnet',
      host: 'db',
      port: 5432,
      database: 'forge_platform',
      user: 'grafana_ro',
      appId: 'dorinda-api',
    },
  });
}

/** Every `{ "type": ..., "uid": ... }` datasource reference in the dashboards/templating, plus
 *  every `datasourceUid:` in the provisioned alert rules. */
function referencedDatasourceUids(compose: string): Set<string> {
  const uids = new Set<string>();
  // Dashboard/templating refs: "datasource": { "type": "...", "uid": "..." } (also multiline).
  for (const m of compose.matchAll(/"datasource":\s*\{[^{}]*?"uid":\s*"([^"]+)"[^{}]*?\}/gs)) {
    uids.add(m[1]!);
  }
  // Alert-rule refs: datasourceUid: forge-prometheus | '-100' | "..."
  for (const m of compose.matchAll(/datasourceUid:\s*['"]?([^'"\s]+)['"]?/g)) {
    uids.add(m[1]!);
  }
  return uids;
}

// ─────────────────────────────────────────────────────────────────────────────
// RED PROOF (guardrail: prove a guard RED against the real bug before trusting it).
// This suite was written BEFORE the 2026-09-05 content.ts change and run against the
// then-current stack. It failed on exactly the real defect:
//
//   FAIL  tests/datasource-catalog.test.ts > datasource catalog — … > every datasource uid
//         referenced by any panel/alert/template is in the catalog
//   AssertionError: datasource uids referenced but not in the committed catalog:
//   expected [ 'forge-loki' ] to deeply equal []
//   + Array [ "forge-loki" ]
//
// (plus: "the retired forge-loki uid appears NOWHERE" — 31 occurrences; the declared-set
// test caught 'Prometheus' vs the catalog's 'Managed Prometheus' and the missing
// Forge-platform/Dorinda DB names.)
// ─────────────────────────────────────────────────────────────────────────────

describe('datasource catalog — panels may only reference committed datasources (F-DD-5)', () => {
  it('every datasource uid referenced by any panel/alert/template is in the catalog', () => {
    // Grafana does not ERROR on an unknown datasource uid — it silently substitutes the default
    // datasource with an empty query, so a wrong reference renders as a working page showing
    // nothing (verified against production 2026-09-05: an Explore link with uid `forge-loki`
    // opened the default Prometheus pane). The only durable guard is: no reference outside the
    // committed catalog, ever.
    const compose = fullCompose();
    const allowed = new Set([...DATASOURCE_CATALOG.map((d) => d.uid), ...GRAFANA_BUILTIN_UIDS]);
    const referenced = referencedDatasourceUids(compose);
    expect(referenced.size).toBeGreaterThan(2); // the scan itself must be finding refs (guard the guard)
    const rogue = [...referenced].filter((u) => !allowed.has(u)).sort();
    expect(rogue, `datasource uids referenced but not in the committed catalog`).toEqual([]);
  });

  it('every datasource DECLARED by the provisioner matches the catalog (uid + type + name)', () => {
    // The declared set is the contract's other half: a declaration whose uid/type/name is not in
    // the catalog is drift by construction (the box-era `forge-loki` declaration was exactly this).
    const compose = fullCompose();
    // The datasources config travels inline under `grafana-datasources:`; scope the scan to it.
    const dsBlock = compose.split('grafana-datasources:')[1]!.split(/\n  [a-z-]+:\n/)[0]!;
    const declared: Array<{ name: string; uid: string; type: string }> = [];
    for (const m of dsBlock.matchAll(/- name: (.+)\n\s+uid: (\S+)\n\s+type: (\S+)/g)) {
      declared.push({ name: m[1]!.trim(), uid: m[2]!, type: m[3]! });
    }
    expect(declared.length).toBeGreaterThan(2);
    for (const d of declared) {
      const entry = DATASOURCE_CATALOG.find((c) => c.uid === d.uid);
      expect(entry, `declared datasource ${d.uid} is not in the committed catalog`).toBeDefined();
      expect({ uid: d.uid, type: d.type, name: d.name }).toEqual({
        uid: entry!.uid,
        type: entry!.type,
        name: entry!.name,
      });
    }
  });

  it('the two Postgres datasources are BOTH declared, with names that say what they connect to', () => {
    const compose = fullCompose();
    // F-DD-3: "App DB (read-only)" pointed at forge_platform — the name was the bug. Both DBs are
    // now declared, each named for its actual target database.
    expect(compose).toContain(`name: ${DS_FORGE_PLATFORM_DB.name}`);
    expect(compose).toContain(`name: ${DS_DORINDA_APP_DB.name}`);
    expect(compose).not.toContain('name: App DB (read-only)');
    // Each connects to ITS database, on the same instance.
    expect(compose).toContain('database: forge_platform');
    expect(compose).toContain('database: dorinda_api');
    // Dedicated roles, never a superuser, each with its own secret.
    expect(compose).toContain('user: grafana_ro');
    expect(compose).toContain('user: grafana_dorinda_ro');
    expect(compose).toContain('$GRAFANA_PG_RO_PASSWORD');
    expect(compose).toContain('$GRAFANA_DORINDA_PG_RO_PASSWORD');
  });

  it('the retired forge-loki uid appears NOWHERE in the provisioned stack', () => {
    // Production has no Loki (logs are Cloud Logging). Declaring forge-loki made ~30 dead panels
    // look merely misconfigured instead of dead — retired 2026-09-05 per the app-db-datasource goal.
    expect(fullCompose()).not.toContain('forge-loki');
  });

  it('catalog invariants: unique uids, postgres entries carry their database', () => {
    const uids = DATASOURCE_CATALOG.map((d) => d.uid);
    expect(new Set(uids).size).toBe(uids.length);
    for (const d of DATASOURCE_CATALOG) {
      if (d.type === 'grafana-postgresql-datasource') {
        expect(d.database, `${d.uid} must pin its target database`).toBeTruthy();
      }
    }
  });
});
