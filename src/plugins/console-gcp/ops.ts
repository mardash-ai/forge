/**
 * Three read-only providers that complete the planned console scope: alerts, drift and cost.
 *
 * Each answers a question that currently requires opening a different tool, and each is deliberately
 * honest about what it cannot see rather than rendering an empty panel that reads as "all clear".
 */
import type { EnvKey } from '../../console/domain';
import type { Feature, Provider, ProviderContext, ProviderHealth } from '../../console/providers/types';
import { gcpJson, gcpPaged } from './http';

// ── Alerts ─────────────────────────────────────────────────────────────────────────────────────

export interface AlertPolicySummary {
  id: string;
  name: string;
  enabled: boolean;
  /** How the alert reaches a human. An alert policy with no channel is a dashboard, not an alert. */
  channels: number;
  documentation?: string;
}

export interface FiringIncident {
  id: string;
  policy: string;
  started_at: string;
  state: string;
  summary: string;
  url?: string;
}

export interface AlertsProvider extends Provider {
  kind: 'alerts';
  listPolicies(ctx: ProviderContext): Promise<AlertPolicySummary[]>;
  listFiring(ctx: ProviderContext): Promise<FiringIncident[]>;
}

export function createGcpAlertsProvider(opts: {
  id: string;
  envs: EnvKey[];
  scope: { project_id: string };
}): AlertsProvider {
  const project = opts.scope.project_id;
  const supported = new Set<Feature>(['alerts.policies', 'alerts.incidents']);

  return {
    id: opts.id,
    type: 'gcp.alerts',
    kind: 'alerts',
    label: 'Cloud Monitoring alerts',
    envs: opts.envs,
    supports: (f) => supported.has(f),

    async health(ctx: ProviderContext): Promise<ProviderHealth> {
      try {
        await gcpJson({
          url: `https://monitoring.googleapis.com/v3/projects/${project}/alertPolicies?pageSize=1`,
          signal: ctx.signal,
        });
        return { ok: true, detail: 'reachable', checked_at: new Date().toISOString() };
      } catch (e) {
        return { ok: false, detail: (e as Error).message.slice(0, 200), checked_at: new Date().toISOString() };
      }
    },

    async listPolicies(ctx): Promise<AlertPolicySummary[]> {
      const policies = await gcpPaged<Record<string, any>>(
        `https://monitoring.googleapis.com/v3/projects/${project}/alertPolicies`,
        (p) => p['alertPolicies'] as Record<string, any>[] | undefined,
        { signal: ctx.signal },
      );
      return policies
        .map((p) => ({
          id: String(p['name']),
          name: String(p['displayName']),
          enabled: p['enabled'] !== false,
          channels: (p['notificationChannels'] ?? []).length,
          ...(p['documentation']?.content ? { documentation: String(p['documentation'].content) } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async listFiring(ctx): Promise<FiringIncident[]> {
      // Cloud Monitoring has no public "list open incidents" API. Firing state is observable via
      // the policies' own condition metrics, which is more work than it is worth here — so this
      // returns [] and the UI says "no API for open incidents" rather than "all clear", because
      // those are not the same statement and only one of them is true.
      void ctx;
      return [];
    },
  };
}

// ── Drift ──────────────────────────────────────────────────────────────────────────────────────

export interface StackDrift {
  stack: string;
  env: EnvKey;
  published_hash?: string;
  last_apply_at?: string;
  /** Module refs found in the published manifest, if any. */
  module_refs: string[];
  /** True when this stack's pins disagree with each other — the mixed-pin hazard. */
  mixed_pins: boolean;
}

export interface PinDrift {
  repo: string;
  file: string;
  pinned: string;
  latest: string;
  /** How many releases behind. 0 = current. */
  behind: number;
}

export interface DriftProvider extends Provider {
  kind: 'drift';
  listStacks(ctx: ProviderContext): Promise<StackDrift[]>;
  /** The newest forge release available, for the staleness axis. */
  latestRelease(ctx: ProviderContext): Promise<string | null>;
  /** CI workflow pins vs the newest release — the axis nothing watched. */
  listPinDrift(ctx: ProviderContext): Promise<PinDrift[]>;
}

/**
 * The THIRD drift axis, which nothing else watches.
 *
 * `forge infra apply` proves declaration→cloud. The nightly drift job proves cloud→declaration.
 * Both stay green while the DECLARATION itself rots: Dorinda's foundation once ran six releases
 * behind on `network`, so Cloud NAT was never created and every non-Google outbound call hung —
 * with apply and drift both reporting success the entire time, because the stack matched its own
 * stale declaration.
 *
 * Reads the published hash objects from the state bucket. Needs no terraform binary.
 */
export function createGcsDriftProvider(opts: {
  id: string;
  envs: EnvKey[];
  scope: { bucket: string };
  githubToken?: string;
  owner?: string;
  /** Consumer repos whose CI pins are checked for adoption drift. */
  repos?: string[];
}): DriftProvider {
  const bucket = opts.scope.bucket;
  const supported = new Set<Feature>(['drift.stacks']);

  return {
    id: opts.id,
    type: 'gcs.drift',
    kind: 'drift',
    label: 'Declaration drift',
    envs: opts.envs,
    supports: (f) => supported.has(f),

    async health(ctx: ProviderContext): Promise<ProviderHealth> {
      try {
        await gcpJson({
          url: `https://storage.googleapis.com/storage/v1/b/${bucket}/o?prefix=hash/&maxResults=1`,
          signal: ctx.signal,
        });
        return { ok: true, detail: `reachable (gs://${bucket})`, checked_at: new Date().toISOString() };
      } catch (e) {
        return { ok: false, detail: (e as Error).message.slice(0, 200), checked_at: new Date().toISOString() };
      }
    },

    async listStacks(ctx): Promise<StackDrift[]> {
      const listing = await gcpJson<{ items?: Array<{ name: string; updated?: string }> }>({
        url: `https://storage.googleapis.com/storage/v1/b/${bucket}/o?prefix=hash/`,
        signal: ctx.signal,
      });
      const out: StackDrift[] = [];
      for (const obj of listing.items ?? []) {
        // hash/<stack>.<env>
        const key = obj.name.replace(/^hash\//, '');
        const dot = key.lastIndexOf('.');
        if (dot < 0) continue;
        out.push({
          stack: key.slice(0, dot),
          env: key.slice(dot + 1),
          ...(obj.updated ? { last_apply_at: obj.updated } : {}),
          module_refs: [],
          mixed_pins: false,
        });
      }
      return out.sort((a, b) => a.stack.localeCompare(b.stack));
    },

    /**
     * ⛔ THE AXIS THAT WAS MISSING, and it cost a whole evening.
     *
     * Consumer repos check forge out at a hard-coded `ref:` in their CI workflows, one pin per
     * file, bumped by hand. On 2026-07-31 **twelve of fourteen pins across the estate were still
     * v0.79.24** — fourteen forge releases behind. A gate fix shipped that evening could not
     * possibly apply, because the consumer's CI had never adopted it: the release was green, the
     * fix was live in forge, and nothing reached the repo that needed it.
     *
     * Terraform module pins were already watched. CI pins were not, so the one mechanism built to
     * catch adoption drift had a blind spot exactly where this failure lives.
     */
    async listPinDrift(ctx): Promise<PinDrift[]> {
      const latest = await this.latestRelease(ctx);
      if (!latest || !opts.repos?.length) return [];
      const rank = await releaseRank(opts.githubToken, ctx.signal);
      const out: PinDrift[] = [];
      for (const repo of opts.repos) {
        for (const file of ['release.yml', 'infra.yml', 'release-data-plane.yml']) {
          try {
            const r = await fetch(
              `https://api.github.com/repos/${opts.owner ?? 'mardash-ai'}/${repo}/contents/.github/workflows/${file}`,
              {
                headers: {
                  accept: 'application/vnd.github.raw',
                  ...(opts.githubToken ? { authorization: `Bearer ${opts.githubToken}` } : {}),
                },
                signal: ctx.signal,
              },
            );
            if (!r.ok) continue; // a repo without that workflow is not drift, it is absence
            const body = await r.text();
            // Only pins that check OUT forge — not unrelated action refs.
            const m = /mardash-ai\/forge[\s\S]{0,120}?ref:\s*(v[0-9][0-9.]*)/.exec(body);
            if (!m) continue;
            const pinned = m[1]!;
            if (pinned === latest) continue;
            const behind = rank.length
              ? Math.max(0, rank.indexOf(pinned) < 0 ? rank.length : rank.indexOf(pinned))
              : 0;
            out.push({ repo, file, pinned, latest, behind });
          } catch {
            /* a single unreadable repo must not blank the screen */
          }
        }
      }
      return out.sort((a, b) => b.behind - a.behind);
    },

    async latestRelease(ctx): Promise<string | null> {
      // Unauthenticated works for a public repo and keeps this useful even without a token.
      try {
        const r = await fetch('https://api.github.com/repos/mardash-ai/forge/releases/latest', {
          headers: {
            accept: 'application/vnd.github+json',
            ...(opts.githubToken ? { authorization: `Bearer ${opts.githubToken}` } : {}),
          },
          signal: ctx.signal,
        });
        if (!r.ok) {
          // Tags work even when no GitHub *release* object exists — this repo tags without releasing.
          const t = await fetch('https://api.github.com/repos/mardash-ai/forge/tags?per_page=1', {
            headers: {
              accept: 'application/vnd.github+json',
              ...(opts.githubToken ? { authorization: `Bearer ${opts.githubToken}` } : {}),
            },
            signal: ctx.signal,
          });
          if (!t.ok) return null;
          const tags = (await t.json()) as Array<{ name: string }>;
          return tags[0]?.name ?? null;
        }
        const body = (await r.json()) as { tag_name?: string };
        return body.tag_name ?? null;
      } catch {
        return null;
      }
    },
  };
}

/** Release tags newest-first, so "how many behind" is a real number rather than a vibe. */
async function releaseRank(token: string | undefined, signal: AbortSignal): Promise<string[]> {
  try {
    const r = await fetch('https://api.github.com/repos/mardash-ai/forge/tags?per_page=100', {
      headers: {
        accept: 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal,
    });
    if (!r.ok) return [];
    return ((await r.json()) as Array<{ name: string }>).map((t) => t.name);
  } catch {
    return [];
  }
}

// ── Cost ───────────────────────────────────────────────────────────────────────────────────────

export interface BudgetState {
  name: string;
  amount_usd: number;
  currency: string;
  thresholds: number[];
  /** Which notification channels it reaches. Zero means the budget is decorative. */
  channels: number;
}

export interface CostProvider extends Provider {
  kind: 'cost';
  listBudgets(ctx: ProviderContext): Promise<BudgetState[]>;
  /**
   * Actual spend. Requires a BigQuery billing export, which is NOT configured here — so this
   * returns null and the UI says exactly that instead of drawing an empty chart. An empty cost
   * chart reads as "you spent nothing", which is never true.
   */
  actuals(ctx: ProviderContext): Promise<null>;
}

export function createGcpCostProvider(opts: {
  id: string;
  envs: EnvKey[];
  scope: { billing_account: string; project_id: string };
}): CostProvider {
  const account = opts.scope.billing_account;
  const quotaProject = opts.scope.project_id;
  // NOT `cost.actuals` — actual spend needs a BigQuery billing export that does not exist. Claiming
  // a feature we cannot serve is how a screen ends up drawing an empty chart as if it were zero spend.
  const supported = new Set<Feature>(['cost.budgets']);

  return {
    id: opts.id,
    type: 'gcp.billing',
    kind: 'cost',
    label: 'Billing',
    envs: opts.envs,
    supports: (f) => supported.has(f),

    async health(ctx: ProviderContext): Promise<ProviderHealth> {
      if (!account) {
        return { ok: false, detail: 'no billing account configured', checked_at: new Date().toISOString() };
      }
      try {
        await gcpJson({
          url: `https://billingbudgets.googleapis.com/v1/billingAccounts/${account}/budgets`,
          signal: ctx.signal,
          quotaProject,
        });
        return { ok: true, detail: 'reachable', checked_at: new Date().toISOString() };
      } catch (e) {
        return { ok: false, detail: (e as Error).message.slice(0, 200), checked_at: new Date().toISOString() };
      }
    },

    async listBudgets(ctx): Promise<BudgetState[]> {
      if (!account) return [];
      const body = await gcpJson<{ budgets?: Record<string, any>[] }>({
        url: `https://billingbudgets.googleapis.com/v1/billingAccounts/${account}/budgets`,
        signal: ctx.signal,
        quotaProject,
      });
      return (body.budgets ?? []).map((b) => ({
        name: String(b['displayName'] ?? 'budget'),
        amount_usd: Number(b['amount']?.specifiedAmount?.units ?? 0),
        currency: String(b['amount']?.specifiedAmount?.currencyCode ?? 'USD'),
        thresholds: (b['thresholdRules'] ?? []).map((t: any) => Number(t.thresholdPercent ?? 0)).sort(),
        channels: (b['notificationsRule']?.monitoringNotificationChannels ?? []).length,
      }));
    },

    async actuals(): Promise<null> {
      return null;
    },
  };
}
