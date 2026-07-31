import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built to console/dist and served by the Fastify process in src/console/server.ts — one container,
// one port, no separate static host. The API is same-origin, so there is no CORS surface at all.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:3000', '/healthz': 'http://localhost:3000' } },
});
