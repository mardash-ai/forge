import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { getBackends } from '../src/storage/backends';
import { connectionsFile } from '../src/shared/paths';
import { hydrateConnection } from '../src/connectors/types';

// ⛔ THE LEGACY-ROW GUARD.
//
// Every connection record written before 2026-08-24 has NO `auth_kind` — the field did not exist. When
// `Connection` became a discriminated union, those rows became objects that satisfy NEITHER arm, so
// every `switch (c.auth_kind)` / `if (c.auth_kind === 'oauth2')` in the codebase would silently take
// the wrong branch. The failure mode is the worst shape there is: it appears ONLY in production,
// against real users' existing Google and Microsoft connections, while the whole local suite stays
// green — because every test writes a FRESH record, which of course has the new field.
//
// So the guard cannot be "does a round-trip work". It has to read a record shaped like the ones
// actually sitting in Postgres today. These tests write that shape on purpose.
const APP_ID = 'hydration-app';

let dir: string;
let prevDir: string | undefined;
let prevKey: string | undefined;

const legacyRecord = {
  owner: 'u1',
  provider: 'google',
  // deliberately NO auth_kind — this is the on-disk shape as of v1.52.2
  access_sealed: { iv: 'iv', tag: 'tag', data: 'data' },
  refresh_sealed: { iv: 'iv2', tag: 'tag2', data: 'data2' },
  access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  scopes: ['openid', 'email'],
  status: 'connected',
  account_label: 'legacy@gmail.test',
  connected_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

beforeEach(async () => {
  prevDir = process.env.FORGE_STATE_DIR;
  prevKey = process.env.FORGE_SECRETS_KEY;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-hydration-'));
  process.env.FORGE_STATE_DIR = dir;
  process.env.FORGE_SECRETS_KEY = 'hydration-test-master-key';
  await store.init();
});

afterEach(async () => {
  process.env.FORGE_STATE_DIR = prevDir;
  process.env.FORGE_SECRETS_KEY = prevKey;
  await rm(dir, { recursive: true, force: true });
});

// Build the doc through the backend (so the on-disk key format is whatever the backend really uses —
// it is a NUL-separated compound key, not something a test should hardcode), then STRIP the
// discriminant back out. What lands on disk is byte-for-byte the pre-union shape, and nothing in the
// test depends on a private constant that could drift.
async function seedLegacyDoc(): Promise<void> {
  const b = (await getBackends()).connections;
  await b.putConnection(APP_ID, { ...legacyRecord, auth_kind: 'oauth2' } as never);
  const file = connectionsFile(APP_ID);
  const doc = JSON.parse(await readFile(file, 'utf8')) as {
    connections: Record<string, Record<string, unknown>>;
  };
  const keys = Object.keys(doc.connections);
  expect(keys).toHaveLength(1);
  const key = keys[0]!;
  delete doc.connections[key]!.auth_kind; // ← the record as it exists in production today
  await writeFile(file, JSON.stringify(doc, null, 2), { mode: 0o600 });
}

describe('connection hydration — records written before the auth_kind union', () => {
  it('hydrateConnection defaults a discriminant-less record to oauth2 (it always WAS one)', () => {
    const out = hydrateConnection(legacyRecord as never);
    expect(out.auth_kind).toBe('oauth2');
    // and preserves everything else untouched
    expect(out.account_label).toBe('legacy@gmail.test');
    expect(out.provider).toBe('google');
  });

  it('never rewrites a record that already declares its kind', () => {
    const basic = { ...legacyRecord, auth_kind: 'basic', username: 'x@icloud.com' };
    expect(hydrateConnection(basic as never).auth_kind).toBe('basic');
  });

  it('getConnection hydrates a legacy row read off disk', async () => {
    await seedLegacyDoc();
    const b = (await getBackends()).connections;
    const got = await b.getConnection(APP_ID, 'u1', 'google');
    expect(got).not.toBeNull();
    expect(got!.auth_kind).toBe('oauth2');
  });

  it('listConnections hydrates legacy rows read off disk', async () => {
    await seedLegacyDoc();
    const b = (await getBackends()).connections;
    const all = await b.listConnections(APP_ID, 'u1');
    expect(all).toHaveLength(1);
    expect(all[0]!.auth_kind).toBe('oauth2');
  });

  // The consequence that actually bites: an un-hydrated legacy row is not `oauth2`, so the broker's
  // `if (conn.auth_kind !== 'oauth2') throw wrongAuthKind(...)` would reject a perfectly good Google
  // connection with "this provider uses a username and password" — a nonsense error, in production,
  // for every user who connected before today.
  it('a hydrated legacy row still satisfies the oauth2 branch the broker gates on', async () => {
    await seedLegacyDoc();
    const b = (await getBackends()).connections;
    const got = await b.getConnection(APP_ID, 'u1', 'google');
    expect(got!.auth_kind === 'oauth2').toBe(true);
  });
});
