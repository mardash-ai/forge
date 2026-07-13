import { randomBytes, createHash } from 'node:crypto';
import { invalidInput, notFound } from '../shared/errors';
import { membershipError } from './errors';
import {
  type MembershipState,
  type Group,
  type Member,
  type RoleDef,
  type Invitation,
  type InvitationView,
  memberKey,
  findOwnerRole,
  findRole,
  permissionsFor,
  roleHasPermission,
  toInvitationView,
  MEMBERS_INVITE,
  MEMBERS_MANAGE_ROLES,
  MEMBERS_REMOVE,
} from './types';

// C31 — the PURE membership operations over a loaded MembershipState snapshot. No I/O: each op reads +
// mutates the passed state in place and returns a result; the store's `mutate()` commits the state
// atomically (FS per-app lock / PG SELECT … FOR UPDATE), so all the multi-record invariants below
// (≥1-owner, singleton flip, one-shot invitations) hold on both backends without duplicating the logic.
// Ops throw a `membershipError(code)` (or invalidInput/notFound) to ABORT with no write.

// The default invitation lifetime (a consumer can shorten by revoking). Kept generous — the consumer
// delivers the token out-of-band (email/SMS) and the invitee may take time to act.
export const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// --- opaque single-use token: mint returns the RAW token once; only its hash is ever stored ----------
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// --- small pure predicates over the graph ------------------------------------------------------------
function activeMember(state: MembershipState, groupId: string, owner: string): Member | undefined {
  const m = state.members[memberKey(groupId, owner)];
  return m && m.status === 'active' ? m : undefined;
}
function activeMembers(state: MembershipState, groupId: string): Member[] {
  return Object.values(state.members).filter((m) => m.group_id === groupId && m.status === 'active');
}
function ownerCount(state: MembershipState, groupId: string, ownerRoleKey: string): number {
  return activeMembers(state, groupId).filter((m) => m.role === ownerRoleKey).length;
}

// Resolve a group by our internal id OR by the consumer's registered external_id (decision #4: the app
// keeps using its OWN group UUIDs everywhere — including authorize + its resource rows — and the platform
// maps external_id → group with zero row rewrites).
export function resolveGroup(state: MembershipState, idOrExternal: string): Group | null {
  return (
    state.groups[idOrExternal] ??
    Object.values(state.groups).find((g) => g.external_id === idOrExternal) ??
    null
  );
}

// The caller's personal group-of-one — the singleton group they hold the owner-role in. Used for the
// no-group_id authorize path + ensure's owner-idempotency.
export function getPersonalGroup(state: MembershipState, owner: string): Group | null {
  const ownerRole = findOwnerRole(state.roles);
  const groups = Object.values(state.groups)
    .filter((g) => g.singleton)
    .filter((g) => {
      const m = activeMember(state, g.id, owner);
      return m && (!ownerRole || m.role === ownerRole.key);
    })
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return groups[0] ?? null;
}

// --- role registry (PUT /roles — idempotent replace) -------------------------------------------------
export function putRoles(state: MembershipState, roles: RoleDef[]): { state: MembershipState; result: RoleDef[] } {
  if (!Array.isArray(roles) || roles.length === 0) throw invalidInput('`roles` must be a non-empty array of role definitions.');
  const normalized: RoleDef[] = [];
  const seen = new Set<string>();
  for (const r of roles) {
    if (!r || typeof r.key !== 'string' || r.key.length === 0) throw invalidInput('each role requires a non-empty string `key`.');
    if (seen.has(r.key)) throw invalidInput(`duplicate role key "${r.key}".`);
    seen.add(r.key);
    if (r.permissions !== undefined && (!Array.isArray(r.permissions) || r.permissions.some((p) => typeof p !== 'string')))
      throw invalidInput(`role "${r.key}" \`permissions\` must be an array of strings.`);
    normalized.push({
      key: r.key,
      ...(r.label !== undefined ? { label: r.label } : {}),
      permissions: r.permissions ?? [],
      rank: typeof r.rank === 'number' ? r.rank : 0,
      owner_role: r.owner_role === true,
      assignable: r.assignable !== false,
    });
  }
  const owners = normalized.filter((r) => r.owner_role);
  if (owners.length !== 1) throw membershipError('no_owner_role', 'exactly one role must have `owner_role: true`.');
  state.roles = normalized;
  return { state, result: normalized };
}

// --- provision a group (ensure / create) -------------------------------------------------------------
// `dedupeOwnerSingleton` distinguishes ensure (idempotent on the owner's personal singleton) from an
// explicit POST /groups (always a distinct new group). Both dedupe on a registered external_id.
export function provisionGroup(
  state: MembershipState,
  input: { owner: string; external_id?: string; name?: string; now: string; newGroupId: string; dedupeOwnerSingleton: boolean },
): { state: MembershipState; result: { group: Group; created: boolean } } {
  const ownerRole = findOwnerRole(state.roles);
  if (!ownerRole) throw membershipError('no_owner_role', 'register a role registry with an owner-role (PUT /roles) before provisioning groups.');
  if (typeof input.owner !== 'string' || input.owner.length === 0) throw invalidInput('`owner` is required.');

  if (input.external_id) {
    const existing = Object.values(state.groups).find((g) => g.external_id === input.external_id);
    if (existing) return { state, result: { group: existing, created: false } };
  }
  if (input.dedupeOwnerSingleton && !input.external_id) {
    const personal = getPersonalGroup(state, input.owner);
    if (personal) return { state, result: { group: personal, created: false } };
  }

  const group: Group = {
    id: input.newGroupId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    singleton: true,
    created_at: input.now,
    updated_at: input.now,
    ...(input.external_id !== undefined ? { external_id: input.external_id } : {}),
  };
  state.groups[group.id] = group;
  const member: Member = {
    group_id: group.id,
    owner: input.owner,
    role: ownerRole.key,
    status: 'active',
    added_at: input.now,
    updated_at: input.now,
  };
  state.members[memberKey(group.id, input.owner)] = member;
  return { state, result: { group, created: true } };
}

// --- invitations -------------------------------------------------------------------------------------
export interface InviteResult {
  invitation: InvitationView;
  token?: string; // present only on a freshly minted invitation; absent when an existing pending one is reused
  reused: boolean;
}
export function inviteMember(
  state: MembershipState,
  input: { groupId: string; actor: string; inviteeHint: string; role: string; now: string; newInvId: string; token: string },
): { state: MembershipState; result: InviteResult } {
  const group = resolveGroup(state, input.groupId);
  if (!group) throw membershipError('unknown_group', `no group "${input.groupId}".`);
  requireActorPermission(state, group.id, input.actor, MEMBERS_INVITE);
  if (typeof input.inviteeHint !== 'string' || input.inviteeHint.length === 0) throw invalidInput('`invitee_hint` is required.');
  const roleDef = findRole(state.roles, input.role);
  if (!roleDef || !roleDef.assignable) throw membershipError('unknown_role', `role "${input.role}" is not an assignable role.`);

  // Can't invite an owner that is already an active member.
  const alreadyMember = Object.values(state.members).some(
    (m) => m.group_id === group.id && m.status === 'active' && m.owner === input.inviteeHint,
  );
  if (alreadyMember) throw membershipError('already_a_member', `${input.inviteeHint} is already a member of group ${group.id}.`);

  // Reuse an outstanding pending invitation for the same (group, invitee_hint) rather than minting a second.
  const pending = Object.values(state.invitations).find(
    (i) => i.group_id === group.id && i.invitee_hint === input.inviteeHint && i.status === 'pending' && i.expires_at > input.now,
  );
  if (pending) return { state, result: { invitation: toInvitationView(pending), reused: true } };

  const invitation: Invitation = {
    id: input.newInvId,
    group_id: group.id,
    role: input.role,
    invitee_hint: input.inviteeHint,
    token_hash: hashToken(input.token),
    status: 'pending',
    invited_by: input.actor,
    created_at: input.now,
    expires_at: new Date(new Date(input.now).getTime() + INVITATION_TTL_MS).toISOString(),
  };
  state.invitations[invitation.id] = invitation;
  return { state, result: { invitation: toInvitationView(invitation), token: input.token, reused: false } };
}

export function revokeInvitation(
  state: MembershipState,
  input: { id: string; now: string },
): { state: MembershipState; result: InvitationView } {
  const inv = state.invitations[input.id];
  if (!inv) throw notFound(`no invitation "${input.id}".`);
  if (inv.status === 'pending') {
    inv.status = 'revoked';
  }
  return { state, result: toInvitationView(inv) };
}

export function acceptInvitation(
  state: MembershipState,
  input: { token: string; owner: string; inviteeHint?: string; now: string },
): { state: MembershipState; result: { member: Member; group: Group } } {
  if (typeof input.owner !== 'string' || input.owner.length === 0) throw invalidInput('`owner` is required.');
  const hash = hashToken(input.token ?? '');
  const inv = Object.values(state.invitations).find((i) => i.token_hash === hash);
  if (!inv) throw membershipError('invalid_token', 'no invitation matches this token.');
  if (inv.status !== 'pending') throw membershipError('invalid_token', `invitation is ${inv.status}.`);
  if (inv.expires_at <= input.now) {
    inv.status = 'expired';
    throw membershipError('expired_token', 'this invitation has expired.');
  }
  // Non-bearer binding: acceptance must come from the invited identity — either the accepting `owner` IS
  // the invited hint, or the caller presents the (session-verified) invitee_hint it was bound to.
  const boundToOwner = inv.invitee_hint === input.owner;
  const boundToHint = input.inviteeHint !== undefined && input.inviteeHint === inv.invitee_hint;
  if (!boundToOwner && !boundToHint) {
    throw membershipError('token_identity_mismatch', 'this invitation is bound to a different identity.');
  }
  const group = state.groups[inv.group_id];
  if (!group) throw membershipError('unknown_group', `group ${inv.group_id} no longer exists.`);
  if (activeMember(state, group.id, input.owner)) throw membershipError('already_a_member', `${input.owner} is already a member of group ${group.id}.`);

  const member: Member = {
    group_id: group.id,
    owner: input.owner,
    role: inv.role,
    status: 'active',
    added_at: input.now,
    updated_at: input.now,
  };
  state.members[memberKey(group.id, input.owner)] = member;
  // The 2nd member flips the auto group-of-one into a real multi-member group.
  if (activeMembers(state, group.id).length >= 2 && group.singleton) {
    group.singleton = false;
    group.updated_at = input.now;
  }
  inv.status = 'accepted';
  inv.accepted_by = input.owner;
  inv.accepted_at = input.now;
  return { state, result: { member, group } };
}

// --- member role management --------------------------------------------------------------------------
export function setMemberRole(
  state: MembershipState,
  input: { groupId: string; actor: string; owner: string; role: string; now: string },
): { state: MembershipState; result: Member } {
  const group = resolveGroup(state, input.groupId);
  if (!group) throw membershipError('unknown_group', `no group "${input.groupId}".`);
  const ownerRole = findOwnerRole(state.roles)!;
  requireActorPermission(state, group.id, input.actor, MEMBERS_MANAGE_ROLES);
  const target = activeMember(state, group.id, input.owner);
  if (!target) throw membershipError('not_a_member', `${input.owner} is not a member of group ${group.id}.`);
  const roleDef = findRole(state.roles, input.role);
  if (!roleDef || !roleDef.assignable) throw membershipError('unknown_role', `role "${input.role}" is not an assignable role.`);
  // ≥1-owner invariant: demoting the sole owner is refused (transfer ownership first).
  if (target.role === ownerRole.key && input.role !== ownerRole.key && ownerCount(state, group.id, ownerRole.key) <= 1) {
    throw membershipError('last_owner', 'cannot demote the last owner; transfer ownership first.');
  }
  target.role = input.role;
  target.updated_at = input.now;
  return { state, result: target };
}

export function removeMember(
  state: MembershipState,
  input: { groupId: string; actor: string; owner: string },
): { state: MembershipState; result: { member: Member; group: Group } } {
  const group = resolveGroup(state, input.groupId);
  if (!group) throw membershipError('unknown_group', `no group "${input.groupId}".`);
  const ownerRole = findOwnerRole(state.roles)!;
  requireActorPermission(state, group.id, input.actor, MEMBERS_REMOVE);
  const target = activeMember(state, group.id, input.owner);
  if (!target) throw membershipError('not_a_member', `${input.owner} is not a member of group ${group.id}.`);
  if (target.role === ownerRole.key && ownerCount(state, group.id, ownerRole.key) <= 1) {
    throw membershipError('last_owner', 'cannot remove the last owner; transfer ownership first.');
  }
  const removed = { ...target };
  delete state.members[memberKey(group.id, input.owner)];
  return { state, result: { member: removed, group } };
}

export function leaveGroup(
  state: MembershipState,
  input: { groupId: string; actor: string },
): { state: MembershipState; result: { member: Member; group: Group } } {
  const group = resolveGroup(state, input.groupId);
  if (!group) throw membershipError('unknown_group', `no group "${input.groupId}".`);
  const ownerRole = findOwnerRole(state.roles)!;
  const me = activeMember(state, group.id, input.actor);
  if (!me) throw membershipError('not_a_member', `${input.actor} is not a member of group ${group.id}.`);
  if (me.role === ownerRole.key && ownerCount(state, group.id, ownerRole.key) <= 1) {
    throw membershipError('last_owner', 'the sole owner cannot leave; transfer ownership first.');
  }
  const removed = { ...me };
  delete state.members[memberKey(group.id, input.actor)];
  return { state, result: { member: removed, group } };
}

export function transferOwnership(
  state: MembershipState,
  input: { groupId: string; actor: string; toOwner: string; demoteActorTo?: string; now: string },
): { state: MembershipState; result: { group: Group; from: Member; to: Member } } {
  const group = resolveGroup(state, input.groupId);
  if (!group) throw membershipError('unknown_group', `no group "${input.groupId}".`);
  const ownerRole = findOwnerRole(state.roles)!;
  const from = activeMember(state, group.id, input.actor);
  if (!from) throw membershipError('not_a_member', `${input.actor} is not a member of group ${group.id}.`);
  if (from.role !== ownerRole.key) throw membershipError('insufficient_role', 'only an owner may transfer ownership.');
  const to = activeMember(state, group.id, input.toOwner);
  if (!to) throw membershipError('not_a_member', `${input.toOwner} is not a member of group ${group.id}; invite them first.`);
  if (input.demoteActorTo !== undefined) {
    const roleDef = findRole(state.roles, input.demoteActorTo);
    if (!roleDef || !roleDef.assignable) throw membershipError('unknown_role', `role "${input.demoteActorTo}" is not an assignable role.`);
  }
  // Promote the recipient FIRST so ≥1 owner always holds through the operation.
  to.role = ownerRole.key;
  to.updated_at = input.now;
  if (input.demoteActorTo !== undefined) {
    from.role = input.demoteActorTo;
    from.updated_at = input.now;
  }
  group.updated_at = input.now;
  return { state, result: { group, from, to } };
}

// --- actor permission gate (shared by the write ops) -------------------------------------------------
function requireActorPermission(state: MembershipState, groupId: string, actor: string, token: string): Member {
  const m = activeMember(state, groupId, actor);
  if (!m) throw membershipError('not_a_member', `actor ${actor} is not a member of group ${groupId}.`);
  if (!roleHasPermission(state.roles, m.role, token)) {
    throw membershipError('insufficient_permission', `role "${m.role}" lacks the "${token}" permission.`);
  }
  return m;
}

// --- read projections (routes + authorize resolution) ------------------------------------------------
export interface ResolvedMembershipCtx {
  group_id: string;
  role?: string;
  permissions: string[];
  is_member: boolean;
  personal: boolean;
}

// Resolve the caller's role/permissions/is_member for the targeted group — the authoritative context the
// C29 enforcement point consumes (NEVER the request's `role`). `targetIdOrExternal` omitted ⇒ the caller's
// personal group-of-one (role = owner-role, is_member = true) — the back-compat path.
export function resolveMembership(state: MembershipState, owner: string, targetIdOrExternal?: string): ResolvedMembershipCtx {
  if (targetIdOrExternal) {
    const group = resolveGroup(state, targetIdOrExternal);
    if (!group) return { group_id: targetIdOrExternal, role: undefined, permissions: [], is_member: false, personal: false };
    const m = activeMember(state, group.id, owner);
    const role = m?.role;
    return { group_id: group.id, role, permissions: permissionsFor(state.roles, role), is_member: !!m, personal: false };
  }
  const ownerRole = findOwnerRole(state.roles);
  const personal = getPersonalGroup(state, owner);
  if (personal) {
    const m = activeMember(state, personal.id, owner);
    const role = m?.role ?? ownerRole?.key;
    return { group_id: personal.id, role, permissions: permissionsFor(state.roles, role), is_member: true, personal: true };
  }
  // Not yet provisioned — the caller is the implicit sole owner-role member of their group-of-one.
  const role = ownerRole?.key;
  return { group_id: `grp_self_${owner}`, role, permissions: permissionsFor(state.roles, role), is_member: true, personal: true };
}

// A member's public projection (GET /groups/:id/members/:owner) — role + expanded permissions + status.
export function memberView(
  state: MembershipState,
  groupId: string,
  owner: string,
): { group_id: string; owner: string; role: string; permissions: string[]; is_member: boolean; status: Member['status'] } | null {
  const group = resolveGroup(state, groupId);
  if (!group) return null;
  const m = state.members[memberKey(group.id, owner)];
  if (!m) return null;
  return {
    group_id: group.id,
    owner,
    role: m.role,
    permissions: permissionsFor(state.roles, m.role),
    is_member: m.status === 'active',
    status: m.status,
  };
}

// The groups an identity belongs to (GET /identities/:owner/groups).
export function groupsForOwner(state: MembershipState, owner: string): Array<{ group_id: string; name?: string; role: string; singleton: boolean }> {
  return Object.values(state.members)
    .filter((m) => m.owner === owner && m.status === 'active')
    .map((m) => {
      const g = state.groups[m.group_id];
      return g ? { group_id: g.id, ...(g.name !== undefined ? { name: g.name } : {}), role: m.role, singleton: g.singleton } : null;
    })
    .filter((x): x is { group_id: string; name?: string; role: string; singleton: boolean } => x !== null)
    .sort((a, b) => (a.group_id < b.group_id ? -1 : 1));
}
