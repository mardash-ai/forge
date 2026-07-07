// Token-conscious rendering. Every returned token costs money, so the CLI
// projects each Resource down to the fields a Builder/agent actually needs and
// always ends with a single suggested_next command.

type Any = Record<string, any>;

function logRef(r: Any): string | undefined {
  return r.log_path ? r.log_path : undefined;
}

// Compact "agent view" of a Resource produced by a Capability.
export function compact(resource: Any): Any {
  const r = resource;
  switch (r.type) {
    case 'Application':
      return {
        resource: r.id,
        type: r.type,
        name: r.name,
        platform: r.platform,
        framework: r.framework,
        repo_path: r.repo_path,
        suggested_next: `forge provision --app ${r.name}`,
      };
    case 'Environment':
      return {
        resource: r.id,
        status: r.status,
        services: r.services,
        ports: r.ports,
        suggested_next: 'forge install --app <app>',
      };
    case 'DependencyInstall':
      return {
        resource: r.id,
        status: r.status,
        summary: r.summary,
        log_ref: logRef(r),
        suggested_next: r.status === 'succeeded' ? 'forge build --app <app>' : `forge explain --resource ${r.id}`,
      };
    case 'DevServer':
      return {
        resource: r.id,
        status: r.status,
        url: r.url,
        health: r.health,
        container_id: r.container_id || undefined,
      };
    case 'Deployment':
      return {
        resource: r.id,
        status: r.status,
        service: r.service,
        ...(r.strategy ? { strategy: r.strategy } : {}),
        ...(r.context ? { context: r.context } : {}),
        duration_ms: r.duration_ms,
        ...(r.status === 'succeeded'
          ? {
              rolled_from: (r.old_container_ids ?? []).map((c: string) => c.slice(0, 12)),
              rolled_to: (r.new_container_ids ?? []).map((c: string) => c.slice(0, 12)),
            }
          : { summary: r.error_summary }),
        log_ref: logRef(r),
        suggested_next:
          r.status === 'succeeded' ? 'forge inspect events --app <app>' : `forge explain --resource ${r.id}`,
      };
    case 'ProductionArtifacts':
      return {
        resource: r.id,
        status: r.status,
        host: r.host,
        services: r.services,
        files: r.files,
        suggested_next: `forge deploy --app <app>`,
      };
    case 'Build':
      return {
        resource: r.id,
        status: r.status,
        duration_ms: r.duration_ms,
        ...(r.status === 'succeeded'
          ? { artifact_refs: r.artifact_refs }
          : { summary: r.error_summary }),
        log_ref: logRef(r),
        suggested_next: r.status === 'succeeded' ? 'forge test --app <app>' : `forge explain --resource ${r.id}`,
      };
    case 'TestRun':
      return {
        resource: r.id,
        status: r.status,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
        ...(r.failure_summary ? { summary: r.failure_summary } : {}),
        log_ref: logRef(r),
        suggested_next: r.status === 'succeeded' ? 'forge lint --app <app>' : `forge explain --resource ${r.id}`,
      };
    case 'CheckRun':
      return {
        resource: r.id,
        status: r.status,
        problems: r.problems,
        summary: r.summary,
        log_ref: logRef(r),
        suggested_next: r.status === 'succeeded' ? 'forge build --app <app>' : `forge explain --resource ${r.id}`,
      };
    case 'Secret':
      // Metadata only — a Secret Resource never carries the value.
      return { resource: r.id, name: r.name, status: r.status };
    case 'ScheduledJob':
      return {
        resource: r.id,
        name: r.name,
        schedule: r.schedule,
        target: `${r.target?.method} ${r.target?.path}`,
        enabled: r.enabled,
        next_run_at: r.next_run_at,
        last_status: r.last_status,
        runs: r.run_count,
      };
    case 'Inspection':
      return { resource: r.id, inspection_type: r.inspection_type, summary: r.summary, data: r.data };
    case 'Analysis':
      return {
        resource: r.id,
        source: r.source_resource_id,
        likely_cause: r.likely_cause,
        evidence: r.evidence,
        file_refs: r.file_refs,
        suggested_actions: r.suggested_actions,
      };
    case 'Plan':
      return {
        resource: r.id,
        goal: r.goal,
        proposed_resources: r.proposed_resources,
        proposed_files: r.proposed_files,
        capability_sequence: r.capability_sequence,
        validation_steps: r.validation_steps,
        risks: r.risks,
      };
    default:
      return r;
  }
}

// Human-readable one-block summary.
export function summarize(resource: Any): string {
  const c = compact(resource);
  const lines: string[] = [];
  const status = c.status ? ` [${c.status}]` : '';
  lines.push(`${resource.type}${status}  ${c.resource ?? ''}`);
  for (const [k, v] of Object.entries(c)) {
    if (k === 'resource' || k === 'type' || k === 'status') continue;
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    lines.push(`  ${k}: ${val}`);
  }
  return lines.join('\n');
}
