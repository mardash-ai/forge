// AppEvent — an application DOMAIN fact (e.g. "goal.created", "task.completed"), emitted by the
// running app and queried back as a per-app feed. This is capability C3.
//
// It is deliberately NOT a `ForgeEvent` (the platform's own facts about Resources, a CLOSED
// catalog in events/catalog.ts) and NOT a Resource (it has no lifecycle — it's an immutable
// fact). App events have an OPEN, app-defined `type`, a `subject` ref the app chooses (e.g. a
// goal id) that the feed filters on, and a denormalized `data` snapshot so the feed still renders
// correctly even if the underlying state later changes.
export interface AppEvent {
  id: string;
  app_id: string;
  // App-defined kind, e.g. "goal.created". Not constrained to a platform enum.
  type: string;
  // App-defined subject ref (the filter key), e.g. a goal id. Optional.
  subject?: string;
  // Owner (C11) — the opaque user id (e.g. C10's session `userId`) this event belongs to.
  // The feed filters by (app, owner): a query passing an owner sees ONLY that owner's events,
  // so events never leak across users. Absent = legacy/app-scoped (pre-C11 or a C10-less app).
  owner?: string;
  // Caller attribution — the identity of the service or host that emitted this event. Set
  // on app-emitted events when the emitter passes `caller` in the POST /app-events body
  // (e.g. dorinda-api stamps the OAuth client id on mcp.tool_call events). Forge-written
  // events (mcp.tool_call, authz.decision, policy.*, connector.*, message.*) also carry this
  // when the platform can determine the originator. Absent = unattributed.
  caller?: string;
  // W3C-style trace id (16-byte hex) from the active span when this event was written. Set
  // only on FORGE-WRITTEN events (mcp.tool_call, authz.decision, policy.*, connector.*,
  // message.*). Consumers use this for cross-hop trace correlation. Absent on app-emitted
  // events (the app controls its own tracing boundary). Also copied into data.trace_id for
  // backward compatibility with consumers that read the data payload directly.
  trace_id?: string;
  // Denormalized snapshot the app supplies; rendered as-is.
  data: Record<string, unknown>;
  // ISO-8601 emit time.
  at: string;
}
