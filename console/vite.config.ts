import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built to console/dist and served by the Fastify process in src/console/server.ts — one container,
// one port, no separate static host. The API is same-origin, so there is no CORS surface at all.
export default defineConfig({
  plugins: [react()],

  // ⛔ TypeScript sources MUST outrank a stale `.js` sibling.
  //
  // Vite's default order puts `.js` before `.tsx`, so a leftover `App.js` — the kind any stray
  // `tsc <file>` drops next to its source, since a direct file compile ignores `noEmit` in the
  // tsconfig — silently becomes the module that gets bundled. The build succeeds, the bundle is
  // stale, and the only symptom is a UI that ignores your edits. This happened; it cost a
  // debugging round on a build that reported success.
  resolve: { extensions: ['.tsx', '.ts', '.jsx', '.mjs', '.js', '.json'] },

  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:3000', '/healthz': 'http://localhost:3000' } },
});
