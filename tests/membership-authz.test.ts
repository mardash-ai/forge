import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { registerAuthzRoutes } from '../src/api/authz-routes';
import { registerMembershipRoutes } from '../src/api/membership-routes';
import { authorize } from '../src/authz/authorize';
import { nowIso } from '../src/shared/time';
import type { Application } from '../src/resources/types';
import type { PolicyRule, Actor, Action, ResolvedMembership } from '../src/authz/types';
import type { RoleDef } from '../src/membership/types';

// C31 — the C29 `authorize()` extension: role resolved from the membership graph, the NOT-A-MEMBER +
// PRIVATE-LEAK floors, permission gating, and the non-negotiable BACK-COMPAT guarantee (no group_id + no
// scope ⇒ verdict IDENTICAL to pre-C31). The pure tests pin the function; the route tests prove
// server-side resolution + the legacy path.

const NOW = '2026-03-04T12:00:00.000Z';
let seq = 0;
const rule = (over: Partial<PolicyRule>): PolicyRule => ({ id: over.id ?? `p${seq++}`, effect: 'allow', priority: 0, match: {}, created_at: NOW, updated_at: NOW, ...over });
const read = (over: Partial<Action> = {}): Action => ({ tool: 'get_note', type: 'read', reversibility: 'reversible', ...over });
const actor = (over: Partial<Actor> = {}): Actor => ({ owner: 'A', ...over });
const mem = (over: Partial<ResolvedMembership> = {}): ResolvedMembership => ({ group_id: 'g', role: 'member', permissions: [], is_member: true, personal: false, ...over });

describe('C31 — pure authorize: BACK-COMPAT (no membership ⇒ identical, no new fields)', () => {
  it('a legacy call is byte-identical to pre-C31 (no role/permissions/is_member/group_id)', () => {
    const policies = [rule({ id: 'allow_reads', effect: 'allow', match: { type: ['read'] } })];
    const d = authorize(actor(), read(), policies, { now: NOW });
    expect(d).toEqual({ decision: 'allow', rule: 'allow_reads', reason: 'governed by policy allow_reads', high_risk: false, action_class: 'get_note' });
    expect(d).not.toHaveProperty('group_id');
    expect(d).not.toHaveProperty('role');
  });

  it('the request role is still honored when NO membership is resolved (legacy)', () => {
    const policies = [rule({ id: 'admins', effect: 'allow', match: { type: ['read'], role: ['admin'] } })];
    expect(authorize(actor({ role: 'admin' }), read(), policies, { now: NOW }).decision).toBe('allow');
    expect(authorize(actor({ role: 'member' }), read(), policies, { now: NOW }).decision).toBe('needs-approval');
  });
});

describe('C31 — pure authorize: resolved role + floors + permission gating', () => {
  it('matches on the RESOLVED role, not the request (role override)', () => {
    const policies = [rule({ id: 'owners', effect: 'allow', match: { type: ['read'], role: ['owner'] } })];
    // actor carries NO role; the resolved membership role 'owner' drives the match.
    const d = authorize(actor(), read(), policies, { now: NOW, membership: mem({ role: 'owner', is_member: true, personal: true }) });
    expect(d.decision).toBe('allow');
    expect(d).toMatchObject({ role: 'owner', is_member: true, group_id: 'g' });
  });

  it('NOT-A-MEMBER floor: a non-personal group you do not belong to → deny not-a-member', () => {
    const allowAll = [rule({ id: 'yolo', effect: 'allow', priority: 100, match: {} })];
    const d = authorize(actor(), read(), allowAll, { now: NOW, membership: mem({ is_member: false, role: undefined, personal: false }) });
    expect(d).toMatchObject({ decision: 'deny', rule: 'not-a-member', is_member: false });
  });

  it('PRIVATE-LEAK floor: private row owned by someone else → deny private-resource', () => {
    const allowAll = [rule({ id: 'yolo', effect: 'allow', priority: 100, match: {} })];
    const d = authorize(actor({ owner: 'B' }), read({ visibility: 'private', resource_owner: 'A' }), allowAll, { now: NOW, membership: mem({ group_id: 'g', is_member: true }) });
    expect(d).toMatchObject({ decision: 'deny', rule: 'private-resource' });
    // the owner of a private row is NOT leaked-against
    expect(authorize(actor({ owner: 'A' }), read({ visibility: 'private', resource_owner: 'A' }), allowAll, { now: NOW, membership: mem({ is_member: true }) }).decision).toBe('allow');
  });

  it('PRIVATE-LEAK floor: shared row denies a caller who is neither owner nor in shared_with', () => {
    const allowAll = [rule({ id: 'yolo', effect: 'allow', priority: 100, match: {} })];
    const denied = authorize(actor({ owner: 'C' }), read({ visibility: 'shared', resource_owner: 'A', shared_with: ['B'] }), allowAll, { now: NOW, membership: mem({ is_member: true }) });
    expect(denied.decision).toBe('deny');
    const allowed = authorize(actor({ owner: 'B' }), read({ visibility: 'shared', resource_owner: 'A', shared_with: ['B'] }), allowAll, { now: NOW, membership: mem({ is_member: true }) });
    expect(allowed.decision).toBe('allow');
  });

  it('group-visible rows never trigger the private-leak floor (membership already gated)', () => {
    const allowAll = [rule({ id: 'yolo', effect: 'allow', priority: 100, match: {} })];
    expect(authorize(actor({ owner: 'B' }), read({ visibility: 'group', resource_owner: 'A' }), allowAll, { now: NOW, membership: mem({ is_member: true }) }).decision).toBe('allow');
  });

  it('PERMISSION gating: a rule with `permission` matches only when the resolved set holds it', () => {
    const policies = [rule({ id: 'perm', effect: 'allow', match: { type: ['read'], permission: ['notes.read'] } })];
    expect(authorize(actor(), read(), policies, { now: NOW, membership: mem({ permissions: ['notes.read'] }) }).decision).toBe('allow');
    expect(authorize(actor(), read(), policies, { now: NOW, membership: mem({ permissions: [] }) }).decision).toBe('needs-approval');
  });

  it('the safety floor still fires under C31 (a resolved role cannot downgrade high-risk)', () => {
    const allowAll = [rule({ id: 'yolo', effect: 'allow', priority: 100, match: {} })];
    const d = authorize(actor(), { tool: 'send_email', type: 'send', channel: 'email', contact: 'x@y.com' }, allowAll, { now: NOW, membership: mem({ role: 'owner' }) });
    expect(d.decision).toBe('needs-approval');
    expect(d.high_risk).toBe(true);
  });
});

// ---- route-level: server-side resolution + the legacy path ----------------------------------------------
const APP = 'demo';
const APP_ID = 'app_demo';
const ROLES: RoleDef[] = [
  { key: 'owner', permissions: ['members.invite', 'members.manage_roles', 'members.remove'], rank: 100, owner_role: true, assignable: true },
  { key: 'member', permissions: [], rank: 10, owner_role: false, assignable: true },
];
let dir: string;
let prev: string | undefined;
let server: FastifyInstance;

const seedApp = async () => {
  const now = nowIso();
  await store.saveResource({
    id: APP_ID, type: 'Application', app_id: APP_ID, created_at: now, updated_at: now,
    name: APP, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web', language: 'typescript', package_manager: 'npm',
  } as Application);
};

describe('C31 — /authorize route: resolution, legacy path, and floors end-to-end', () => {
  beforeEach(async () => {
    prev = process.env.FORGE_STATE_DIR;
    dir = await mkdtemp(path.join(tmpdir(), 'forge-mauthz-'));
    process.env.FORGE_STATE_DIR = dir;
    await store.init();
    await seedApp();
    server = Fastify({ logger: false });
    registerAuthzRoutes(server, { defaultApp: () => APP });
    registerMembershipRoutes(server, { defaultApp: () => APP });
    await server.ready();
  });
  afterEach(async () => {
    await server.close();
    if (prev === undefined) delete process.env.FORGE_STATE_DIR; else process.env.FORGE_STATE_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  });
  const post = (url: string, payload: unknown) => server.inject({ method: 'POST', url, payload: payload as object });
  const put = (url: string, payload: unknown) => server.inject({ method: 'PUT', url, payload: payload as object });
  const authorizeCall = (body: unknown) => post('/authorize', body).then((r) => r.json());

  it('legacy (no role registry): request role honored, response has NO resolved fields', async () => {
    await post('/policies', { effect: 'allow', match: { type: ['read'], role: ['admin'] } });
    const d = await authorizeCall({ owner: 'A', role: 'admin', action: read() });
    expect(d.decision).toBe('allow');
    expect(d).not.toHaveProperty('group_id');
  });

  it('with a registry: role is RESOLVED (request role ignored) + fields echoed + personal group lazy-provisioned', async () => {
    await put('/roles', { roles: ROLES });
    await post('/policies', { effect: 'allow', match: { type: ['read'], role: ['admin'] } });
    // request says role:'admin' but the resolved personal role is 'owner' → the admin policy no longer matches.
    const d = await authorizeCall({ owner: 'A', role: 'admin', action: read() });
    expect(d.decision).toBe('needs-approval'); // request role was IGNORED
    expect(d).toMatchObject({ role: 'owner', is_member: true });
    expect(typeof d.group_id).toBe('string');
    // the group-of-one is now real
    const groups = (await server.inject({ method: 'GET', url: '/identities/A/groups' })).json();
    expect(groups.total).toBe(1);
  });

  it('BACK-COMPAT: no group_id + no scope resolves to the group-of-one with an IDENTICAL verdict', async () => {
    await post('/policies', { effect: 'allow', match: { type: ['read'] } }); // matches on type, not role
    const legacy = await authorizeCall({ owner: 'A', action: read() });
    await put('/roles', { roles: ROLES });
    const resolved = await authorizeCall({ owner: 'A', action: read() });
    // the verdict fields are identical; the resolved call merely ADDS the platform-resolved context.
    expect(resolved.decision).toBe(legacy.decision);
    expect(resolved.rule).toBe(legacy.rule);
    expect(resolved.reason).toBe(legacy.reason);
    expect(resolved.high_risk).toBe(legacy.high_risk);
    expect(resolved.action_class).toBe(legacy.action_class);
    expect(resolved).toMatchObject({ role: 'owner', is_member: true, permissions: ['members.invite', 'members.manage_roles', 'members.remove'] });
  });

  it('PRIVATE-LEAK deny end-to-end: a caller acting on another owner’s private row is denied', async () => {
    await put('/roles', { roles: ROLES });
    await post('/policies', { effect: 'allow', match: {} }); // allow-all — the floor must still deny
    const d = await authorizeCall({ owner: 'B', action: read({ visibility: 'private', resource_owner: 'A' }) });
    expect(d).toMatchObject({ decision: 'deny', rule: 'private-resource' });
  });

  it('NOT-A-MEMBER deny end-to-end: targeting a group the caller does not belong to', async () => {
    await put('/roles', { roles: ROLES });
    const g = (await post('/groups/ensure', { owner: 'A' })).json().group;
    await post('/policies', { effect: 'allow', match: {} });
    const d = await authorizeCall({ owner: 'B', group_id: g.id, action: read() });
    expect(d).toMatchObject({ decision: 'deny', rule: 'not-a-member', is_member: false });
  });
});
