import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An empty state must never remove the control that creates the first item.
 *
 * The test-tenants screen shipped exactly that: `tenants.length === 0` rendered an Empty card
 * INSTEAD of the branch containing "Create a test tenant". Deleting your last tenant therefore
 * removed the only way to make another — a one-way door out of the whole screen, reached by using
 * the screen exactly as intended. Found in production, by a delete.
 *
 * ⚠️ This is a SOURCE-SHAPE check, not a render test, and it is weaker than one. The console has no
 * jsdom/testing-library setup, and adding one while the screen was broken was the wrong trade. A
 * render test that asserts "with zero tenants, the create control is still on the page" is the
 * right guard; this holds the line until then. It follows the same source-scanning style as
 * tests/logging-consistency.test.ts in dorinda-api.
 */

const SRC = readFileSync(join(process.cwd(), 'console/src/App.tsx'), 'utf8');

/** The source of one `function <Name>(` block, up to the next top-level `function `. */
function screenSource(name: string): string {
  const start = SRC.indexOf(`function ${name}(`);
  expect(start, `screen ${name} not found`).toBeGreaterThan(-1);
  const next = SRC.indexOf('\nfunction ', start + 1);
  return SRC.slice(start, next === -1 ? undefined : next);
}

describe('empty states do not remove the way out', () => {
  it('keeps the create control reachable with zero test tenants', () => {
    const src = screenSource('TestTenants');
    expect(src).toContain('Create a test tenant');

    /*
     * The specific shape that broke it: a ternary on emptiness whose FALSE branch holds everything
     * else. `tenants.length === 0 ? <Empty/> : <>…create…</>` reads as "show the empty state",
     * but what it does is hide the page.
     */
    const emptyTernary = /tenants\.length === 0 \?/.test(src);
    expect(
      emptyTernary,
      'an emptiness ternary here hides every sibling control, including Create — ' +
        'render the empty state INSIDE the list instead',
    ).toBe(false);

    // And positively: the create card must not sit after a `tenants.length > 0 &&` gate.
    const gate = src.indexOf('tenants.length > 0 &&');
    const create = src.indexOf('Create a test tenant');
    if (gate !== -1) {
      expect(create, 'the create card is gated behind having tenants').toBeLessThan(gate);
    }
  });
});
