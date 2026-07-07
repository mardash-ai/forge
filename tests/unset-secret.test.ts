import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { store } from '../src/storage/store';
import { executeCapability } from '../src/core/runtime';
import { ForgeError } from '../src/shared/errors';
import { SYSTEM_ACTOR } from '../src/shared/domain';
import { setSecret, unsetSecret, listSecretNames } from '../src/plugins/secrets-local/index';
import type { Application, Secret } from '../src/resources/types';
import { nowIso } from '../src/shared/time';

// P2 — UnsetSecret (`forge secrets unset`), the C5 SetSecret follow-up. Removes/revokes a secret
// from the vault: idempotent, 404 unknown app, 422 bad name, never returns the value. Uses a
// throwaway FORGE_STATE_DIR and a pinned master key (self-contained; no network, no real key).
const prevKey = process.env.FORGE_SECRETS_KEY;
let dir: string;
let prevState: string | undefined;

beforeAll(() => {
  process.env.FORGE_SECRETS_KEY = 'test-master-key-not-for-production';
});
afterAll(() => {
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
});

async function seedApp(name: string): Promise<Application> {
  const now = nowIso();
  const app: Application = {
    id: `app_${name}`, type: 'Application', app_id: `app_${name}`, created_at: now, updated_at: now,
    name, repo_path: '/app', platform: 'web', framework: 'nextjs', template: 'nextjs-web',
    language: 'typescript', package_manager: 'npm',
  };
  await store.saveResource(app);
  return app;
}

beforeEach(async () => {
  prevState = process.env.FORGE_STATE_DIR;
  dir = await mkdtemp(path.join(tmpdir(), 'forge-unset-'));
  process.env.FORGE_STATE_DIR = dir;
  await store.init();
});

afterEach(async () => {
  if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevState;
  await rm(dir, { recursive: true, force: true });
});

describe('secrets-local: unsetSecret (revoke)', () => {
  it('set -> unset removes it from the vault; list no longer shows it', async () => {
    await setSecret('app_x', 'ANTHROPIC_API_KEY', 'sk-ant-123');
    expect(await listSecretNames('app_x')).toEqual(['ANTHROPIC_API_KEY']);

    expect(await unsetSecret('app_x', 'ANTHROPIC_API_KEY')).toBe(true); // removed
    expect(await listSecretNames('app_x')).toEqual([]); // gone
  });

  it('unsetting an absent secret is a no-op success (idempotent)', async () => {
    expect(await unsetSecret('app_x', 'NOPE')).toBe(false); // nothing to remove, but no throw
    // Re-unsetting after a real unset is also a no-op success.
    await setSecret('app_x', 'A', '1');
    expect(await unsetSecret('app_x', 'A')).toBe(true);
    expect(await unsetSecret('app_x', 'A')).toBe(false);
  });

  it('unsetting one secret leaves the others intact', async () => {
    await setSecret('app_x', 'A', '1');
    await setSecret('app_x', 'B', '2');
    await unsetSecret('app_x', 'A');
    expect(await listSecretNames('app_x')).toEqual(['B']);
  });
});

describe('UnsetSecret capability (P2)', () => {
  it('set (capability) -> unset (capability) -> inspect secrets no longer lists it', async () => {
    const app = await seedApp('demo');
    await executeCapability('set-secret', { app: 'demo', name: 'ANTHROPIC_API_KEY', value: 'sk-ant-live' }, SYSTEM_ACTOR);

    // The Secret metadata Resource exists and is 'set'.
    let secrets = (await store.listResources({ type: 'Secret', app_id: app.id })) as Secret[];
    expect(secrets.map((s) => s.name)).toContain('ANTHROPIC_API_KEY');

    const res = await executeCapability('unset-secret', { app: 'demo', name: 'ANTHROPIC_API_KEY' }, SYSTEM_ACTOR);
    expect((res.resource as Secret).status).toBe('unset');
    expect(JSON.stringify(res)).not.toContain('sk-ant-live'); // never returns the value

    // inspect secrets (what `forge secrets list` calls) no longer shows it.
    const inspect = await executeCapability('inspect', { app: 'demo', type: 'secrets' }, SYSTEM_ACTOR);
    expect(JSON.stringify(inspect)).not.toContain('ANTHROPIC_API_KEY');

    // The Secret metadata Resource was retired too.
    secrets = (await store.listResources({ type: 'Secret', app_id: app.id })) as Secret[];
    expect(secrets.find((s) => s.name === 'ANTHROPIC_API_KEY')).toBeUndefined();

    // A SecretUnset fact was recorded (name only, no value).
    const events = await store.listEvents({ app_id: app.id });
    const unsetEvt = events.find((e) => e.type === 'SecretUnset');
    expect(unsetEvt?.data?.name).toBe('ANTHROPIC_API_KEY');
    expect(JSON.stringify(unsetEvt)).not.toContain('sk-ant-live');
  });

  it('unsetting an absent secret succeeds (idempotent, status unset)', async () => {
    await seedApp('demo');
    const res = await executeCapability('unset-secret', { app: 'demo', name: 'NEVER_SET' }, SYSTEM_ACTOR);
    expect((res.resource as Secret).status).toBe('unset');
  });

  it('404 not_found for an unknown app', async () => {
    await expect(
      executeCapability('unset-secret', { app: 'ghost', name: 'A' }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('422 invalid_input for an invalid name', async () => {
    await seedApp('demo');
    await expect(
      executeCapability('unset-secret', { app: 'demo', name: '1-bad name' }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ status: 422 });
    // Sanity: the thrown error is a ForgeError.
    await executeCapability('unset-secret', { app: 'demo', name: '9bad' }, SYSTEM_ACTOR).catch((e) => {
      expect(e).toBeInstanceOf(ForgeError);
    });
  });
});
