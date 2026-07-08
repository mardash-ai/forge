// C16 — App theming for platform-served UI.
//
// A SINGLE, declarative contract by which a consuming app brands EVERY piece of
// platform-served UI it leverages (the C10 hosted auth pages, the C15 status page,
// and any future UI capability). One token set, one schema — theme once, theme all.
//
// This module is PURE (string in / string out, no I/O): it owns the theme SCHEMA,
// the neutral DEFAULT look, the normalization/sanitization of an app-declared theme
// into a safe `Theme`, the CSS custom-property (`--forge-*`) token set every page
// renders from, and the sandboxed custom-CSS escape hatch. The file I/O that reads an
// app's `forge.theme.json` lives in `src/api/theme-context.ts` (it needs the store).
//
// Security: an app's theme file is app-authored but its values flow into an inline
// `<style>` and into `href`/`src` attributes, so every value is sanitized here —
// colors/font/radius against conservative allowlists (no `;{}<>` breakout), asset
// URLs against a scheme allowlist (no `javascript:`), and the custom CSS through a
// sandbox that makes an HTML/script breakout or an external fetch impossible.

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type ThemeMode = 'auto' | 'light' | 'dark';

// The full color token set — the SAME fields power auth + status + any future UI.
export interface ThemePalette {
  primary: string; // brand/action color: buttons, links, accents
  primaryContrast: string; // text/icon color that sits ON primary
  accent: string; // secondary highlight
  background: string; // page background
  surface: string; // card / panel background
  text: string; // body text
  textMuted: string; // secondary text
  border: string; // hairlines / input borders
  success: string; // status: operational / ok
  warning: string; // status: degraded
  danger: string; // status: outage / error
}

export interface Theme {
  name?: string; // app display name (title + brand label)
  logo?: string; // logo asset (URL or app-served path)
  favicon?: string; // favicon href
  mode: ThemeMode; // light / dark / auto (default auto)
  font: string; // font-family stack
  radius: string; // base corner radius (e.g. "8px")
  light: ThemePalette; // resolved light palette
  dark: ThemePalette; // resolved dark palette
  customCss: string; // sanitized custom-CSS escape hatch ('' when none)
}

// The raw shape an app declares in `forge.theme.json` (all fields optional).
export interface RawTheme {
  name?: unknown;
  logo?: unknown;
  favicon?: unknown;
  mode?: unknown;
  font?: unknown;
  radius?: unknown;
  colors?: Record<string, unknown>;
  dark?: Record<string, unknown>;
  custom_css?: unknown;
  custom_css_path?: unknown;
}

// ---------------------------------------------------------------------------
// Neutral default — what an app that declares NO theme gets: clean + professional.
// ---------------------------------------------------------------------------

export const DEFAULT_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const DEFAULT_RADIUS = '8px';

export const DEFAULT_LIGHT: ThemePalette = {
  primary: '#4f46e5',
  primaryContrast: '#ffffff',
  accent: '#0ea5e9',
  background: '#f6f7f9',
  surface: '#ffffff',
  text: '#111827',
  textMuted: '#6b7280',
  border: '#d1d5db',
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
};

export const DEFAULT_DARK: ThemePalette = {
  primary: '#818cf8',
  primaryContrast: '#111827',
  accent: '#38bdf8',
  background: '#0b0f19',
  surface: '#111827',
  text: '#e5e7eb',
  textMuted: '#9ca3af',
  border: '#374151',
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#f87171',
};

export const DEFAULT_THEME: Theme = {
  mode: 'auto',
  font: DEFAULT_FONT,
  radius: DEFAULT_RADIUS,
  light: DEFAULT_LIGHT,
  dark: DEFAULT_DARK,
  customCss: '',
};

// The theme token names (the public contract a page/consumer renders from).
export const THEME_TOKENS = [
  '--forge-font',
  '--forge-radius',
  '--forge-radius-lg',
  '--forge-color-primary',
  '--forge-color-primary-contrast',
  '--forge-color-accent',
  '--forge-color-bg',
  '--forge-color-surface',
  '--forge-color-text',
  '--forge-color-text-muted',
  '--forge-color-border',
  '--forge-color-success',
  '--forge-color-warning',
  '--forge-color-danger',
] as const;

// "brand-ish" palette fields carry a custom LIGHT value into dark when the app
// didn't give an explicit dark value; "surface-ish" fields keep the neutral dark
// default instead (a custom light background would be wrong in dark mode).
const BRAND_FIELDS: (keyof ThemePalette)[] = [
  'primary',
  'primaryContrast',
  'accent',
  'success',
  'warning',
  'danger',
];
const PALETTE_FIELDS: (keyof ThemePalette)[] = [
  'primary',
  'primaryContrast',
  'accent',
  'background',
  'surface',
  'text',
  'textMuted',
  'border',
  'success',
  'warning',
  'danger',
];

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Value sanitizers — every declared value passes one before it reaches the page.
// ---------------------------------------------------------------------------

// Accepts #hex (3/4/6/8), rg[b|a]()/hsl[a]() with only numeric/%, and a bare CSS
// named color. Anything with `;{}<>` or other CSS-breaking content → the fallback.
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const FUNC_COLOR_RE = /^(rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/deg]+\)$/i;
const NAMED_COLOR_RE = /^[a-zA-Z]{3,20}$/;

export function sanitizeColor(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  if (HEX_RE.test(s) || FUNC_COLOR_RE.test(s) || NAMED_COLOR_RE.test(s)) return s;
  return fallback;
}

// Font-family stack: letters/digits/space/comma/quote/hyphen/dot only (no CSS
// control chars, no url()/expression()). Capped in length.
const FONT_RE = /^[a-zA-Z0-9 ,"'\-.]{1,200}$/;
export function sanitizeFont(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  return FONT_RE.test(s) ? s : fallback;
}

// A length token: a positive number with an optional css unit.
const SIZE_RE = /^[0-9]+(\.[0-9]+)?(px|rem|em|%)?$/;
export function sanitizeSize(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const s = v.trim();
  return SIZE_RE.test(s) ? s : fallback;
}

// Asset URL/path for logo/favicon (goes into an href/src). Allow only a same-origin
// path, a data:image URI, or an http(s) URL — never `javascript:`; no whitespace,
// quotes, or angle brackets (attribute breakout). Undefined when it doesn't qualify.
export function sanitizeUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s || s.length > 2000) return undefined;
  if (/[\s"'<>`]/.test(s)) return undefined;
  if (/^(\/(?![/\\])|\.\/|data:image\/|https?:\/\/)/.test(s)) return s;
  return undefined;
}

export function sanitizeName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s.slice(0, 120) : undefined;
}

function sanitizeMode(v: unknown): ThemeMode {
  return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto';
}

// The custom-CSS sandbox (the escape hatch). Guarantees the injected text can only
// be CSS — never an HTML/script breakout, never an external fetch:
//   - strip anything that could close the <style> or inject markup: `<` and `>`,
//   - strip `@import` (would pull in an external sheet),
//   - strip `javascript:`, `expression(`, and IE `behavior:`/`-moz-binding` vectors,
//   - drop `url(...)` whose target isn't an https or data: asset.
// Capped in size. This is CSS-only by construction; it cannot change page structure
// enough to inject script or break out of the sheet.
const MAX_CUSTOM_CSS = 20_000;
export function sanitizeCustomCss(v: unknown): string {
  if (typeof v !== 'string') return '';
  let css = v.slice(0, MAX_CUSTOM_CSS);
  css = css.replace(/[<>]/g, ''); // no markup / </style> breakout
  css = css.replace(/@import[^;]*;?/gi, ''); // no external sheets
  css = css.replace(/expression\s*\(/gi, ''); // legacy IE script vector
  css = css.replace(/(behavior|-moz-binding)\s*:[^;]*;?/gi, ''); // IE/Mozilla binding
  css = css.replace(/javascript:/gi, ''); // no javascript: targets
  // url(...) may only reference an https or data: asset (no javascript:, no http:).
  css = css.replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (m, _q, target: string) => {
    const t = String(target).trim();
    return /^(https:\/\/|data:)/i.test(t) ? m : 'none';
  });
  return css.trim();
}

// ---------------------------------------------------------------------------
// Normalize a raw declared theme into a safe, fully-resolved Theme.
// ---------------------------------------------------------------------------

export function normalizeTheme(raw: RawTheme | null | undefined): Theme {
  if (!raw || typeof raw !== 'object') return DEFAULT_THEME;

  const colors = (raw.colors && typeof raw.colors === 'object' ? raw.colors : {}) as Record<string, unknown>;
  const darkOverrides = (raw.dark && typeof raw.dark === 'object' ? raw.dark : {}) as Record<string, unknown>;

  // Field name in the declared JSON (camelCase) for a palette key.
  const jsonKey: Record<keyof ThemePalette, string> = {
    primary: 'primary',
    primaryContrast: 'primaryContrast',
    accent: 'accent',
    background: 'background',
    surface: 'surface',
    text: 'text',
    textMuted: 'textMuted',
    border: 'border',
    success: 'success',
    warning: 'warning',
    danger: 'danger',
  };

  // Light: neutral default overlaid with the app's declared `colors`.
  const light = { ...DEFAULT_LIGHT };
  for (const f of PALETTE_FIELDS) {
    light[f] = sanitizeColor(colors[jsonKey[f]], DEFAULT_LIGHT[f]);
  }
  // If a primary is set but no explicit contrast, pick black/white by luminance.
  if (colors.primary !== undefined && colors.primaryContrast === undefined) {
    light.primaryContrast = readableOn(light.primary, DEFAULT_LIGHT.primaryContrast);
  }

  // Dark: neutral dark default, then carry any customized BRAND colors from light
  // (unless the app gave explicit dark values), then overlay explicit `dark`.
  const dark = { ...DEFAULT_DARK };
  for (const f of BRAND_FIELDS) {
    if (colors[jsonKey[f]] !== undefined && darkOverrides[jsonKey[f]] === undefined) {
      dark[f] = light[f];
    }
  }
  for (const f of PALETTE_FIELDS) {
    if (darkOverrides[jsonKey[f]] !== undefined) {
      dark[f] = sanitizeColor(darkOverrides[jsonKey[f]], dark[f]);
    }
  }

  const theme: Theme = {
    mode: sanitizeMode(raw.mode),
    font: sanitizeFont(raw.font, DEFAULT_FONT),
    radius: sanitizeSize(raw.radius, DEFAULT_RADIUS),
    light,
    dark,
    customCss: sanitizeCustomCss(raw.custom_css),
  };
  const name = sanitizeName(raw.name);
  if (name) theme.name = name;
  const logo = sanitizeUrl(raw.logo);
  if (logo) theme.logo = logo;
  const favicon = sanitizeUrl(raw.favicon);
  if (favicon) theme.favicon = favicon;
  return theme;
}

// Relative luminance → choose a readable contrast color. Falls back when unparseable.
function readableOn(color: string, fallback: string): string {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color);
  if (!m) return fallback;
  let hex = m[1]!;
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? '#111827' : '#ffffff';
}

// ---------------------------------------------------------------------------
// Render — the CSS custom-property token set + page-head helpers.
// ---------------------------------------------------------------------------

function paletteVars(p: ThemePalette): string {
  return [
    `--forge-color-primary:${p.primary}`,
    `--forge-color-primary-contrast:${p.primaryContrast}`,
    `--forge-color-accent:${p.accent}`,
    `--forge-color-bg:${p.background}`,
    `--forge-color-surface:${p.surface}`,
    `--forge-color-text:${p.text}`,
    `--forge-color-text-muted:${p.textMuted}`,
    `--forge-color-border:${p.border}`,
    `--forge-color-success:${p.success}`,
    `--forge-color-warning:${p.warning}`,
    `--forge-color-danger:${p.danger}`,
  ].join(';');
}

// The `:root{…}` token declarations — the canonical artifact every platform-served
// page renders from. `mode:auto` emits a light `:root` plus a dark `@media` override;
// `light`/`dark` pin a single palette. Served verbatim at `/theme.css` and inlined
// into each page so there is no flash-of-unthemed-content and no extra round trip.
export function renderTokenCss(theme: Theme): string {
  const shape = `--forge-font:${theme.font};--forge-radius:${theme.radius};--forge-radius-lg:calc(${theme.radius} * 1.75)`;
  if (theme.mode === 'light') {
    return `:root{color-scheme:light;${shape};${paletteVars(theme.light)}}`;
  }
  if (theme.mode === 'dark') {
    return `:root{color-scheme:dark;${shape};${paletteVars(theme.dark)}}`;
  }
  return (
    `:root{color-scheme:light dark;${shape};${paletteVars(theme.light)}}` +
    `@media(prefers-color-scheme:dark){:root{${paletteVars(theme.dark)}}}`
  );
}

// The full `/theme.css` body: the tokens plus the app's sandboxed custom CSS (so a
// consumer that only links this stylesheet still gets the overrides).
export function renderThemeCss(theme: Theme): string {
  return theme.customCss ? `${renderTokenCss(theme)}\n${theme.customCss}\n` : `${renderTokenCss(theme)}\n`;
}

// Head fragment: charset/viewport, the (composed) title, an optional favicon link,
// and the inlined token `<style>`. Callers add their own component `<style>` after
// this, then `themeCustomStyleTag()` LAST so the escape hatch wins the cascade.
export function themeMetaHead(theme: Theme, title: string): string {
  const favicon = theme.favicon ? `<link rel="icon" href="${escapeHtml(theme.favicon)}">` : '';
  return (
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>${favicon}` +
    `<style id="forge-theme">${renderTokenCss(theme)}</style>`
  );
}

// The custom-CSS escape hatch as a trailing <style>. Sanitized at normalize time, so
// this can never carry markup or a </style> breakout. '' when the app supplied none.
export function themeCustomStyleTag(theme: Theme): string {
  return theme.customCss ? `<style id="forge-custom">${theme.customCss}</style>` : '';
}

// Compose a page title as "<base> · <app name>" when the theme names the app.
export function themeTitle(theme: Theme, base: string): string {
  return theme.name ? `${base} · ${theme.name}` : base;
}

// A brand logo <img> (when the theme supplies one), else ''. Used in page headers.
export function themeLogoImg(theme: Theme, className: string): string {
  if (!theme.logo) return '';
  const alt = escapeHtml(theme.name ?? '');
  return `<img class="${className}" src="${escapeHtml(theme.logo)}" alt="${alt}">`;
}
