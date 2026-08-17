/**
 * DID THE TOOL SURFACE MOVE, OR DID THE PRODUCT?
 *
 * Every forge-hat run reports `manifest: { contract_hash, guidance_hash, instructions_hash }` — the
 * three fingerprints of the MCP tool surface it executed against — and the ingest route stores them
 * at `meta.manifest`. This module is the only thing that reads them.
 *
 * It exists because of the question a red workflow raises first. dorinda-api's
 * `agent-instructions.md` has 51 revisions; the instruction block can be rewritten end to end
 * without one tool name, argument, description or annotation moving. So when last night's ACCEPTED
 * becomes tonight's REJECTED, "the product regressed" and "the surface the model reads changed
 * under it" look identical in every other field the console holds. These three hashes are the only
 * evidence that separates them, and three rather than one so the answer can name WHICH surface
 * moved: contract (names + argument shapes), guidance (descriptions + annotations), instructions
 * (the server's own block).
 *
 * ⛔ THE INVARIANT: AN UNREAD HASH IS NOT EVIDENCE OF STABILITY.
 *
 * A run whose manifest is missing — an older runner, a Cloud Run execution with no recorded
 * baseline, a row written before this field existed — supports NO claim in either direction. The
 * only honest answer is `known: false`, and every boolean stays `false` because none of them is a
 * finding. Reporting "unchanged" from a manifest nobody could read is HAT-F-065's error in a new
 * place: a default treated as an observation, which there cost three releases and four paid live
 * runs. `known` is what a caller must gate its rendering on — never the booleans alone.
 *
 * Pure by construction: no I/O, no clock, no network — the property that makes a decision testable
 * directly rather than inferred from a rendered page. This mirrors forge-hat's own
 * `src/results/diff.ts` `manifestDelta`, deliberately field-for-field: the two sides of one contract
 * must classify a surface change identically, or the runner's report and the console's page will
 * disagree about the same two runs.
 */

/** The three fingerprints as stored at `meta.manifest`. Every field is independently optional. */
export interface RunManifest {
  contract_hash?: string;
  guidance_hash?: string;
  instructions_hash?: string;
  served_tools_hash?: string;
}

export interface ManifestDelta {
  /** true only when BOTH runs recorded this hash and they differ. */
  contract_hash: boolean;
  guidance_hash: boolean;
  instructions_hash: boolean;
  served_tools_hash: boolean;
  /**
   * ⛔ false when either run's manifest could not be read. The booleans above are meaningless
   * unless this is true — unknown is never "unchanged".
   */
  known: boolean;
}

/**
 * Did the MCP tool surface move between these two runs?
 *
 * ⛔ Returns `known: false` — with every flag false — whenever either side is missing or carries no
 * hash at all. False flags under `known: false` mean "no finding", NOT "no change".
 */
export function manifestDelta(
  before: RunManifest | null | undefined,
  after: RunManifest | null | undefined,
): ManifestDelta {
  if (!before || !after) {
    return {
      contract_hash: false,
      guidance_hash: false,
      instructions_hash: false,
      served_tools_hash: false,
      known: false,
    };
  }

  // ⛔ A field present on one side and absent on the other is UNKNOWN for that field, not changed.
  // The pair says nothing about whether the surface moved, and a `true` here would be read as
  // "the contract changed" on the strength of one observation.
  const differs = (a?: string, b?: string): boolean => {
    if (!a || !b) return false;
    return a !== b;
  };

  // Both sides must have recorded SOMETHING. An empty manifest object is as unread as a null one —
  // it is the shape a defaulted `{}` takes, and that must not certify a comparison.
  const known = Boolean(
    (before.contract_hash || before.guidance_hash || before.instructions_hash || before.served_tools_hash) &&
    (after.contract_hash || after.guidance_hash || after.instructions_hash || after.served_tools_hash),
  );

  return {
    contract_hash: differs(before.contract_hash, after.contract_hash),
    guidance_hash: differs(before.guidance_hash, after.guidance_hash),
    instructions_hash: differs(before.instructions_hash, after.instructions_hash),
    // ⛔ The only field that is populated for a CONTAINERISED run: `.dockerignore` excludes `.hat/`,
    // so the three recorded hashes are absent in the Cloud Run job and read unknown, never
    // "unchanged". This one is derived live from the run's own tools/list.
    served_tools_hash: differs(before.served_tools_hash, after.served_tools_hash),
    known,
  };
}

/**
 * Pull a run's manifest out of its stored `meta` blob.
 *
 * `meta` is untyped jsonb written by an external sender, so this narrows rather than casts, and
 * returns null when there is nothing readable there. ⛔ Null, never `{}`: an empty object would
 * travel into `manifestDelta` as a manifest that exists and holds no hashes, which is one step away
 * from a comparison that certifies itself.
 */
export function manifestFromMeta(meta: unknown): RunManifest | null {
  if (!meta || typeof meta !== 'object') return null;
  const raw = (meta as Record<string, unknown>)['manifest'];
  if (!raw || typeof raw !== 'object') return null;

  const source = raw as Record<string, unknown>;
  const manifest: RunManifest = {};
  for (const key of ['contract_hash', 'guidance_hash', 'instructions_hash'] as const) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) manifest[key] = value;
  }
  return Object.keys(manifest).length > 0 ? manifest : null;
}
