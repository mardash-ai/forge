// C31 — Household / multi-member identity + roles + shared-private scoping. GENERIC and product-agnostic:
// the platform owns the MEMBERSHIP GRAPH (groups + members) + an app-registered ROLE REGISTRY, so a
// consumer app can make "who is in this group and what role do they hold" an UNSPOOFABLE, server-resolved
// primitive instead of trusting a client-supplied `role`. Nothing here names a household/family/team — a
// "group" is just a tenancy + sharing boundary; roles + their permissions are entirely app-supplied.
//
// The permission tokens on a RoleDef are OPAQUE to the platform (it stores + set-tests them, never
// interprets them), with ONE exception: the three well-known membership-management tokens below, which the
// platform recognizes to gate the membership lifecycle operations (invite / manage-roles / remove). An app
// grants a role those powers simply by including the token(s) in that role's `permissions`.

// The three membership-management permission tokens the platform recognizes (still app-opt-in: a role holds
// the power only if its `permissions` include the token). Everything else in `permissions` is opaque.
export const MEMBERS_INVITE = 'members.invite';
export const MEMBERS_MANAGE_ROLES = 'members.manage_roles';
export const MEMBERS_REMOVE = 'members.remove';

// A GROUP — the platform-owned tenancy + sharing boundary. `singleton` marks an auto group-of-one (lazily
// provisioned on first sight of an identity); it flips false when a 2nd member joins. `external_id` is the
// migration linchpin: a consumer registers an EXISTING group id (its own UUID) so adoption carries over
// with zero row rewrites. A group always has ≥1 member holding the app's owner-role.
export interface Group {
  id: string;
  name?: string;
  singleton: boolean;
  created_at: string;
  updated_at: string;
  external_id?: string;
}

export type MemberStatus = 'active' | 'removed';

// MEMBERSHIP is many-to-many (group_id × owner): one identity may belong to many groups. `owner` is the
// identity subject (the C10/C11 user id). `role` is a KEY into the app's role registry (resolved
// server-side; never trusted from a request). `label` is a display hint the app supplies.
export interface Member {
  group_id: string;
  owner: string;
  role: string;
  label?: string;
  status: MemberStatus;
  added_at: string;
  updated_at: string;
}

// A ROLE DEFINITION — app-registered, OPAQUE to the platform. `permissions` are app tokens the platform
// stores + set-tests but never interprets (save the three well-known membership tokens above). Exactly ONE
// role per app has `owner_role:true` (it tracks the ≥1-owner invariant without the platform naming it).
// `rank` orders roles (higher = more privileged, app-defined); `assignable:false` marks a role that can be
// resolved but not handed out via invite/role-change (e.g. a system role).
export interface RoleDef {
  key: string;
  label?: string;
  permissions: string[];
  rank: number;
  owner_role: boolean;
  assignable: boolean;
}

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

// An INVITATION — the platform mints an opaque single-use token (only its HASH is stored, like C10/C23
// tokens); the CONSUMER delivers it (the platform never sends email). The token is BOUND to `invitee_hint`
// (an app-chosen email / identity hint): acceptance must match the hint (or be the invited identity), so it
// is NOT a bearer token. One-shot: accepting flips it to `accepted`.
export interface Invitation {
  id: string;
  group_id: string;
  role: string;
  invitee_hint: string;
  token_hash: string;
  status: InvitationStatus;
  invited_by: string;
  created_at: string;
  expires_at: string;
  accepted_by?: string;
  accepted_at?: string;
}

// The invitation as it is safe to RETURN in a list / on revoke — the token hash is stripped (the raw token
// is only ever returned ONCE, at mint time, alongside this view).
export interface InvitationView {
  id: string;
  group_id: string;
  role: string;
  invitee_hint: string;
  status: InvitationStatus;
  invited_by: string;
  created_at: string;
  expires_at: string;
  accepted_by?: string;
  accepted_at?: string;
}

export function toInvitationView(inv: Invitation): InvitationView {
  const { token_hash: _omit, ...view } = inv;
  return view;
}

// The FULL per-app membership state — the platform-owned graph as one document (roles + groups + members +
// invitations). Keyed maps so the pure operations (src/membership/service.ts) can read-modify-write a
// snapshot; the store commits it atomically (FS per-app lock / PG SELECT … FOR UPDATE). Members are keyed
// by (group_id, owner); groups + invitations by id.
export interface MembershipState {
  roles: RoleDef[];
  groups: Record<string, Group>;
  members: Record<string, Member>;
  invitations: Record<string, Invitation>;
}

export function emptyMembershipState(): MembershipState {
  return { roles: [], groups: {}, members: {}, invitations: {} };
}

export function memberKey(groupId: string, owner: string): string {
  return `${groupId}:${owner}`;
}

// --- pure role-registry helpers (no I/O) -----------------------------------------------------------------

// The app's owner-role definition (the one with `owner_role:true`), if the registry defines one.
export function findOwnerRole(roles: RoleDef[]): RoleDef | undefined {
  return roles.find((r) => r.owner_role);
}

export function findRole(roles: RoleDef[], key: string | undefined): RoleDef | undefined {
  if (key === undefined) return undefined;
  return roles.find((r) => r.key === key);
}

// The (opaque) permission set a role expands to. Unknown roles expand to no permissions.
export function permissionsFor(roles: RoleDef[], key: string | undefined): string[] {
  return findRole(roles, key)?.permissions ?? [];
}

// Whether a role's expanded permission set contains a token.
export function roleHasPermission(roles: RoleDef[], key: string | undefined, token: string): boolean {
  return permissionsFor(roles, key).includes(token);
}
