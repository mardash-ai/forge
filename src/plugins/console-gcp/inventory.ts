/**
 * GCP inventory provider — what exists, in which scope, and whether it costs money.
 *
 * The scope distinction is load-bearing and is why this does not just return a flat list. Almost
 * nothing in this estate is zonal: Cloud Run, the load balancers, certificates and secrets are
 * global or regional, and the runner MIG spreads across three zones. Exactly ONE resource is
 * zone-pinned — Cloud SQL — which makes it, by itself, the entire single-zone availability story.
 * A flat list hides that; grouping by real scope shows it at a glance.
 *
 * `billable` is set per-kind from what actually appears on the bill. It is deliberately explicit
 * rather than inferred, because "which of these am I paying for" is a question the console must
 * answer without hedging.
 */
import type { InfraResource, ResourceKind, Scope } from '../../console/domain';
import type {
  Feature,
  InventoryProvider,
  ProviderContext,
  ProviderHealth,
} from '../../console/providers/types';
import { gcpJson, gcpPaged } from './http';

export interface GcpScope {
  project_id: string;
  region: string;
}

const CONSOLE = 'https://console.cloud.google.com';

/** Kinds that appear on the invoice. Everything else is free (VPCs, subnets, IAM, secrets metadata). */
const BILLABLE: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
  'compute.service',
  'compute.instance',
  'db.instance',
  'net.load_balancer',
  'net.nat',
  'net.dns_zone',
  'registry.repo',
  'bucket',
]);

function res(
  p: {
    kind: ResourceKind;
    native_type: string;
    external_id: string;
    name: string;
    scope: Scope;
    location?: string;
    labels?: Record<string, string>;
    state?: string;
    created_at?: string;
    attributes?: Record<string, string | number | boolean | null>;
    link?: string;
  },
  env: string,
  providerId: string,
): InfraResource {
  return {
    provider_id: providerId,
    env,
    kind: p.kind,
    native_type: p.native_type,
    external_id: p.external_id,
    name: p.name,
    scope: p.scope,
    ...(p.location ? { location: p.location } : {}),
    billable: BILLABLE.has(p.kind),
    labels: p.labels ?? {},
    ...(p.state ? { state: p.state } : {}),
    ...(p.created_at ? { created_at: p.created_at } : {}),
    attributes: p.attributes ?? {},
    ...(p.link ? { link: p.link } : {}),
  };
}

export function createGcpInventoryProvider(opts: {
  id: string;
  envs: string[];
  scope: GcpScope;
}): InventoryProvider {
  const { project_id: project, region } = opts.scope;
  const supported = new Set<Feature>(['inventory.list']);

  return {
    id: opts.id,
    type: 'gcp.inventory',
    kind: 'inventory',
    label: `GCP · ${project}`,
    envs: opts.envs,
    supports: (f) => supported.has(f),

    async health(ctx: ProviderContext): Promise<ProviderHealth> {
      try {
        await gcpJson({
          url: `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services?pageSize=1`,
          signal: ctx.signal,
        });
        return { ok: true, detail: `reachable (${project})`, checked_at: new Date().toISOString() };
      } catch (e) {
        return {
          ok: false,
          detail: (e as Error).message.slice(0, 200),
          checked_at: new Date().toISOString(),
        };
      }
    },

    async list(ctx: ProviderContext): Promise<InfraResource[]> {
      const env = ctx.env;
      const R = (p: Parameters<typeof res>[0]) => res(p, env, opts.id);
      const out: InfraResource[] = [];
      const s = ctx.signal;

      // Each family is fetched independently and failures are isolated: a missing API or a denied
      // role costs you that family's rows, never the whole inventory.
      const families: Array<[string, () => Promise<InfraResource[]>]> = [
        [
          'cloud-run',
          async () => {
            const items = await gcpPaged<Record<string, any>>(
              `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services`,
              (p) => p['services'] as Record<string, any>[] | undefined,
              { signal: s },
            );
            return items.map((x) => {
              const name = String(x['name']).split('/').pop()!;
              const c = x['template']?.containers?.[0] ?? {};
              return R({
                kind: 'compute.service',
                native_type: 'run.googleapis.com/Service',
                external_id: String(x['name']),
                name,
                scope: 'regional',
                location: region,
                labels: x['labels'] ?? {},
                state:
                  x['terminalCondition']?.type === 'Ready' &&
                  x['terminalCondition']?.state === 'CONDITION_SUCCEEDED'
                    ? 'Ready'
                    : (x['terminalCondition']?.state ?? 'unknown'),
                created_at: x['createTime'],
                attributes: {
                  image: c['image'] ?? null,
                  cpu: c['resources']?.limits?.cpu ?? null,
                  memory: c['resources']?.limits?.memory ?? null,
                  min_instances: x['template']?.scaling?.minInstanceCount ?? 0,
                  max_instances: x['template']?.scaling?.maxInstanceCount ?? null,
                  ingress: x['ingress'] ?? null,
                  service_account: x['template']?.serviceAccount ?? null,
                  url: x['uri'] ?? null,
                },
                link: `${CONSOLE}/run/detail/${region}/${name}/metrics?project=${project}`,
              });
            });
          },
        ],

        [
          'cloud-sql',
          async () => {
            const p = await gcpJson<{ items?: Record<string, any>[] }>({
              url: `https://sqladmin.googleapis.com/v1/projects/${project}/instances`,
              signal: s,
            });
            const instances = p.items ?? [];

            // For each instance, fetch recent backup runs in parallel.
            // Three distinct outcomes — empty is NEVER silently treated as "no runs":
            //   (a) sqladmin/backupRuns unreachable or errored → backup_runs_status = 'api_error'
            //   (b) automated backups disabled on the instance → backup_runs_status = 'disabled'
            //   (c) runs fetched but the list is empty → backup_runs_status = 'none'
            // A backup run fetch failure is isolated per instance: it costs only that instance's
            // run history, never the inventory row or any sibling instance.
            return Promise.all(
              instances.map(async (x) => {
                const instName = String(x['name']);
                const backupsEnabled: boolean = x['settings']?.backupConfiguration?.enabled ?? false;

                const bkAttrs: Record<string, string | number | boolean | null> = {};

                if (!backupsEnabled) {
                  // (b) Automated backups disabled — no runs to fetch or report.
                  bkAttrs['backup_runs_status'] = 'disabled';
                } else {
                  try {
                    const br = await gcpJson<{ items?: Record<string, any>[] }>({
                      url:
                        `https://sqladmin.googleapis.com/v1/projects/${project}/instances/` +
                        `${encodeURIComponent(instName)}/backupRuns?maxResults=5`,
                      signal: s,
                    });
                    const runs = br.items ?? [];
                    if (runs.length > 0) {
                      const latest = runs[0]!;
                      bkAttrs['backup_runs_status'] = 'ok';
                      bkAttrs['backup_last_status'] = latest['status'] ?? null;
                      bkAttrs['backup_last_type'] = latest['type'] ?? null;
                      bkAttrs['backup_last_end_time'] = latest['endTime'] ?? null;
                      bkAttrs['backup_last_start_time'] = latest['startTime'] ?? null;
                      bkAttrs['backup_recent_failures'] = runs.filter((r) => r['status'] === 'FAILED').length;
                      // Compact JSON for the UI detail view (status, timing, type per run).
                      bkAttrs['backup_runs_json'] = JSON.stringify(
                        runs.map((r) => ({
                          id: String(r['id'] ?? ''),
                          status: String(r['status'] ?? ''),
                          type: String(r['type'] ?? ''),
                          startTime: r['startTime'] ?? null,
                          endTime: r['endTime'] ?? null,
                        })),
                      );
                    } else {
                      // (c) No runs on record even though backups are enabled.
                      bkAttrs['backup_runs_status'] = 'none';
                    }
                  } catch (e) {
                    // (a) sqladmin/backupRuns was unreachable or returned an error.
                    bkAttrs['backup_runs_status'] = 'api_error';
                    bkAttrs['backup_runs_error'] = (e as Error).message.slice(0, 200);
                  }
                }

                return R({
                  kind: 'db.instance',
                  native_type: 'sqladmin.googleapis.com/Instance',
                  external_id: `projects/${project}/instances/${instName}`,
                  name: instName,
                  // The ONE zonal resource, and therefore the whole single-zone story.
                  scope: x['settings']?.availabilityType === 'REGIONAL' ? 'regional' : 'zonal',
                  location: x['gceZone'] ?? x['region'],
                  state: x['state'],
                  created_at: x['createTime'],
                  attributes: {
                    version: x['databaseVersion'] ?? null,
                    tier: x['settings']?.tier ?? null,
                    edition: x['settings']?.edition ?? null,
                    disk_gb: x['settings']?.dataDiskSizeGb ?? null,
                    availability: x['settings']?.availabilityType ?? null,
                    backups: backupsEnabled,
                    pitr: x['settings']?.backupConfiguration?.pointInTimeRecoveryEnabled ?? false,
                    private_ip:
                      (x['ipAddresses'] ?? []).find((i: any) => i.type === 'PRIVATE')?.ipAddress ?? null,
                    ...bkAttrs,
                  },
                  link: `${CONSOLE}/sql/instances/${instName}/overview?project=${project}`,
                });
              }),
            );
          },
        ],

        [
          'backends',
          async () => {
            const items = await gcpPaged<Record<string, any>>(
              `https://compute.googleapis.com/compute/v1/projects/${project}/global/backendServices`,
              (p) => p['items'] as Record<string, any>[] | undefined,
              { signal: s },
            );
            return items.map((x) =>
              R({
                kind: 'net.backend',
                native_type: 'compute.googleapis.com/BackendService',
                external_id: String(x['selfLink']),
                name: String(x['name']),
                scope: 'global',
                attributes: { protocol: x['protocol'] ?? null, scheme: x['loadBalancingScheme'] ?? null },
                link: `${CONSOLE}/net-services/loadbalancing/list/backends?project=${project}`,
              }),
            );
          },
        ],

        [
          'forwarding-rules',
          async () => {
            const items = await gcpPaged<Record<string, any>>(
              `https://compute.googleapis.com/compute/v1/projects/${project}/global/forwardingRules`,
              (p) => p['items'] as Record<string, any>[] | undefined,
              { signal: s },
            );
            return items.map((x) =>
              R({
                kind: 'net.load_balancer',
                native_type: 'compute.googleapis.com/ForwardingRule',
                external_id: String(x['selfLink']),
                name: String(x['name']),
                scope: 'global',
                attributes: { ip: x['IPAddress'] ?? null, ports: x['portRange'] ?? null },
                link: `${CONSOLE}/net-services/loadbalancing/list/loadBalancers?project=${project}`,
              }),
            );
          },
        ],

        [
          'secrets',
          async () => {
            const items = await gcpPaged<Record<string, any>>(
              `https://secretmanager.googleapis.com/v1/projects/${project}/secrets`,
              (p) => p['secrets'] as Record<string, any>[] | undefined,
              { signal: s },
            );
            // Metadata only. The console holds `secretmanager.viewer`, never `accessor` — it can see
            // that a secret exists and when it was made, and cannot read a single value.
            return items.map((x) =>
              R({
                kind: 'secret',
                native_type: 'secretmanager.googleapis.com/Secret',
                external_id: String(x['name']),
                name: String(x['name']).split('/').pop()!,
                scope: 'global',
                created_at: x['createTime'],
                labels: x['labels'] ?? {},
                link: `${CONSOLE}/security/secret-manager?project=${project}`,
              }),
            );
          },
        ],

        [
          'certificates',
          async () => {
            const items = await gcpPaged<Record<string, any>>(
              `https://certificatemanager.googleapis.com/v1/projects/${project}/locations/global/certificates`,
              (p) => p['certificates'] as Record<string, any>[] | undefined,
              { signal: s },
            );
            return items.map((x) =>
              R({
                kind: 'certificate',
                native_type: 'certificatemanager.googleapis.com/Certificate',
                external_id: String(x['name']),
                name: String(x['name']).split('/').pop()!,
                scope: 'global',
                state: x['managed']?.state ?? 'unknown',
                created_at: x['createTime'],
                attributes: {
                  domains: (x['sanDnsnames'] ?? []).join(', ') || null,
                  expires_at: x['expireTime'] ?? null,
                },
                link: `${CONSOLE}/security/ccm/list?project=${project}`,
              }),
            );
          },
        ],

        [
          'artifact-repos',
          async () => {
            const items = await gcpPaged<Record<string, any>>(
              `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${region}/repositories`,
              (p) => p['repositories'] as Record<string, any>[] | undefined,
              { signal: s },
            );
            return items.map((x) =>
              R({
                kind: 'registry.repo',
                native_type: 'artifactregistry.googleapis.com/Repository',
                external_id: String(x['name']),
                name: String(x['name']).split('/').pop()!,
                scope: 'regional',
                location: region,
                attributes: { format: x['format'] ?? null, size_bytes: x['sizeBytes'] ?? null },
                link: `${CONSOLE}/artifacts?project=${project}`,
              }),
            );
          },
        ],

        [
          'buckets',
          async () => {
            const p = await gcpJson<{ items?: Record<string, any>[] }>({
              url: `https://storage.googleapis.com/storage/v1/b?project=${project}`,
              signal: s,
            });
            return (p.items ?? []).map((x) =>
              R({
                kind: 'bucket',
                native_type: 'storage.googleapis.com/Bucket',
                external_id: `gs://${x['name']}`,
                name: String(x['name']),
                scope: 'regional',
                location: String(x['location'] ?? '').toLowerCase(),
                created_at: x['timeCreated'],
                attributes: { storage_class: x['storageClass'] ?? null },
                link: `${CONSOLE}/storage/browser/${x['name']}?project=${project}`,
              }),
            );
          },
        ],

        [
          'networks',
          async () => {
            const items = await gcpPaged<Record<string, any>>(
              `https://compute.googleapis.com/compute/v1/projects/${project}/global/networks`,
              (p) => p['items'] as Record<string, any>[] | undefined,
              { signal: s },
            );
            return items.map((x) =>
              R({
                kind: 'net.network',
                native_type: 'compute.googleapis.com/Network',
                external_id: String(x['selfLink']),
                name: String(x['name']),
                scope: 'global',
                attributes: {
                  auto_subnets: x['autoCreateSubnetworks'] ?? false,
                  subnet_count: (x['subnetworks'] ?? []).length,
                },
                link: `${CONSOLE}/networking/networks/list?project=${project}`,
              }),
            );
          },
        ],

        [
          'instances',
          async () => {
            const items = await gcpPaged<Record<string, any>>(
              `https://compute.googleapis.com/compute/v1/projects/${project}/aggregated/instances`,
              (p) => {
                const agg = (p['items'] ?? {}) as Record<string, { instances?: Record<string, any>[] }>;
                return Object.values(agg).flatMap((z) => z.instances ?? []);
              },
              { signal: s },
            );
            return items.map((x) =>
              R({
                kind: 'compute.instance',
                native_type: 'compute.googleapis.com/Instance',
                external_id: String(x['selfLink']),
                name: String(x['name']),
                scope: 'zonal',
                location: String(x['zone'] ?? '')
                  .split('/')
                  .pop(),
                state: x['status'],
                created_at: x['creationTimestamp'],
                attributes: {
                  machine_type:
                    String(x['machineType'] ?? '')
                      .split('/')
                      .pop() ?? null,
                  spot: x['scheduling']?.provisioningModel === 'SPOT',
                },
                link: `${CONSOLE}/compute/instances?project=${project}`,
              }),
            );
          },
        ],
      ];

      const settled = await Promise.allSettled(families.map(([, fn]) => fn()));
      settled.forEach((r) => {
        if (r.status === 'fulfilled') out.push(...r.value);
      });
      return out;
    },
  };
}
