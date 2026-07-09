// Plugin: release-orchestrator — the PURE planning layer for the Release Capability (C18).
//
// `forge release` is the capstone over Deploy (C7), Productionize/repin (C8), and Verify
// (C14): one command that takes a committed app to DEPLOYED + VERIFIED, end-to-end,
// idempotently and fail-safe. This module owns the DECISION logic only — no Docker, no git,
// no I/O — so the "what should run, what is already done, in what order" brain is exhaustively
// unit-testable. The side effects live behind the ReleaseExecutor interface (orchestrate.ts);
// the real technology (git rev-parse, GHCR digest resolution, `docker buildx`) lives in ghcr.ts
// and the Capability. Keeping this pure is what lets us PROVE the idempotent-resume and
// fail-safe behavior without a registry or a daemon.

// The ordered phases a release runs. `assess` is a read-only observation that always runs
// (even in --dry-run); the four that follow each MUTATE and are individually skippable when
// assessment proves them already done (idempotent resume).
export const RELEASE_PHASES = ['assess', 'publish', 'repin', 'deploy', 'verify'] as const;
export type ReleasePhase = (typeof RELEASE_PHASES)[number];

// R1 — a production image pin is a registry digest `sha256:<64 hex>`.
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
export function isSha256(digest: string): boolean {
  return SHA256_RE.test(digest.trim());
}

// Options that shape how the target image ref is constructed when the caller does not pass a
// full `--image-ref`. The naming convention is the C18 contract: `ghcr.io/<owner>/<app>-app:sha-<commit>`.
export interface ImageRefParts {
  registry?: string; // default 'ghcr.io'
  owner: string; // GitHub org/user that owns the app's GHCR package
  app: string; // application name
  commit: string; // the commit whose build we deploy (full or short sha)
  suffix?: string; // repo suffix, default '-app' (→ <app>-app)
}

// Build the tagged image ref for THIS commit's build. Never blindly `:latest` — the tag is
// commit-addressed so `forge release` resolves exactly the build for the code it is shipping.
export function targetImageRef(parts: ImageRefParts): string {
  const registry = (parts.registry ?? 'ghcr.io').replace(/\/+$/, '');
  const suffix = parts.suffix ?? '-app';
  const commit = parts.commit.trim();
  return `${registry}/${parts.owner}/${parts.app}${suffix}:sha-${commit}`;
}

// Strip a `:tag` from an image ref WITHOUT eating a `:port` in the registry host. The tag,
// when present, is the last `:` that comes AFTER the last `/` (a registry port's colon
// precedes the first `/`). A ref that is already digest-pinned (`@sha256:…`) is returned as-is.
export function stripTag(ref: string): string {
  if (ref.includes('@')) return ref.slice(0, ref.indexOf('@'));
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  return colon > slash ? ref.slice(0, colon) : ref;
}

// The R1 digest pin `forge productionize --web-image` receives: `<repo>@sha256:<digest>`.
// The commit tag is dropped in favor of the immutable digest so the deployed pin can never
// drift to a re-pushed tag.
export function toDigestPin(ref: string, digest: string): string {
  return `${stripTag(ref)}@${digest.trim()}`;
}

// ---------------------------------------------------------------------------
// Phase predicates — the idempotent-resume brain. Each answers "does this mutating phase
// still need to run, given what assessment observed?" A re-run after a partial/interrupted
// release re-derives these and continues from the first phase that is NOT already satisfied.
// ---------------------------------------------------------------------------

// PUBLISH is needed until the commit's image is resolvable in the registry (a digest in hand).
// A re-run after the image already landed (the manual flow's "died after the push") skips it.
export function needsPublish(publishedDigest: string | undefined): boolean {
  return !publishedDigest || !isSha256(publishedDigest);
}

// REPIN is needed until compose.prod.yaml / forge.app.json already carry EXACTLY the target
// digest pin. A re-run where the pin already matches skips the productionize rewrite.
export function needsRepin(currentPin: string | undefined, targetPin: string): boolean {
  return (currentPin ?? '').trim() !== targetPin.trim();
}

// DEPLOY is skippable only when BOTH the compose is already pinned to the target AND the
// running web container is already on that exact image (compared by LOCAL image id, the same
// identity the P14 drift gate uses). Any uncertainty (image not pulled, container not found,
// pin mismatch) returns true → deploy runs. Deploy is itself idempotent (a no-drift roll is a
// safe reconcile), so "when unsure, deploy" never half-applies; it only costs a reconcile.
export function needsDeploy(opts: {
  pinMatches: boolean;
  runningWebImageId: string | undefined;
  pinnedWebImageId: string | undefined;
}): boolean {
  if (!opts.pinMatches) return true;
  if (!opts.runningWebImageId || !opts.pinnedWebImageId) return true;
  return opts.runningWebImageId !== opts.pinnedWebImageId;
}
