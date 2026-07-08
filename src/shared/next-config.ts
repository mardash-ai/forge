// The canonical Next.js config Forge generates for every app. ONE source of truth,
// used by BOTH InitializeApp's scaffold (the dev shape) and Productionize's fallback
// (`defaultNextConfig`, when an app has no config of its own) — so a scaffolded app
// and a from-scratch productionized app carry the identical, correct config.
//
// Its load-bearing part is the `/auth/*` rewrite. C10 hosted auth is served by the
// Forge data-plane sidecar; the consuming app ships no auth UI and instead proxies
// `/auth/*` there SAME-ORIGIN (so the session cookie is set on the app's own domain).
//
// The rewrite MUST survive `next build`. Next evaluates `rewrites()` (like
// `headers()`/`redirects()`) at BUILD time, so a config that GATES the rule on a
// runtime-only env — e.g. `const url = process.env.FORGE_DATA_PLANE_URL; if (!url)
// return []` — sees that var absent in CI's build step, returns `[]`, and bakes the
// rewrite OUT of the image → `/auth/login` 404s in prod. So the destination DEFAULTS
// to the in-cluster data-plane DNS and the rule is ALWAYS emitted; a runtime env
// (FORGE_DATA_PLANE_URL / FORGE_EVENTS_URL, e.g. under `next dev`) only OVERRIDES the
// destination — it never decides whether the rule exists.

export interface ForgeNextConfigOptions {
  // Emit `output: 'standalone'` — Productionize's slim multi-stage image builds from
  // Next's standalone output. The dev scaffold omits it (Productionize injects it).
  standalone?: boolean;
}

export function forgeNextConfig(opts: ForgeNextConfigOptions = {}): string {
  const outputLine = opts.standalone ? "  output: 'standalone',\n" : '';
  return `/** @type {import('next').NextConfig} */
const nextConfig = {
${outputLine}  reactStrictMode: true,
  // Proxy the C10 hosted-auth surface (/auth/*) to the Forge data-plane sidecar,
  // same-origin so the session cookie is set on this app's own domain. The
  // destination DEFAULTS to the in-cluster data-plane DNS so the rule is baked into
  // \`next build\` even when no runtime env is present (CI). A runtime override —
  // FORGE_DATA_PLANE_URL / FORGE_EVENTS_URL (e.g. \`next dev\` against a local
  // data-plane) — only changes the destination. Do NOT gate this on a build-absent
  // env: Next evaluates rewrites() at build time and would compile the rule out of
  // the image (→ /auth/* 404s in prod).
  async rewrites() {
    const dataPlane =
      process.env.FORGE_DATA_PLANE_URL || process.env.FORGE_EVENTS_URL || 'http://data-plane:3718';
    return [{ source: '/auth/:path*', destination: \`\${dataPlane}/auth/:path*\` }];
  },
};

export default nextConfig;
`;
}
