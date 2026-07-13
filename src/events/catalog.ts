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
  'VerificationCompleted',
  'AnalysisCreated',
  'PlanCreated',
  'SecretSet',
  'SecretUnset',
  'JobScheduled',
  'JobUnscheduled',
  'JobRan',
  'JobRunFailed',
  'DeploymentStarted',
  'DeploymentCompleted',
  'DeploymentRolledBack',
  'ProductionArtifactsGenerated',
  'ReleaseStarted',
  'ReleaseCompleted',
  'ReleaseFailed',
  'AgentRunSucceeded',
  'AgentRunFailed',
  'ArtifactCreated',
  'EmailSent',
  'EmailFailed',
  // Outbound message sent AS a connected user (C25 SendMessage). Facts carry a REDACTED recipient +
  // channel/provider + provider message/thread ids only — never the body, a token, or the full address.
  'MessageSent',
  'MessageFailed',
  // Identity / auth (C10) — facts carry a REDACTED email + ids only; never a
  // password, hash, session token, or verify/reset token.
  'UserSignedUp',
  'UserVerified',
  'UserAuthenticated',
  'SessionRefreshed',
  'SessionRevoked',
  'PasswordResetRequested',
  'PasswordChanged',
  'OwnerSeeded',
  // Status incidents (C15 Phase 3) — operator-declared facts shown on the public
  // status page. Carry only the incident id/title/status/impact, never PII.
  'IncidentOpened',
  'IncidentUpdated',
  'IncidentResolved',
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
