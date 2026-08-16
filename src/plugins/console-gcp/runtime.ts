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

/**
 * ⛔ WHAT VERSION IS THIS SERVICE ACTUALLY RUNNING?
 *
 * Every service here is rolled BY DIGEST, deliberately — a tag is a label someone can move, and
 * digest-pinning is what makes a rollout verifiable. The cost is that the deploys screen could show
 * `app@sha256:abf3cd1…` and nothing else, so "is v1.40.2 live?" was a question only
 * `gcloud artifacts docker images list` could answer.
 *
 * That cost is not hypothetical: on 2026-08-16 forge-console served v1.37.1 for two days while two
 * releases sat unadopted — one of them a feature Mark had asked for and been told had shipped — and
 * no screen in this console could have revealed it.
 *
 * So: resolve the digest back to its tag through Artifact Registry. The digest stays the identity;
 * the tag is presentation. A digest is immutable, so the answer is cached for the process lifetime.
 *
 * Returns null — never a guess — when the image is not in Artifact Registry, when the lookup fails,
 * or when the image carries no version-shaped tag. The UI renders that as unknown, because a
 * version display that can be WRONG is worse than none.
 */
const versionCache = new Map<string, string | null>();

export async function resolveImageVersion(
  imageRef: string,
  ctx: { signal?: AbortSignal },
): Promise<string | null> {
  if (!imageRef) return null;
  // A ref that already carries a tag needs no lookup: `…/app:v1.2.3` or `…/app:v1.2.3@sha256:…`.
  const tagged = /:(v?\d+\.\d+\.\d+[^@]*)(?:@|$)/.exec(imageRef);
  if (tagged) return tagged[1]!;

  const at = imageRef.indexOf('@');
  if (at < 0) return null;
  const digest = imageRef.slice(at + 1);
  const path = imageRef.slice(0, at);
  if (versionCache.has(digest)) return versionCache.get(digest)!;

  // us-east1-docker.pkg.dev/<project>/<repo>/<package...>
  const m = /^([a-z0-9-]+)-docker\.pkg\.dev\/([^/]+)\/([^/]+)\/(.+)$/.exec(path);
  if (!m) {
    versionCache.set(digest, null); // not Artifact Registry — nothing to resolve against
    return null;
  }
  const [, location, imgProject, repo, pkg] = m;
  try {
    const res = await gcpJson<{ tags?: string[] }>({
      url:
        `https://artifactregistry.googleapis.com/v1/projects/${imgProject}/locations/${location}` +
        `/repositories/${repo}/dockerImages/${encodeURIComponent(`${pkg}@${digest}`)}`,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const tags = res?.tags ?? [];
    /*
     * ⛔ NOT EVERY SERVICE TAGS WITH SEMVER, and assuming so is how this shows a version for one
     * service and "unknown" for the rest.
     *
     * Verified against the live estate 2026-08-16:
     *   forge-console, forge-data-plane   v1.40.2      semver, from a release tag
     *   dorinda-api, dorinda-web, …-site  8d588a8      the COMMIT the image was built from
     *
     * A commit sha is a perfectly good build identity — it is what those pipelines publish — so
     * take it when there is no semver. `latest` is excluded because it names nothing: it is
     * whatever was pushed last, which is the opposite of an identity.
     */
    const version = tags.find((t) => /^v?\d+\.\d+\.\d+/.test(t)) ?? tags.find((t) => t !== 'latest') ?? null;
    versionCache.set(digest, version);
    return version;
  } catch {
    // A failed lookup is UNKNOWN, not "no version". Not cached: a transient 503 must not freeze
    // this digest as unknown for the life of the process.
    return null;
  }
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
        return {
          ok: false,
          detail: (e as Error).message.slice(0, 200),
          checked_at: new Date().toISOString(),
        };
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

      // Resolve digest → version once per UNIQUE image, in parallel. Revisions of one service
      // usually repeat a handful of digests, and the cache makes repeats free.
      const uniqueImages = [...new Set(revisions.map((r) => r.containers?.[0]?.image ?? '').filter(Boolean))];
      const versions = new Map<string, string | null>(
        await Promise.all(
          uniqueImages.map(async (img) => [img, await resolveImageVersion(img, ctx)] as const),
        ),
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
            // null = we could not resolve one. Rendered as unknown, never guessed.
            image_version: versions.get(image) ?? null,
            created_at: r.createTime ?? '',
            traffic_percent: traffic.get(short) ?? 0,
            ready: ready?.state === 'CONDITION_SUCCEEDED',
            ...(ready?.message ? { ready_detail: ready.message } : {}),
            ...(r.scaling?.minInstanceCount !== undefined
              ? { min_instances: r.scaling.minInstanceCount }
              : {}),
            ...(r.scaling?.maxInstanceCount !== undefined
              ? { max_instances: r.scaling.maxInstanceCount }
              : {}),
          } satisfies Revision;
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
  };
}
