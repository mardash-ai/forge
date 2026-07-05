import { z } from 'zod';
import type { Store } from '../storage/store';
import type { Application } from '../resources/types';
import { notFound } from '../shared/errors';
import { nowIso } from '../shared/time';
import { newResourceId } from '../shared/ids';

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
