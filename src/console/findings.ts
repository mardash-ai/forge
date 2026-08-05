/**
 * The findings engine. PURE — takes a snapshot, returns observations.
 *
 * REPORT-ONLY IS STRUCTURAL, not a convention: a rule receives a frozen snapshot and returns
 * `Finding[]`. There is no provider handle, no client, no way to act. A rule that wanted to fix
 * something could not, because it has nothing to fix anything with.
 *
 * Every rule here was written from something that actually happened in this estate. That is the
 * bar for adding one: a finding nobody has ever been bitten by is noise, and noise is what makes
 * operators stop reading their own dashboards.
 */
import type { Credential, Finding, InfraResource, PipelineRun, ServiceGraph } from './domain';

export interface FindingsSnapshot {
  readonly resources: readonly InfraResource[];
  readonly graph: ServiceGraph;
  readonly credentials: readonly Credential[];
  readonly runs: readonly PipelineRun[];
  /** Whether the app-metrics store has ANY recent samples. */
  readonly metricsIngesting: boolean;
  readonly now: Date;
}

type Rule = (s: FindingsSnapshot) => Finding[];

const f = (p: Omit<Finding, 'id' | 'first_seen_at'> & { id?: string }, now: Date): Finding => ({
  id: p.id ?? `${p.rule}:${p.subject}`,
  first_seen_at: now.toISOString(),
  ...p,
});

const days = (from: Date, to: Date): number => Math.floor((to.getTime() - from.getTime()) / 86_400_000);

/**
 * The meta-check, and the reason it is first: on 2026-07-31 Managed Prometheus was empty for days
 * behind a five-fault chain, and nothing anywhere noticed. A store with no data must be an ALARM,
 * never a quiet dashboard.
 */
const metricsPipelineDead: Rule = (s) =>
  s.metricsIngesting
    ? []
    : [
        f(
          {
            rule: 'metrics-pipeline-dead',
            severity: 'critical',
            title: 'No application metrics are being ingested',
            detail:
              'Managed Prometheus has no recent samples. Every app-metric dashboard will render empty, ' +
              'and it will look like low traffic rather than a broken pipeline.',
            subject: 'managed-prometheus',
            suggested_action:
              'Check the otel-collector is running with min_instances >= 1 and that its exports are not being rejected.',
          },
          s.now,
        ),
      ];

/** Expiring credentials. The runner PAT taking CI down on a Friday is the motivating example. */
const expiringCredentials: Rule = (s) =>
  s.credentials.flatMap((c) => {
    if (!c.expires_at || c.auto_renews) return [];
    const left = days(s.now, new Date(c.expires_at));
    if (left > 30) return [];
    const severity = left <= 0 ? 'critical' : left <= 7 ? 'critical' : 'warn';
    return [
      f(
        {
          rule: 'credential-expiring',
          severity,
          title:
            left <= 0 ? `${c.name} has EXPIRED` : `${c.name} expires in ${left} day${left === 1 ? '' : 's'}`,
          detail:
            c.kind === 'tls_certificate'
              ? 'A managed certificate renews automatically only while its DNS authorization resolves.'
              : 'Nothing renews this automatically.',
          subject: c.id,
          env: c.env,
          suggested_action: `Rotate ${c.name} and update the secret value.`,
        },
        s.now,
      ),
    ];
  });

/** A resource that belongs to no service. Orphans are cost and risk, and nobody ever goes looking. */
const unboundResources: Rule = (s) =>
  s.graph.unbound.length === 0
    ? []
    : [
        f(
          {
            rule: 'unbound-resources',
            severity: 'info',
            title: `${s.graph.unbound.length} resources belong to no known service`,
            detail:
              'The console could not attach these to any service. They are shown rather than hidden — ' +
              'an orphan is usually either a leftover that still costs money, or a gap in correlation.',
            subject: 'correlation',
            suggested_action: 'Review the list; delete what is genuinely unused, or add an override.',
          },
          s.now,
        ),
      ];

/** Two services claiming one resource — ambiguity is reported, never silently resolved. */
const correlationConflicts: Rule = (s) =>
  s.graph.conflicts.map((c) =>
    f(
      {
        rule: 'correlation-conflict',
        severity: 'warn',
        title: `${c.external_id.split('/').pop()} is claimed by ${c.claimants.length} services`,
        detail: `Claimed by: ${c.claimants.join(', ')}. The console will not guess which is right.`,
        subject: c.external_id,
        suggested_action: 'Add an override to attach it to the correct service.',
      },
      s.now,
    ),
  );

/**
 * A push-based collector on min_instances=0 drops everything pushed while it is cold. This cost a
 * week of metrics; it is worth its own rule rather than being folded into a generic config check.
 */
const collectorScalesToZero: Rule = (s) =>
  s.resources
    .filter(
      (r) =>
        r.kind === 'compute.service' &&
        /collector/.test(r.name) &&
        Number(r.attributes['min_instances'] ?? 0) < 1,
    )
    .map((r) =>
      f(
        {
          rule: 'collector-scales-to-zero',
          severity: 'critical',
          title: `${r.name} can scale to zero`,
          detail:
            'A push-based OTLP collector cannot scale to zero: anything emitted while it is cold is ' +
            'dropped silently, and the metric store then looks merely quiet.',
          subject: r.external_id,
          env: r.env,
          service_key: r.service_key ?? '',
          suggested_action: 'Set min_instances = 1 on the collector.',
        },
        s.now,
      ),
    );

/** Backups are the one thing you cannot retrofit after you need them. */
const databaseProtection: Rule = (s) =>
  s.resources
    .filter((r) => r.kind === 'db.instance')
    .flatMap((r) => {
      const out: Finding[] = [];
      if (!r.attributes['backups']) {
        out.push(
          f(
            {
              rule: 'db-no-backups',
              severity: 'critical',
              title: `${r.name} has no automated backups`,
              detail: 'This is unrecoverable data loss waiting to happen.',
              subject: r.external_id,
              env: r.env,
              suggested_action: 'Enable automated backups and point-in-time recovery.',
            },
            s.now,
          ),
        );
      } else if (!r.attributes['pitr']) {
        out.push(
          f(
            {
              rule: 'db-no-pitr',
              severity: 'warn',
              title: `${r.name} has backups but no point-in-time recovery`,
              detail: 'You can restore to last night, but not to just before a bad write.',
              subject: r.external_id,
              env: r.env,
              suggested_action: 'Enable point-in-time recovery.',
            },
            s.now,
          ),
        );
      }
      if (r.scope === 'zonal') {
        out.push(
          f(
            {
              rule: 'db-single-zone',
              severity: 'info',
              title: `${r.name} is pinned to a single zone (${r.location})`,
              detail:
                "This is the estate's only zone-pinned resource, so it is the entire single-zone " +
                'availability story: if that zone goes, everything else stays up with nothing to talk to.',
              subject: r.external_id,
              env: r.env,
              suggested_action: 'Regional HA is an in-place setting change when you want it.',
            },
            s.now,
          ),
        );
      }
      return out;
    });

/**
 * A failed or stale most-recent backup run signals that the restore point you are counting on may
 * not exist. Combined with db-no-backups (which fires when the SETTING is off), this covers both
 * the configuration axis and the runtime axis.
 *
 * Four cases, each with a distinct message:
 *   api_error  — the sqladmin backupRuns call failed; posture unknown
 *   disabled   — backups off; db-no-backups handles it; this rule is silent
 *   FAILED     — most recent run has status FAILED; no current restore point
 *   stale      — most recent successful run is older than 26 h
 *
 * A rule that fires on FAILED but skips RUNNING avoids a false alarm during an in-progress run.
 */
const databaseBackupRunHealth: Rule = (s) =>
  s.resources
    .filter((r) => r.kind === 'db.instance')
    .flatMap((r) => {
      const runStatus = r.attributes['backup_runs_status'];

      // (a) sqladmin/backupRuns was unreachable or returned an error.
      if (runStatus === 'api_error') {
        return [
          f(
            {
              rule: 'db-backup-api-error',
              severity: 'warn',
              title: `Backup run history unavailable for ${r.name}`,
              detail:
                'The sqladmin backupRuns API returned an error, so the most-recent-backup posture ' +
                'cannot be confirmed. ' +
                (r.attributes['backup_runs_error']
                  ? String(r.attributes['backup_runs_error']).slice(0, 150)
                  : ''),
              subject: r.external_id,
              env: r.env,
              suggested_action:
                'Verify the console SA holds roles/cloudsql.viewer and the sqladmin API is enabled.',
            },
            s.now,
          ),
        ];
      }

      // (b) Backups disabled — db-no-backups already fires; this rule stays silent.
      if (!r.attributes['backups'] || runStatus === 'disabled') return [];

      const lastStatus = r.attributes['backup_last_status'];
      const lastEndTime = r.attributes['backup_last_end_time'];

      // Most recent run FAILED — no current restore point.
      if (lastStatus === 'FAILED') {
        return [
          f(
            {
              rule: 'db-backup-run-failed',
              severity: 'critical',
              title: `${r.name}: most recent backup run FAILED`,
              detail:
                'The latest backup completed with status FAILED. Until a successful backup finishes, ' +
                'this database has no recent restore point.',
              subject: r.external_id,
              env: r.env,
              suggested_action:
                'Check Cloud SQL logs for the backup failure reason; trigger a manual on-demand backup.',
            },
            s.now,
          ),
        ];
      }

      // No runs on record (newly created instance or unexpected pruning).
      // Skip if a run is currently in progress — it has not produced an endTime yet.
      if ((runStatus === 'none' || !lastEndTime) && lastStatus !== 'RUNNING') {
        return [
          f(
            {
              rule: 'db-backup-stale',
              severity: 'warn',
              title: `${r.name}: no backup run on record`,
              detail:
                'Automated backups are enabled but the backupRuns history shows no completed runs. ' +
                'The instance may be newly created, or runs are being pruned before the console reads them.',
              subject: r.external_id,
              env: r.env,
              suggested_action:
                'Verify the backup window is configured and at least one run has completed.',
            },
            s.now,
          ),
        ];
      }

      // Most recent successful backup is STALE (> 26 h). Skip if a run is currently in progress.
      if (lastStatus !== 'RUNNING') {
        const endDate = new Date(String(lastEndTime));
        const ageMs = s.now.getTime() - endDate.getTime();
        const STALE_MS = 26 * 60 * 60 * 1_000;
        if (!isNaN(endDate.getTime()) && ageMs > STALE_MS) {
          const hours = Math.floor(ageMs / 3_600_000);
          return [
            f(
              {
                rule: 'db-backup-stale',
                severity: 'warn',
                title: `${r.name}: last backup is ${hours}h old`,
                detail:
                  `The most recent backup completed ${hours} hours ago (threshold: 26 h). ` +
                  'This gap leaves the database with an extended potential data-loss window.',
                subject: r.external_id,
                env: r.env,
                suggested_action:
                  'Check that the backup window is configured correctly and is not overlapping with maintenance.',
              },
              s.now,
            ),
          ];
        }
      }

      return [];
    });

/** Over-provisioned disk you pay for and never use. Found by hand once; found automatically now. */
const overProvisionedDisk: Rule = (s) =>
  s.resources
    .filter((r) => r.kind === 'db.instance' && Number(r.attributes['disk_gb'] ?? 0) >= 50)
    .map((r) =>
      f(
        {
          rule: 'db-disk-oversized',
          severity: 'info',
          title: `${r.name} provisions ${r.attributes['disk_gb']} GB`,
          detail:
            'Cloud SQL bills PROVISIONED gigabytes, not used ones, and autoresize means the initial ' +
            'size is a floor rather than a capacity plan. Disks cannot be shrunk in place.',
          subject: r.external_id,
          env: r.env,
          suggested_action: 'Check actual usage; right-size at the next rebuild.',
        },
        s.now,
      ),
    );

/** The default VPC: free, but 40+ subnets and permissive default firewall rules nobody asked for. */
const defaultNetwork: Rule = (s) =>
  s.resources
    .filter((r) => r.kind === 'net.network' && r.name === 'default' && r.attributes['auto_subnets'] === true)
    .map((r) =>
      f(
        {
          rule: 'default-vpc-present',
          severity: 'warn',
          title: 'The auto-mode `default` VPC still exists',
          detail:
            `${r.attributes['subnet_count']} subnets and the default firewall rules (including 0.0.0.0/0 ` +
            'on SSH and RDP) created at project birth. Nothing runs in it, so nothing is exposed today — ' +
            'but it is standing attack surface an assessor will ask about.',
          subject: r.external_id,
          env: r.env,
          suggested_action: 'Delete the default VPC.',
        },
        s.now,
      ),
    );

/** Repeated CI failure on one pipeline — the signal that something is broken, not flaky. */
const failingPipelines: Rule = (s) => {
  const byPipeline = new Map<string, PipelineRun[]>();
  for (const r of s.runs) {
    if (r.status !== 'completed') continue;
    const list = byPipeline.get(r.pipeline_id) ?? [];
    list.push(r);
    byPipeline.set(r.pipeline_id, list);
  }
  const out: Finding[] = [];
  for (const [, runs] of byPipeline) {
    const recent = runs.slice(0, 3);
    if (recent.length >= 2 && recent.every((r) => r.conclusion === 'failure')) {
      const r0 = recent[0]!;
      out.push(
        f(
          {
            rule: 'pipeline-failing',
            severity: 'warn',
            title: `${r0.pipeline_name} has failed ${recent.length} times in a row`,
            detail: `Most recent: ${r0.repo} run #${r0.number} on ${r0.branch}.`,
            subject: r0.pipeline_id,
            suggested_action: 'Open the run log; this is consistent failure rather than flake.',
            action_pipeline: { repo: r0.repo, pipeline_id: r0.pipeline_id },
          },
          s.now,
        ),
      );
    }
  }
  return out;
};

/**
 * A user-managed service-account key should not exist ANYWHERE in this platform — everything
 * authenticates through Workload Identity. A key is a long-lived credential that can be copied off
 * a laptop, and its presence is the finding regardless of expiry.
 */
const serviceAccountKeys: Rule = (s) =>
  s.credentials
    .filter((c) => c.kind === 'service_account_key')
    .map((c) =>
      f(
        {
          rule: 'service-account-key-exists',
          severity: 'critical',
          title: `A service-account key exists: ${c.name}`,
          detail:
            'This platform authenticates exclusively through Workload Identity and should hold no ' +
            'service-account keys. A key is long-lived, copyable, and does not expire with a session.',
          subject: c.id,
          env: c.env,
          suggested_action: 'Delete the key and move whatever uses it to Workload Identity.',
        },
        s.now,
      ),
    );

const RULES: Rule[] = [
  serviceAccountKeys,
  metricsPipelineDead,
  collectorScalesToZero,
  databaseProtection,
  databaseBackupRunHealth,
  expiringCredentials,
  failingPipelines,
  defaultNetwork,
  correlationConflicts,
  overProvisionedDisk,
  unboundResources,
];

const ORDER = { critical: 0, warn: 1, info: 2 } as const;

export function runFindings(snapshot: FindingsSnapshot): Finding[] {
  // Frozen so a rule cannot mutate what it is inspecting — report-only, enforced.
  const frozen = Object.freeze({ ...snapshot });
  return RULES.flatMap((rule) => {
    try {
      return rule(frozen);
    } catch {
      // A broken rule must never take down the findings screen.
      return [];
    }
  }).sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.title.localeCompare(b.title));
}
