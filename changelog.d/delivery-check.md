---
bump: minor
---

### Added

- **C38 DeliveryCheck capability** — guards all four hops of the delivery pipeline (commit→tag, tag→image, image→deploy, release→consumer pin).
  - **Producer check**: fails the build when `main` carries source commits not included in any release tag; names the exact commit count and artifact, states the remedy.
  - **Release check**: fails the build when the deployed service is not running the latest release digest (tag's image not in GHCR, or `deployment.json` tracking shows a digest mismatch); names the specific image artifact and expected digest.
  - **Consumer check**: fails the build when a consumer's pinned version lags the producer's latest release; names the specific pinned artifact and the remedying update.
  - Every failing check exits non-zero, names the specific artifact that is behind, and states the concrete remedy — a warning-only or pass-only check was rejected.
  - A lag is silenced **only** by an explicit `.delivery-silence.json` in the repo with a non-empty `reason` field (and optional `expires` date); there is no default silencing.
  - Forge's own producer and release checks are wired through the capability and proven RED (main ahead of newest release / deployment off the release digest) then GREEN in 29 unit tests using fake drivers that reconstruct each behind-state.
- **`scripts/delivery-check.ts`** — standalone CI runner (`npx tsx scripts/delivery-check.ts producer release`) that exits 1 on any unsilenced failure.
- **`.github/workflows/delivery-check.yml`** — GitHub Actions workflow running both forge producer and release checks on every push to `main` and on a daily schedule (08:00 UTC); uses `packages:read` to resolve GHCR digests for the release check.
- **`deployment.json`** tracking format — records the deployed digest per image; updated by the release/deploy process; read by the release check driver.
- `DeliveryCheckRun` resource type and `DeliveryCheckCompleted` / `DeliveryCheckFailed` events added to the platform catalog.
