// Plugin: release-orchestrator — the phase RUNNER for the Release Capability (C18).
//
// This is the atomic, idempotent, fail-safe driver. It is pure with respect to the
// ReleaseExecutor it is handed (all Docker/git/GHCR/deploy/verify side effects live behind
// that interface), so the sequencing, the idempotent assess-and-resume, and the fail-safe
// abort semantics are all exercised in unit tests with a fake executor — exactly the
// behavior whose correctness matters most (a release that half-applies a deploy is the
// failure mode this command exists to eliminate).
//
// Contract:
//   • Phases run in order: assess → publish → repin → deploy → verify.
//   • A re-run continues from the first UNSATISFIED phase (needs* predicates in plan.ts);
//     finished phases are recorded 'skipped', never blindly redone.
//   • ANY phase throwing aborts the whole release: NO later phase runs (no half-apply),
//     prod stays on the last-good version, and the runner throws a ReleaseError naming the
//     phase. The Capability turns that into a failed Release + a non-zero CLI exit.

import {
  needsPublish,
  needsRepin,
  needsDeploy,
  toDigestPin,
  type ReleasePhase,
} from './plan';

// What assessment observed about the world before any mutation. Read-only.
export interface Observed {
  commit: string; // the commit being released (git HEAD or --commit)
  workingTreeClean?: boolean; // undefined = could not determine (e.g. git unavailable)
  imageRef: string; // the tagged ref for this commit's build (ghcr.io/<owner>/<app>-app:sha-<commit>)
  publishedDigest?: string; // sha256:… if the image is already resolvable in the registry
  currentPin?: string; // the web_image pin already in compose/forge.app.json, if any
  host?: string; // public host recovered from the app's persisted production config, if any
}

export interface DeployResult {
  id: string;
  status: 'succeeded' | 'failed';
  error?: string;
}

export interface VerifyResult {
  id: string;
  passed: boolean;
  summary: string;
}

// The seam between the pure runner and the real world. The Capability supplies an
// implementation that shells out (git/docker) and reuses the C7/C8/C14 code paths; tests
// supply a fake. Every method is a side effect the runner sequences and guards.
export interface ReleaseExecutor {
  // Observe the world (resolve commit, target image ref, whether it is already published, the
  // current pin, the persisted host). MUST NOT mutate anything.
  assess(): Promise<Observed>;
  // Ensure the commit's image exists in the registry and RETURN its digest (sha256:…). In
  // CI mode this polls/waits (bounded) until the app's publish workflow lands the build; in
  // build mode it builds+pushes a multi-arch image. Throws on timeout / build failure.
  publish(imageRef: string, observed: Observed): Promise<string>;
  // Is the running web container already on the target pin's exact image? (local image-id
  // compare, same identity the P14 drift gate uses). Read-only; any doubt → false.
  isDeployCurrent(targetPin: string): Promise<boolean>;
  // Repin compose.prod.yaml + forge.app.json to the target digest via `forge productionize
  // --web-image` (keeps the data-plane pin). Returns a short human detail. Throws on failure.
  repin(targetPin: string): Promise<string>;
  // Roll the production stack (C7 Deploy: start-first + P14 drift gate). A failed roll
  // auto-discards the new replica and keeps the old serving.
  deploy(): Promise<DeployResult>;
  // Post-deploy contract smoke (C14 Verify) against the public host. The final gate.
  verify(host: string): Promise<VerifyResult>;
}

export interface ReleaseOptions {
  publishMode: 'ci' | 'build';
  dryRun: boolean;
  allowDirty: boolean;
  host?: string; // explicit --host; falls back to the assessed/persisted host
}

export interface PhaseRecord {
  phase: ReleasePhase;
  status: 'ran' | 'skipped' | 'failed';
  detail: string;
  duration_ms: number;
}

export interface ReleaseOutcome {
  status: 'succeeded' | 'failed';
  commit: string;
  image_ref: string;
  web_image_pin?: string;
  host?: string;
  phases: PhaseRecord[];
  deployment_id?: string;
  verification_id?: string;
}

// A phase failure. Carries the phase that failed + the full phase log (successful phases plus
// the failed one) so the Capability can record precisely where the release stopped. Its
// presence is the signal "prod is on the last-good version; nothing after `phase` ran."
export class ReleaseError extends Error {
  readonly phase: ReleasePhase;
  readonly phases: PhaseRecord[];
  constructor(phase: ReleasePhase, message: string, priorPhases: PhaseRecord[], durationMs: number) {
    super(message);
    this.name = 'ReleaseError';
    this.phase = phase;
    this.phases = [...priorPhases, { phase, status: 'failed', detail: message, duration_ms: durationMs }];
  }
}

const short = (sha: string): string => (sha.length > 12 ? sha.slice(0, 12) : sha);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// Observe each phase transition (for CLI progress output). Never throws.
export type PhaseListener = (rec: PhaseRecord) => void;

// Drive the full release. Resolves to a succeeded ReleaseOutcome, or throws ReleaseError at
// the first failing phase (prod left on last-good). `onPhase` streams progress for the CLI.
export async function runRelease(
  exec: ReleaseExecutor,
  opts: ReleaseOptions,
  onPhase: PhaseListener = () => {},
): Promise<ReleaseOutcome> {
  const phases: PhaseRecord[] = [];
  const record = (phase: ReleasePhase, status: PhaseRecord['status'], detail: string, ms: number): void => {
    const rec: PhaseRecord = { phase, status, detail, duration_ms: ms };
    phases.push(rec);
    onPhase(rec);
  };
  // Run a mutating phase under a timer; convert any throw into a fail-safe ReleaseError that
  // stops the whole release before the next phase.
  const guard = async <T>(phase: ReleasePhase, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } catch (e) {
      throw new ReleaseError(phase, errMsg(e), phases, Date.now() - t);
    }
  };

  // -- ASSESS (read-only; always runs) --------------------------------------
  const t0 = Date.now();
  let observed: Observed;
  try {
    observed = await exec.assess();
  } catch (e) {
    throw new ReleaseError('assess', errMsg(e), phases, Date.now() - t0);
  }
  const host = opts.host ?? observed.host;
  record(
    'assess',
    'ran',
    `commit ${short(observed.commit)}; image ${observed.imageRef}; ` +
      `${observed.publishedDigest ? `already published @${observed.publishedDigest}` : 'image not yet published'}; ` +
      `${observed.currentPin ? `current pin ${observed.currentPin}` : 'no current pin'}; ` +
      `${host ? `host ${host}` : 'host unknown'}`,
    Date.now() - t0,
  );

  // Fail-safe gate BEFORE any mutation: refuse to release an uncommitted working tree unless
  // explicitly allowed (a release must be reproducible from a known commit).
  if (observed.workingTreeClean === false && !opts.allowDirty) {
    throw new ReleaseError(
      'assess',
      'working tree has uncommitted changes — commit them first, or pass --allow-dirty. Refusing to release an un-committed state.',
      phases,
      0,
    );
  }

  // -- DRY RUN: report the plan, mutate nothing -----------------------------
  if (opts.dryRun) {
    const willPublish = needsPublish(observed.publishedDigest);
    record('publish', willPublish ? 'ran' : 'skipped',
      willPublish ? `WOULD publish/await ${observed.imageRef} (mode=${opts.publishMode})` : `already published @${observed.publishedDigest}`, 0);
    const targetPin = observed.publishedDigest ? toDigestPin(observed.imageRef, observed.publishedDigest) : undefined;
    const willRepin = targetPin ? needsRepin(observed.currentPin, targetPin) : true;
    record('repin', willRepin ? 'ran' : 'skipped',
      targetPin ? `WOULD repin web_image=${targetPin}` : 'WOULD repin to the freshly published digest', 0);
    record('deploy', 'ran', 'WOULD deploy (start-first roll + P14 drift gate)', 0);
    record('verify', host ? 'ran' : 'skipped',
      host ? `WOULD verify @ ${host}` : 'no host resolvable — WOULD SKIP the post-deploy gate', 0);
    return { status: 'succeeded', commit: observed.commit, image_ref: observed.imageRef, web_image_pin: targetPin, host, phases };
  }

  // -- PUBLISH: ensure the commit's image exists + resolve its digest -------
  let digest = observed.publishedDigest;
  if (needsPublish(digest)) {
    const t = Date.now();
    digest = await guard('publish', () => exec.publish(observed.imageRef, observed));
    record('publish', 'ran', `resolved ${observed.imageRef} → @${digest} (mode=${opts.publishMode})`, Date.now() - t);
  } else {
    record('publish', 'skipped', `image already in registry → @${digest}`, 0);
  }
  const targetPin = toDigestPin(observed.imageRef, digest as string);

  // -- REPIN: converge compose/manifest onto the target digest (C8) --------
  if (needsRepin(observed.currentPin, targetPin)) {
    const t = Date.now();
    const detail = await guard('repin', () => exec.repin(targetPin));
    record('repin', 'ran', detail, Date.now() - t);
  } else {
    record('repin', 'skipped', `compose already pinned to ${targetPin}`, 0);
  }

  // -- DEPLOY: start-first roll + P14 drift gate (C7) ----------------------
  let deployment_id: string | undefined;
  const alreadyCurrent = await exec.isDeployCurrent(targetPin); // read-only; any doubt → false
  if (!alreadyCurrent) {
    const t = Date.now();
    const d = await guard('deploy', async () => {
      const r = await exec.deploy();
      if (r.status !== 'succeeded') throw new Error(r.error ?? 'deploy failed (the roll kept the last-good replica serving)');
      return r;
    });
    deployment_id = d.id;
    record('deploy', 'ran', `rolled — deployment ${d.id}`, Date.now() - t);
  } else {
    record('deploy', 'skipped', `running web already on the target image (${targetPin})`, 0);
  }

  // -- VERIFY: post-deploy contract smoke (C14) — the final gate -----------
  let verification_id: string | undefined;
  if (host) {
    const t = Date.now();
    const v = await guard('verify', async () => {
      const r = await exec.verify(host);
      if (!r.passed) throw new Error(r.summary);
      return r;
    });
    verification_id = v.id;
    record('verify', 'ran', v.summary, Date.now() - t);
  } else {
    record('verify', 'skipped', 'no host resolvable (pass --host or run `forge productionize --host` first) — POST-DEPLOY GATE DID NOT RUN', 0);
  }

  return {
    status: 'succeeded',
    commit: observed.commit,
    image_ref: observed.imageRef,
    web_image_pin: targetPin,
    host,
    phases,
    deployment_id,
    verification_id,
  };
}
