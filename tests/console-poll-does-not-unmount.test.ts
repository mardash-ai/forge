/**
 * ⛔ A BACKGROUND POLL MUST NOT UNMOUNT THE PAGE UNDER THE OPERATOR.
 *
 * Mark, 2026-08-14, watching a full catalogue run:
 *
 *   "It appears the entire list and detail page is refreshing for each poll. If I've scrolled down
 *    the page (especially the detail page) the page re-renders at the top after every poll, making
 *    it impossible to read detailed content lower on the page."
 *
 * MECHANISM (traced, and neither of the two hypotheses I first wrote down):
 *
 *   `useApi` set `loading: true` on EVERY reload, not just the first. The E2E screen gates whole
 *   subtrees on that flag — `runsState === 'connected'` for the run table, `showRunDetail` for the
 *   metric tiles, filter bar, chart, workflow table and integrity strip. So during each in-flight
 *   poll every gated block returned false AT ONCE and the page collapsed to its header. `<main>`
 *   sets no `overflow`, so the document itself is the scroller: when content drops below viewport
 *   height the browser clamps `scrollTop` to 0, and remounting a moment later does not restore it.
 *
 * It was NOT data identity (useApi deliberately keeps the old payload) and NOT the `replaceState`
 * URL sync (its deps are click-driven primitives no poll can change, and `replaceState` does not
 * move scroll in any browser).
 *
 * THE FIX: `loading` now means "there is nothing to show yet"; `refreshing` means "a request is in
 * flight". Gates read `loading`, so a poll over existing data changes nothing structural.
 *
 * Deliberately NOT done: flipping `loading` globally to `data === null`. Other screens (Explore,
 * Runtime) call `useApi` with user-driven deps and rely on `loading` to indicate a parameter change
 * is fetching; that would have shown them stale data with no indicator. Splitting the flag keeps
 * this fix inside the screen that needed it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API = readFileSync(join(__dirname, '..', 'console', 'src', 'lib', 'api.ts'), 'utf8');

describe('useApi separates a cold load from a refresh', () => {
  it('⛔ does not raise `loading` unconditionally on every fetch', () => {
    // The single line that emptied the page every 5 seconds.
    expect(API).not.toMatch(/const id = \+\+latest\.current;\s*setLoading\(true\);/);
  });

  it('raises `loading` only when nothing has arrived yet', () => {
    expect(API).toMatch(/if \(!hasData\.current\) setLoading\(true\);/);
  });

  it('exposes `refreshing` for the in-flight case', () => {
    // So a caller that genuinely wants a background-activity hint can still have one, without
    // gating structure on it.
    expect(API).toMatch(/refreshing: boolean;/);
    expect(API).toMatch(/setRefreshing\(true\)/);
    expect(API).toMatch(/setRefreshing\(false\)/);
    expect(API).toMatch(/return \{ data, error, loading, refreshing,/);
  });

  it('⛔ treats a NEW path as a cold load again', () => {
    // Otherwise the data on screen — belonging to the previous path — would suppress the loading
    // state and be read as if it were the new path's result.
    expect(API).toMatch(/hasData\.current = false;/);
  });

  it('marks data as arrived when a payload lands', () => {
    expect(API).toMatch(/hasData\.current = true;\s*setData\(env\.data\);/);
  });

  it('uses a ref rather than setState inside an updater', () => {
    // A `setData(prev => { if (prev === null) setLoading(true); return prev; })` works but is an
    // impure updater and runs twice under StrictMode.
    expect(API).not.toMatch(/setData\(\(prev\) => \{[\s\S]*setLoading/);
  });
});
