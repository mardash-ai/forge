import type { FastifyInstance } from 'fastify';
import { store } from '../storage/store';
import { getBackends } from '../storage/backends';
import { newId } from '../shared/ids';
import { nowIso } from '../shared/time';
import { authorize } from '../authz/authorize';
import type { Actor, Action, PolicyRule, PolicyEffect, PolicyMatch, HighRiskSpec, Decision } from '../authz/types';

// C29 — the authorization/policy HTTP surface. Registered on BOTH planes (control: policy config; data:
// runtime `POST /authorize`), like the other data-plane surfaces. The deterministic decision itself is
// the pure, mirrorable `authorize()` (src/authz/authorize.ts) — this route loads the actor's applicable
// policies, evaluates, RECORDS the decision to the C3 audit trail, and returns it. Owner-scoped (C11).
//
//   POST   /authorize            { owner, role?, group_id?, action, default_decision?, high_risk? } -> AuthzDecision
//   GET    /policies             ?owner=                                                            -> { policies }
//   POST   /policies             { id?, owner?, group_id?, visibility?, effect, priority?, match?, reason? } -> { policy }
//   GET    /policies/:id         ?app=                                                              -> { policy }
//   DELETE /policies/:id         ?app=                                                              -> { deleted }
//   POST   /authz/approvals      { owner, action_class }                                            -> { recorded }
//   GET    /authz/approvals      ?owner=&action_class=&threshold=                                    -> { action_class, approvals, suggest_policy }
//
// `app` defaults to the sidecar's FORGE_APP_NAME. Progressive autonomy: the app records a human APPROVAL
// of a staged action via POST /authz/approvals; GET /authz/approvals surfaces "approved N times" so the
// app can offer to create a policy (the platform provides the mechanism; the app builds the UX).

const EFFECTS: PolicyEffect[] = ['allow', 'needs-approval', 'deny'];
const AUTHZ_DECISION = 'authz.decision';
const AUTHZ_APPROVAL = 'authz.approval';

export function registerAuthzRoutes(app: FastifyInstance, opts: { defaultApp?: () => string | undefined } = {}): void {
  const resolveAppId = async (name?: string): Promise<string | null> => {
    const n = name ?? opts.defaultApp?.();
    if (!n) return null;
    const a = await store.findAppByName(n);
    return a && a.type === 'Application' ? a.id : null;
  };
  const unknownApp = { error: { code: 'not_found', message: 'unknown app (pass `app` or set FORGE_APP_NAME).', retry: 'change-input' } };
  const invalid = (message: string) => ({ error: { code: 'invalid_input', message, retry: 'change-input' } });

  // === POST /authorize — the deterministic decision (+ C3 audit) ===================================
  app.post('/authorize', async (req, reply) => {
    const b = (req.body ?? {}) as {
      app?: string; owner?: string; role?: string; group_id?: string;
      action?: Action; default_decision?: Decision; high_risk?: HighRiskSpec;
    };
    if (!b.owner || typeof b.owner !== 'string') return reply.status(400).send(invalid('authorize requires a string `owner`.'));
    if (!b.action || typeof b.action !== 'object') return reply.status(400).send(invalid('authorize requires an `action` object.'));
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);

    const actor: Actor = { owner: b.owner, ...(b.group_id ? { group_id: b.group_id } : {}), ...(b.role ? { role: b.role } : {}) };
    // The applicable policy set: the owner's + the app-wide rules. Evaluation is a pure function.
    const policies = await (await getBackends()).policy.list(app_id, { owner: b.owner });
    const decision = authorize(actor, b.action, policies, {
      ...(b.default_decision ? { defaultDecision: b.default_decision } : {}),
      ...(b.high_risk ? { highRiskClasses: b.high_risk } : {}),
    });

    // Record the decision to the C3 audit trail (owner-scoped), keyed by the action class.
    await store.appendAppEvent({
      app_id,
      type: AUTHZ_DECISION,
      subject: decision.action_class,
      owner: b.owner,
      data: { decision: decision.decision, rule: decision.rule, high_risk: decision.high_risk, action: b.action },
    });

    return reply.status(200).send(decision);
  });

  // === Policy CRUD =================================================================================
  app.get('/policies', async (req, reply) => {
    const q = req.query as { app?: string; owner?: string };
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const policies = await (await getBackends()).policy.list(app_id, { owner: q.owner });
    return { policies };
  });

  app.post('/policies', async (req, reply) => {
    const b = (req.body ?? {}) as Partial<PolicyRule> & { app?: string };
    if (!b.effect || !EFFECTS.includes(b.effect)) return reply.status(422).send(invalid(`a policy requires \`effect\` (one of ${EFFECTS.join(', ')}).`));
    if (b.match !== undefined && (typeof b.match !== 'object' || Array.isArray(b.match))) return reply.status(422).send(invalid('`match` must be an object.'));
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);

    const backend = (await getBackends()).policy;
    const now = nowIso();
    const id = b.id && typeof b.id === 'string' ? b.id : newId('policy');
    const existing = await backend.get(app_id, id); // preserve created_at on update
    const policy: PolicyRule = {
      id,
      ...(b.owner ? { owner: b.owner } : {}),
      ...(b.group_id ? { group_id: b.group_id } : {}),
      ...(b.visibility ? { visibility: b.visibility } : {}),
      effect: b.effect,
      priority: typeof b.priority === 'number' ? b.priority : 0,
      match: (b.match as PolicyMatch) ?? {},
      ...(b.reason ? { reason: b.reason } : {}),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    await backend.put(app_id, policy);
    return reply.status(200).send({ policy });
  });

  app.get('/policies/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { app?: string };
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const policy = await (await getBackends()).policy.get(app_id, id);
    if (!policy) return reply.status(404).send({ error: { code: 'not_found', message: `no policy "${id}".`, retry: 'change-input' } });
    return { policy };
  });

  app.delete('/policies/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { app?: string };
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    return { deleted: await (await getBackends()).policy.delete(app_id, id) };
  });

  // === Progressive autonomy — record + count approvals of a staged action class ===================
  app.post('/authz/approvals', async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; owner?: string; action_class?: string };
    if (!b.owner || typeof b.owner !== 'string') return reply.status(400).send(invalid('an approval requires a string `owner`.'));
    if (!b.action_class || typeof b.action_class !== 'string') return reply.status(400).send(invalid('an approval requires a string `action_class`.'));
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    await store.appendAppEvent({ app_id, type: AUTHZ_APPROVAL, subject: b.action_class, owner: b.owner, data: { action_class: b.action_class } });
    return reply.status(200).send({ recorded: true });
  });

  app.get('/authz/approvals', async (req, reply) => {
    const q = req.query as { app?: string; owner?: string; action_class?: string; threshold?: string };
    if (!q.owner) return reply.status(400).send(invalid('an approvals query requires an `owner`.'));
    if (!q.action_class) return reply.status(400).send(invalid('an approvals query requires an `action_class`.'));
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const events = await store.listAppEvents({ app_id, owner: q.owner, subject: q.action_class, limit: 500 });
    const approvals = events.filter((e) => e.type === AUTHZ_APPROVAL).length;
    const threshold = q.threshold ? Number(q.threshold) : 3;
    return { action_class: q.action_class, approvals, suggest_policy: approvals >= threshold };
  });
}
