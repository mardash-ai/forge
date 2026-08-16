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
/**
 * Which repository a service is built from.
 *
 * Convention: the service is named after its repo. The forge-* services are the exception — both
 * are built from the forge monorepo, so they are named explicitly rather than left to a convention
 * that would silently look up repositories that do not exist.
 */
/**
 * Cloud Run JOBS in this project. Named explicitly rather than probed: a 404-driven
 * service-then-job fallback would turn every genuine "service not found" into a second request and
 * a confusing error, and this list changes about once a year.
 */
const JOB_NAMES: ReadonlySet<string> = new Set(['e2e-runner']);

type RunExecution = {
  name?: string;
  createTime?: string;
  startTime?: string;
  succeededCount?: number;
  template?: { containers?: Array<{ image?: string; env?: Array<{ name: string; value?: string }> }> };
};

type RunJob = {
  template?: {
    template?: { containers?: Array<{ image?: string; env?: Array<{ name: string; value?: string }> }> };
  };
  terminalCondition?: { state?: string };
  createTime?: string;
  updateTime?: string;
};

const SERVICE_REPO: Record<string, string> = {
  'forge-console': 'mardash-ai/forge',
  'forge-data-plane': 'mardash-ai/forge',
  'e2e-runner': 'mardash-ai/forge-hat',
};
const repoForService = (service: string): string => SERVICE_REPO[service] ?? `mardash-ai/${service}`;

/** package.json is at the repo root in most services and under app/ in dorinda-api. */
const PACKAGE_PATHS = ['package.json', 'app/package.json'] as const;

const semverCache = new Map<string, string | null>();

/**
 * ⛔ THE VERSION THAT MATCHES THE CHANGELOG — not the tag that happens to be on the image.
 *
 * dorinda-api, dorinda-web and dorinda-site publish images tagged with the COMMIT SHA: those repos
 * cut no git tags at all. So the deploys screen could name the build (`8d588a8`) but not the
 * release, and `8d588a8` cannot be looked up in a CHANGELOG.
 *
 * The semver does exist — in `package.json`, at that very commit, which is the same file the
 * CHANGELOG entry is written against. So resolve it from the repo at the deployed sha. This works
 * retroactively for every image already in production and needs no change to three separate
 * release pipelines.
 *
 * Returns null on any failure. The caller then falls back to the registry tag, so a GitHub outage
 * degrades to today's behaviour rather than to a blank column.
 */
async function semverAtCommit(
  service: string,
  sha: string,
  ctx: { signal?: AbortSignal },
): Promise<string | null> {
  const token = process.env.CONSOLE_GITHUB_TOKEN ?? '';
  if (!token || !sha) return null;
  const repo = repoForService(service);
  const key = `${repo}@${sha}`;
  if (semverCache.has(key)) return semverCache.get(key)!;

  for (const path of PACKAGE_PATHS) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(sha)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.raw',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        },
      );
      if (!res.ok) continue;
      const version = (JSON.parse(await res.text()) as { version?: string }).version ?? null;
      if (version) {
        semverCache.set(key, version);
        return version;
      }
    } catch {
      // Try the next path; a transient failure is not cached, so it can recover.
    }
  }
  return null;
}

/** Where to read what changed in this build. The sha pins the file to the deployed commit. */
export function changelogUrl(service: string, ref: string): string | null {
  if (!ref) return null;
  return `https://github.com/${repoForService(service)}/blob/${ref}/CHANGELOG.md`;
}

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
      /*
       * ⛔ A JOB IS NOT A SERVICE. It runs to completion: no traffic split, no revision history,
       * one configured template that the next execution will run.
       *
       * Handled here because the deploys screen enumerated services only, so `e2e-runner` — the
       * thing that executes every acceptance run — appeared nowhere in the console. On 2026-08-16
       * "the runner is live on v0.38.0" was a claim only `gcloud` could check, which is exactly the
       * gap the version column exists to close.
       *
       * Its version needs no registry lookup: the release that rolls the job stamps HAT_VERSION and
       * HAT_COMMIT into it, in the same step that sets the digest.
       */
      if (JOB_NAMES.has(runtimeId)) {
        const job = await gcpJson<RunJob>({
          url: `${RUN}/projects/${project}/locations/${region}/jobs/${runtimeId}`,
          signal: ctx.signal,
        });
        const c = job?.template?.template?.containers?.[0];
        const image = c?.image ?? '';
        const env = c?.env ?? [];
        const pick = (n: string) => env.find((e) => e.name === n)?.value ?? null;
        const commit = pick('HAT_COMMIT');
        const ready = job?.terminalCondition?.state === 'CONDITION_SUCCEEDED';
        /*
         * ⛔ AND ITS HISTORY. A job has no revisions, but every EXECUTION records the image it ran
         * plus the version stamped into it — so the history exists, and the first cut of this
         * simply did not read it. Mark: "the last deployment (0.38.0) is completely gone."
         *
         * Executions are what ACTUALLY RAN, which is the more useful history here than a list of
         * configurations: it answers "which version produced that result?" for any past run.
         */
        const executions = await gcpPaged<RunExecution>(
          `${RUN}/projects/${project}/locations/${region}/jobs/${runtimeId}/executions`,
          (p) => p['executions'] as RunExecution[] | undefined,
          { signal: ctx.signal, maxPages: 1 },
        ).catch(() => [] as RunExecution[]);

        const history: Revision[] = executions.map((x) => {
          const ec = x.template?.containers?.[0];
          const eimg = ec?.image ?? '';
          const eenv = ec?.env ?? [];
          const epick = (n: string) => eenv.find((e) => e.name === n)?.value ?? null;
          const ecommit = epick('HAT_COMMIT');
          return {
            id:
              String(x.name ?? '')
                .split('/')
                .pop() ?? '',
            image_digest: eimg.includes('@') ? eimg.split('@')[1]! : '',
            image_ref: eimg,
            // An execution is history, never "what runs next" — that is the configured row above.
            traffic_percent: 0,
            ready: (x.succeededCount ?? 0) > 0,
            created_at: x.createTime ?? x.startTime ?? '',
            image_version: epick('HAT_VERSION'),
            source_ref: ecommit,
            changelog_url: changelogUrl(runtimeId, ecommit ?? ''),
          };
        });

        return [
          {
            id: `${runtimeId} (configured)`,
            image_digest: image.includes('@') ? image.split('@')[1]! : '',
            image_ref: image,
            // Jobs carry no traffic. 100 says "this is what the next execution runs", which is the
            // question the column answers for a service too.
            traffic_percent: 100,
            ready,
            created_at: job?.updateTime ?? job?.createTime ?? '',
            image_version: pick('HAT_VERSION') ?? (await resolveImageVersion(image, ctx)),
            source_ref: commit,
            changelog_url: changelogUrl(runtimeId, commit ?? ''),
          },
          ...history,
        ];
      }

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
      /*
       * The registry tag is a COMMIT SHA for dorinda-api / -web / -site (those repos cut no git
       * tags), and a semver for the forge services. Mark needs the version that matches the
       * CHANGELOG, so where the tag is a sha, resolve the semver from package.json AT that commit —
       * the same file the changelog entry is written against.
       *
       * The sha is kept either way: it is the precise identity, and it is what the changelog link
       * pins to so the file is read exactly as it was at this deploy.
       */
      const semvers = new Map<string, string | null>(
        await Promise.all(
          uniqueImages.map(async (img) => {
            const tag = versions.get(img);
            // Already semver (forge-*) — nothing to resolve.
            if (tag && /^v?\d+\.\d+\.\d+/.test(tag)) return [img, tag] as const;
            const sha = tag ?? '';
            return [img, await semverAtCommit(runtimeId, sha, ctx)] as const;
          }),
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
            /*
             * Prefer the semver that matches the CHANGELOG; fall back to the registry tag (a
             * commit sha) when it cannot be resolved, so a GitHub outage degrades to naming the
             * build rather than to a blank column. null only when neither is known.
             */
            image_version: semvers.get(image) ?? versions.get(image) ?? null,
            /** The registry tag as-published — a sha for most services, a semver for forge-*. */
            source_ref: versions.get(image) ?? null,
            changelog_url: changelogUrl(runtimeId, versions.get(image) ?? ''),
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
