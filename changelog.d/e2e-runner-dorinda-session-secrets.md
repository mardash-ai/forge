### Added

- Two enduring Secret Manager secrets (`e2e-runner-dorinda-email`, `e2e-runner-dorinda-password`) in the e2e-runner terraform module; both are OOB-seeded and follow the same placeholder-version + `ignore_changes` pattern as the existing MCP credential containers.
- `DORINDA_EMAIL` and `DORINDA_PASSWORD` environment variables wired into the Cloud Run Job via `secret_key_ref`, enabling the runner to mint a `forge_session` at run start. The session itself is short-lived and is never stored anywhere.
- `roles/secretmanager.secretAccessor` granted to the `e2e-runner` service account on each new secret (resource-scoped only — no project-level grant), preserving the existing per-secret least-privilege separation.
- Two `forge.infra.json` verify checks that read the job's live environment back and assert both secret-backed env references are present after apply.
- `PROVIDER_ACCOUNTS.md` entries for both new secrets, explicitly noting the `forge_session` is minted at run start and never stored.
