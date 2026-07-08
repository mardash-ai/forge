import type { FastifyRequest } from 'fastify';
import { store } from '../storage/store';
import { APP_HEADER } from '../shared/session';

// Resolve which app a platform-served request targets — the same precedence the C10
// auth routes use, factored out for the C15 status page + C16 /theme.css routes:
//   explicit arg → `?app=` query → `X-Forge-App` header (a dev proxy on a multi-app
//   control plane) → the server's default (the single-app data-plane FORGE_APP_NAME).
// Prod is un-regressed: with no explicit app and no header it falls to the default.

export interface ResolvedApp {
  id: string;
  name: string;
  repoPath: string;
}

const trimmed = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
};

export function resolveAppName(
  req: FastifyRequest,
  defaultApp?: () => string | undefined,
  explicit?: string,
): string | undefined {
  const fromExplicit = trimmed(explicit);
  if (fromExplicit) return fromExplicit;
  const fromQuery = trimmed((req.query as { app?: string } | undefined)?.app);
  if (fromQuery) return fromQuery;
  const fromBody = trimmed((req.body as { app?: string } | undefined)?.app);
  if (fromBody) return fromBody;
  const hdr = req.headers[APP_HEADER];
  const fromHeader = trimmed(Array.isArray(hdr) ? hdr[0] : hdr);
  if (fromHeader) return fromHeader;
  return defaultApp?.();
}

export async function resolveApp(
  req: FastifyRequest,
  defaultApp?: () => string | undefined,
  explicit?: string,
): Promise<ResolvedApp | null> {
  const name = resolveAppName(req, defaultApp, explicit);
  if (!name) return null;
  const a = await store.findAppByName(name);
  if (!a || a.type !== 'Application') return null;
  return { id: a.id, name, repoPath: (a as { repo_path?: string }).repo_path ?? '/app' };
}
