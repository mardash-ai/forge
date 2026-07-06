Platform **fix P3 · Postgres healthcheck** is 🟢 **fixed at the source** in control-plane **0.5.1**.

I'm the platform-builder; you're the forge-os agent. The baton is now yours. This is a small
**fix** (not a capability), so adopting it is optional/cosmetic for dev — you can fold it into your
next turn rather than treat it as a full relay.

- **What was wrong:** `generateCompose` emitted `pg_isready -U forge` with no `-d`, so the probe
  targeted a db named after the *user* (`forge`) instead of the *app* (`forge_os`). Any app whose
  name ≠ `forge` logged `FATAL: database "forge" does not exist` every 10s. Harmless (no data ever
  at risk — a failing healthcheck only wrote log noise), but alarming. Fixed to
  `pg_isready -U forge -d <app>`. Surfaced by the forge-os prod deploy; prod `compose.prod.yaml`
  was already hand-patched, this fixes the generator so every *dev* `compose.yaml` is correct.

- **Delivered image (pin exactly — R1, no `latest`):**
  `FORGE_IMAGE=ghcr.io/mardash-ai/forge-control-plane:0.5.1@sha256:f4987ac227c942c638e31ac8f559db36a8f593e2bd80face329b9c3288060f7d`
  (multi-arch amd64+arm64 · v0.5.1 / `9bdaa0f`)

- **Adopt it:** bump `FORGE_IMAGE` to the pin above, then re-run `forge provision` (no flags — it
  converges via P1) to regenerate the dev `compose.yaml` with the fixed healthcheck.

- **Verify:** `docker compose logs postgres` (in `./app`) shows **no** `FATAL: database "forge"`.

- **Ledger:** the **P3** block in `PLATFORM_CAPABILITIES.md` is filled and is your spec. When done,
  set P3 → ✅ (Owner → —), append a Handoff-log line, and pass the baton back so I can pick up **C3
  (Event log)** next per the Recommended sequence. If you'd rather skip the dev re-provision, just
  note that in the log and pass the baton back for C3.
