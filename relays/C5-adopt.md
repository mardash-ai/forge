# Relay → forge-os agent · C5 · Secrets  (paste the block below)

Platform capability **C5 · Secrets / credential management** is 🟢 **Ready for adoption**.

I'm the platform-builder; you're the forge-os agent. Adopt it by following *Instructions for the
forge-os agent (on adoption)* in `PLATFORM_CAPABILITIES.md` — do not re-grow a stopgap.

- **Delivered image (pin this exactly — R1, no `latest`):**
  `FORGE_IMAGE=ghcr.io/mardash-ai/forge-control-plane:0.2.0@sha256:e396a891c7ad1a1f39d2f0aa4c019f90539a2f2efa01d29fe9d62e447a7dbda1`
  (baseline floor is `0.1.1@sha256:b2ba103f183fc8e1923129c077611379fb7265f9d688f54d0e96309a754478b3`.)
- **Ledger:** the **C5 Platform delivery** block is filled — that is your spec. Start there.
- **Consume it:** new `./forge` surface — `forge secrets set|list`, and declare a needed secret via
  `forge provision --app <app> --secret <NAME>` (or a `"secrets": ["<NAME>"]` array in
  `forge.app.json`). Values inject automatically into the container at `forge dev`. Full
  signatures / types / failure-modes are in the Delivery block.
- **Wire it in:**
  1. Bump `FORGE_IMAGE` to the pinned digest above.
  2. `forge provision --app <app> --secret ANTHROPIC_API_KEY` (regenerates `app/compose.yaml` with a
     Forge-managed `- ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}` line).
  3. `forge secrets set --app <app> --name ANTHROPIC_API_KEY --value <key>`
     (or `--from-env ANTHROPIC_API_KEY` if your `./forge` forwards the env into the CLI).
  No `app/package.json` change.
- **Verify:**
  - `forge secrets list --app <app>` → `[{"name":"ANTHROPIC_API_KEY","set":true}]`
  - `grep ANTHROPIC_API_KEY app/compose.yaml` → only `- ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}` (no value)
  - `forge dev --app <app>` then `POST /api/goals/<id>/plan` → **200** (a plan), not 503
  - `.forge/secrets/vault-*.json` holds ciphertext only — the key is in no tracked file or image layer
- **Refactors OUT:** delete the hand-added `ANTHROPIC_API_KEY=${…}` wiring you maintained, the
  `app/.env` key convention, and the `.env.example` key line — the compose line is now Forge-generated
  from your declaration. **Keep (domain):** the `isPlannerConfigured()` 503 semantics.
- **Graceful degradation:** confirm that with **no** secret set, `POST /api/goals/<id>/plan` still
  returns **503** and the app stays up.
- **⚠ Security:** a real key previously landed in a tracked file — **rotate `ANTHROPIC_API_KEY`**
  before storing it via `forge secrets set`.

When done: pin the exact `tag@digest` in `app/compose.yaml` / `FORGE_IMAGE` (record under *Now runs
on*), fill the **Adoption** block, note the metric (C5 doesn't touch `lib/db.ts`, so that count is
unchanged by this one — the debt paid down here is the `.env`/compose hand-wiring), set the row
**✅ Owner → —**, append to the Handoff log, commit, and tell me (the human) so I can relay the next
one (deferred sequence head: **C2 · Scheduler**). If the block is missing anything you need, set it
⛔ Owner → platform-builder with the gap instead of guessing.
