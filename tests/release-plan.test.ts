import { describe, it, expect } from 'vitest';
import {
  isSha256,
  targetImageRef,
  shortSha,
  candidateImageRefs,
  stripTag,
  toDigestPin,
  needsPublish,
  needsRepin,
  needsDeploy,
} from '../src/plugins/release-orchestrator/plan';
import {
  parseOwnerFromRemote,
  parseImageDigest,
  isNotFound,
  waitForDigest,
  waitForAnyDigest,
  resolveAnyDigest,
  type DockerRunner,
} from '../src/plugins/release-orchestrator/ghcr';

// C18 `forge release` — the PURE decision layer. These cover the image-ref/digest-pin math,
// the idempotent-resume predicates (needs*), the registry-output parsers, and the transient-
// error-resilient poll loop. The real git/docker execution is integration-only (below is all
// pure or fake-driven), matching how the repo covers the C7 rollout.

const DIGEST = 'sha256:' + 'a'.repeat(64);
const DIGEST2 = 'sha256:' + 'b'.repeat(64);

describe('release plan — image ref + digest pin helpers', () => {
  it('isSha256 accepts a well-formed digest and rejects anything else', () => {
    expect(isSha256(DIGEST)).toBe(true);
    expect(isSha256('sha256:' + 'A'.repeat(64))).toBe(false); // upper-case hex is not canonical
    expect(isSha256('sha256:abc')).toBe(false);
    expect(isSha256('')).toBe(false);
  });

  it('targetImageRef builds the C18 convention ghcr.io/<owner>/<app>-app:sha-<commit>', () => {
    expect(targetImageRef({ owner: 'acme', app: 'shop', commit: 'abc1234' })).toBe(
      'ghcr.io/acme/shop-app:sha-abc1234',
    );
  });

  it('targetImageRef honors registry + suffix overrides', () => {
    expect(targetImageRef({ registry: 'reg.example.com', owner: 'acme', app: 'shop', commit: 'c0ffee', suffix: '-web' })).toBe(
      'reg.example.com/acme/shop-web:sha-c0ffee',
    );
  });

  it('stripTag removes a :tag but not a registry :port', () => {
    expect(stripTag('ghcr.io/acme/shop-app:sha-abc')).toBe('ghcr.io/acme/shop-app');
    expect(stripTag('reg.example.com:5000/acme/shop:latest')).toBe('reg.example.com:5000/acme/shop');
    expect(stripTag('reg.example.com:5000/acme/shop')).toBe('reg.example.com:5000/acme/shop'); // no tag → unchanged
    expect(stripTag('ghcr.io/acme/shop@' + DIGEST)).toBe('ghcr.io/acme/shop'); // already digest-pinned
  });

  it('toDigestPin drops the commit tag in favor of the immutable digest (R1)', () => {
    expect(toDigestPin('ghcr.io/acme/shop-app:sha-abc', DIGEST)).toBe(`ghcr.io/acme/shop-app@${DIGEST}`);
  });
});

// P23 — the tag the app's publish workflow (docker/metadata-action `type=sha`) produces is the
// SHORT 7-char SHA. `forge release` used to derive its poll tag from the FULL 40-char SHA, so it
// waited out the whole --timeout for a `sha-<full>` tag the workflow never creates. These lock in
// the short-SHA derivation + the short/full dual-tag robustness that fixes it.
describe('release plan — short-SHA tag derivation (P23)', () => {
  // The exact production values that surfaced P23.
  const FULL = 'dae6c6a14afedc315f43823c6700e3b8f7e53ad8';
  const SHORT = 'dae6c6a';

  it('shortSha takes the first 7 chars (docker/metadata-action type=sha default), not git --short', () => {
    expect(shortSha(FULL)).toBe(SHORT);
    expect(shortSha('  ' + FULL + '  ')).toBe(SHORT); // trimmed
    expect(shortSha('abc12')).toBe('abc12'); // already ≤ 7 → unchanged
    expect(shortSha(SHORT)).toBe(SHORT);
  });

  it('candidateImageRefs puts the short-SHA tag FIRST (what the workflow publishes), full as fallback', () => {
    const refs = candidateImageRefs({ owner: 'mardash-ai', app: 'forge-os', commit: FULL });
    expect(refs).toEqual([
      `ghcr.io/mardash-ai/forge-os-app:sha-${SHORT}`, // primary — the standard workflow's tag
      `ghcr.io/mardash-ai/forge-os-app:sha-${FULL}`, // fallback — a workflow tagging the long SHA
    ]);
  });

  it('candidateImageRefs honors registry/owner/suffix overrides and dedups a ≤7-char commit', () => {
    expect(candidateImageRefs({ registry: 'reg.example.com', owner: 'acme', app: 'shop', commit: FULL, suffix: '-web' })).toEqual([
      `reg.example.com/acme/shop-web:sha-${SHORT}`,
      `reg.example.com/acme/shop-web:sha-${FULL}`,
    ]);
    // A commit already ≤ 7 chars → short === full → a single deduped candidate.
    expect(candidateImageRefs({ owner: 'acme', app: 'shop', commit: 'abc1234' })).toEqual(['ghcr.io/acme/shop-app:sha-abc1234']);
  });
});

describe('release plan — idempotent-resume predicates', () => {
  it('needsPublish is true until a valid digest is in hand', () => {
    expect(needsPublish(undefined)).toBe(true);
    expect(needsPublish('sha256:short')).toBe(true); // malformed → still needs publishing
    expect(needsPublish(DIGEST)).toBe(false);
  });

  it('needsRepin is true only when the current pin differs from the target', () => {
    const target = toDigestPin('ghcr.io/acme/shop-app:sha-abc', DIGEST);
    expect(needsRepin(undefined, target)).toBe(true);
    expect(needsRepin(`ghcr.io/acme/shop-app@${DIGEST2}`, target)).toBe(true); // different digest
    expect(needsRepin(target, target)).toBe(false); // already pinned to the target
    expect(needsRepin(`  ${target}  `, target)).toBe(false); // whitespace-insensitive
  });

  it('needsDeploy skips only when pinned AND running the exact local image id', () => {
    // Already current → skip.
    expect(needsDeploy({ pinMatches: true, runningWebImageId: 'sha256:img1', pinnedWebImageId: 'sha256:img1' })).toBe(false);
    // Pin matches but the running image differs (the P14 stale-image trap) → deploy.
    expect(needsDeploy({ pinMatches: true, runningWebImageId: 'sha256:old', pinnedWebImageId: 'sha256:img1' })).toBe(true);
    // Compose not yet pinned to the target → deploy.
    expect(needsDeploy({ pinMatches: false, runningWebImageId: 'sha256:img1', pinnedWebImageId: 'sha256:img1' })).toBe(true);
    // Any unknown (image not pulled / container not found) → deploy (safe: it is idempotent).
    expect(needsDeploy({ pinMatches: true, runningWebImageId: undefined, pinnedWebImageId: 'sha256:img1' })).toBe(true);
    expect(needsDeploy({ pinMatches: true, runningWebImageId: 'sha256:img1', pinnedWebImageId: undefined })).toBe(true);
  });
});

describe('release ghcr — pure parsers', () => {
  it('parseOwnerFromRemote handles the SSH and HTTPS forms git prints', () => {
    expect(parseOwnerFromRemote('git@github.com:mardash-ai/forge.git')).toBe('mardash-ai');
    expect(parseOwnerFromRemote('https://github.com/mardash-ai/forge.git')).toBe('mardash-ai');
    expect(parseOwnerFromRemote('https://github.com/mardash-ai/forge')).toBe('mardash-ai');
    expect(parseOwnerFromRemote('ssh://git@github.com/acme/shop.git')).toBe('acme');
    expect(parseOwnerFromRemote('')).toBeUndefined();
  });

  it('parseImageDigest extracts a sha256 from JSON-quoted or bare output, else undefined', () => {
    expect(parseImageDigest(`"${DIGEST}"`)).toBe(DIGEST);
    expect(parseImageDigest(`${DIGEST}\n`)).toBe(DIGEST);
    expect(parseImageDigest(`Digest: ${DIGEST} (index)`)).toBe(DIGEST);
    expect(parseImageDigest('no digest here')).toBeUndefined();
    expect(parseImageDigest('')).toBeUndefined();
  });

  it('isNotFound distinguishes a normal poll miss from a transient/hard error', () => {
    expect(isNotFound('ghcr.io/acme/shop-app:sha-abc: not found')).toBe(true);
    expect(isNotFound('manifest unknown')).toBe(true);
    expect(isNotFound('unexpected status: 401 Unauthorized')).toBe(false);
    expect(isNotFound('dial tcp: i/o timeout')).toBe(false);
  });
});

// A deterministic clock so the poll loop's timeout is exercised without real waiting.
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

// A docker runner scripted to return a sequence of results (last one repeats).
function scriptedDocker(seq: Array<{ code: number; out: string }>): DockerRunner {
  let i = 0;
  return async () => {
    const r = seq[Math.min(i, seq.length - 1)]!;
    i++;
    return r;
  };
}

describe('release ghcr — waitForDigest (transient-error-resilient poll)', () => {
  it('keeps polling through transient errors + not-found, then returns the digest', async () => {
    const clock = fakeClock();
    const docker = scriptedDocker([
      { code: 1, out: 'dial tcp: i/o timeout' }, // transient — retry
      { code: 1, out: 'not found' }, // not published yet — retry
      { code: 0, out: `"${DIGEST}"` }, // landed
    ]);
    const digest = await waitForDigest(docker, 'ghcr.io/acme/shop-app:sha-abc', {
      timeoutMs: 10_000,
      intervalMs: 10,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(digest).toBe(DIGEST);
  });

  it('throws an actionable timeout error when the image never appears', async () => {
    const clock = fakeClock();
    const docker = scriptedDocker([{ code: 1, out: 'not found' }]);
    await expect(
      waitForDigest(docker, 'ghcr.io/acme/shop-app:sha-abc', {
        timeoutMs: 100,
        intervalMs: 50,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow(/timed out.*waiting for .*not published yet/s);
  });
});

// A docker runner that answers per-ref: the SHORT-SHA tag exists (the workflow's real output),
// the FULL-SHA tag is 404 — the exact production condition that surfaced P23. `imagetools
// inspect` puts the ref at args[3].
function refAwareDocker(present: Record<string, string>): DockerRunner {
  return async (args) => {
    const ref = args[3] ?? '';
    const digest = present[ref];
    return digest ? { code: 0, out: `"${digest}"` } : { code: 1, out: `${ref}: not found` };
  };
}

describe('release ghcr — dual-tag resolution finds the workflow\'s short-SHA image (P23)', () => {
  const FULL = 'dae6c6a14afedc315f43823c6700e3b8f7e53ad8';
  const SHORT = 'dae6c6a';
  const REPO = 'ghcr.io/mardash-ai/forge-os-app';
  const SHORT_REF = `${REPO}:sha-${SHORT}`;
  const FULL_REF = `${REPO}:sha-${FULL}`;
  const PROD_DIGEST = 'sha256:b3b6c75061fdf8196822a65906f984768675745b6ddd4cd43d8f05b408a482b8';
  const refs = candidateImageRefs({ owner: 'mardash-ai', app: 'forge-os', commit: FULL });

  it('resolveAnyDigest resolves the SHORT tag when only the short-SHA image is published (the prod case)', async () => {
    // Only sha-<short> exists — exactly what docker/metadata-action `type=sha` pushed; sha-<full> is 404.
    const docker = refAwareDocker({ [SHORT_REF]: PROD_DIGEST });
    const hit = await resolveAnyDigest(docker, refs);
    expect(hit).toEqual({ ref: SHORT_REF, digest: PROD_DIGEST });
  });

  it('resolveAnyDigest still resolves via the FULL tag when only the long-SHA image exists (robustness)', async () => {
    const docker = refAwareDocker({ [FULL_REF]: PROD_DIGEST });
    const hit = await resolveAnyDigest(docker, refs);
    expect(hit).toEqual({ ref: FULL_REF, digest: PROD_DIGEST });
  });

  it('resolveAnyDigest is undefined when neither tag is published yet', async () => {
    const hit = await resolveAnyDigest(refAwareDocker({}), refs);
    expect(hit).toBeUndefined();
  });

  it('waitForAnyDigest lands on the short-SHA tag while the full-SHA tag stays 404 — no more timeout wedge', async () => {
    const clock = fakeClock();
    const docker = refAwareDocker({ [SHORT_REF]: PROD_DIGEST }); // short exists, full never will
    const hit = await waitForAnyDigest(docker, refs, {
      timeoutMs: 600_000,
      intervalMs: 10_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(hit).toEqual({ ref: SHORT_REF, digest: PROD_DIGEST });
  });

  it('waitForAnyDigest names every candidate in the timeout error when nothing lands', async () => {
    const clock = fakeClock();
    await expect(
      waitForAnyDigest(refAwareDocker({}), refs, { timeoutMs: 100, intervalMs: 50, now: clock.now, sleep: clock.sleep }),
    ).rejects.toThrow(new RegExp(`timed out.*${SHORT_REF}.*or.*${FULL_REF}.*not published yet`, 's'));
  });
});
