import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { registerMembershipRoutes } from '../src/api/membership-routes';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';
import type { RoleDef, MembershipState } from '../src/membership/types';
import { emptyMembershipState, memberKey } from '../src/membership/types';
import { acceptInvitation, hashToken } from '../src/membership/service';

// C31 — the membership lifecycle surface + the pure invariants, exercised through the configured backend
// (filesystem on the default run, Postgres on the pg run) — so this whole suite validates BOTH backends.
const APP = 'demo';
const APP_ID = 'app_demo';
let dir: string;
let prev: string | undefined;
let server: FastifyInstance;

const ROLES: RoleDef[] = [
  { key: 'owner', label: 'Owner', permissions: ['members.invite', 'members.manage_roles', 'members.remove'], rank: 100, owner_role: true, assignable: true },
  { key: 'member', label: 'Member', permissions: [], rank: 10, owner_role: false, assignable: true },
  { key: 'viewer', label: 'Viewer', permissions: [], rank: 1, owner_role: false, assignable: true },
];

const seedApp = async (): Promise<void> => {
  const now = nowIso();
  await store.saveResource({
    id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
    name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web', language: 'typescript', package_manager: 'npm',
  } as Application);
};

beforeEach(async () => {
  prev = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-membership-'));
  process.env.FORGE_STATE_DIR = dir;
  await store.init();
  await seedApp();
  server = Fastify({ logger: false });
  registerMembershipRoutes(server, { defaultApp: () => APP });
  await server.ready();
});
afterEach(async () => {
  await server.close();
  if (prev === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prev;
  await rm(dir, { recursive: true, force: true });
});

const post = (url: string, payload: unknown = {}) => server.inject({ method: 'POST', url, payload: payload as object });
const put = (url: string, payload: unknown = {}) => server.inject({ method: 'PUT', url, payload: payload as object });
const get = (url: string) => server.inject({ method: 'GET', url });
const del = (url: string, payload: unknown = {}) => server.inject({ method: 'DELETE', url, payload: payload as object });
const setRoles = () => put('/roles', { roles: ROLES });

describe('C31 — role registry', () => {
  it('PUT /roles is an idempotent replace; GET /roles returns it', async () => {
    const r = await setRoles();
    expect(r.statusCode).toBe(200);
    expect(r.json().roles.map((x: RoleDef) => x.key)).toEqual(['owner', 'member', 'viewer']);
    expect((await get('/roles')).json().roles).toHaveLength(3);
    // replace
    await put('/roles', { roles: ROLES.slice(0, 2) });
    expect((await get('/roles')).json().roles).toHaveLength(2);
  });

  it('rejects a registry without exactly one owner_role', async () => {
    expect((await put('/roles', { roles: [{ key: 'm', permissions: [], rank: 1, owner_role: false, assignable: true }] })).statusCode).toBe(422);
    expect((await put('/roles', { roles: [
      { key: 'o1', permissions: [], rank: 2, owner_role: true, assignable: true },
      { key: 'o2', permissions: [], rank: 1, owner_role: true, assignable: true },
    ] })).statusCode).toBe(422);
  });
});

describe('C31 — groups: lazy provision + idempotent ensure (migration linchpin)', () => {
  beforeEach(setRoles);

  it('ensure is idempotent on the owner singleton — same group, created flips false', async () => {
    const first = await post('/groups/ensure', { owner: 'A' });
    expect(first.statusCode).toBe(200);
    expect(first.json().created).toBe(true);
    const g = first.json().group;
    expect(g.singleton).toBe(true);
    const again = await post('/groups/ensure', { owner: 'A' });
    expect(again.json().created).toBe(false);
    expect(again.json().group.id).toBe(g.id);
    // owner A is the sole owner-role member
    const members = (await get(`/groups/${g.id}/members`)).json();
    expect(members.total).toBe(1);
    expect(members.items[0]).toMatchObject({ owner: 'A', role: 'owner', status: 'active' });
  });

  it('ensure is idempotent on external_id — a consumer registers its EXISTING group id with zero rewrites', async () => {
    const a = await post('/groups/ensure', { owner: 'A', external_id: 'consumer-uuid-123', name: 'House' });
    expect(a.json().created).toBe(true);
    expect(a.json().group.external_id).toBe('consumer-uuid-123');
    const b = await post('/groups/ensure', { owner: 'A', external_id: 'consumer-uuid-123' });
    expect(b.json().created).toBe(false);
    expect(b.json().group.id).toBe(a.json().group.id);
    // resolvable by BOTH the internal id and the external id
    expect((await get(`/groups/${a.json().group.id}`)).statusCode).toBe(200);
    expect((await get('/groups/consumer-uuid-123')).json().group.id).toBe(a.json().group.id);
  });

  it('GET member/:owner projects role + expanded permissions; a non-member is 404 not_a_member', async () => {
    const g = (await post('/groups/ensure', { owner: 'A' })).json().group;
    const view = (await get(`/groups/${g.id}/members/A`)).json();
    expect(view).toMatchObject({ owner: 'A', role: 'owner', is_member: true, permissions: ['members.invite', 'members.manage_roles', 'members.remove'] });
    const miss = await get(`/groups/${g.id}/members/nobody`);
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error.code).toBe('not_a_member');
  });

  it('GET /identities/:owner/groups lists every group the identity belongs to', async () => {
    const g1 = (await post('/groups/ensure', { owner: 'A' })).json().group;
    const g2 = (await post('/groups', { owner: 'A', name: 'Second' })).json().group;
    const list = (await get('/identities/A/groups')).json();
    expect(list.total).toBe(2);
    expect(list.items.map((x: { group_id: string }) => x.group_id).sort()).toEqual([g1.id, g2.id].sort());
  });
});

describe('C31 — invitations: opaque token, binding, single-use, singleton flip', () => {
  beforeEach(setRoles);

  const makeGroup = async () => (await post('/groups/ensure', { owner: 'A' })).json().group;

  it('mint → deliver → accept adds a member and flips the group off singleton', async () => {
    const g = await makeGroup();
    const inv = await post(`/groups/${g.id}/invitations`, { actor: 'A', invitee_hint: 'B', role: 'member' });
    expect(inv.statusCode).toBe(200);
    const token = inv.json().invitation.token;
    expect(typeof token).toBe('string');

    const acc = await post('/invitations/accept', { token, owner: 'B' });
    expect(acc.statusCode).toBe(200);
    expect(acc.json().member).toMatchObject({ owner: 'B', role: 'member', status: 'active' });
    expect(acc.json().group.singleton).toBe(false);
    expect((await get(`/groups/${g.id}/members`)).json().total).toBe(2);
  });

  it('binds to the invitee hint — a wrong identity cannot accept (token_identity_mismatch)', async () => {
    const g = await makeGroup();
    const token = (await post(`/groups/${g.id}/invitations`, { actor: 'A', invitee_hint: 'bob@x.com', role: 'member' })).json().invitation.token;
    const wrong = await post('/invitations/accept', { token, owner: 'C' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.code).toBe('token_identity_mismatch');
    // presenting the bound hint (session-verified by the app) lets the invited identity accept
    const ok = await post('/invitations/accept', { token, owner: 'C', invitee_hint: 'bob@x.com' });
    expect(ok.statusCode).toBe(200);
  });

  it('is single-use — a second accept with the same token is invalid_token', async () => {
    const g = await makeGroup();
    const token = (await post(`/groups/${g.id}/invitations`, { actor: 'A', invitee_hint: 'B', role: 'member' })).json().invitation.token;
    expect((await post('/invitations/accept', { token, owner: 'B' })).statusCode).toBe(200);
    const second = await post('/invitations/accept', { token, owner: 'B' });
    expect(second.statusCode).toBe(404);
    expect(second.json().error.code).toBe('invalid_token');
  });

  it('a bad token is invalid_token; an unknown role is unknown_role', async () => {
    const g = await makeGroup();
    expect((await post('/invitations/accept', { token: 'nope', owner: 'B' })).json().error.code).toBe('invalid_token');
    const bad = await post(`/groups/${g.id}/invitations`, { actor: 'A', invitee_hint: 'B', role: 'ghost' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('unknown_role');
  });

  it('already_invited returns the existing pending invitation (no fresh token); already_a_member after accept', async () => {
    const g = await makeGroup();
    const first = await post(`/groups/${g.id}/invitations`, { actor: 'A', invitee_hint: 'B', role: 'member' });
    const dup = await post(`/groups/${g.id}/invitations`, { actor: 'A', invitee_hint: 'B', role: 'member' });
    expect(dup.json().reused).toBe(true);
    expect(dup.json().invitation.id).toBe(first.json().invitation.id);
    expect(dup.json().invitation.token).toBeUndefined();

    await post('/invitations/accept', { token: first.json().invitation.token, owner: 'B' });
    const member = await post(`/groups/${g.id}/invitations`, { actor: 'A', invitee_hint: 'B', role: 'member' });
    expect(member.statusCode).toBe(409);
    expect(member.json().error.code).toBe('already_a_member');
  });

  it('revoked invitation cannot be accepted', async () => {
    const g = await makeGroup();
    const inv = (await post(`/groups/${g.id}/invitations`, { actor: 'A', invitee_hint: 'B', role: 'member' })).json().invitation;
    expect((await post(`/invitations/${inv.id}/revoke`)).json().invitation.status).toBe('revoked');
    expect((await post('/invitations/accept', { token: inv.token, owner: 'B' })).json().error.code).toBe('invalid_token');
  });
});

describe('C31 — permission gating on membership operations (resolved, not asserted)', () => {
  beforeEach(setRoles);

  const twoMemberGroup = async () => {
    const g = (await post('/groups/ensure', { owner: 'A' })).json().group;
    const token = (await post(`/groups/${g.id}/invitations`, { actor: 'A', invitee_hint: 'B', role: 'member' })).json().invitation.token;
    await post('/invitations/accept', { token, owner: 'B' });
    return g;
  };

  it('a member without members.invite cannot invite (insufficient_permission); a non-member is not_a_member', async () => {
    const g = await twoMemberGroup();
    const denied = await post(`/groups/${g.id}/invitations`, { actor: 'B', invitee_hint: 'C', role: 'member' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('insufficient_permission');

    const stranger = await post(`/groups/${g.id}/invitations`, { actor: 'Z', invitee_hint: 'C', role: 'member' });
    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().error.code).toBe('not_a_member');
  });

  it('an owner (members.manage_roles) can change a member role', async () => {
    const g = await twoMemberGroup();
    const ok = await post(`/groups/${g.id}/members/B/role`, { actor: 'A', role: 'viewer' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().member.role).toBe('viewer');
    // a plain member can't manage roles
    const denied = await post(`/groups/${g.id}/members/A/role`, { actor: 'B', role: 'viewer' });
    expect(denied.statusCode).toBe(403);
  });
});

describe('C31 — ≥1-owner invariant + transfer + leave + removal event', () => {
  beforeEach(setRoles);

  const twoMemberGroup = async () => {
    const g = (await post('/groups/ensure', { owner: 'A' })).json().group;
    const token = (await post(`/groups/${g.id}/invitations`, { actor: 'A', invitee_hint: 'B', role: 'member' })).json().invitation.token;
    await post('/invitations/accept', { token, owner: 'B' });
    return g;
  };

  it('the last owner cannot be removed, demoted, or leave', async () => {
    const g = (await post('/groups/ensure', { owner: 'A' })).json().group;
    expect((await del(`/groups/${g.id}/members/A`, { actor: 'A' })).json().error.code).toBe('last_owner');
    expect((await post(`/groups/${g.id}/members/A/role`, { actor: 'A', role: 'member' })).json().error.code).toBe('last_owner');
    expect((await post(`/groups/${g.id}/leave`, { actor: 'A' })).json().error.code).toBe('last_owner');
  });

  it('transfer-ownership is atomic and preserves an owner; the demoted ex-owner can then leave', async () => {
    const g = await twoMemberGroup();
    const t = await post(`/groups/${g.id}/transfer-ownership`, { actor: 'A', to_owner: 'B', demote_actor_to: 'member' });
    expect(t.statusCode).toBe(200);
    expect(t.json().to).toMatchObject({ owner: 'B', role: 'owner' });
    expect(t.json().from).toMatchObject({ owner: 'A', role: 'member' });
    // now A (a plain member) may leave; B remains the sole owner
    expect((await post(`/groups/${g.id}/leave`, { actor: 'A' })).statusCode).toBe(200);
    expect((await get(`/groups/${g.id}/members`)).json().total).toBe(1);
  });

  it('removing a member emits membership.removed via C3 and never touches app rows', async () => {
    const g = await twoMemberGroup();
    const r = await del(`/groups/${g.id}/members/B`, { actor: 'A' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ removed: true, member: { owner: 'B' } });
    const events = await store.listAppEvents({ app_id: APP_ID, subject: g.id });
    const removed = events.find((e) => e.type === 'membership.removed');
    expect(removed).toBeTruthy();
    expect(removed!.data).toMatchObject({ removed_owner: 'B', actor: 'A', via: 'remove' });
  });
});

describe('C31 — pure service: invitation expiry', () => {
  it('acceptInvitation rejects an expired token (expired_token) at the pure layer', () => {
    const state: MembershipState = emptyMembershipState();
    state.roles = ROLES;
    state.groups['g'] = { id: 'g', singleton: true, created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z' };
    state.members[memberKey('g', 'A')] = { group_id: 'g', owner: 'A', role: 'owner', status: 'active', added_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z' };
    state.invitations['i'] = {
      id: 'i', group_id: 'g', role: 'member', invitee_hint: 'B', token_hash: hashToken('tok'),
      status: 'pending', invited_by: 'A', created_at: '2020-01-01T00:00:00.000Z', expires_at: '2020-01-15T00:00:00.000Z',
    };
    expect(() => acceptInvitation(state, { token: 'tok', owner: 'B', now: '2026-01-01T00:00:00.000Z' })).toThrowError(/expired/i);
  });
});
