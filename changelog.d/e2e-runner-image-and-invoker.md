### Changed

- **e2e-runner Cloud Run Job image**: replaced the `us-docker.pkg.dev/cloudrun/container/hello`
  placeholder with the real forge control-plane image, digest-pinned on every infra CI run.
  The infra workflow now runs a `t-runner-image` step that reads the `Docker-Content-Digest` of
  `ghcr.io/<owner>/forge-control-plane:latest` via the OCI Distribution v2 API and injects it as
  `TF_VAR_runner_image` for plan/apply/drift-check — no manual out-of-band image update needed.
  Removed `lifecycle.ignore_changes` on the job image field; Terraform now manages the image from
  the CI-resolved digest.

- **e2e-runner container command/args**: added `command = ["./node_modules/.bin/tsx", "src/cli/index.ts"]`
  and `args = ["eval"]` to the Cloud Run Job container spec. The job's default execution is
  `tsx src/cli/index.ts eval`; suite-specific arguments (`suite-file`, `--app`, `--mcp-url`) are
  supplied by the invoker at execution time via `gcloud run jobs execute --args`.

### Added

- **`roles/run.invoker` on the e2e-runner job** (job-level only, not project-level): added
  `google_cloud_run_v2_job_iam_member.console_invoker` granting `run-forge-console@dorinda-prod.iam.gserviceaccount.com`
  the `roles/run.invoker` role scoped exclusively to the `e2e-runner` Cloud Run Job. This enables
  the forge console to trigger E2E runs without any project-wide role.

- **Multi-arch control-plane image** (`publish-image.yml`): added `linux/amd64` (via QEMU on the
  arm64 runner) alongside `linux/arm64`. The OCI index manifest covers both platforms — Cloud Run
  (x86) picks `amd64`; the Apple Silicon Mac mini picks `arm64`.

- **`packages: read` permission** on `infra.yml` so `GITHUB_TOKEN` can authenticate the GHCR
  digest lookup in the `t-runner-image` step.

- **`variable "invoker_member"`** in the e2e-runner module, defaulting to
  `serviceAccount:run-forge-console@dorinda-prod.iam.gserviceaccount.com`; overridable when
  adopting the module in a different project.
