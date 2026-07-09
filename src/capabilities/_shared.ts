import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../storage/store';
import type { Application } from '../resources/types';
import { notFound } from '../shared/errors';
import { nowIso } from '../shared/time';
import { newResourceId } from '../shared/ids';
import { appDir } from '../shared/paths';

// Common input fragments. Platform is always explicit (agent-context.md), and
// defaults to web/nextjs — the only Implementation wired up in v1.
export const platformInput = {
  platform: z.string().default('web'),
  framework: z.string().default('nextjs'),
};

export const appRefInput = {
  app: z.string().min(1).describe('Application name'),
  ...platformInput,
};

// Resolve an Application Resource by name (Capabilities receive a name, not id).
export async function resolveApp(store: Store, name: string): Promise<Application> {
  const app = await store.findAppByName(name);
  if (!app || app.type !== 'Application') {
    throw notFound(`No Application named "${name}". Run: forge init app --name ${name}`, { app: name });
  }
  return app as Application;
}

// The DEPLOY-TIME app target: a name + the repo the deploy operates on, and the store id when
// one exists. Unlike the strict `resolveApp` above (which every DEV-workspace capability uses,
// where `forge init app` has always run), the deploy-time capabilities — `forge deploy`,
// `productionize` (the `release` repin), `verify` (the `release` gate), and `release` itself —
// run on a PRODUCTION host whose control-plane store may NEVER have been populated by `forge init
// app` (that box only ever ran `forge deploy` / `forge productionize`). There, a registered
// Application is OPTIONAL: the app is inferred from the single-app layout + the committed
// `app/forge.app.json` (which carries the app name, the production host, and the current web-image
// pin). A store record, when present, STILL wins — its id links Resources/Events. Its ABSENCE is
// not fatal as long as `forge.app.json` resolves the app, so assess/repin/verify never require a
// box-side `forge init app` (the P19 deploy-host regression: `release` used the strict lookup and
// failed `not_found` where `forge deploy` succeeded). If NEITHER a store record NOR a usable
// `app/forge.app.json` resolves the app, it still fails clearly.
export interface AppTarget {
  id?: string; // present only when a store Application exists (links resources/events)
  name: string;
  repo_path: string;
}

export async function resolveAppLenient(store: Store, name: string): Promise<AppTarget> {
  const known = await store.findAppByName(name);
  if (known && known.type === 'Application') {
    const app = known as Application;
    return { id: app.id, name: app.name, repo_path: app.repo_path };
  }
  // No store record — infer from the single-app layout + the committed app manifest. This is the
  // SAME repo `forge deploy` operates on; the manifest is the source of truth for the app name.
  const repo = appDir(name);
  try {
    const manifest = JSON.parse(await readFile(path.join(repo, 'forge.app.json'), 'utf8')) as { name?: string };
    const resolvedName = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : name;
    return { id: undefined, name: resolvedName, repo_path: repo };
  } catch {
    throw notFound(
      `No Application named "${name}", and no readable app/forge.app.json to resolve it from. ` +
        `Run: forge init app --name ${name}, or run from the app's workspace (single-app layout).`,
      { app: name },
    );
  }
}

// Build a base Resource envelope.
export function baseResource<T extends string>(type: T, app_id?: string) {
  const now = nowIso();
  return {
    id: newResourceId(type),
    type,
    app_id,
    created_at: now,
    updated_at: now,
  };
}
