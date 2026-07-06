import { describe, it, expect, afterEach } from 'vitest';
import { appDir, appLayout, appsDir } from '../src/shared/paths';

// Guards the single-app layout switch. Downstream Capabilities resolve apps via
// the stored repo_path, so this is the one place the on-disk location is decided.
describe('app layout', () => {
  const prevLayout = process.env.FORGE_APP_LAYOUT;
  const prevWs = process.env.FORGE_WORKSPACE;

  afterEach(() => {
    if (prevLayout === undefined) delete process.env.FORGE_APP_LAYOUT;
    else process.env.FORGE_APP_LAYOUT = prevLayout;
    if (prevWs === undefined) delete process.env.FORGE_WORKSPACE;
    else process.env.FORGE_WORKSPACE = prevWs;
  });

  it('defaults to multi-app (./apps/<name>) for backward compatibility', () => {
    process.env.FORGE_WORKSPACE = '/ws';
    delete process.env.FORGE_APP_LAYOUT;
    expect(appLayout()).toBe('multi');
    expect(appsDir()).toBe('/ws/apps');
    expect(appDir('my-app')).toBe('/ws/apps/my-app');
  });

  it('treats any non-"single" value as multi', () => {
    process.env.FORGE_WORKSPACE = '/ws';
    process.env.FORGE_APP_LAYOUT = 'nonsense';
    expect(appLayout()).toBe('multi');
    expect(appDir('my-app')).toBe('/ws/apps/my-app');
  });

  it('single-app mode resolves every app to ./app regardless of name', () => {
    process.env.FORGE_WORKSPACE = '/ws';
    process.env.FORGE_APP_LAYOUT = 'single';
    expect(appLayout()).toBe('single');
    expect(appDir('forge-os')).toBe('/ws/app');
    expect(appDir('anything-else')).toBe('/ws/app');
  });
});
