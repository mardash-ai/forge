import { describe, it, expect } from 'vitest';
import {
  checkDatasources,
  parseProvisionedDatasources,
  fetchLiveDatasources,
  type LiveDatasource,
} from '../src/plugins/monitoring-stack/datasource-check';
import { renderResolvedDatasources } from '../src/plugins/monitoring-stack/index';
import { DATASOURCE_CATALOG } from '../src/console/datasource-catalog';

// ─────────────────────────────────────────────────────────────────────────────
// RED PROOF (guardrail: prove a guard RED against the real bug before trusting it).
// Before the 2026-09-05 fix, this check run — TODAY'S declared datasources vs the live
// production /api/datasources — failed with exactly the real drift:
//
//   AssertionError: expected [ …(4) ] to deeply equal []
//   + "MISSING: declared datasource forge-loki (loki \"Loki\") is not live — panels bound
//      to it silently render the default datasource",
//   + "UNDECLARED: live datasource cloud-logging (googlecloud-logging-datasource
//      \"Cloud Logging\") is not in the committed catalog",
//   + "UNDECLARED: live datasource cloud-monitoring (stackdriver \"Cloud Monitoring\")
//      is not in the committed catalog",
//   + "DRIFT: forge-prometheus name is \"Managed Prometheus\" live but \"Prometheus\" declared",
//
// (First parser attempt returned [] silently and flagged everything UNDECLARED — the
// "guard that certifies coverage it never looked at" failure mode; the parser now has its
// own found-something assertions below.)
// ─────────────────────────────────────────────────────────────────────────────

/** Production grafana.dorinda.ai /api/datasources as it MUST look after the shared-infra
 *  adopter lands (dorinda-appdb added, forge-appdb renamed). */
const LIVE_POST_ADOPTION: LiveDatasource[] = [
  { uid: 'forge-prometheus', type: 'prometheus', name: 'Managed Prometheus' },
  { uid: 'cloud-logging', type: 'googlecloud-logging-datasource', name: 'Cloud Logging' },
  { uid: 'cloud-monitoring', type: 'stackdriver', name: 'Cloud Monitoring' },
  {
    uid: 'forge-appdb',
    type: 'grafana-postgresql-datasource',
    name: 'Forge platform DB (read-only)',
    database: 'forge_platform',
  },
  {
    uid: 'dorinda-appdb',
    type: 'grafana-postgresql-datasource',
    name: 'Dorinda app DB (read-only)',
    database: 'dorinda_api',
  },
];

/** Production as read live 2026-09-05 (deep-dive inventory) — BEFORE adoption. */
const LIVE_PRODUCTION_2026_09_05: LiveDatasource[] = [
  { uid: 'cloud-logging', type: 'googlecloud-logging-datasource', name: 'Cloud Logging' },
  { uid: 'forge-prometheus', type: 'prometheus', name: 'Managed Prometheus' },
  { uid: 'cloud-monitoring', type: 'stackdriver', name: 'Cloud Monitoring' },
  {
    uid: 'forge-appdb',
    type: 'grafana-postgresql-datasource',
    name: 'App DB (read-only)',
    database: 'forge_platform',
  },
];

function declaredFull() {
  const declared = parseProvisionedDatasources(
    renderResolvedDatasources({
      gcpProject: 'dorinda-prod',
      appDb: { network: 'n', host: 'db', database: 'forge_platform' },
    }),
  );
  // The parser must actually FIND the declarations — an empty declared set would make every
  // comparison below pass-or-fail for the wrong reason (the worthless-guard mode).
  expect(declared.length).toBe(DATASOURCE_CATALOG.length);
  return declared;
}

describe('post-provision datasource check (F-DD-5)', () => {
  it('is GREEN when the live Grafana matches the declared set exactly', () => {
    const result = checkDatasources(LIVE_POST_ADOPTION, declaredFull());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('the full declared set IS the committed catalog (uid+type+name+database)', () => {
    // Two halves of the same contract: the provisioner's declarations must be the catalog,
    // not merely overlap with it.
    const declared = declaredFull();
    expect(declared.map(({ uid, type, name }) => ({ uid, type, name }))).toEqual(
      DATASOURCE_CATALOG.map(({ uid, type, name }) => ({ uid, type, name })),
    );
    for (const c of DATASOURCE_CATALOG) {
      if (c.database) {
        expect(declared.find((d) => d.uid === c.uid)?.database).toBe(c.database);
      }
    }
  });

  it('FAILS against pre-adoption production: dorinda-appdb missing + forge-appdb still misnamed', () => {
    // This is the exact drift the shared-infra adopter task must close. When production is
    // updated, this fixture documents what changed and why.
    const result = checkDatasources(LIVE_PRODUCTION_2026_09_05, declaredFull());
    expect(result.ok).toBe(false);
    expect(result.missing.map((d) => d.uid)).toEqual(['dorinda-appdb']);
    expect(result.drifted).toEqual([
      {
        uid: 'forge-appdb',
        field: 'name',
        declared: 'Forge platform DB (read-only)',
        live: 'App DB (read-only)',
      },
    ]);
  });

  it('FAILS when the live Grafana carries an undeclared datasource (the forge-loki shape)', () => {
    const result = checkDatasources(
      [...LIVE_POST_ADOPTION, { uid: 'forge-loki', type: 'loki', name: 'Loki' }],
      declaredFull(),
    );
    expect(result.ok).toBe(false);
    expect(result.undeclared.map((d) => d.uid)).toEqual(['forge-loki']);
  });

  it('FAILS when a postgres datasource points at the WRONG database (the F-DD-3 lie)', () => {
    const tampered = LIVE_POST_ADOPTION.map((d) =>
      d.uid === 'dorinda-appdb' ? { ...d, database: 'forge_platform' } : d,
    );
    const result = checkDatasources(tampered, declaredFull());
    expect(result.ok).toBe(false);
    expect(result.drifted).toEqual([
      { uid: 'dorinda-appdb', field: 'database', declared: 'dorinda_api', live: 'forge_platform' },
    ]);
  });

  it('treats the legacy "postgres" type alias as grafana-postgresql-datasource', () => {
    const aliased = LIVE_POST_ADOPTION.map((d) =>
      d.type === 'grafana-postgresql-datasource' ? { ...d, type: 'postgres' } : d,
    );
    expect(checkDatasources(aliased, declaredFull()).ok).toBe(true);
  });

  it('ignores Grafana built-ins in the live list (-100, -- Grafana --)', () => {
    const withBuiltins = [
      ...LIVE_POST_ADOPTION,
      { uid: '-100', type: '__expr__', name: 'Expression' },
      { uid: '-- Grafana --', type: 'datasource', name: 'Grafana' },
    ];
    expect(checkDatasources(withBuiltins, declaredFull()).ok).toBe(true);
  });

  it('a partial stack (no appDb) declares a SUBSET of the catalog and checks against that subset', () => {
    const declared = parseProvisionedDatasources(renderResolvedDatasources({ gcpProject: 'p' }));
    expect(declared.map((d) => d.uid).sort()).toEqual([
      'cloud-logging',
      'cloud-monitoring',
      'forge-prometheus',
    ]);
    // every declared entry is still catalog-derived
    for (const d of declared) {
      expect(DATASOURCE_CATALOG.find((c) => c.uid === d.uid)?.name).toBe(d.name);
    }
  });

  it('fetchLiveDatasources maps /api/datasources (incl. jsonData.database) and rejects non-200', async () => {
    const payload = [
      {
        uid: 'forge-appdb',
        type: 'grafana-postgresql-datasource',
        name: 'Forge platform DB (read-only)',
        jsonData: { database: 'forge_platform' },
      },
    ];
    const okFetch = (async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch;
    const live = await fetchLiveDatasources('http://g:3000/', { user: 'admin', pass: 'x' }, okFetch);
    expect(live).toEqual([
      {
        uid: 'forge-appdb',
        type: 'grafana-postgresql-datasource',
        name: 'Forge platform DB (read-only)',
        database: 'forge_platform',
      },
    ]);
    const badFetch = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    await expect(
      fetchLiveDatasources('http://g:3000', { user: 'admin', pass: 'x' }, badFetch),
    ).rejects.toThrow('401');
  });
});
