import { randomUUID } from 'node:crypto';

// Short, prefixed, sortable-ish ids. Prefix communicates the resource/event kind
// at a glance, which keeps agent-facing output readable.
export function newId(prefix: string): string {
  const uuid = randomUUID().replace(/-/g, '');
  return `${prefix}_${uuid.slice(0, 20)}`;
}

export const RESOURCE_ID_PREFIX: Record<string, string> = {
  Application: 'app',
  Environment: 'env',
  DependencyInstall: 'dep',
  DevServer: 'dev',
  Build: 'build',
  TestRun: 'test',
  CheckRun: 'check',
  Inspection: 'insp',
  Analysis: 'analysis',
  Plan: 'plan',
  Secret: 'sec',
  ScheduledJob: 'job',
  Deployment: 'deploy',
  Release: 'rel',
  AgentTask: 'run',
  Artifact: 'art',
  EmailDelivery: 'email',
};

export function newResourceId(type: string): string {
  return newId(RESOURCE_ID_PREFIX[type] ?? type.toLowerCase());
}

export function newEventId(): string {
  return newId('evt');
}
