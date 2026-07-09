import { describe, it, expect } from 'vitest';
import {
  isSha256,
  targetImageRef,
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
