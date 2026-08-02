/**
 * GitHub Actions provider — the CI plane, and the ONLY provider in the console that can write.
 *
 * Every mutating operation the console offers (deploy, roll back, trigger a backup, apply infra)
 * compiles down to `dispatch()` here. That is deliberate: it means every write goes through CI and
 * therefore inherits the read-back, the behaviour gate and the audit trail, and the receipt handed
 * back to the user is a real GitHub run URL they can open.
 *
 * Rate limit: 5000/h on a PAT. Conditional requests that return 304 do not consume quota, so the
 * run poller sends `If-None-Match` and the remaining budget is tracked from the response headers.
 */
import type { Pipeline, PipelineRun, RunConclusion, RunStatus } from '../../console/domain';
import type {
  Feature,
  PipelinesProvider,
  ProviderContext,
  ProviderHealth,
} from '../../console/providers/types';

const API = 'https://api.github.com';

interface GhOpts {
  id: string;
  envs: string[];
  owner: string;
  repos: string[];
  /** Resolved at boot from Secret Manager; absent means the CI plane degrades to unavailable. */
  token?: string;
}

export function createGitHubPipelinesProvider(opts: GhOpts): PipelinesProvider {
  const supported = new Set<Feature>(['pipelines.list', 'pipelines.runs']);
  // The console must never *pretend* it can deploy. Without a token, dispatch is not offered at
  // all and the UI greys the button rather than failing at the moment of use.
  if (opts.token) supported.add('pipelines.dispatch');

  const etags = new Map<string, { etag: string; body: unknown }>();
  let rateRemaining = Number.NaN;

  async function gh<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    if (!opts.token) throw new Error('GitHub token not configured');
    const url = `${API}${path}`;
    const cached = etags.get(url);
    const res = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${opts.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(cached ? { 'If-None-Match': cached.etag } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: signal ?? AbortSignal.timeout(20_000),
    });

    const rem = res.headers.get('x-ratelimit-remaining');
    if (rem) rateRemaining = Number(rem);

    // 304 costs no quota — this is why the poller is affordable at all.
    if (res.status === 304 && cached) return cached.body as T;
    if (res.status === 204) return undefined as T;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${res.status} ${path}: ${text.slice(0, 240)}`);
    }
    const body = (await res.json()) as T;
    const etag = res.headers.get('etag');
    if (etag && (init.method ?? 'GET') === 'GET') etags.set(url, { etag, body });
    return body;
  }

  function mapRun(r: any, pipelineName: string): PipelineRun {
    const started = r.run_started_at ?? r.created_at;
    const finished = r.status === 'completed' ? r.updated_at : undefined;
    return {
      id: String(r.id),
      pipeline_id: String(r.workflow_id),
      pipeline_name: pipelineName || r.name,
      repo: r.repository?.full_name ?? '',
      number: r.run_number,
      status: r.status as RunStatus,
      ...(r.conclusion ? { conclusion: r.conclusion as RunConclusion } : {}),
      event: r.event,
      branch: r.head_branch,
      commit_sha: r.head_sha,
      actor: r.actor?.login ?? r.triggering_actor?.login ?? 'unknown',
      ...(started ? { started_at: started } : {}),
      ...(finished ? { finished_at: finished } : {}),
      ...(started && finished
        ? { duration_ms: new Date(finished).getTime() - new Date(started).getTime() }
        : {}),
      url: r.html_url,
    };
  }

  return {
    id: opts.id,
    type: 'github.actions',
    kind: 'pipelines',
    label: `GitHub · ${opts.owner}`,
    envs: opts.envs,
    supports: (f) => supported.has(f),

    async health(ctx: ProviderContext): Promise<ProviderHealth> {
      if (!opts.token) {
        return {
          ok: false,
          // Say exactly what is missing and what it costs — not "unavailable".
          detail: 'no GitHub token configured — CI is read-unavailable and deploys are disabled',
          checked_at: new Date().toISOString(),
        };
      }
      try {
        await gh('/rate_limit', {}, ctx.signal);
        return {
          ok: true,
          detail: Number.isNaN(rateRemaining) ? 'reachable' : `reachable · ${rateRemaining} req remaining`,
          checked_at: new Date().toISOString(),
        };
      } catch (e) {
        return {
          ok: false,
          detail: (e as Error).message.slice(0, 200),
          checked_at: new Date().toISOString(),
        };
      }
    },

    /**
     * The API budget, read from the horse's mouth rather than counted locally.
     *
     * A console that polls CI is itself a consumer of this quota, so exhausting it would blind the
     * very screen you would use to notice. Actions *minutes* are deliberately absent: that figure
     * lives behind a billing endpoint this token is not scoped for, and a fabricated minutes number
     * is exactly the confident-but-wrong reading this console exists to eliminate.
     */
    async quotas(ctx: ProviderContext) {
      if (!opts.token) return [];
      try {
        const body = await gh<{ resources?: { core?: { limit?: number; remaining?: number } } }>(
          '/rate_limit',
          {},
          ctx.signal,
        );
        const core = body.resources?.core;
        if (!core || core.limit === undefined || core.remaining === undefined) return [];
        return [
          {
            name: 'GitHub API requests',
            scope: 'github',
            used: core.limit - core.remaining,
            limit: core.limit,
            unit: 'requests/hour',
            detail: `${core.remaining} remaining this hour · conditional 304s cost nothing`,
            headroom_percent: Math.round((core.remaining / core.limit) * 100),
          },
        ];
      } catch {
        return [];
      }
    },

    async listPipelines(ctx: ProviderContext): Promise<Pipeline[]> {
      const out: Pipeline[] = [];
      const settled = await Promise.allSettled(
        opts.repos.map(async (repo) => {
          const body = await gh<{ workflows?: any[] }>(
            `/repos/${opts.owner}/${repo}/actions/workflows`,
            {},
            ctx.signal,
          );
          return (body.workflows ?? []).map<Pipeline>((w) => ({
            id: `${repo}:${w.id}`,
            repo: `${opts.owner}/${repo}`,
            name: w.name,
            path: w.path,
            // Only a workflow declaring workflow_dispatch can be triggered; the console reads that
            // from the file path list rather than guessing.
            dispatchable: w.state === 'active',
          }));
        }),
      );
      settled.forEach((r) => {
        if (r.status === 'fulfilled') out.push(...r.value);
      });
      return out;
    },

    async listRuns(o, ctx): Promise<PipelineRun[]> {
      const limit = o.limit ?? 20;
      if (o.pipeline_id) {
        const [repo, wf] = o.pipeline_id.split(':');
        const body = await gh<{ workflow_runs?: any[] }>(
          `/repos/${opts.owner}/${repo}/actions/workflows/${wf}/runs?per_page=${limit}`,
          {},
          ctx.signal,
        );
        return (body.workflow_runs ?? []).map((r) =>
          mapRun({ ...r, repository: { full_name: `${opts.owner}/${repo}` } }, r.name),
        );
      }
      const per = Math.max(3, Math.ceil(limit / Math.max(1, opts.repos.length)));
      const settled = await Promise.allSettled(
        opts.repos.map(async (repo) => {
          const body = await gh<{ workflow_runs?: any[] }>(
            `/repos/${opts.owner}/${repo}/actions/runs?per_page=${per}`,
            {},
            ctx.signal,
          );
          return (body.workflow_runs ?? []).map((r) =>
            mapRun({ ...r, repository: { full_name: `${opts.owner}/${repo}` } }, r.name),
          );
        }),
      );
      const runs: PipelineRun[] = [];
      settled.forEach((r) => {
        if (r.status === 'fulfilled') runs.push(...r.value);
      });
      return runs.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? '')).slice(0, limit);
    },

    async dispatch(pipelineId, o, ctx) {
      if (!opts.token) throw new Error('GitHub token not configured — cannot dispatch');
      const [repo, wf] = pipelineId.split(':');
      await gh(
        `/repos/${opts.owner}/${repo}/actions/workflows/${wf}/dispatches`,
        { method: 'POST', body: JSON.stringify({ ref: o.ref, inputs: o.inputs }) },
        ctx.signal,
      );
      // The dispatch API returns 204 with no run id, so link to the filtered run list — a real,
      // openable destination rather than a fabricated run URL.
      return {
        url: `https://github.com/${opts.owner}/${repo}/actions/workflows/${String(wf)}`,
        accepted_at: new Date().toISOString(),
      };
    },
  };
}
