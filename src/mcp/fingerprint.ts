import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { mcpDir, mcpFingerprintFile } from '../shared/paths';
import type { ToolRegistration } from './types';

// C23 manifest-fingerprint diff + startup `notifications/tools/list_changed` push.
//
// WHY: `broadcastToolListChanged` already fires on every `POST /mcp/tools` and `DELETE /mcp/tools/:name`
// while the sidecar is running. But if a consumer registers/re-registers tools while the sidecar is
// DOWN (e.g. during a rolling deploy, or before the sidecar ever booted for a new app), there are no
// live SSE clients to receive the broadcast. On the next boot the fingerprint check detects the
// difference and pushes to any sessions that open during that boot — most importantly the rapid-reconnect
// sessions an MCP host opens immediately after its connector detects the endpoint is back.
//
// SCOPE (honest): the broadcaster is IN-PROCESS. Clients that connect to a DIFFERENT replica (in a
// scaled-out deploy) will not receive the notification for a change that hit ONLY this replica's boot.
// That boundary is documented in the C23 runbook.

// --- canonical form -------------------------------------------------------

/**
 * The fingerprint-canonical representation of one tool. Covers name + description + input/output
 * schemas + all annotation hints — the fields a client consumes to understand what the tool does
 * and how to call it. Omits runtime-only fields (scope, family, handler_path, high_risk,
 * created_at, updated_at) that carry no client-visible semantic meaning.
 *
 * A description-only change MUST flip the digest (the acceptance criterion), so `description`
 * sits at the top level of this object, not nested under `annotations`.
 */
function toolCanon(t: ToolRegistration): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    ...(t.output_schema !== undefined ? { output_schema: t.output_schema } : {}),
    // MCP annotation hints — all optional, snake_case at rest. A change to any hint changes the
    // client's behavioural model of the tool, so all belong in the fingerprint.
    ...(t.title !== undefined ? { title: t.title } : {}),
    ...(t.read_only_hint !== undefined ? { read_only_hint: t.read_only_hint } : {}),
    ...(t.destructive_hint !== undefined ? { destructive_hint: t.destructive_hint } : {}),
    ...(t.idempotent_hint !== undefined ? { idempotent_hint: t.idempotent_hint } : {}),
    ...(t.open_world_hint !== undefined ? { open_world_hint: t.open_world_hint } : {}),
  };
}

/**
 * Compute a SHA-256 hex fingerprint over the tool manifest. Sorted by `name` so re-ordering the
 * tool set alone does NOT flip the digest (only semantic changes do). The serialization is
 * deterministic because JSON.stringify on a plain object is order-stable for the keys we
 * write above (they are always added in the same order by `toolCanon`).
 */
export function computeManifestFingerprint(tools: ToolRegistration[]): string {
  const canon = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map(toolCanon);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// --- persistence ----------------------------------------------------------

/**
 * Load the previously persisted fingerprint for `appId`. Returns `null` when the file is absent
 * (first boot, or state volume was cleared) — treating a missing record as "unknown / changed" is
 * the safe default: we might push a spurious notification but we never suppress a real one.
 */
export async function loadSavedFingerprint(appId: string): Promise<string | null> {
  try {
    const text = (await readFile(mcpFingerprintFile(appId), 'utf8')).trim();
    return text.length === 64 ? text : null; // a sha256 hex is exactly 64 chars
  } catch {
    return null; // file absent on first boot — safe to treat as changed
  }
}

/** Persist `fp` as the current fingerprint for `appId` (overwrites any previous value). */
export async function saveFingerprint(appId: string, fp: string): Promise<void> {
  await mkdir(path.join(mcpDir()), { recursive: true });
  await writeFile(mcpFingerprintFile(appId), fp + '\n', 'utf8');
}

// --- startup check --------------------------------------------------------

/** Result of a startup manifest-change check. */
export interface ManifestCheckResult {
  /** `true` when the fingerprint differs from the previous boot's fingerprint. */
  changed: boolean;
  /** The fingerprint computed from the CURRENT tool set. */
  fingerprint: string;
  /** The fingerprint recorded from the PREVIOUS boot, or `null` on first boot. */
  previous: string | null;
  /** How many connected sessions the notification was pushed to (0 = no live streams at boot time). */
  notified: number;
}

/**
 * Compare the current tool manifest fingerprint against the persisted previous-boot fingerprint for
 * `appId`. When they differ (or when no previous fingerprint exists), saves the new fingerprint and
 * calls `broadcastFn(appId)` to push `notifications/tools/list_changed` to any connected SSE
 * sessions. When the fingerprint is unchanged, does nothing and returns `changed: false`.
 *
 * `broadcastFn` is injected so tests can assert on calls without importing the routes module
 * (which carries the in-process subscriber map as mutable module state).
 */
export async function checkAndMaybeBroadcastManifestChange(
  appId: string,
  tools: ToolRegistration[],
  broadcastFn: (appId: string) => number,
): Promise<ManifestCheckResult> {
  const fingerprint = computeManifestFingerprint(tools);
  const previous = await loadSavedFingerprint(appId);
  const changed = previous !== fingerprint;
  if (changed) {
    // Save BEFORE broadcasting so a crash-between-broadcast-and-save does not permanently suppress
    // future notifications (the persisted fingerprint is the "what we told clients" record, but on
    // first boot the safe default is "changed", so writing an incorrect fingerprint is fine —
    // clients that reconnect will catch the correction on the next boot).
    await saveFingerprint(appId, fingerprint);
    const notified = broadcastFn(appId);
    return { changed: true, fingerprint, previous, notified };
  }
  return { changed: false, fingerprint, previous, notified: 0 };
}
