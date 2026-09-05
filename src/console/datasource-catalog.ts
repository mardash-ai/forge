// THE canonical Grafana datasource catalog — ONE committed uid/type/name per datasource.
//
// Why this file exists (deep-dive inventory 2026-09-05, findings F-DD-3 / F-DD-5):
//   · Production Grafana had a datasource named "App DB (read-only)" (`forge-appdb`) that was NOT
//     the app database — it pointed at `forge_platform`, so `select count(*) from events` failed
//     and none of dorinda-api's tables were queryable from any UI. A name that lies is a defect.
//   · `monitoring-stack/content.ts` declared a `forge-loki` datasource that production does not
//     have (production logs are Cloud Logging). Grafana SILENTLY substitutes its default
//     datasource when a panel references an unknown uid, so a wrong declaration renders as a
//     working page showing nothing — the most expensive kind of broken.
//
// The contract (guardrail: a contract has two halves — write the names ONCE):
//   · The monitoring-stack provisioner derives its datasource declarations from THIS list.
//   · Every dashboard panel / alert rule / templating variable derives its datasource
//     `{ type, uid }` from THIS list — never a literal.
//   · The post-provision check (`monitoring-stack/datasource-check.ts`) compares THIS list
//     against a live `/api/datasources` and fails on drift in either direction.
//   · Anything that emits Grafana Explore deep links must only ever use uids from THIS list —
//     an unknown uid does not error, it silently shows the default datasource with an empty query.
//
// Pure data — no imports, no I/O — importable from plugins, capabilities, the console, and tests.

export interface DatasourceCatalogEntry {
  /** Fixed Grafana uid — referenced by panels, alert rules, and Explore deep links. */
  uid: string;
  /** Grafana datasource plugin id, exactly as `/api/datasources` reports it. */
  type: string;
  /** Canonical display name — it must say what the datasource CONNECTS TO. */
  name: string;
  /** Postgres datasources only: the database the connection MUST target (the F-DD-3 lie guard). */
  database?: string;
}

/** Metrics — Prometheus-compatible. Locally a Prometheus container; in production the
 *  Google Managed Prometheus frontend proxy. The uid is box-era and load-bearing (every
 *  metrics panel binds to it), so it stays `forge-prometheus`. */
export const DS_PROMETHEUS: DatasourceCatalogEntry = {
  uid: 'forge-prometheus',
  type: 'prometheus',
  name: 'Managed Prometheus',
};

/** Logs — Google Cloud Logging. This is THE logs datasource: production has no Loki
 *  (the box-era `forge-loki` uid is retired; declaring it made ~30 dead panels look
 *  merely misconfigured). */
export const DS_CLOUD_LOGGING: DatasourceCatalogEntry = {
  uid: 'cloud-logging',
  type: 'googlecloud-logging-datasource',
  name: 'Cloud Logging',
};

/** GCP service metrics (Cloud Run RED metrics, Cloud SQL) — the Service Health dashboard. */
export const DS_CLOUD_MONITORING: DatasourceCatalogEntry = {
  uid: 'cloud-monitoring',
  type: 'stackdriver',
  name: 'Cloud Monitoring',
};

/** Forge's own platform database (`forge_platform`: forge_identity_users + forge_app_events),
 *  via a dedicated SELECT-only role — NEVER a superuser. This is the datasource that used to be
 *  named "App DB (read-only)" — a lie, since it cannot see the app's data (F-DD-3). The uid is
 *  kept (the User Experience email picker binds to it); the NAME now says what it connects to. */
export const DS_FORGE_PLATFORM_DB: DatasourceCatalogEntry = {
  uid: 'forge-appdb',
  type: 'grafana-postgresql-datasource',
  name: 'Forge platform DB (read-only)',
  database: 'forge_platform',
};

/** dorinda-api's application database (`dorinda_api` — events, messages, approvals, all 41
 *  migrations' tables), on the SAME instance as forge_platform (dorinda-pg hosts both — verified
 *  2026-09-05), via its OWN dedicated SELECT-only role — NEVER a superuser, never the forge
 *  platform role. This is the datasource F-DD-3 found missing: without it there is no UI that
 *  can query the app's data at all. */
export const DS_DORINDA_APP_DB: DatasourceCatalogEntry = {
  uid: 'dorinda-appdb',
  type: 'grafana-postgresql-datasource',
  name: 'Dorinda app DB (read-only)',
  database: 'dorinda_api',
};

/** The catalog — the complete set of datasources the estate declares. Order is display order. */
export const DATASOURCE_CATALOG: readonly DatasourceCatalogEntry[] = [
  DS_PROMETHEUS,
  DS_CLOUD_LOGGING,
  DS_CLOUD_MONITORING,
  DS_FORGE_PLATFORM_DB,
  DS_DORINDA_APP_DB,
];

/** Grafana's built-in pseudo-datasources — always present, never declared, legal in panels:
 *  `-100` is the expression/math engine (alert rule reduce/threshold steps);
 *  `-- Grafana --` / `grafana` is the built-in annotations & random-walk source. */
export const GRAFANA_BUILTIN_UIDS: readonly string[] = ['-100', '-- Grafana --', 'grafana'];

/** Look up a catalog entry by uid (undefined when the uid is not in the catalog). */
export function datasourceByUid(uid: string): DatasourceCatalogEntry | undefined {
  return DATASOURCE_CATALOG.find((d) => d.uid === uid);
}
