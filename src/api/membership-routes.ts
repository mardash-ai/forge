import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { store } from '../storage/store';
import { getBackends } from '../storage/backends';
import { newId } from '../shared/ids';
import { nowIso } from '../shared/time';
import { ForgeError } from '../shared/errors';
import type { RoleDef } from '../membership/types';
import {
  putRoles,
  provisionGroup,
  inviteMember,
  revokeInvitation,
  acceptInvitation,
  setMemberRole,
  removeMember,
  leaveGroup,
  transferOwnership,
  mintToken,
  memberView,
  groupsForOwner,
  resolveGroup,
} from '../membership/service';
import { toInvitationView } from '../membership/types';

// C31 — the MEMBERSHIP lifecycle surface (groups + members + invitations + the app role registry). Makes
// household/team membership a PLATFORM-OWNED, unspoofable primitive: role is resolved from THIS graph, never
// a request. Registered on BOTH planes like the C29 authz surface (control: role-registry/group config;
// data: the running app drives membership over the internal network). GENERIC — no household/family naming;
// roles + their permissions are entirely app-supplied via `PUT /roles`.
//
// Trust model (identical to C29 `/authorize` + the C3 app-event log): these are TRUSTED-INTERNAL calls on
// the compose network — `owner`/`actor` + `app` ride the request; a browser cannot reach the data-plane
// sidecar directly. The platform RESOLVES + ENFORCES the acting member's permission from the graph
// (`members.invite` / `members.manage_roles` / `members.remove`) — the caller can't assert its own role.
//
//   PUT    /roles                                  { app?, roles:[RoleDef] }                 -> { roles }        (idempotent replace)
//   GET    /roles                                  ?app=                                     -> { roles }
//   POST   /groups/ensure                          { app?, owner, external_id?, name? }      -> { group, created }
//   POST   /groups                                 { app?, owner, external_id?, name? }      -> { group, created }
//   GET    /groups/:id                             ?app=                                     -> { group } | 404
//   GET    /groups/:id/members                     ?app=                                     -> { items:[Member], total }
//   GET    /groups/:id/members/:owner              ?app=                                     -> { group_id, owner, role, permissions, is_member, status } | 404 not_a_member
//   GET    /identities/:owner/groups               ?app=                                     -> { items:[{group_id,name?,role,singleton}], total }
//   POST   /groups/:id/invitations                 { app?, actor, invitee_hint, role }       -> { invitation:{…,token}, reused? }   (actor needs members.invite)
//   GET    /groups/:id/invitations                 ?app=                                     -> { items:[InvitationView], total }
//   POST   /invitations/:id/revoke                 { app? }                                  -> { invitation }
//   POST   /invitations/accept                     { app?, token, owner, invitee_hint? }     -> { member, group }
//   POST   /groups/:id/members/:owner/role         { app?, actor, role }                     -> { member }       (actor needs members.manage_roles)
//   DELETE /groups/:id/members/:owner              { app?, actor }                           -> { removed, member } (actor needs members.remove; emits membership.removed)
//   POST   /groups/:id/transfer-ownership          { app?, actor, to_owner, demote_actor_to? } -> { group, from, to } (owner-only; preserves ≥1 owner)
//   POST   /groups/:id/leave                       { app?, actor }                           -> { left, member }  (sole owner -> 409 last_owner)
//
// `app` is the Application NAME; it defaults to the server's own app (data-plane: FORGE_APP_NAME).
export function registerMembershipRoutes(app: FastifyInstance, opts: { defaultApp?: () => string | undefined } = {}): void {
  const resolveAppId = async (name?: string): Promise<string | null> => {
    const n = name ?? opts.defaultApp?.();
    if (!n) return null;
    const a = await store.findAppByName(n);
    return a && a.type === 'Application' ? a.id : null;
  };
  const unknownApp = { error: { code: 'not_found', message: 'unknown app (pass `app` or set FORGE_APP_NAME).', retry: 'change-input' } };
  const invalid = (message: string) => ({ error: { code: 'invalid_input', message, retry: 'change-input' } });

  // Wrap a handler so a thrown ForgeError (the membership failure vocabulary) serializes to its status —
  // works even on a bare test server with no app-level error handler.
  const guard =
    (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply);
      } catch (e) {
        if (e instanceof ForgeError) return reply.status(e.status).send(e.toJSON());
        throw e;
      }
    };

  // === role registry ===============================================================================
  app.put('/roles', guard(async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; roles?: RoleDef[] };
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const roles = await (await getBackends()).membership.mutate(app_id, (s) => putRoles(s, b.roles as RoleDef[]));
    return reply.status(200).send({ roles });
  }));

  app.get('/roles', guard(async (req, reply) => {
    const q = req.query as { app?: string };
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const state = await (await getBackends()).membership.read(app_id);
    return { roles: state.roles };
  }));

  // === groups ======================================================================================
  const provision = (dedupeOwnerSingleton: boolean) =>
    guard(async (req, reply) => {
      const b = (req.body ?? {}) as { app?: string; owner?: string; external_id?: string; name?: string };
      if (!b.owner || typeof b.owner !== 'string') return reply.status(422).send(invalid('a group requires a string `owner`.'));
      const app_id = await resolveAppId(b.app);
      if (!app_id) return reply.status(404).send(unknownApp);
      const result = await (await getBackends()).membership.mutate(app_id, (s) =>
        provisionGroup(s, {
          owner: b.owner!,
          ...(b.external_id ? { external_id: b.external_id } : {}),
          ...(b.name !== undefined ? { name: b.name } : {}),
          now: nowIso(),
          newGroupId: newId('grp'),
          dedupeOwnerSingleton,
        }),
      );
      return reply.status(200).send(result);
    });

  app.post('/groups/ensure', provision(true));
  app.post('/groups', provision(false));

  app.get('/groups/:id', guard(async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { app?: string };
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const state = await (await getBackends()).membership.read(app_id);
    const group = resolveGroup(state, id);
    if (!group) return reply.status(404).send({ error: { code: 'unknown_group', message: `no group "${id}".`, retry: 'change-input' } });
    return { group };
  }));

  app.get('/groups/:id/members', guard(async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { app?: string };
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const state = await (await getBackends()).membership.read(app_id);
    const group = resolveGroup(state, id);
    if (!group) return reply.status(404).send({ error: { code: 'unknown_group', message: `no group "${id}".`, retry: 'change-input' } });
    const items = Object.values(state.members).filter((m) => m.group_id === group.id && m.status === 'active');
    return { items, total: items.length };
  }));

  app.get('/groups/:id/members/:owner', guard(async (req, reply) => {
    const { id, owner } = req.params as { id: string; owner: string };
    const q = req.query as { app?: string };
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const state = await (await getBackends()).membership.read(app_id);
    const view = memberView(state, id, owner);
    if (!view || view.status !== 'active') return reply.status(404).send({ error: { code: 'not_a_member', message: `${owner} is not a member of group ${id}.`, retry: 'change-input' } });
    return view;
  }));

  app.get('/identities/:owner/groups', guard(async (req, reply) => {
    const { owner } = req.params as { owner: string };
    const q = req.query as { app?: string };
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const state = await (await getBackends()).membership.read(app_id);
    const items = groupsForOwner(state, owner);
    return { items, total: items.length };
  }));

  // === invitations =================================================================================
  app.post('/groups/:id/invitations', guard(async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { app?: string; actor?: string; invitee_hint?: string; role?: string };
    if (!b.actor || typeof b.actor !== 'string') return reply.status(422).send(invalid('an invitation requires a string `actor`.'));
    if (!b.invitee_hint || typeof b.invitee_hint !== 'string') return reply.status(422).send(invalid('an invitation requires a string `invitee_hint`.'));
    if (!b.role || typeof b.role !== 'string') return reply.status(422).send(invalid('an invitation requires a string `role`.'));
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const token = mintToken();
    const result = await (await getBackends()).membership.mutate(app_id, (s) =>
      inviteMember(s, { groupId: id, actor: b.actor!, inviteeHint: b.invitee_hint!, role: b.role!, now: nowIso(), newInvId: newId('inv'), token }),
    );
    // The raw token rides the invitation object ONCE, on mint. A reused (already-pending) invitation has no
    // fresh token — the consumer revokes + re-invites to rotate.
    const invitation = result.reused ? result.invitation : { ...result.invitation, token: result.token };
    return reply.status(200).send({ invitation, ...(result.reused ? { reused: true } : {}) });
  }));

  app.get('/groups/:id/invitations', guard(async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { app?: string };
    const app_id = await resolveAppId(q.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const state = await (await getBackends()).membership.read(app_id);
    const group = resolveGroup(state, id);
    if (!group) return reply.status(404).send({ error: { code: 'unknown_group', message: `no group "${id}".`, retry: 'change-input' } });
    const items = Object.values(state.invitations).filter((i) => i.group_id === group.id).map(toInvitationView);
    return { items, total: items.length };
  }));

  app.post('/invitations/:id/revoke', guard(async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { app?: string };
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const invitation = await (await getBackends()).membership.mutate(app_id, (s) => revokeInvitation(s, { id, now: nowIso() }));
    return reply.status(200).send({ invitation });
  }));

  app.post('/invitations/accept', guard(async (req, reply) => {
    const b = (req.body ?? {}) as { app?: string; token?: string; owner?: string; invitee_hint?: string };
    if (!b.token || typeof b.token !== 'string') return reply.status(422).send(invalid('accept requires a string `token`.'));
    if (!b.owner || typeof b.owner !== 'string') return reply.status(422).send(invalid('accept requires a string `owner`.'));
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const result = await (await getBackends()).membership.mutate(app_id, (s) =>
      acceptInvitation(s, { token: b.token!, owner: b.owner!, ...(b.invitee_hint !== undefined ? { inviteeHint: b.invitee_hint } : {}), now: nowIso() }),
    );
    return reply.status(200).send(result);
  }));

  // === member role management + removal ============================================================
  app.post('/groups/:id/members/:owner/role', guard(async (req, reply) => {
    const { id, owner } = req.params as { id: string; owner: string };
    const b = (req.body ?? {}) as { app?: string; actor?: string; role?: string };
    if (!b.actor || typeof b.actor !== 'string') return reply.status(422).send(invalid('a role change requires a string `actor`.'));
    if (!b.role || typeof b.role !== 'string') return reply.status(422).send(invalid('a role change requires a string `role`.'));
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const member = await (await getBackends()).membership.mutate(app_id, (s) => setMemberRole(s, { groupId: id, actor: b.actor!, owner, role: b.role!, now: nowIso() }));
    return reply.status(200).send({ member });
  }));

  app.delete('/groups/:id/members/:owner', guard(async (req, reply) => {
    const { id, owner } = req.params as { id: string; owner: string };
    const b = (req.body ?? {}) as { app?: string; actor?: string };
    if (!b.actor || typeof b.actor !== 'string') return reply.status(422).send(invalid('a member removal requires a string `actor`.'));
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const { member, group } = await (await getBackends()).membership.mutate(app_id, (s) => removeMember(s, { groupId: id, actor: b.actor!, owner }));
    // The platform NEVER touches app rows — it emits a fact (via C3) + returns cleanly; the consumer decides
    // resource disposition (reassign/delete/leave-as-is).
    await store.appendAppEvent({ app_id, type: 'membership.removed', subject: group.id, owner, data: { group_id: group.id, removed_owner: owner, actor: b.actor, role: member.role, via: 'remove' } });
    return reply.status(200).send({ removed: true, member });
  }));

  app.post('/groups/:id/transfer-ownership', guard(async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { app?: string; actor?: string; to_owner?: string; demote_actor_to?: string };
    if (!b.actor || typeof b.actor !== 'string') return reply.status(422).send(invalid('transfer requires a string `actor`.'));
    if (!b.to_owner || typeof b.to_owner !== 'string') return reply.status(422).send(invalid('transfer requires a string `to_owner`.'));
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const result = await (await getBackends()).membership.mutate(app_id, (s) =>
      transferOwnership(s, { groupId: id, actor: b.actor!, toOwner: b.to_owner!, ...(b.demote_actor_to !== undefined ? { demoteActorTo: b.demote_actor_to } : {}), now: nowIso() }),
    );
    return reply.status(200).send(result);
  }));

  app.post('/groups/:id/leave', guard(async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { app?: string; actor?: string };
    if (!b.actor || typeof b.actor !== 'string') return reply.status(422).send(invalid('leave requires a string `actor`.'));
    const app_id = await resolveAppId(b.app);
    if (!app_id) return reply.status(404).send(unknownApp);
    const { member, group } = await (await getBackends()).membership.mutate(app_id, (s) => leaveGroup(s, { groupId: id, actor: b.actor! }));
    await store.appendAppEvent({ app_id, type: 'membership.removed', subject: group.id, owner: b.actor, data: { group_id: group.id, removed_owner: b.actor, actor: b.actor, role: member.role, via: 'leave' } });
    return reply.status(200).send({ left: true, member });
  }));
}
