import { stat, rm } from 'node:fs/promises';
import path from 'node:path';

// Plugin: build-npm — Next.js build-artifact helpers.
//
// `next build` (production) and `next dev` (development) both write to `.next`. Forge runs each in
// the SAME container over the SAME bind-mounted `app/.next`, so running `forge build` and THEN
// `forge dev` leaves the dev server loading stale PRODUCTION chunks — every route 500s with
// `Error: Cannot find module './chunks/vendor-chunks/next.js'`. The dev server can't recover on its
// own; the only fix is to wipe `.next`. These helpers let RunDevServer detect a leftover production
// build and reset it BEFORE starting dev, so the build→dev order can never corrupt dev state.

// Files that ONLY a completed `next build` writes into `.next`; a `next dev` session never does.
// Any one present ⇒ `.next` holds a production build. (Verified against Next 14 output: a production
// `.next` has BUILD_ID / required-server-files.json / prerender-manifest.json; a dev `.next` has
// none of them.) Checking several is belt-and-suspenders in case a partial build left only some.
const PRODUCTION_MARKERS = ['BUILD_ID', 'required-server-files.json', 'prerender-manifest.json'];

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Does `<appDir>/.next` look like a production build (vs a dev-server working directory)?
export async function isProductionNextDir(appDir: string): Promise<boolean> {
  const nextDir = path.join(appDir, '.next');
  for (const marker of PRODUCTION_MARKERS) {
    if (await exists(path.join(nextDir, marker))) return true;
  }
  return false;
}

// If `.next` holds a production build, remove it so a fresh `next dev` starts clean. Returns whether
// a reset happened. Never throws for a missing/dev `.next` — a dev start must not be blocked by this.
export async function resetStaleProductionNext(appDir: string): Promise<{ reset: boolean }> {
  if (!(await isProductionNextDir(appDir))) return { reset: false };
  await rm(path.join(appDir, '.next'), { recursive: true, force: true });
  return { reset: true };
}
