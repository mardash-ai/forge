/**
 * ⛔ THE DEPLOYS SCREEN MUST NAME THE BUILD, FOR EVERY SERVICE.
 *
 * Every service in this estate is rolled BY DIGEST, deliberately: a tag is a label someone can
 * move, and digest-pinning is what makes a rollout verifiable. The cost is that the deploys screen
 * showed `app@sha256:abf3cd1…` and nothing else, so "is v1.40.2 live?" was answerable only by
 * `gcloud artifacts docker images list`.
 *
 * That cost was paid on 2026-08-16: forge-console served v1.37.1 for two days while two releases
 * sat released-and-unadopted — one of them a feature Mark had asked for and been told had shipped.
 * The scheduled pin-check was RED throughout and went unread, and no screen could have revealed it.
 *
 * The digest is still the identity; the version sits BESIDE it, resolved from the registry.
 *
 * ⛔ The rule this file exists to protect is the SECOND test. The first implementation matched only
 * semver tags — which would have shown a version for forge-console and forge-data-plane and
 * "unknown" for dorinda-api, dorinda-web and dorinda-site, because those pipelines tag by COMMIT
 * SHA. Three of five services blank is exactly the "just forge-console" outcome the feature was
 * asked to avoid, and only checking the real estate caught it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const RUNTIME = readFileSync(join(root, 'src', 'plugins', 'console-gcp', 'runtime.ts'), 'utf8');
const APP = readFileSync(join(root, 'console', 'src', 'App.tsx'), 'utf8');

const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

const RUNTIME_CODE = codeOnly(RUNTIME);
const APP_CODE = codeOnly(APP);

describe('the deploys screen names the running build', () => {
  it('resolves the serving digest back to a registry tag', () => {
    expect(RUNTIME_CODE).toMatch(/export async function resolveImageVersion\(/);
    expect(RUNTIME_CODE).toMatch(/artifactregistry\.googleapis\.com/);
    expect(RUNTIME_CODE).toMatch(/image_version: versions\.get\(image\) \?\? null/);
  });

  it('⛔ accepts a COMMIT-SHA tag, not only semver — most services here use one', () => {
    // Verified against the live estate: forge-console/forge-data-plane publish v1.40.2, while
    // dorinda-api/web/site publish a commit sha. Matching only semver blanks three of five.
    expect(RUNTIME_CODE).toMatch(
      /tags\.find\(\(t\) => \/\^v\?\\d\+\\\.\\d\+\\\.\\d\+\/\.test\(t\)\) \?\? tags\.find\(\(t\) => t !== 'latest'\) \?\? null/,
    );
  });

  it('⛔ never treats `latest` as an identity', () => {
    // `latest` is whatever was pushed last — the opposite of a build identity.
    expect(RUNTIME_CODE).toMatch(/t !== 'latest'/);
  });

  it('caches per digest, because a digest is immutable', () => {
    expect(RUNTIME_CODE).toMatch(/versionCache\.set\(digest, version\)/);
  });

  it('⛔ a FAILED lookup is not cached — a transient 503 must not freeze a digest as unknown', () => {
    // The catch returns null WITHOUT writing the cache. Caching there would make one bad minute
    // permanent for the life of the process.
    const catchBlock = RUNTIME_CODE.slice(
      RUNTIME_CODE.indexOf('} catch {', RUNTIME_CODE.indexOf('resolveImageVersion')),
    );
    expect(catchBlock.slice(0, 200)).not.toMatch(/versionCache\.set/);
  });

  it('resolves each unique image once, in parallel', () => {
    expect(RUNTIME_CODE).toMatch(/const uniqueImages = \[\.\.\.new Set\(/);
    expect(RUNTIME_CODE).toMatch(/await Promise\.all\(/);
  });

  it('⛔ renders unknown rather than guessing, and keeps the digest beside it', () => {
    expect(APP_CODE).toMatch(/'Version', 'Digest'/);
    expect(APP_CODE).toMatch(/r\.image_version \?/);
    expect(APP_CODE).toMatch(/unknown/);
    // The digest column survives: the version is presentation, the digest is the identity.
    expect(APP_CODE).toMatch(/r\.image_digest\.slice\(0, 19\)/);
  });
});
