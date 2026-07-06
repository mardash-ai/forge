Platform capability **C7 · Deploy** is ✅ **delivered AND adopted** (the human compressed the relay
into one session — platform + both consumers updated together).

- **Delivered image (pin — R1):**
  `FORGE_IMAGE=ghcr.io/mardash-ai/forge-control-plane:0.6.1@sha256:482bda5ccbf88c9d8b163d18dc34b6655ae8988e77ca6c3b2bdb90ab2a98c61e`
  (multi-arch; `v0.6.1` / commit `0115e04`; Deploy shipped in `0.6.0`, `0.6.1` made `--app` a soft label)
- **Capability:** `forge deploy --app <app> [--service web] [--context <docker-ctx>] [--compose-file compose.prod.yaml] [--proxy-net proxy] [--no-pull] [--drain-seconds 3] [--timeout-seconds 120]`
  — reconciles non-`--service` compose services in place, then rolls `--service` **start-first**
  (new replica up + Docker-healthy → drain old out of the proxy → remove). Auto-rollback if the new
  never gets healthy. Records a `Deployment` resource + `DeploymentStarted`/`Completed`/`RolledBack`.
- **Ledger:** the C7 **Platform delivery** + **Adoption** blocks are filled; row is ✅.

**Adopted in:**
- **forge-os** (`d367099`): `make deploy` → `make up` (transient control plane) → `./forge deploy
  --app forge-os --proxy-net proxy`. Deleted `deploy/rollout.sh`; pinned `FORGE_IMAGE`.
- **forge-starter** (`d20e511`): full prod pipeline that *consumes* `forge deploy` — `compose.prod.yaml`,
  `.env.prod.example`, `deploy/` (jobs + standalone `app-image/`), CI/publish workflows, `DEPLOY.md`,
  `make deploy`. No `rollout.sh`.

**Proven:** local 2-service roll — running container count **never hit 0** (start-first); the source
bash rollout showed **0 HTTP drops** live earlier this session; 52/52 platform tests + typecheck green.

**⚠ One open verification:** the forge-os **box** deploy path (transient control plane + `forge deploy`
on the box) is wired + documented but not yet run against the box — it needs the control-plane image
pulled there once (same keychain-over-SSH gotcha as the app image). Recommend a **supervised** first
`make deploy` on the box. The rollout algorithm itself is proven; only the box transport is new.

**Next per sequence:** C3 (Application event log). Baton → platform-builder.
