/**
 * ⛔ THE CONSOLE MUST SAY WHAT IT IS RUNNING.
 *
 * 2026-08-16. forge-console served v1.37.1 for two days while v1.38.0 and v1.39.0 sat released and
 * unadopted — including a feature Mark had asked for and been told had shipped. Nothing on the page
 * could have revealed it. The scheduled `forge-pin-check` was RED the whole time and went unread,
 * and the only way to answer "is my fix live?" was `gcloud run services describe`.
 *
 * A version in the corner of the screen is the cheapest possible answer to a question this estate
 * keeps getting wrong. These guards exist because a version display that can be WRONG is worse than
 * none — it converts "I don't know" into false confidence.
 *
 * Two properties, and the second is the one with teeth:
 *
 *   1. it is READ FROM THE RUNNING IMAGE (its own package.json), never from a config value, an env
 *      var an operator could set, or a constant someone must remember to bump;
 *   2. a build with no release identity SAYS SO rather than inventing one. `dev` and `v1.40.2` must
 *      never be confusable, or the display becomes another thing to distrust.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const SERVER = readFileSync(join(root, 'src', 'console', 'server.ts'), 'utf8');
const APP = readFileSync(join(root, 'console', 'src', 'App.tsx'), 'utf8');
const DOCKERFILE = readFileSync(join(root, 'Dockerfile'), 'utf8');
const DOCKERFILE_CONSOLE = readFileSync(join(root, 'Dockerfile.console'), 'utf8');
const PUBLISH = readFileSync(join(root, '.github', 'workflows', 'publish-image.yml'), 'utf8');

/** Comments describe the bug; only code can reintroduce it. */
const codeOnly = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('#'))
    .join('\n');

describe('the console reports the build it is actually running', () => {
  it('⛔ reads the version from the IMAGE, not from config', () => {
    // package.json travels inside the image, so this reports what is running. An env var or a
    // hand-maintained constant would report what someone last remembered to set.
    expect(codeOnly(SERVER)).toMatch(/import pkgJson from '\.\.\/\.\.\/package\.json';/);
    expect(codeOnly(SERVER)).toMatch(/version: \(pkgJson as \{ version\?: string \}\)\.version \?\? null/);
  });

  it('serves the commit alongside it', () => {
    expect(codeOnly(SERVER)).toMatch(/commit: process\.env\.FORGE_COMMIT \|\| null/);
  });

  it('⛔ the commit is stamped at BUILD time, so it cannot drift from the image', () => {
    expect(codeOnly(DOCKERFILE)).toMatch(/ARG FORGE_COMMIT=""/);
    expect(codeOnly(DOCKERFILE)).toMatch(/ENV FORGE_COMMIT=\$FORGE_COMMIT/);
    expect(codeOnly(PUBLISH)).toMatch(/FORGE_COMMIT=\$\{\{ github\.sha \}\}/);
  });

  it('⛔ EVERY Dockerfile that ships a console carries the stamp — not just the default one', () => {
    /*
     * The one I got wrong. `Dockerfile` is forge's own image; forge-console in production is built
     * from `Dockerfile.console` by dorinda-forge-console's release workflow. Stamping only the
     * former shipped a production console reporting its commit as "dev" — honest, but not the
     * answer a released build should give, and I only caught it by reading FORGE_COMMIT off the
     * running revision instead of trusting that the feature was done.
     *
     * Any future Dockerfile that serves the console must carry it too, so this asserts the
     * property across all of them rather than naming one.
     */
    for (const [name, contents] of [
      ['Dockerfile', DOCKERFILE],
      ['Dockerfile.console', DOCKERFILE_CONSOLE],
    ] as const) {
      expect(codeOnly(contents), `${name} must accept FORGE_COMMIT`).toMatch(/ARG FORGE_COMMIT=""/);
      expect(codeOnly(contents), `${name} must expose FORGE_COMMIT`).toMatch(
        /ENV FORGE_COMMIT=\$FORGE_COMMIT/,
      );
    }
  });

  it('renders it in the UI', () => {
    expect(codeOnly(APP)).toMatch(/data-testid="console-version"/);
    expect(codeOnly(APP)).toMatch(/boot\.data\?\.version/);
  });

  it('⛔ a build with NO release identity says so instead of inventing one', () => {
    // Three distinct states that must never share an appearance:
    //   v1.40.2 · abc1234   a real release
    //   v1.40.2 · dev       running the source, no build stamp
    //   version unknown     bootstrap has not answered
    const code = codeOnly(APP);
    expect(code).toMatch(/' · dev'/);
    expect(code).toMatch(/'version unknown'/);
  });
});
