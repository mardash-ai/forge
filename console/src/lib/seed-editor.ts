/**
 * What the Seed editor should show when a test tenant is opened.
 *
 * ## Why this is a module of its own
 *
 * It was inline in a click handler, and that cost a real bug. A later edit to it silently failed to
 * apply — the anchor's indentation had shifted when the tenant table gained a nesting level, and
 * `String.replace` no-ops rather than erroring. The type change and the LABEL change did land, so
 * the banner read *"Already seeded — the fixture below is the one that produced it"* while the
 * editor showed `{}`. Typecheck passed. Every test passed. Grepping for strings from the change
 * found them, because two thirds of the change was there.
 *
 * Logic that decides what an operator sees needs to be assertable directly, not inferred from the
 * shape of a component file.
 */

/** The editor state for a selection: which preset reads as chosen, and the JSON to show. */
export interface SeedEditorState {
  /**
   * The preset key, or `''` meaning NONE of them.
   *
   * `''` matters: the editor is holding this tenant's OWN fixture, which is not any preset. A
   * `<select>` whose value matches no option displays the FIRST one, so the caller must offer an
   * explicit entry for it — otherwise the dropdown reads "Empty — no data" beside an editor full of
   * fixture, which is exactly the contradiction that surfaced this.
   */
  preset: string;
  /** Pretty-printed JSON for the textarea. */
  fixture: string;
}

/**
 * Choose what to show for `tenant`.
 *
 * A tenant that carries its own fixture gets it back — opening a populated tenant and being shown
 * an unrelated preset is how a re-seed becomes an accident, since the editor looks authoritative
 * and whatever sits in it reads as "what this tenant contains".
 *
 * Everything else falls back to `fallback`. The normal case for that is a household MEMBER: it was
 * created by its owner's fixture, so the document that produced it belongs to the owner and this
 * tenant genuinely has none.
 */
export function fixtureForSelection(
  tenant: { lastFixture?: unknown | null } | null,
  fallback: unknown,
): SeedEditorState {
  if (tenant?.lastFixture) {
    return { preset: '', fixture: JSON.stringify(tenant.lastFixture, null, 2) };
  }
  return { preset: 'empty', fixture: JSON.stringify(fallback, null, 2) };
}
