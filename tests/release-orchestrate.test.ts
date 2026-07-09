import { describe, it, expect } from 'vitest';
import {
  runRelease,
  ReleaseError,
  toDigestPin,
  type ReleaseExecutor,
  type Observed,
  type ReleaseOptions,
  type PhaseRecord,
} from '../src/plugins/release-orchestrator/index';

// C18 `forge release` — the fail-safe, idempotent phase RUNNER, driven by a fake executor.
// This is where the behavior that matters most is proven: a full run completes all phases in
// order; ANY phase failure aborts BEFORE the next mutating phase (no half-applied deploy); a
// re-run assesses state and SKIPS finished phases (idempotent resume); and --dry-run mutates
// nothing. The real git/docker/deploy execution is integration-only.

const IMAGE_REF = 'ghcr.io/acme/shop-app:sha-abc123';
const DIGEST = 'sha256:' + 'a'.repeat(64);
const TARGET_PIN = toDigestPin(IMAGE_REF, DIGEST);

interface Calls {
  assess: number;
  publish: number;
  isDeployCurrent: number;
  repin: number;
  deploy: number;
  verify: number;
}

// A configurable fake executor that records every call, so tests can assert not just the
// outcome but exactly WHICH side effects ran (the fail-safe / idempotent guarantees).
function makeExec(overrides: Partial<ReleaseExecutor> & { observed?: Partial<Observed> } = {}): {
  exec: ReleaseExecutor;
  calls: Calls;
} {
  const calls: Calls = { assess: 0, publish: 0, isDeployCurrent: 0, repin: 0, deploy: 0, verify: 0 };
  const observed: Observed = {
    commit: 'abc123def456',
    workingTreeClean: true,
    imageRef: IMAGE_REF,
    publishedDigest: undefined,
    currentPin: undefined,
    host: 'shop.example.com',
    ...overrides.observed,
  };
  const exec: ReleaseExecutor = {
    async assess() {
      calls.assess++;
      return observed;
    },
    async publish() {
      calls.publish++;
      return DIGEST;
    },
    async isDeployCurrent() {
      calls.isDeployCurrent++;
      return false;
    },
    async repin() {
      calls.repin++;
      return `repinned ${TARGET_PIN}`;
    },
    async deploy() {
      calls.deploy++;
      return { id: 'deploy_1', status: 'succeeded' };
    },
    async verify() {
      calls.verify++;
      return { id: 'ver_1', passed: true, summary: 'all contract checks passed' };
    },
    ...stripObserved(overrides),
  };
  return { exec, calls };
}

function stripObserved(o: Partial<ReleaseExecutor> & { observed?: unknown }): Partial<ReleaseExecutor> {
  const { observed: _drop, ...rest } = o;
  return rest;
}

const baseOpts: ReleaseOptions = { publishMode: 'ci', dryRun: false, allowDirty: false };
const phaseOrder = (phases: PhaseRecord[]) => phases.map((p) => p.phase);
const statusOf = (phases: PhaseRecord[], phase: string) => phases.find((p) => p.phase === phase)?.status;

describe('runRelease — a full green run', () => {
  it('runs every phase in order and returns a succeeded outcome with the digest pin', async () => {
    const { exec, calls } = makeExec();
    const seen: PhaseRecord[] = [];
    const outcome = await runRelease(exec, baseOpts, (rec) => seen.push(rec));

    expect(outcome.status).toBe('succeeded');
    expect(phaseOrder(outcome.phases)).toEqual(['assess', 'publish', 'repin', 'deploy', 'verify']);
    expect(outcome.phases.every((p) => p.status === 'ran')).toBe(true);
    expect(outcome.web_image_pin).toBe(TARGET_PIN);
    expect(outcome.deployment_id).toBe('deploy_1');
    expect(outcome.verification_id).toBe('ver_1');
    expect(calls).toMatchObject({ publish: 1, repin: 1, deploy: 1, verify: 1 });
    // The listener streamed the same phases (CLI progress).
    expect(phaseOrder(seen)).toEqual(['assess', 'publish', 'repin', 'deploy', 'verify']);
  });
});

describe('runRelease — fail-safe: any phase failure aborts before the next mutating phase', () => {
  it('publish failure → repin/deploy/verify NEVER run (no half-apply)', async () => {
    const { exec, calls } = makeExec({
      async publish() {
        calls.publish++;
        throw new Error('GHCR timeout');
      },
    });
    await expect(runRelease(exec, baseOpts)).rejects.toMatchObject({ name: 'ReleaseError', phase: 'publish' });
    expect(calls).toMatchObject({ repin: 0, deploy: 0, verify: 0 });
  });

  it('repin failure → deploy/verify NEVER run', async () => {
    const { exec, calls } = makeExec({
      async repin() {
        calls.repin++;
        throw new Error('productionize rejected the pin');
      },
    });
    await expect(runRelease(exec, baseOpts)).rejects.toMatchObject({ phase: 'repin' });
    expect(calls).toMatchObject({ deploy: 0, verify: 0 });
  });

  it('deploy failure (drift gate / unhealthy roll) → verify NEVER runs; prod is on last-good', async () => {
    const { exec, calls } = makeExec({
      async deploy() {
        calls.deploy++;
        return { id: 'deploy_x', status: 'failed', error: 'deploy drift: running != pinned' };
      },
    });
    let caught: ReleaseError | undefined;
    try {
      await runRelease(exec, baseOpts);
    } catch (e) {
      caught = e as ReleaseError;
    }
    expect(caught?.phase).toBe('deploy');
    expect(caught?.message).toMatch(/drift/);
    expect(statusOf(caught!.phases, 'deploy')).toBe('failed');
    expect(calls.verify).toBe(0);
  });

  it('verify failure → the release fails (never claims success on a failed post-deploy gate)', async () => {
    const { exec } = makeExec({
      async verify() {
        return { id: 'ver_x', passed: false, summary: 'health check FAILED' };
      },
    });
    await expect(runRelease(exec, baseOpts)).rejects.toMatchObject({ phase: 'verify' });
  });

  it('assess failure (e.g. cannot resolve commit) aborts before any mutation', async () => {
    const { exec, calls } = makeExec({
      async assess() {
        calls.assess++;
        throw new Error('could not resolve the commit to release');
      },
    });
    await expect(runRelease(exec, baseOpts)).rejects.toMatchObject({ phase: 'assess' });
    expect(calls).toMatchObject({ publish: 0, repin: 0, deploy: 0, verify: 0 });
  });

  it('a dirty working tree is refused before any mutation (unless --allow-dirty)', async () => {
    const { exec, calls } = makeExec({ observed: { workingTreeClean: false } });
    await expect(runRelease(exec, baseOpts)).rejects.toMatchObject({ phase: 'assess' });
    expect(calls.publish).toBe(0);

    // With --allow-dirty the same state proceeds through the pipeline.
    const { exec: exec2, calls: calls2 } = makeExec({ observed: { workingTreeClean: false } });
    const outcome = await runRelease(exec2, { ...baseOpts, allowDirty: true });
    expect(outcome.status).toBe('succeeded');
    expect(calls2.publish).toBe(1);
  });
});

describe('runRelease — idempotent resume', () => {
  it('a re-run after everything landed is a no-op: publish/repin/deploy all SKIP, only verify runs', async () => {
    const { exec, calls } = makeExec({
      observed: { publishedDigest: DIGEST, currentPin: TARGET_PIN },
      async isDeployCurrent() {
        calls.isDeployCurrent++;
        return true; // running web already on the target image
      },
    });
    const outcome = await runRelease(exec, baseOpts);

    expect(outcome.status).toBe('succeeded');
    expect(statusOf(outcome.phases, 'publish')).toBe('skipped');
    expect(statusOf(outcome.phases, 'repin')).toBe('skipped');
    expect(statusOf(outcome.phases, 'deploy')).toBe('skipped');
    expect(statusOf(outcome.phases, 'verify')).toBe('ran');
    // No mutating side effect fired — a true no-op resume.
    expect(calls).toMatchObject({ publish: 0, repin: 0, deploy: 0, verify: 1 });
  });

  it('resumes mid-flow: image already published but pin stale → skip publish, run repin+deploy', async () => {
    const { exec, calls } = makeExec({
      observed: { publishedDigest: DIGEST, currentPin: 'ghcr.io/acme/shop-app@sha256:' + 'b'.repeat(64) },
    });
    const outcome = await runRelease(exec, baseOpts);
    expect(statusOf(outcome.phases, 'publish')).toBe('skipped');
    expect(statusOf(outcome.phases, 'repin')).toBe('ran');
    expect(statusOf(outcome.phases, 'deploy')).toBe('ran');
    expect(calls).toMatchObject({ publish: 0, repin: 1, deploy: 1, verify: 1 });
  });
});

describe('runRelease — observability + host handling', () => {
  it('--dry-run assesses + plans but mutates NOTHING', async () => {
    const { exec, calls } = makeExec();
    const outcome = await runRelease(exec, { ...baseOpts, dryRun: true });
    expect(outcome.status).toBe('succeeded');
    expect(phaseOrder(outcome.phases)).toEqual(['assess', 'publish', 'repin', 'deploy', 'verify']);
    // Not a single side effect ran.
    expect(calls).toMatchObject({ publish: 0, isDeployCurrent: 0, repin: 0, deploy: 0, verify: 0 });
    expect(outcome.phases.find((p) => p.phase === 'publish')?.detail).toMatch(/WOULD/);
  });

  it('skips verify (with a loud phase note) when no host is resolvable', async () => {
    const { exec, calls } = makeExec({ observed: { host: undefined } });
    const outcome = await runRelease(exec, { ...baseOpts, host: undefined });
    expect(outcome.status).toBe('succeeded');
    expect(statusOf(outcome.phases, 'verify')).toBe('skipped');
    expect(outcome.phases.find((p) => p.phase === 'verify')?.detail).toMatch(/GATE DID NOT RUN/);
    expect(calls.verify).toBe(0);
  });

  it('an explicit --host overrides the assessed host for the verify gate', async () => {
    let verifiedHost = '';
    const { exec } = makeExec({
      observed: { host: 'stale.example.com' },
      async verify(host: string) {
        verifiedHost = host;
        return { id: 'ver_1', passed: true, summary: 'ok' };
      },
    });
    await runRelease(exec, { ...baseOpts, host: 'fresh.example.com' });
    expect(verifiedHost).toBe('fresh.example.com');
  });
});
