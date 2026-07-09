import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';

// P21 GUARD (static half) — every external package the RUNTIME code (`src/**`) imports must be a real
// `dependencies` entry, not merely a `devDependency` or a transitive dependency that happens to be in
// the dev `node_modules`.
//
// Why this exists: C20's blob routes `import '@fastify/multipart'`. Had that landed in `devDependencies`
// (or been left undeclared), it would still resolve locally (dev installs everything) AND from source
// (`tsx src/api/server.ts` over the full tree) — but the PRODUCTION data-plane image installs with
// `npm ci --omit=dev`, so the module would be ABSENT there and the server would throw at import before it
// could `.listen()` → "container Running but API never reachable." A source-only test never sees that.
// This test asserts the invariant at the source level so the whole class is caught in plain `npm test`,
// long before an image is built. The IMAGE smoke (tests/smoke/image-serves.sh + the image-smoke CI job)
// is the runtime half — together they close the gap.
//
// Everything under `src/` ships in the slim `--omit=dev` data-plane image, so every bare import there
// must resolve from `dependencies`. (`tests/**` may use devDependencies — it never ships.)

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const prodDeps = new Set(Object.keys(pkg.dependencies ?? {}));
const devDeps = new Set(Object.keys(pkg.devDependencies ?? {}));
// Node builtins, with and without the `node:` prefix, are never package deps.
const builtins = new Set<string>([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// The package NAME a module specifier belongs to: `@scope/pkg/sub` -> `@scope/pkg`; `pkg/sub` -> `pkg`.
function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
}

// Extract EVERY module specifier that this file actually imports — static `import`/`export … from`,
// dynamic `import()`, and `require()`. Uses the TS parser, so specifiers that appear only inside string
// literals (e.g. the scaffold plugin's Next.js code templates) are NOT collected — they aren't imports.
function importedSpecifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      specs.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const isDynImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const arg = node.arguments[0];
      if ((isDynImport || isRequire) && arg && ts.isStringLiteral(arg)) {
        specs.push(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

describe('P21 — runtime dependency hygiene (src/** imports resolve from prod `dependencies`)', () => {
  const files = walk(SRC);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every external package imported by src/** is declared in `dependencies` (survives --omit=dev)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of importedSpecifiers(file)) {
        if (spec.startsWith('.') || spec.startsWith('/')) continue; // relative / absolute
        if (builtins.has(spec)) continue; // node builtin (with or without node: prefix)
        const name = packageName(spec);
        if (builtins.has(name)) continue;
        if (prodDeps.has(name)) continue; // the invariant we want
        const where = path.relative(ROOT, file);
        offenders.push(
          devDeps.has(name)
            ? `${where}: imports "${spec}" which is a devDependency ("${name}") — it will be ABSENT in the --omit=dev image`
            : `${where}: imports "${spec}" ("${name}") which is not in package.json dependencies`,
        );
      }
    }
    expect(offenders, `runtime deps missing from "dependencies":\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});
