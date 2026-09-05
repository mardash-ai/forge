// Post-provision datasource check — the live half of the datasource contract.
//
// The committed catalog (`src/console/datasource-catalog.ts`) says what the estate DECLARES; a
// Grafana's `/api/datasources` says what it actually HAS. This module compares the two and fails
// on drift in EITHER direction:
//   · declared-but-missing  — a dashboard panel bound to it will silently render the DEFAULT
//     datasource with an empty query (Grafana does not error on an unknown uid — verified live
//     2026-09-05: an Explore link with the retired `forge-loki` uid opened a working-looking,
//     empty Prometheus pane);
//   · live-but-undeclared   — something was hand-provisioned outside the committed definition
//     and will be lost/contradicted on the next provision;
//   · uid matches but type/name/database differs — the F-DD-3 shape: a datasource NAMED
//     "App DB (read-only)" that actually connected to `forge_platform`.
//
// Pure comparison + a small fetcher, so tests inject fixtures and the capability/CLI reuse both.

import { DATASOURCE_CATALOG, GRAFANA_BUILTIN_UIDS } from '../../console/datasource-catalog';

/** What both halves of the contract agree on — the catalog satisfies this, and so does a
 *  parsed provisioning YAML, so the check can compare any declared set against any live set. */
export interface DatasourceContract {
  uid: string;
  type: string;
  name: string;
  database?: string;
}

/** The subset of a `/api/datasources` element the contract covers. */
export interface LiveDatasource {
  uid: string;
  type: string;
  name: string;
  /** Postgres: the connected database (`/api/datasources` reports it under jsonData.database). */
  database?: string;
}

export interface DatasourceDrift {
  uid: string;
  field: 'type' | 'name' | 'database';
  declared: string;
  live: string;
}

export interface DatasourceCheckResult {
  ok: boolean;
  /** Declared in the catalog, absent from the live Grafana. */
  missing: DatasourceContract[];
  /** Present in the live Grafana, absent from the catalog. */
  undeclared: LiveDatasource[];
  /** Same uid on both sides, but type/name/database disagree. */
  drifted: DatasourceDrift[];
  /** One human-readable line per problem — empty when ok. */
  problems: string[];
}

/** Grafana's legacy alias for the Postgres plugin — `/api/datasources` may report either. */
function normalizeType(t: string): string {
  return t === 'postgres' ? 'grafana-postgresql-datasource' : t;
}

/**
 * Compare a live `/api/datasources` payload against the committed catalog. Both directions must
 * match; Grafana built-ins (`-100`, `-- Grafana --`) are never expected to appear in either.
 */
export function checkDatasources(
  live: LiveDatasource[],
  declared: readonly DatasourceContract[] = DATASOURCE_CATALOG,
): DatasourceCheckResult {
  const liveByUid = new Map(live.map((d) => [d.uid, d]));
  const declaredUids = new Set(declared.map((d) => d.uid));

  const missing = declared.filter((d) => !liveByUid.has(d.uid));
  const undeclared = live.filter((d) => !declaredUids.has(d.uid) && !GRAFANA_BUILTIN_UIDS.includes(d.uid));

  const drifted: DatasourceDrift[] = [];
  for (const d of declared) {
    const l = liveByUid.get(d.uid);
    if (!l) continue;
    if (normalizeType(l.type) !== normalizeType(d.type)) {
      drifted.push({ uid: d.uid, field: 'type', declared: d.type, live: l.type });
    }
    if (l.name !== d.name) {
      drifted.push({ uid: d.uid, field: 'name', declared: d.name, live: l.name });
    }
    if (d.database && l.database !== undefined && l.database !== d.database) {
      drifted.push({ uid: d.uid, field: 'database', declared: d.database, live: l.database });
    }
  }

  const problems = [
    ...missing.map(
      (d) =>
        `MISSING: declared datasource ${d.uid} (${d.type} "${d.name}") is not live — panels bound to it silently render the default datasource`,
    ),
    ...undeclared.map(
      (d) => `UNDECLARED: live datasource ${d.uid} (${d.type} "${d.name}") is not in the committed catalog`,
    ),
    ...drifted.map((d) => `DRIFT: ${d.uid} ${d.field} is "${d.live}" live but "${d.declared}" declared`),
  ];

  return { ok: problems.length === 0, missing, undeclared, drifted, problems };
}

/** Parse the datasources OUT of a rendered provisioning YAML (the provisioner's declared half),
 *  so the check can also run declared-vs-declared without a live Grafana. */
export function parseProvisionedDatasources(yaml: string): LiveDatasource[] {
  // Split into one chunk per `- name:` entry (after the `datasources:` key), then read each
  // field within its own chunk so an entry without `database:` can never borrow the next one's.
  const body = yaml.split(/\ndatasources:\n/)[1];
  if (!body) return [];
  const out: LiveDatasource[] = [];
  for (const chunk of body.split(/\n\s*- name: /).slice(1)) {
    const name = chunk.split('\n')[0]!.trim();
    const uid = chunk.match(/\n\s*uid: (\S+)/)?.[1];
    const type = chunk.match(/\n\s*type: (\S+)/)?.[1];
    const database = chunk.match(/\n\s*database: (\S+)/)?.[1];
    if (uid && type) out.push({ name, uid, type, database });
  }
  return out;
}

/** Fetch the live datasource list from a Grafana. Basic-auth admin (the provisioned stack's
 *  admin user) — the caller supplies credentials; nothing is read from the environment here. */
export async function fetchLiveDatasources(
  origin: string,
  auth: { user: string; pass: string },
  fetchImpl: typeof fetch = fetch,
): Promise<LiveDatasource[]> {
  const res = await fetchImpl(`${origin.replace(/\/$/, '')}/api/datasources`, {
    headers: {
      authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64'),
      accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`GET /api/datasources returned ${res.status}`);
  const body = (await res.json()) as Array<{
    uid: string;
    type: string;
    name: string;
    jsonData?: { database?: string };
  }>;
  return body.map((d) => ({
    uid: d.uid,
    type: d.type,
    name: d.name,
    database: d.jsonData?.database,
  }));
}
