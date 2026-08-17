/**
 * `manifestDelta` — "did the tool surface move, or did the product?"
 *
 * ⛔ THE LOAD-BEARING TESTS ARE THE UNKNOWN ONES.
 *
 * Detecting a changed hash is the easy half and the half that will never silently break. The half
 * that WILL is the absent one: a run with no recorded manifest compares equal to another run with
 * no recorded manifest under any naive implementation, and the console would then print
 * "tool surface: unchanged" over two runs whose surface nobody ever read. That is HAT-F-065's
 * shape — a default scored as an observation — which cost three releases and four paid live runs.
 *
 * So every test below marked ⛔ pins the same rule from a different direction: unknown is reported
 * as unknown, and is NEVER reported as "unchanged" or as "changed".
 */

import { describe, it, expect } from 'vitest';

import { manifestDelta, manifestFromMeta, type RunManifest } from '../src/console/manifest-delta';

const FULL: RunManifest = {
  contract_hash: 'aaaa111122223333',
  guidance_hash: 'bbbb111122223333',
  instructions_hash: 'cccc111122223333',
};

describe('manifestDelta — detecting a surface change', () => {
  it('detects a changed instructions_hash — the case the field exists for', () => {
    // agent-instructions.md is revised without any tool name, argument, description or annotation
    // moving. Nothing else in a run report can see this.
    const delta = manifestDelta(FULL, { ...FULL, instructions_hash: 'dddd444455556666' });

    expect(delta.known).toBe(true);
    expect(delta.instructions_hash).toBe(true);
    expect(delta.contract_hash).toBe(false);
    expect(delta.guidance_hash).toBe(false);
  });

  it('names WHICH surface moved, one field at a time', () => {
    const fields = ['contract_hash', 'guidance_hash', 'instructions_hash'] as const;
    for (const field of fields) {
      const delta = manifestDelta(FULL, { ...FULL, [field]: 'ffff999988887777' });
      expect(delta.known).toBe(true);
      for (const other of fields) {
        expect(delta[other]).toBe(other === field);
      }
    }
  });

  it('reports no change when every hash is identical', () => {
    const delta = manifestDelta(FULL, { ...FULL });

    expect(delta.known).toBe(true);
    expect(delta.contract_hash).toBe(false);
    expect(delta.guidance_hash).toBe(false);
    expect(delta.instructions_hash).toBe(false);
  });

  it('reports all three when the whole surface was replaced', () => {
    const delta = manifestDelta(FULL, {
      contract_hash: 'zzzz000000000000',
      guidance_hash: 'yyyy000000000000',
      instructions_hash: 'xxxx000000000000',
    });

    expect(delta).toEqual({
      contract_hash: true,
      guidance_hash: true,
      instructions_hash: true,
      // ⛔ Absent on both sides, so it did not "change" — unknown is never rendered as movement.
      served_tools_hash: false,
      known: true,
    });
  });
});

describe('⛔ an unread manifest is never a finding', () => {
  it('⛔ a null side reports known:false and asserts nothing in either direction', () => {
    for (const [before, after] of [
      [null, FULL],
      [FULL, null],
      [null, null],
      [undefined, FULL],
      [FULL, undefined],
    ] as Array<[RunManifest | null | undefined, RunManifest | null | undefined]>) {
      const delta = manifestDelta(before, after);

      expect(delta.known).toBe(false);
      // ⛔ Not "changed"...
      expect(delta.contract_hash).toBe(false);
      expect(delta.guidance_hash).toBe(false);
      expect(delta.instructions_hash).toBe(false);
      // ...and ⛔ NOT "unchanged" either: `known:false` is what makes the three falses mean
      // "no finding". A caller that renders the booleans without checking `known` is the bug.
      expect(delta).toEqual({
        contract_hash: false,
        guidance_hash: false,
        instructions_hash: false,
        served_tools_hash: false,
        known: false,
      });
    }
  });

  it('⛔ an EMPTY manifest object is as unread as a null one', () => {
    // The shape a defaulted `{}` takes. Two of them compare equal field-for-field, so an
    // implementation that only null-checks would certify "unchanged" from nothing at all.
    expect(manifestDelta({}, {}).known).toBe(false);
    expect(manifestDelta({}, FULL).known).toBe(false);
    expect(manifestDelta(FULL, {}).known).toBe(false);
  });

  it('⛔ a field recorded on one side only is unknown for that field, never changed', () => {
    // The older run predates `instructions_hash`; the newer one has it. That is not evidence the
    // instruction block moved — nobody fingerprinted it the first time.
    const before: RunManifest = { contract_hash: FULL.contract_hash, guidance_hash: FULL.guidance_hash };
    const delta = manifestDelta(before, FULL);

    expect(delta.known).toBe(true); // both runs recorded something, so the pair is comparable
    expect(delta.instructions_hash).toBe(false); // ...but this field is not a finding
    expect(delta.contract_hash).toBe(false);
    expect(delta.guidance_hash).toBe(false);
  });

  it('⛔ an empty-string hash is treated as absent, not as a value that can differ', () => {
    // A sender that zero-fills rather than omits must not be able to manufacture a "change".
    const delta = manifestDelta({ ...FULL, contract_hash: '' }, FULL);
    expect(delta.contract_hash).toBe(false);
  });

  it('is symmetric — swapping the runs cannot change what is known', () => {
    const older: RunManifest = { contract_hash: 'aaaa111122223333' };
    const newer: RunManifest = { contract_hash: 'bbbb111122223333' };

    expect(manifestDelta(older, newer)).toEqual(manifestDelta(newer, older));
  });
});

describe('manifestFromMeta — reading the stored jsonb', () => {
  it('reads the three hashes the ingest route writes to meta.manifest', () => {
    const meta = { runner_sa: 'runner@example.iam.gserviceaccount.com', manifest: { ...FULL } };
    expect(manifestFromMeta(meta)).toEqual(FULL);
  });

  it('keeps a partial manifest partial rather than filling the gaps', () => {
    expect(manifestFromMeta({ manifest: { instructions_hash: 'cccc111122223333' } })).toEqual({
      instructions_hash: 'cccc111122223333',
    });
  });

  it('⛔ returns null — never {} — when there is nothing readable', () => {
    // `{}` would travel into manifestDelta as "a manifest exists", one step from a self-certifying
    // comparison. Null is the absence the delta is built to recognise.
    for (const meta of [
      null,
      undefined,
      {},
      { runner_sa: 'x' },
      { manifest: null },
      { manifest: {} },
      { manifest: 'not-an-object' },
      { manifest: { contract_hash: '' } },
      { manifest: { contract_hash: 123 } },
      'not-an-object',
    ]) {
      expect(manifestFromMeta(meta)).toBeNull();
    }
  });

  it('a run with no stored manifest can never report a surface change', () => {
    // The end-to-end shape: two rows out of the store, one of them written before the runner sent
    // manifests at all.
    const older = manifestFromMeta({ runner_sa: 'x' });
    const newer = manifestFromMeta({ runner_sa: 'x', manifest: { ...FULL } });

    expect(manifestDelta(older, newer).known).toBe(false);
  });
});

describe('⛔ the sender and the receiver are two halves of one contract', () => {
  it('the ingest route persists every manifest field the payload declares', async () => {
    // The standing warning in ingest-routes.ts: "EVERY metric the sender provides must be persisted
    // here". p50/p99 and the token totals shipped in the payload and were dropped by the mapping,
    // rendering null in the console for every run. This inverts that: the payload's own declaration
    // is the checklist, and a field with no persister fails the build.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/api/ingest-routes.ts'), 'utf8');

    const decl = src.slice(src.indexOf('manifest?: {'));
    const declared = [...decl.slice(0, decl.indexOf('}')).matchAll(/^\s+([a-z0-9_]+)\??:/gm)].map(
      (m) => m[1] as string,
    );
    // ⛔ `served_tools_hash` is the ONLY one populated for a containerised run: `.dockerignore`
    // excludes `.hat/`, so the three recorded hashes are absent in the Cloud Run job. It is derived
    // live from the run's own tools/list. This assertion is the checklist — a field declared on the
    // payload with no persister fails the build.
    expect(declared).toEqual(['contract_hash', 'guidance_hash', 'instructions_hash', 'served_tools_hash']);

    // ...and the update mapping names each one, storing them under meta.manifest.
    const mapping = src.slice(src.indexOf('const metaUpdate'), src.indexOf('update.meta = metaUpdate'));
    for (const field of declared) {
      expect(mapping).toContain(field);
    }
    expect(mapping).toContain("metaUpdate['manifest']");
  });
});
