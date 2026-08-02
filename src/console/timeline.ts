/**
 * The unified "what changed" axis. PURE — merges already-fetched facts, fetches nothing.
 *
 * The value is entirely in the MERGE. Each of these sources is individually available today, in its
 * own tool, on its own clock; the thing nobody can do is see them against one another. Every real
 * incident this estate has had was diagnosed by eventually noticing that something deployed four
 * minutes before the symptom started.
 */
import type { Finding, PipelineRun, Revision, TimelineEvent } from './domain';

export interface TimelineInput {
  runs: readonly PipelineRun[];
  /** Revisions per service — the deploy axis. */
  revisions: ReadonlyArray<{ service: string; revisions: readonly Revision[] }>;
  findings: readonly Finding[];
  audit: ReadonlyArray<{ at: string; actor: string; action: string; target: string; outcome: string }>;
  /** Cut the window so a 200-run backlog cannot bury today. */
  since: Date;
}

const outcomeOf = (r: PipelineRun): TimelineEvent['outcome'] =>
  r.status !== 'completed'
    ? 'neutral'
    : r.conclusion === 'success'
      ? 'ok'
      : r.conclusion === 'failure'
        ? 'failed'
        : 'neutral';

export function buildTimeline(input: TimelineInput): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const cutoff = input.since.getTime();
  const inWindow = (iso?: string): boolean => !!iso && new Date(iso).getTime() >= cutoff;

  for (const r of input.runs) {
    if (!inWindow(r.started_at)) continue;
    events.push({
      at: r.started_at!,
      kind: 'pipeline',
      title: `${r.pipeline_name} #${r.number}`,
      detail: `${r.repo.split('/').pop()} · ${r.branch} · ${r.actor}`,
      outcome: outcomeOf(r),
      link: r.url,
    });
  }

  for (const { service, revisions } of input.revisions) {
    for (const rev of revisions) {
      if (!inWindow(rev.created_at)) continue;
      events.push({
        at: rev.created_at,
        kind: 'deploy',
        title: `${service} → ${rev.id}`,
        // The digest, not the tag: on cutover night `:latest` was the same string before and after.
        detail: rev.image_digest
          ? `${rev.traffic_percent}% traffic · ${rev.image_digest.slice(0, 19)}`
          : `${rev.traffic_percent}% traffic`,
        service_key: service,
        outcome: rev.ready ? 'ok' : 'failed',
      });
    }
  }

  for (const f of input.findings) {
    if (!inWindow(f.first_seen_at)) continue;
    events.push({
      at: f.first_seen_at,
      kind: 'finding',
      title: f.title,
      detail: f.detail.slice(0, 160),
      ...(f.service_key ? { service_key: f.service_key } : {}),
      outcome: f.severity === 'info' ? 'neutral' : 'failed',
    });
  }

  for (const a of input.audit) {
    if (!inWindow(a.at)) continue;
    events.push({
      at: a.at,
      kind: 'action',
      title: `${a.action} ${a.target}`,
      detail: `by ${a.actor}`,
      outcome: a.outcome === 'succeeded' ? 'ok' : a.outcome === 'failed' ? 'failed' : 'neutral',
    });
  }

  // Newest first: during an incident you read backwards from now.
  return events.sort((a, b) => b.at.localeCompare(a.at));
}
