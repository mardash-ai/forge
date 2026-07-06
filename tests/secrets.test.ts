import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setSecret, readSecrets, listSecretNames } from '../src/plugins/secrets-local/index';
import { generateCompose } from '../src/plugins/runtime-docker-compose/index';

// Isolate the state dir and pin a deterministic master key so the crypto
// round-trip is self-contained and leaves nothing outside a temp directory.
const prevState = process.env.FORGE_STATE_DIR;
const prevKey = process.env.FORGE_SECRETS_KEY;
let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'forge-secrets-'));
  process.env.FORGE_STATE_DIR = tmp;
  process.env.FORGE_SECRETS_KEY = 'test-master-key-not-for-production';
});

afterAll(async () => {
  if (prevState === undefined) delete process.env.FORGE_STATE_DIR;
  else process.env.FORGE_STATE_DIR = prevState;
  if (prevKey === undefined) delete process.env.FORGE_SECRETS_KEY;
  else process.env.FORGE_SECRETS_KEY = prevKey;
  await rm(tmp, { recursive: true, force: true });
});

describe('secrets-local: encrypted at rest, decrypted only for injection', () => {
  it('round-trips a stored secret', async () => {
    await setSecret('app_one', 'ANTHROPIC_API_KEY', 'sk-ant-secret-123');
    expect(await readSecrets('app_one')).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-secret-123' });
  });

  it('never persists the plaintext value on disk', async () => {
    await setSecret('app_two', 'TOKEN', 'plaintext-must-not-appear');
    const onDisk = await readFile(path.join(tmp, 'secrets', 'vault-app_two.json'), 'utf8');
    expect(onDisk).not.toContain('plaintext-must-not-appear');
  });

  it('returns nothing when a secret is absent (graceful degradation)', async () => {
    expect(await readSecrets('app_absent')).toEqual({});
    expect(await listSecretNames('app_absent')).toEqual([]);
  });

  it('lists names only, and overwrites on re-set', async () => {
    await setSecret('app_three', 'A', '1');
    await setSecret('app_three', 'B', '2');
    await setSecret('app_three', 'A', '1-updated');
    expect(await listSecretNames('app_three')).toEqual(['A', 'B']);
    expect((await readSecrets('app_three')).A).toBe('1-updated');
  });
});

describe('generateCompose: declared secrets become empty-by-default interpolation lines', () => {
  const base = { appName: 'demo', port: 3000, withPostgres: false, withRedis: false, devCommand: 'npm run dev' };

  it('emits one env line per declared secret, empty when unset', () => {
    const yaml = generateCompose({ ...base, secrets: ['ANTHROPIC_API_KEY'] });
    expect(yaml).toContain('- ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}');
  });

  it('writes no secret material and no interpolation when none are declared', () => {
    const yaml = generateCompose({ ...base });
    expect(yaml).not.toContain('${');
  });
});
