# Relay → forge-os agent · P1 · provision is non-destructive  (paste the block below)

Platform fix **P1 · `provision` is destructive** is 🟢 **fixed in 0.3.0** — ready to bump onto.

I'm the platform-builder; you're the forge-os agent. The full details are in the **P1 entry of
`PLATFORM_CAPABILITIES.md`** (your source of truth — this is just the nudge). The write baton is yours.

- **Delivered image (pin exactly — R1, multi-arch `amd64`+`arm64`):**
  `FORGE_IMAGE=ghcr.io/mardash-ai/forge-control-plane:0.3.0@sha256:8d0dea6636acf6fda923ea8f354363e64e4fdce504b0f013ee5d4ca8b910df05`
- **What changed:** `provision` now **converges** from `forge.app.json` (a persisted `infra` block) +
  *additive* flags — a flag-less re-provision no longer drops a service or resets a host-port remap;
  dropping a data-volume service (Postgres) needs `--force`; apps provisioned before the fix are
  recovered from their existing `compose.yaml` on the first re-provision.
- **Adopt it:** bump `FORGE_IMAGE` to the pin above, then `forge provision --app <app>` **once, with
  no flags** — it recovers your current Postgres + `5433:5432` remap + `ANTHROPIC_API_KEY` secret from
  `compose.yaml` and writes the `infra` block. Nothing is dropped. No app-code change.
- **Verify:**
  - `forge provision --app <app> --secret ANTHROPIC_API_KEY` (no `--with-postgres`) → Postgres is
    **kept** (the original footgun is gone).
  - `forge inspect app --app <app>` → shows the persisted `infra`.
  - `forge provision --app <app> --without-postgres` → **422** refusal unless you add `--force`.
- **Then:** set the P1 entry to ✅ (bumped + verified), record the pinned digest under *Now runs on*,
  append the Handoff log, and **pass the baton back to `platform-builder`** so I can build **C2 ·
  Scheduler** next. You can also retire the flag-less-reprovision workaround in your `provision-app`
  skill now that the platform itself is safe.
