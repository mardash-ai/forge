import { describe, it, expect } from 'vitest';
import { scaffold } from '../src/plugins/scaffold-nextjs-npm/index';

describe('scaffold-nextjs-npm', () => {
  it('produces a Dockerized Next.js app shape', () => {
    const { files, scripts } = scaffold({ name: 'demo-app', port: 3000 });
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'package.json',
        'tsconfig.json',
        'app/layout.tsx',
        'app/page.tsx',
        'app/api/health/route.ts',
        'lib/health.ts',
        'tests/health.test.ts',
        'Dockerfile',
        '.dockerignore',
      ]),
    );
    expect(scripts.build).toBe('next build');
    expect(files['package.json']).toContain('"next"');
  });
});
