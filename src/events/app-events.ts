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
  // Denormalized snapshot the app supplies; rendered as-is.
  data: Record<string, unknown>;
  // ISO-8601 emit time.
  at: string;
}
