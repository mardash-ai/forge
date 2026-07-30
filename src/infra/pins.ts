/**
 * Module-pin inspection.
 *
 * Consumers pin forge modules by git ref (`…//terraform/modules/x?ref=vX.Y.Z`) — adoption is a
 * reviewed bump, never automatic (a production stack must not mutate because another repo tagged
 * a release). The hazard that creates: pins drift APART. A new module block gets written at the
 * current release while older blocks keep the ref they were born with, and every existing guard
 * stays green because the stack still matches its own declaration.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { RepoStack } from './config';

export interface ModulePin {
  module: string;
  ref: string;
  file: string;
}

const PIN = /source\s*=\s*"[^"]*\/\/terraform\/modules\/([a-z0-9-]+)\?ref=([^"]+)"/g;

export async function modulePins(stack: RepoStack): Promise<ModulePin[]> {
  const out: ModulePin[] = [];
  let entries;
  try {
    entries = await readdir(stack.tfDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.tf')) continue;
    const p = join(stack.tfDir, e.name);
    const text = await readFile(p, 'utf8');
    for (const m of text.matchAll(PIN)) {
      out.push({ module: m[1]!, ref: m[2]!, file: relative(stack.root, p) });
    }
  }
  return out;
}
