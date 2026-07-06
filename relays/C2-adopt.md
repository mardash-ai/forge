# Relay → forge-os agent · C2 · Scheduler  (paste the block below)

Platform capability **C2 · Scheduler / background jobs** is 🟢 **Ready for adoption**. The full spec is
the **C2 Platform delivery block in `PLATFORM_CAPABILITIES.md`** (your source of truth). The baton is yours.

- **Delivered image (pin exactly — R1, multi-arch `amd64`+`arm64`):**
  `FORGE_IMAGE=ghcr.io/mardash-ai/forge-control-plane:0.4.0@sha256:9d2166188eebc852f82d3f19f6d13674292e8bc6e6d641d4ca1a9ef311e71a47`
- **Plane (R3):** **data-plane** (the running scheduler that fires jobs in production); `forge schedule`
  / `jobs` is the control-plane management surface. v1 seam: the ticker runs inside the control-plane
  image for now.
- **Consume it:** `forge schedule --app <app> --name <n> --target <path> (--every <dur> | --cron
  "<expr>" | --at <iso>)`; `forge jobs` / `forge inspect jobs` to observe. On cadence Forge calls
  `<method> http://host.docker.internal:<web-port><target>` on your app — so expose that route and keep
  the app running (`forge dev`) for a call to land.
- **Wire it in:** bump `FORGE_IMAGE`; add **idempotent** cron endpoint(s) (e.g. `POST
  /api/cron/habits-finalize`, `POST /api/cron/reminders`); register jobs — `forge schedule --app <app>
  --name habits --cron "5 0 * * *" --target /api/cron/habits-finalize`; `... --name reminders --every
  15m --target /api/cron/reminders`. No `package.json` change.
- **Verify:** register `--every 30s --target /api/cron/ping`; `forge dev`; after a tick `forge jobs`
  shows `ping last=succeeded runs≥1`; `forge inspect events` shows `JobRan`; a `--cron "0 0 * * *"`
  job's `next_run_at` is the next UTC midnight; a malformed cron → **422**; `--remove` drops it.
- **Refactors OUT:** move Habits' *finalize/notify at the period boundary* and Reminders'
  *precompute/push* into scheduled cron endpoints. **Keep** the pure `computeStreak` + read-time
  derivation as the safety net (flip pull→push under C4 later).
- **Graceful degradation:** with no jobs (or an older image) the app behaves exactly as today — the
  read-time derivations still compute correct values on read. Keep the cron endpoints idempotent.

When done: pin the digest in `app/compose.yaml` (record under *Now runs on*), fill the **C2 Adoption**
block, set the row **✅ Owner → —**, append the Handoff log, and pass the baton back to
`platform-builder` for the next capability (**C3 · Event log**, per the sequence). If anything's
missing, set it ⛔ Owner → platform-builder with the gap instead of guessing.
