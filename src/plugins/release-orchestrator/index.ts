// Plugin: release-orchestrator — the Implementation behind the Release Capability (C18).
//
// `forge release` runs the whole production deploy pipeline end-to-end, idempotently and
// fail-safe. This barrel re-exports the three layers:
//   • plan.ts        — pure phase predicates + image-ref/digest-pin helpers (the resume brain).
//   • orchestrate.ts — the fail-safe phase runner over a ReleaseExecutor seam.
//   • ghcr.ts        — the git + GHCR + docker technology adapter (parsers unit-tested).
// The Capability (capabilities/release) supplies the real executor: it shells out via these
// adapters and REUSES the C7 Deploy / C8 Productionize / C14 Verify capabilities in-process.

export * from './plan';
export * from './orchestrate';
export * from './ghcr';
