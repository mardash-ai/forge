import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hasValidServiceToken } from '../shared/service-auth';
import { getBackends } from '../storage/backends';
import { nowIso } from '../shared/time';
import * as authStore from '../plugins/auth-identity/store';
import { deleteCustomer } from '../billing/service';
import { teardownMember } from '../membership/service';
import { disconnectAll } from '../connectors/service';
import { store } from '../storage/store';

const APP_HEADER = 'x-forge-app';

/** Resolve the target app the same way every other admin route does (query, body, header). */
async function resolveAppId(
  req: FastifyRequest,
  // The data plane serves ONE app and its caller does not send `app` — it comes from the
  // environment, exactly as the membership and billing routes already do. Without this, the app's
  // own teardown call would 404 on the plane it actually talks to.
  defaultApp?: () => string | undefined,
): Promise<{ id: string; name: string } | null> {
  const n =
    (typeof (req.query as { app?: string })?.app === 'string' && (req.query as { app?: string }).app!.trim()) ||
    (typeof (req.body as { app?: string })?.app === 'string' && (req.body as { app?: string }).app!.trim()) ||
    (Array.isArray(req.headers[APP_HEADER]) ? (req.headers[APP_HEADER] as string[])[0] : (req.headers[APP_HEADER] as string | undefined)) ||
    defaultApp?.();
  if (!n) return null;
  const a = await store.findAppByName(String(n));
  return a && a.type === 'Application' ? { id: a.id, name: String(n) } : null;
}

/**
 * C34 — WHOLE-TENANT TEARDOWN. One call that removes everything the platform holds for one owner.
 *
 * WHY THIS EXISTS. Erasing an account used to mean the consumer orchestrating four or five separate
 * service-token-gated calls — identity, billing, membership, connectors, MCP grants — in an order it
 * had to get right, with its own retry semantics, reimplemented in every consumer. Dorinda had a
 * tested version of that orchestration; nobody else did, and Dorinda's would drift from the platform
 * the moment a sixth subsystem appeared. Worse, five subsystems had NO per-owner delete at all
 * (app events had none of any kind; push subscriptions could not even be enumerated over HTTP), so a
 * "complete" deletion was not achievable from outside this process no matter how carefully a
 * consumer sequenced its calls.
 *
 * The inventory belongs where it can be kept current — next to the backends that own the rows.
 *
 * WHAT THIS DOES NOT DO. It does not touch the consumer's own schema. Forge does not know that
 * `delegations` exists, and inventing a callback so it could would trade a clear boundary for a
 * distributed transaction with no way to roll back. The consumer deletes its own tables and then
 * calls this once. Four brittle calls become one; the ordering lives here and is tested once.
 *
 * ⚠️ NO TEST-TENANT ALLOW-LIST, DELIBERATELY. Deleting real accounts is this endpoint's job — a
 * GDPR erasure request is the primary use, and test-tenant decommission is a secondary one that
 * doubles as a live rehearsal of it. The compensating controls are below, and they matter precisely
 * because this is the one platform endpoint that can destroy a paying customer's account.
 */
export function registerTenantRoutes(
  app: FastifyInstance,
  opts: { defaultApp?: () => string | undefined } = {},
): void {
  app.delete('/tenant/:owner', async (req, reply) => {
    const { owner } = req.params as { owner: string };
    const body = (req.body ?? {}) as { app?: string; confirm_email?: string; dry_run?: boolean };

    const app_ = await resolveAppId(req, opts.defaultApp);
    if (!app_) {
      return reply.status(404).send({ error: { code: 'unknown_app', message: 'unknown app.', retry: 'needs-human' } });
    }
    const app_id = app_.id;
    if (!(await hasValidServiceToken(req, app_id))) {
      return reply.status(401).send({
        error: { code: 'unauthorized', message: 'a valid service token is required for tenant teardown.', retry: 'needs-human' },
      });
    }

    const identity = await authStore.getUser(app_id, owner).catch(() => null);
    if (!identity) {
      // Idempotent: a second teardown of an already-erased owner is a success, not a 404. Retrying
      // after a partial failure is the normal path and must not require special-casing by the caller.
      return reply.send({ owner, deleted: {}, retained: [], already_absent: true });
    }

    /*
     * CONFIRMATION. The caller must name the account it believes it is deleting, and it must match.
     * A wrong id then becomes a 400 instead of an irreversible deletion — the machine equivalent of
     * typing the repository name to confirm. This is cheap and it is the only control that catches
     * the specific failure of passing a correct-looking but wrong identifier.
     */
    if (!body.confirm_email || body.confirm_email.toLowerCase() !== identity.email.toLowerCase()) {
      return reply.status(400).send({
        error: {
          code: 'confirmation_mismatch',
          message: '`confirm_email` must match the account being deleted.',
          retry: 'needs-human',
        },
      });
    }

    if (body.dry_run) {
      return reply.send({ owner, dry_run: true, email: identity.email, would_delete: SUBSYSTEMS });
    }

    /*
     * PARTIAL-TOLERANT, NOT ALL-OR-NOTHING. These are separate systems — several of them external —
     * with no shared transaction. Billing 503s transiently when Stripe is unreachable. Aborting the
     * whole cascade on the first failure would strand accounts half-deleted with no path forward,
     * and retrying is safe because every step is idempotent. So: attempt everything, report exactly
     * what did not go, and let the caller retry.
     *
     * A silent partial success is the failure mode to avoid here — `retained` is the whole point,
     * and an empty `retained` is the only thing that means "nothing left behind".
     */
    const deleted: Record<string, number | boolean> = {};
    const retained: Array<{ subsystem: string; reason: string }> = [];
    const b = await getBackends();

    const step = async (name: string, fn: () => Promise<number | boolean>): Promise<void> => {
      try {
        deleted[name] = await fn();
      } catch (e) {
        retained.push({ subsystem: name, reason: (e as Error)?.message ?? 'unknown error' });
      }
    };

    // ORDER MATTERS, and it is the order Dorinda's tested cascade already established:
    // external systems first (they can fail and be retried), identity LAST (it is the account
    // anchor — losing it first would leave the rest unreachable and unretryable).
    await step('connectors', async () => {
      await disconnectAll(app_id, owner); // revokes at the PROVIDER, not just locally
      return true;
    });
    await step('mcp_grants', async () => {
      const mcpStore = (await getBackends()).mcp;
      const consents = await mcpStore.listConsents(app_id, owner);
      for (const c of consents) await mcpStore.revokeConsent(app_id, owner, c.client_id);
      return consents.length;
    });
    await step('billing', async () => {
      await deleteCustomer(app_id, owner);
      return true;
    });
    await step('push', () => b.push.deleteByOwner(app_id, owner));
    await step('notifications', () => b.notifications.deleteByOwner(app_id, owner));
    await step('search', () => b.search.deleteByOwner(app_id, owner));
    await step('blobs', () => b.blobs.deleteByOwner(app_id, owner));
    await step('app_events', () => b.events.deleteByOwner(app_id, owner));
    await step('memberships', async () => {
      await (await getBackends()).membership.mutate(app_id, (st) => teardownMember(st, { owner, now: nowIso() }));
      return true;
    });
    await step('identity', async () => {
      await authStore.deleteUser(app_id, owner);
      return true;
    });

    /*
     * AUDIT. Always, at warning level, whether or not it succeeded. An account deletion nobody
     * initiated is worth noticing, and this is the record that makes that possible — stdout survives
     * a telemetry outage, which is exactly when you would want to know.
     */
    process.stderr.write(
      JSON.stringify({
        severity: retained.length ? 'ERROR' : 'WARNING',
        event: 'tenant.teardown',
        app_id,
        owner,
        email: identity.email,
        deleted,
        retained,
        at: new Date().toISOString(),
      }) + '\n',
    );

    return reply.send({ owner, deleted, retained, complete: retained.length === 0 });
  });
}

/** What a teardown covers — returned by `dry_run` so a caller can see the scope before committing. */
const SUBSYSTEMS = [
  'connectors',
  'mcp_grants',
  'billing',
  'push',
  'notifications',
  'search',
  'blobs',
  'app_events',
  'memberships',
  'identity',
] as const;
