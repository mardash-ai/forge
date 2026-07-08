import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THEME,
  DEFAULT_LIGHT,
  DEFAULT_DARK,
  normalizeTheme,
  renderTokenCss,
  renderThemeCss,
  sanitizeColor,
  sanitizeFont,
  sanitizeSize,
  sanitizeUrl,
  sanitizeCustomCss,
  themeMetaHead,
  themeCustomStyleTag,
} from '../src/shared/theme';

// C16 — the pure theme model: schema normalization, the `--forge-*` token set, the
// value sanitizers, and the custom-CSS sandbox. No I/O here.

describe('C16 theme — value sanitizers', () => {
  it('accepts safe colors and rejects CSS-breakout attempts', () => {
    expect(sanitizeColor('#4f46e5', '#000')).toBe('#4f46e5');
    expect(sanitizeColor('#abc', '#000')).toBe('#abc');
    expect(sanitizeColor('rgb(10, 20, 30)', '#000')).toBe('rgb(10, 20, 30)');
    expect(sanitizeColor('rebeccapurple', '#000')).toBe('rebeccapurple');
    // breakout / injection attempts fall back
    expect(sanitizeColor('red; } body { display:none } /*', '#000')).toBe('#000');
    expect(sanitizeColor('#fff</style><script>', '#000')).toBe('#000');
    expect(sanitizeColor('url(javascript:alert(1))', '#000')).toBe('#000');
    expect(sanitizeColor(42, '#000')).toBe('#000');
  });

  it('sanitizes font, size, and asset URLs', () => {
    expect(sanitizeFont('Inter, system-ui, sans-serif', 'x')).toContain('Inter');
    expect(sanitizeFont('Inter;}<script>', 'fallback')).toBe('fallback');
    expect(sanitizeSize('12px', 'x')).toBe('12px');
    expect(sanitizeSize('0.5rem', 'x')).toBe('0.5rem');
    expect(sanitizeSize('12px; color:red', 'fallback')).toBe('fallback');
    // urls: relative path, https, data:image OK; javascript: and quotes rejected
    expect(sanitizeUrl('/logo.svg')).toBe('/logo.svg');
    expect(sanitizeUrl('https://cdn.example.com/l.png')).toBe('https://cdn.example.com/l.png');
    expect(sanitizeUrl('data:image/svg+xml;base64,AAAA')).toBe('data:image/svg+xml;base64,AAAA');
    expect(sanitizeUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeUrl('/logo.svg" onerror="alert(1)')).toBeUndefined();
    expect(sanitizeUrl('//evil.com/x')).toBeUndefined();
  });

  it('sandboxes custom CSS — no markup, imports, or script vectors survive', () => {
    const dirty = `body{color:red} </style><script>alert(1)</script>
      @import url('https://evil.com/x.css');
      .x{behavior:url(#default#time2)}
      .y{background:url(javascript:alert(1))}
      .z{width:expression(alert(1))}`;
    const clean = sanitizeCustomCss(dirty);
    expect(clean).not.toContain('<');
    expect(clean).not.toContain('>');
    expect(clean).not.toMatch(/@import/i);
    expect(clean).not.toMatch(/expression\s*\(/i);
    expect(clean).not.toMatch(/behavior\s*:/i);
    expect(clean).not.toMatch(/javascript:/i);
    // legitimate declarations survive
    expect(clean).toContain('color:red');
  });

  it('allows https/data url() in custom CSS but neutralizes others', () => {
    const css = sanitizeCustomCss(`.a{background:url(https://cdn/x.png)} .b{background:url(http://x/y.png)}`);
    expect(css).toContain('url(https://cdn/x.png)');
    expect(css).toContain('.b{background:none}');
  });
});

describe('C16 theme — normalization', () => {
  it('an empty / missing theme is the neutral default', () => {
    expect(normalizeTheme(undefined)).toEqual(DEFAULT_THEME);
    expect(normalizeTheme({})).toEqual(DEFAULT_THEME);
    expect(normalizeTheme(null)).toEqual(DEFAULT_THEME);
  });

  it('overlays declared light colors and keeps neutral dark surfaces', () => {
    const t = normalizeTheme({ name: 'Acme', colors: { primary: '#ff0066', background: '#fafafa' } });
    expect(t.name).toBe('Acme');
    expect(t.light.primary).toBe('#ff0066');
    expect(t.light.background).toBe('#fafafa');
    // brand color carries into dark; a custom LIGHT background does NOT (neutral dark kept)
    expect(t.dark.primary).toBe('#ff0066');
    expect(t.dark.background).toBe(DEFAULT_DARK.background);
  });

  it('honors an explicit dark override block', () => {
    const t = normalizeTheme({ colors: { primary: '#111' }, dark: { primary: '#eee', background: '#000' } });
    expect(t.dark.primary).toBe('#eee');
    expect(t.dark.background).toBe('#000');
  });

  it('auto-derives a readable primary contrast when none is given', () => {
    const light = normalizeTheme({ colors: { primary: '#ffffff' } });
    expect(light.light.primaryContrast).toBe('#111827'); // dark text on a light primary
    const dark = normalizeTheme({ colors: { primary: '#000000' } });
    expect(dark.light.primaryContrast).toBe('#ffffff'); // white text on a dark primary
  });

  it('drops a malicious logo/favicon but keeps the rest', () => {
    const t = normalizeTheme({ name: 'X', logo: 'javascript:alert(1)', favicon: '/f.ico', colors: { primary: '#123456' } });
    expect(t.logo).toBeUndefined();
    expect(t.favicon).toBe('/f.ico');
    expect(t.light.primary).toBe('#123456');
  });

  it('rejects invalid mode and falls back to auto', () => {
    expect(normalizeTheme({ mode: 'weird' }).mode).toBe('auto');
    expect(normalizeTheme({ mode: 'dark' }).mode).toBe('dark');
  });
});

describe('C16 theme — token rendering', () => {
  it('emits every --forge-* token in :root', () => {
    const css = renderTokenCss(DEFAULT_THEME);
    for (const token of [
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
    ]) {
      expect(css).toContain(token);
    }
  });

  it('auto mode emits a light :root + a dark @media override', () => {
    const css = renderTokenCss({ ...DEFAULT_THEME, mode: 'auto' });
    expect(css).toContain('color-scheme:light dark');
    expect(css).toContain('@media(prefers-color-scheme:dark)');
    expect(css).toContain(DEFAULT_LIGHT.primary);
    expect(css).toContain(DEFAULT_DARK.background);
  });

  it('light / dark modes pin a single palette (no media query)', () => {
    const light = renderTokenCss({ ...DEFAULT_THEME, mode: 'light' });
    expect(light).toContain('color-scheme:light;');
    expect(light).not.toContain('@media');
    const dark = renderTokenCss({ ...DEFAULT_THEME, mode: 'dark' });
    expect(dark).toContain('color-scheme:dark;');
    expect(dark).toContain(DEFAULT_DARK.primary);
  });

  it('renderThemeCss appends sandboxed custom CSS', () => {
    const t = normalizeTheme({ custom_css: '.card{border-radius:0}' });
    expect(renderThemeCss(t)).toContain('.card{border-radius:0}');
  });

  it('page-head helpers inline the tokens and escape the title', () => {
    const head = themeMetaHead(normalizeTheme({ favicon: '/f.ico' }), 'Sign in · A&B');
    expect(head).toContain('<style id="forge-theme">');
    expect(head).toContain('--forge-color-primary');
    expect(head).toContain('<title>Sign in · A&amp;B</title>');
    expect(head).toContain('<link rel="icon" href="/f.ico">');
    // custom style tag only when custom css is present
    expect(themeCustomStyleTag(DEFAULT_THEME)).toBe('');
    expect(themeCustomStyleTag(normalizeTheme({ custom_css: '.x{color:red}' }))).toContain('<style id="forge-custom">');
  });
});
