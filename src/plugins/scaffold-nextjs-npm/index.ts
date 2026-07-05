// Plugin: scaffold-nextjs-npm.
//
// The initial Implementation of the InitializeApp Capability for web/nextjs.
// Produces a standardized, Docker-ready Next.js (App Router) app that all other
// Capabilities understand. npm is used because it is universally available in
// Node images — the Capability stays `InitializeApp`, not `InitializeNextNpmApp`.

export const IMPLEMENTATION = 'scaffold-nextjs-npm';

export interface ScaffoldOptions {
  name: string;
  port: number;
}

export interface ScaffoldResult {
  files: Record<string, string>;
  scripts: Record<string, string>;
  port: number;
}

const NEXT_VERSION = '14.2.15';

export function scaffold(opts: ScaffoldOptions): ScaffoldResult {
  const { name, port } = opts;

  const scripts: Record<string, string> = {
    dev: `next dev -H 0.0.0.0 -p ${port}`,
    build: 'next build',
    start: `next start -H 0.0.0.0 -p ${port}`,
    lint: 'next lint',
    test: 'vitest run',
  };

  const files: Record<string, string> = {
    'package.json': JSON.stringify(
      {
        name,
        version: '0.1.0',
        private: true,
        scripts,
        dependencies: {
          next: NEXT_VERSION,
          react: '18.3.1',
          'react-dom': '18.3.1',
        },
        devDependencies: {
          '@types/node': '22.9.0',
          '@types/react': '18.3.12',
          '@types/react-dom': '18.3.1',
          eslint: '8.57.1',
          'eslint-config-next': NEXT_VERSION,
          typescript: '5.6.3',
          vitest: '2.1.5',
        },
      },
      null,
      2,
    ) + '\n',

    'tsconfig.json': JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['dom', 'dom.iterable', 'esnext'],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: 'preserve',
          incremental: true,
          plugins: [{ name: 'next' }],
          paths: { '@/*': ['./*'] },
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      },
      null,
      2,
    ) + '\n',

    'next.config.mjs': `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
`,

    '.eslintrc.json': JSON.stringify(
      { extends: 'next/core-web-vitals', ignorePatterns: ['tests/', 'vitest.config.ts'] },
      null,
      2,
    ) + '\n',

    'vitest.config.ts': `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
`,

    '.gitignore': `node_modules/
.next/
next-env.d.ts
*.log
.env
.env.local
`,

    '.dockerignore': `node_modules
.next
.git
npm-debug.log*
Dockerfile
.dockerignore
`,

    // App Router
    'app/layout.tsx': `import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '${name}',
  description: 'A Forge-initialized Next.js application.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,

    'app/page.tsx': `export default function HomePage() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem' }}>
      <h1>${name}</h1>
      <p>Initialized by Forge. Health endpoint: <code>/api/health</code></p>
    </main>
  );
}
`,

    'app/api/health/route.ts': `import { NextResponse } from 'next/server';
import { healthPayload } from '../../../lib/health';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(healthPayload('${name}'));
}
`,

    // A tiny pure module so there is meaningful, deterministic test coverage.
    'lib/health.ts': `export interface HealthPayload {
  status: 'ok';
  service: string;
  time: string;
}

export function healthPayload(service: string, now: Date = new Date()): HealthPayload {
  return { status: 'ok', service, time: now.toISOString() };
}
`,

    'tests/health.test.ts': `import { describe, it, expect } from 'vitest';
import { healthPayload } from '../lib/health';

describe('healthPayload', () => {
  it('reports ok for the service', () => {
    const p = healthPayload('${name}', new Date('2026-01-01T00:00:00.000Z'));
    expect(p.status).toBe('ok');
    expect(p.service).toBe('${name}');
    expect(p.time).toBe('2026-01-01T00:00:00.000Z');
  });
});
`,

    // Production image (multi-stage). Not used by the v1 Build Capability
    // (which runs `next build` via the runtime), but shipped so the app is
    // deployable and self-describing.
    Dockerfile: `# Production image for ${name}.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE ${port}
CMD ["npm", "run", "start"]
`,

    'README.md': `# ${name}

A Dockerized Next.js web application, initialized by **Forge**.

Everything runs in Docker via Forge Capabilities — do not run npm on the host.

\`\`\`bash
forge provision --app ${name}
forge install   --app ${name}
forge build     --app ${name}
forge test      --app ${name}
forge lint      --app ${name}
forge dev       --app ${name}     # http://localhost:${port}
forge inspect app --app ${name}
\`\`\`
`,
  };

  return { files, scripts, port };
}
