/**
 * §3.7 — content-addressing the declared configuration.
 *
 * "A zero exit code is not evidence." `forge infra apply` proves it applied by (1) hashing the
 * declared config, (2) publishing that hash next to the state after a converged apply, and
 * (3) letting `status` / drift detection compare the live hash against the declared one. The hash is
 * over the FILES THAT DECLARE THE STACK — *.tf, *.tfvars(.json), and forge.infra.json — sorted, so
 * it is stable across machines and file-system orderings.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const DECLARES_STACK = /\.(tf|tfvars|tfvars\.json)$/;

/** Files that are generated per-run and must NOT affect the declared-config hash. */
const GENERATED = new Set(['contract.auto.tfvars.json']);

export async function listDeclarationFiles(repoRoot: string, tfDir: string): Promise<string[]> {
  const files: string[] = [join(repoRoot, 'forge.infra.json')];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // no infra/ dir yet — hash covers just the declaration
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === '.terraform') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (DECLARES_STACK.test(e.name) && !GENERATED.has(e.name)) files.push(p);
    }
  };
  await walk(tfDir);
  return files.sort();
}

/** sha256 over (relative-path || byte-content) of every declaration file, in sorted order. */
export async function declaredConfigHash(repoRoot: string, tfDir: string): Promise<string> {
  const h = createHash('sha256');
  for (const f of await listDeclarationFiles(repoRoot, tfDir)) {
    h.update(relative(repoRoot, f));
    h.update('\0');
    h.update(await readFile(f));
    h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}
