import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../storage/store';
import type { Application } from '../resources/types';
import { SERVICE_TOKEN_HEADER } from './session';

// Where the platform reaches a consuming app's HTTP server to CALL BACK into it — the one sidecar→app
// address used by BOTH the C2 scheduler (cron fires) and the C23 MCP host (tool dispatch). Extracted so the
// resolution + service-auth headers live in one place.
//
// Prod sidecar mode: the app's address is given by env (host + port) on the deploy compose network, e.g.
// FORGE_APP_CALLBACK_HOST=web FORGE_APP_CALLBACK_PORT=3000 — no provisioned Resource/manifest needed.
// Dev mode: resolve the app's web host port from its provisioned manifest; the host is host.docker.internal
// (overridable for Linux/CI via FORGE_APP_CALLBACK_HOST).
export async function appCallbackBase(store: Store, appId?: string): Promise<string | null> {
  const host = process.env.FORGE_APP_CALLBACK_HOST ?? 'host.docker.internal';
  const envPort = process.env.FORGE_APP_CALLBACK_PORT;
  if (process.env.FORGE_APP_CALLBACK_HOST && envPort) {
    return `http://${host}:${envPort}`;
  }
  if (!appId) return null;
  const app = (await store.getResource('Application', appId)) as Application | null;
  if (!app) return null;
  let port = 3000;
  try {
    const manifest = JSON.parse(await readFile(path.join(app.repo_path, 'forge.app.json'), 'utf8'));
    const webPort = manifest?.infra?.ports?.web;
    port = typeof webPort === 'number' ? webPort : typeof manifest.port === 'number' ? manifest.port : 3000;
  } catch {
    /* default */
  }
  return `http://${host}:${port}`;
}

// The headers that authenticate a callback as a SERVICE principal (C10 §5), not a user session. Sent under
// both a dedicated header and Bearer so the app can check whichever it prefers. When no token is
// configured, none is sent and the app's gate rejects it (detectable, not silent).
export function serviceAuthHeaders(serviceToken: string | null): Record<string, string> {
  if (!serviceToken) return {};
  return { [SERVICE_TOKEN_HEADER]: serviceToken, authorization: `Bearer ${serviceToken}` };
}
