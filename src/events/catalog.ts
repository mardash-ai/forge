// Events — immutable FACTS about what happened. Events carry no intent and are
// never commands. Append-only. See 02_FORGE_DOMAIN_MODEL.md.

import type { Actor } from '../shared/domain';

export const EVENT_TYPES = [
  'ApplicationInitialized',
  'EnvironmentProvisioned',
  'DependenciesInstalled',
  'DevServerStarted',
  'DevServerStopped',
  'BuildStarted',
  'BuildSucceeded',
  'BuildFailed',
  'TestRunStarted',
  'TestRunSucceeded',
  'TestRunFailed',
  'CheckRunStarted',
  'CheckRunSucceeded',
  'CheckRunFailed',
  'InspectionCreated',
  'AnalysisCreated',
  'PlanCreated',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface ForgeEvent {
  id: string;
  type: EventType;
  resource_type: string;
  resource_id: string;
  app_id?: string;
  timestamp: string;
  actor: Actor;
  data: Record<string, unknown>;
}
