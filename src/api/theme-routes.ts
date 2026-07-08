import type { FastifyInstance } from 'fastify';
import { resolveApp } from './app-resolver';
import { resolveThemeForApp } from './theme-context';
import { DEFAULT_THEME, renderThemeCss } from '../shared/theme';

// C16 — the app theme served as a linkable stylesheet.
//
//   GET /theme.css   -> text/css: the `:root{ --forge-* }` token set (light + a dark
//                       @media override) plus the app's sandboxed custom CSS.
//
// This is the canonical, cacheable artifact any platform-served page (or a future UI
// capability) can `<link>`; the auth + status pages ALSO inline the same tokens so
// they render with no flash-of-unthemed-content. Public (no auth) — a theme is not a
// secret. Registered on BOTH planes like /auth and /status; `defaultApp` scopes the
// single-app data-plane sidecar. An un-themed / unknown app gets the neutral default.
export function registerThemeRoutes(
  app: FastifyInstance,
  opts: { defaultApp?: () => string | undefined } = {},
): void {
  app.get('/theme.css', async (req, reply) => {
    const resolved = await resolveApp(req, opts.defaultApp);
    const theme = resolved ? await resolveThemeForApp(resolved.id) : DEFAULT_THEME;
    reply
      .type('text/css; charset=utf-8')
      .header('cache-control', 'public, max-age=60')
      .send(renderThemeCss(theme));
  });
}
