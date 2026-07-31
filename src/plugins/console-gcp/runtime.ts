/**
 * What is actually serving right now, and what you could roll back to.
 *
 * READ-ONLY, and structurally so: `RuntimeProvider` offers no mutate method and the console's cloud
 * identity holds only viewer roles. A rollback from this console is a PIPELINE DISPATCH — it goes
 * through CI, gets the read-back and behaviour gate, and leaves a real run URL as its receipt.
 * Flipping traffic directly from a web page would bypass every gate this platform has.
 *
 * The digest matters more than the tag. `dorinda-api:latest` told us nothing on cutover night; the
 * digest is the only identifier that distinguishes the image that works from the one that does not.
 */
import type { Revision } from '../../console/domain';
import type {
  Feature,
  ProviderContext,
  ProviderHealth,
  RuntimeProvider,
} from '../../console/providers/types';
import { gcpJson, gcpPaged } from './http';

const RUN = 'https://run.googleapis.com/v2';

export interface RunServiceTraffic {
  trafficStatuses?: Array<{ type?: string; revision?: string; percent?: number }>;
  latestReadyRevision?: string;
}

/**
 * Which revision is actually taking traffic, by short name.
 *
 * ⛔ A `..._LATEST` traffic target carries NO revision name — the name is only in
 * `latestReadyRevision`. EVERY service in this estate routes by latest, so reading `t.revision`
 * alone yields an empty map and a screen that reports nothing is serving. That is a confidently
 * wrong answer about production, which is strictly worse than no answer.
 */
export function resolveTraffic(svc: RunServiceTraffic): Map<string, number> {
  const traffic = new Map<string, number>();
  for (const t of svc.trafficStatuses ?? []) {
    const revision =
      t.revision ||
      (t.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST'
        ? (svc.latestReadyRevision ?? '').split('/').pop()
        : '');
    if (revision) traffic.set(revision, t.percent ?? 0);
  }
  return traffic;
}

interface RunRevision {
  name: string;
  createTime?: string;
  containers?: Array<{ image?: string }>;
  scaling?: { minInstanceCount?: number; maxInstanceCount?: number };
  conditions?: Array<{ type?: string; state?: string; message?: string }>;
}

export function createCloudRunRuntimeProvider(opts: {
  id: string;
  envs: string[];
  scope: { project_id: string; region: string };
}): RuntimeProvider {
  const { project_id: project, region } = opts.scope;
  const supported = new Set<Feature>(['runtime.revisions', 'runtime.rollback_targets']);

  return {
    id: opts.id,
    type: 'gcp.cloud-run',
    kind: 'runtime',
    label: 'Cloud Run revisions',
    envs: opts.envs,
    supports: (f) => supported.has(f),

    async health(ctx: ProviderContext): Promise<ProviderHealth> {
      try {
        await gcpJson({
          url: `${RUN}/projects/${project}/locations/${region}/services?pageSize=1`,
          signal: ctx.signal,
        });
        return { ok: true, detail: 'reachable', checked_at: new Date().toISOString() };
      } catch (e) {
        return { ok: false, detail: (e as Error).message.slice(0, 200), checked_at: new Date().toISOString() };
      }
    },

    async listRevisions(runtimeId: string, ctx: ProviderContext): Promise<Revision[]> {
      const parent = `${RUN}/projects/${project}/locations/${region}/services/${runtimeId}`;

      // Traffic first: a revision list without traffic shares cannot answer "what is serving?", which
      // is the only question this screen exists for.
      const svc = await gcpJson<RunServiceTraffic>({ url: parent, signal: ctx.signal });
      const traffic = resolveTraffic(svc);

      const revisions = await gcpPaged<RunRevision>(
        `${parent}/revisions`,
        (p) => p['revisions'] as RunRevision[] | undefined,
        { signal: ctx.signal, maxPages: 3 },
      );

      return revisions
        .map((r) => {
          const short = r.name.split('/').pop() ?? r.name;
          const image = r.containers?.[0]?.image ?? '';
          const ready = r.conditions?.find((c) => c.type === 'Ready');
          return {
            id: short,
            // The digest is the identity. A tag is a label someone can move.
            image_digest: image.includes('@') ? image.split('@')[1]! : '',
            image_ref: image,
            created_at: r.createTime ?? '',
            traffic_percent: traffic.get(short) ?? 0,
            ready: ready?.state === 'CONDITION_SUCCEEDED',
            ...(ready?.message ? { ready_detail: ready.message } : {}),
            ...(r.scaling?.minInstanceCount !== undefined ? { min_instances: r.scaling.minInstanceCount } : {}),
            ...(r.scaling?.maxInstanceCount !== undefined ? { max_instances: r.scaling.maxInstanceCount } : {}),
          } satisfies Revision;
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
  };
}
