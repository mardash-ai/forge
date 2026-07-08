import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { store } from '../storage/store';
import {
  DEFAULT_THEME,
  normalizeTheme,
  sanitizeCustomCss,
  type RawTheme,
  type Theme,
} from '../shared/theme';

// The C16 theme file an app declares at its repo root. It is the SINGLE declaration
// that brands every platform-served UI (auth + status + future UI). `forge
// productionize` scaffolds a starter and mounts it into the data-plane sidecar
// (FORGE_THEME_FILE), so the same file drives dev and prod.
export const THEME_FILE = 'forge.theme.json';

// Locate an app's theme file: the explicit prod-sidecar mount (FORGE_THEME_FILE) wins;
// otherwise it is `<repo_path>/forge.theme.json`. Returns null when neither resolves.
async function themeFilePath(appId: string): Promise<string | null> {
  const fromEnv = process.env.FORGE_THEME_FILE;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const app = (await store.getResource('Application', appId)) as { repo_path?: string } | null;
  const repo = app?.repo_path;
  if (!repo) return null;
  return path.join(repo, THEME_FILE);
}

// Resolve the fully-normalized, sanitized Theme for an app. Never throws: a missing
// or malformed theme file → the neutral DEFAULT_THEME (a clean, professional look).
// A `custom_css_path` (relative to the theme file) is read server-side and folded
// into the sandboxed custom CSS alongside any inline `custom_css`.
export async function resolveThemeForApp(appId: string): Promise<Theme> {
  const file = await themeFilePath(appId);
  if (!file) return DEFAULT_THEME;
  let raw: RawTheme;
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as RawTheme;
  } catch {
    return DEFAULT_THEME; // no theme file, or invalid JSON → neutral default
  }
  const theme = normalizeTheme(raw);

  // Optional custom CSS supplied as a file (relative to the theme file's directory).
  // Read + sandbox it and merge with any inline custom_css. Inline is the prod-portable
  // form (it travels inside the single mounted theme JSON); a path is a dev convenience.
  const cssPath = typeof raw.custom_css_path === 'string' ? raw.custom_css_path.trim() : '';
  if (cssPath) {
    const resolved = path.resolve(path.dirname(file), cssPath);
    // Contain the read to the theme file's directory subtree (no `../` escape).
    if (resolved.startsWith(path.dirname(file) + path.sep)) {
      try {
        const fileCss = sanitizeCustomCss(await readFile(resolved, 'utf8'));
        theme.customCss = [theme.customCss, fileCss].filter(Boolean).join('\n');
      } catch {
        /* unreadable custom-css file → ignore, keep inline */
      }
    }
  }
  return theme;
}
