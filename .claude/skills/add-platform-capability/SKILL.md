---
name: add-platform-capability
description: >-
  Build and deliver the next Forge platform capability that forge-os needs — the
  platform-builder agent's turn, codified. Use whenever the human asks to advance the
  platform-capabilities queue / work the wind-tunnel ledger / build the next Cn / hand a
  capability to the forge-os agent. Reads ../forge-os/PLATFORM_CAPABILITIES.md (the two-agent
  relay contract), picks the next capability by the Recommended sequence, implements it in THIS
  Forge repo per the Domain Model + 06_FORGE_REPOSITORY recipe, validates it, publishes a
  version-pinned control-plane image (tag @ sha256:digest, R1), fills the Platform delivery block
  and sets the row 🟢 Ready, then emits a relay prompt for the human to paste to the forge-os
  agent. One invocation = one adoptable capability (R2: one at a time).
---

# Add a Platform Capability (the platform-builder's turn)

This repo (`forge`) **is the Forge platform**. The sibling repo `../forge-os` is a **black-box
consumer** — an app that pressures Forge into growing. The two are built by two different agents
that **never talk directly**; a human relays between them through one shared file:

> **`../forge-os/PLATFORM_CAPABILITIES.md`** — the wind-tunnel ledger and the contract between the
> **forge-os agent** (records pressure, adopts capabilities) and **you, the platform-builder agent**
> (build capabilities here, hand them over). That file's own instructions are authoritative; this
> skill is how you execute *your* side of the loop, end-to-end, in one invocation.

You run this skill when the human says something like *"build the next platform capability"* /
*"advance the ledger"* / *"work capability Cn"*. One run takes exactly **one** capability from the
queue all the way to **🟢 Ready for adoption** and produces a **relay prompt** the human pastes into
the forge-os session.

**You build only in this repo.** Read `../forge-os` files **read-only** (the reference
implementation is your behavioral spec). Never edit forge-os app code, its specs, its *Refactors
OUT* plans, or its *Adoption* blocks. The **one** file you may write in forge-os is
`PLATFORM_CAPABILITIES.md`, and only the platform-builder-owned fields (see *Edit discipline* in
that file).

---

## The loop (one invocation)

```
0. Orient   → read the ledger; guard R2 (nothing already 🟢) + branch=main
1. Pick     → next capability by Recommended sequence, honoring deps; CONFIRM with the human
2. Spec     → read the forge-os Reference implementation READ-ONLY; Required semantics = acceptance
3. Design   → Capability(behavior) / Resource(state) / Event(fact); pick the app-facing consume path
4. Build    → implement in src/ per 06_FORGE_REPOSITORY + the Implementation Map (CLAUDE.md)
5. Validate → make test + typecheck green; re-check Required semantics + graceful degradation
6. Publish  → update CHANGELOG.md (new X.Y.Z) → /commit-and-publish (minor) → wait for CI →
              resolve tag @ sha256:digest  (R1)
7. Deliver  → fill the Delivery block + Runtime table, set 🟢/owner→forge-os, Handoff log; commit
              ONLY the ledger in ../forge-os  (R1 + R2)
8. Relay    → print the forge-os adoption prompt AND write it to relays/<Cn>-adopt.md
```

Two rules from the ledger bind every run and a violation makes the turn **incomplete**:

- **R1 · Pin every image.** Every delivered version is a concrete `tag @ sha256:digest` — never
  `latest`, never a bare tag. On the **first** run, if the ledger's *Runtime & version → Baseline*
  still says `latest`, pin it to a real digest as your first ledger edit.
- **R2 · One capability per relay.** Set **exactly one** row to 🟢 and then stop. If a row is
  **already** 🟢 (awaiting forge-os adoption) when you start, **do not** build another — tell the
  human to get that one adopted first.

---

## 0. Orient — read the ledger, run the guards

1. **Read `../forge-os/PLATFORM_CAPABILITIES.md` in full.** It is the source of truth for status,
   ownership, the field templates, the Recommended sequence, and R1/R2. Re-read it each run — it
   changes between turns.
2. **Guard R2.** Scan every `Cn` status. If **any** capability is already **🟢 Ready for adoption**
   (or 🔵 In progress by you), STOP. Report which one and tell the human it must reach ✅ (or be
   bounced ⛔) before you hand over another. Do not proceed.
3. **Guard the repo & branch.** You publish from `main`. Confirm `git branch --show-current` is
   `main` and the working tree is clean enough that `/commit-and-publish`'s `git add -A` will commit
   only your capability work (stash or surface anything unrelated first). `package.json` name must be
   `forge`.
4. **Guard ⛔ rows you own.** If a row is ⛔ with Owner → platform-builder, prefer resolving it.

## 1. Pick the next capability (auto → confirm)

- Compute the next capability from the **Recommended sequence** in the ledger, **honoring
  dependencies first** (e.g. C4 needs C2 + C3; don't deliver a capability whose deps aren't yet at
  least 🟢/✅). Skip anything already ✅.
- If the human named a capability (e.g. "C5"), use it — but still validate it against dependencies
  and R2, and say so if it's out of sequence.
- **Show your pick and your reasoning, then confirm with the human before building** (this is the
  one interactive checkpoint). If you reorder away from the Recommended sequence, note *why* — you'll
  record that in the Handoff log too.

## 2. Spec — the forge-os reference implementation is your behavioral spec

For the chosen `Cn`, open the files under *Reference implementation* **read-only** (they live under
`../forge-os/app/…`). They are a **working, verified example** of the exact behavior forge-os will
re-verify before deleting its stopgap.

- Treat the **Required semantics** bullets as **acceptance criteria** — the forge-os agent will
  check *precisely* those. Your implementation is done when every one is satisfiable through the
  contract you ship.
- Note the **Refactors OUT** list (forge-os's plan) so your contract actually lets them delete that
  code — but **do not** implement or edit anything in forge-os.
- Honor **graceful degradation**: when the capability is absent/unconfigured, the app must be able to
  *detect* that and degrade (e.g. C5 keeps the "503 when no key" behavior; C1 stays detectable).
  Your contract must expose that detectability.

## 3. Design — stay inside the Domain Model

Separate the concepts (see CLAUDE.md *Core Mental Model* + Load-Bearing Rules):

- **Capability** = the behavior/contract (`src/capabilities/<slug>/`). Behavior lives here, never in
  a Resource.
- **Resource** = durable state it creates/evolves (`src/resources/types.ts`). State lives here,
  never in a Capability.
- **Event** = immutable facts it emits (`src/events/catalog.ts`).
- **Policy / Permission** = governance + authorization the core checks (`src/policies/`,
  `src/permissions/`).
- **Implementation / Plugin** = only at a **real technology boundary** (`src/plugins/<impl>/` — e.g.
  a model provider for C1, a scheduler engine for C2, a secrets backend for C5). Do **not** create a
  plugin for business logic or speculative abstraction.

Then decide the **app-facing consume mechanism** — this is what you must document unambiguously so
forge-os can write against it. Pick the one that fits and keep humans and agents on the *same*
contract:
- a new **`./forge <subcommand>`** (CLI over the control-plane API), and/or
- an **HTTP endpoint** on the control-plane API (`src/api/server.ts`) the app calls (document base
  URL + auth reach), and/or
- an **npm client** the app adds to `app/package.json`, and/or
- **env-provided / injected** runtime config.

Long-running work returns a **Resource** the caller observes (202 + resource), not a blocked call.

## 4. Build — implement in this repo

Follow the **"Adding a Capability"** recipe in `docs/06_FORGE_REPOSITORY.md` and the
**Implementation Map** in `CLAUDE.md` (both at the repo root):

1. Define the Capability contract + input schema in `src/capabilities/<slug>/index.ts`.
2. Define/extend the Resource shape in `src/resources/types.ts`.
3. Define the Events in `src/events/catalog.ts`.
4. Add Policy/Permission needs in `src/policies/` / `src/permissions/` if required.
5. Add **one** Implementation; make it a Plugin under `src/plugins/<impl>/` **only** at a genuine
   technology boundary.
6. Expose it through the interfaces: API route in `src/api/server.ts`, CLI in `src/cli/index.ts`
   (keep output compact — every returned token costs money, see `src/cli/render.ts`).
7. **Register** the Capability in `src/capabilities/index.ts`.
8. If the control-plane Docker image needs new files/dirs or deps, update the `Dockerfile` COPY
   lines (and `compose.yaml` bind mounts for live iteration) — per CLAUDE.md's operational notes.

Keep the core boring and provider-agnostic; keep provider specifics inside the plugin.

## 5. Validate (before you publish — don't push red to `main`)

- Run the platform's own suite: **`make test`** (vitest inside the container). Add/extend tests that
  cover the capability's **Required semantics** and its **absence/degradation** path.
- **Typecheck.** CI (triggered by the push in step 6) runs `tsc --noEmit` + tests as the hard gate,
  but catch failures locally first (e.g. `make shell` → `npm run typecheck`, or run `tsc` in the
  container). A red push blocks the release.
- Re-read the **Required semantics** and confirm each is now satisfiable through your contract, and
  that **graceful degradation** is expressible (the app can detect absence).

## 6. Publish a version-pinned control-plane image (R1)

The Delivery block is worthless without a concrete `tag @ sha256:digest`, so you must ship an image.

1. **Update `CHANGELOG.md`** (repo root) so the release records itself — this MUST happen *before*
   the next step, so `/commit-and-publish`'s `git add -A` folds it into the release commit.
   - **Compute the target version.** A capability is a feature → a **minor** bump: take
     `package.json`'s current `X.Y.Z` and increment the minor, reset patch to 0 (e.g. `0.2.0 → 0.3.0`).
     Use that same directive in the next step so the numbers match.
   - **Add a `## [X.Y.Z] — <today>` section** (get today's date from the environment) just below
     `## [Unreleased]`, in [Keep a Changelog](https://keepachangelog.com) style — group entries under
     **Added / Changed / Fixed / Removed**. Describe the capability and any behavior change (e.g. a
     new provision flag or compose output). **Move any existing `## [Unreleased]` items** into this
     new section, leaving `## [Unreleased]` empty.
   - **Update the compare-link footer:** point `[Unreleased]` at `compare/vX.Y.Z...HEAD` and add
     `[X.Y.Z]: …/compare/v<prev>...vX.Y.Z`.
   - Keep it a control-plane changelog (platform changes), not a forge-os one; the forge-os ledger is
     the separate handoff record.
2. **Ship it** via the existing release flow — invoke **`/commit-and-publish minor`** (the same
   directive whose version you computed above; override only if the ledger/human dictates). That
   commits your `src/` changes **and `CHANGELOG.md`**, pushes `main` (runs CI), and pushes a `vX.Y.Z`
   tag which triggers **`Publish control-plane image`** →
   `ghcr.io/mardash-ai/forge-control-plane:X.Y.Z` + `:latest`.
   > Only your capability code + the changelog should be in that commit — the ledger lives in forge-os
   > and is committed separately in step 7.
3. **Wait for the publish to finish**, then **resolve the digest** (no `latest`, ever):
   - Prefer, if `gh` is available: `gh run watch` the *Publish control-plane image* run.
   - Resolve the digest without pulling:
     ```bash
     docker buildx imagetools inspect ghcr.io/mardash-ai/forge-control-plane:X.Y.Z \
       --format '{{.Manifest.Digest}}'
     ```
     Poll every ~30s until it returns a `sha256:…` (it appears once CI has pushed). If it errors on
     auth, `docker login ghcr.io` first. If tooling is unavailable, ask the human to paste the digest
     from the GHCR package page — do **not** fabricate one.
   - Record the full pin: **`X.Y.Z @ sha256:<digest>`**.
4. **R1 baseline (first run only).** If the ledger's *Runtime & version → Baseline* still says
   `latest`, resolve the digest of the current published baseline image (the version *before* this
   one) and pin it there as the floor — your first ledger edit.
5. Note whether the **app base image** (`node:22-…` in `app/compose.yaml`) must change — usually it
   does **not**; only mention it if consuming the capability requires it.

## 7. Deliver — fill the ledger and hand ownership over (R1 + R2)

Edit `../forge-os/PLATFORM_CAPABILITIES.md` — **only** the platform-builder-owned fields:

1. **Platform delivery block** for `Cn` — fill it **completely** against that file's field template
   (*What each side records → Platform delivery block*). Missing any field means forge-os bounces it
   ⛔, so cover every one:
   - **Delivered in** — `X.Y.Z @ sha256:<digest>` + the platform commit/tag ref (and app base-image
     tag *iff* it must change).
   - **Consume it** — the exact interface: mechanism (`./forge <cmd>` / HTTP method+path+how base
     URL & auth reach the app / npm package+version / injected/env), request+response **types**, and
     every **failure mode**.
   - **Wire it in** — image bump (from → to `FORGE_IMAGE`), any `./forge provision --<flag>`, new
     compose service/env var, `app/package.json` dep. If nothing changes: "no runtime change."
   - **Detect absence / degrade** — how the app tells it's unavailable/unconfigured.
   - **Verify** — a concrete call/command with expected output the forge-os agent can run.
   - **Data & migration** — clean cutover vs. import path.
   - **Compatibility / breaking** — impact on already-adopted capabilities / re-provision needs.
2. **Runtime & version table** — fill the `Cn` row's *Delivered in* (and the Baseline pin if step 6.4
   applied).
3. **Status → 🟢 Ready for adoption, Owner → forge-os.** Set exactly this one row (R2).
4. **Handoff log** — append one line: `| Cn | → 🟢 | platform-builder | <image tag / commit> | <note> |`.
   Record any deliberate reordering here.
5. **Commit the ledger in forge-os** — stage **only** that file and commit it there:
   ```bash
   git -C ../forge-os add PLATFORM_CAPABILITIES.md
   git -C ../forge-os commit -m "chore(ledger): Cn delivered — 🟢 ready for adoption (X.Y.Z@sha256:…)"
   ```
   Do **not** `git add -A` in forge-os and do **not** touch any other forge-os file.

## 8. Relay — hand the prompt to the human

Produce the **forge-os adoption prompt** (template below), filled for this capability. **Print it in
the transcript** and **write it to `relays/<Cn>-adopt.md`** in this repo (create `relays/` if
needed) so the human has a durable copy. Then report, in the transcript: which `Cn` shipped, the
`X.Y.Z @ sha256:digest`, the forge commit/tag, the forge-os ledger commit, and that it's now
**forge-os's turn** (R2: you will not build another until this reaches ✅).

### Relay prompt template

````text
Platform capability **<Cn> · <name>** is 🟢 **Ready for adoption**.

I'm the platform-builder; you're the forge-os agent. Adopt it by following
*Instructions for the forge-os agent (on adoption)* in PLATFORM_CAPABILITIES.md — do not
re-grow a stopgap.

- **Delivered image (pin this exactly — R1, no `latest`):**
  `FORGE_IMAGE=ghcr.io/mardash-ai/forge-control-plane:X.Y.Z@sha256:<digest>`
- **Ledger:** the `<Cn>` **Platform delivery** block is filled — that's your spec. Start there.
- **Consume it:** <one-line summary of the mechanism + where the full signature is in the block>
- **Wire it in:** <image bump + any provision flag / env / dep — or "no runtime change">
- **Verify:** <the concrete call from the Delivery block's Verify field>
- **Refactors OUT:** <the tables/files/routes to delete, per the block> — keep the domain code.
- **Graceful degradation:** confirm <the absence-detection behavior> still holds.

When done: pin the exact `tag@digest` in `app/compose.yaml`/`FORGE_IMAGE`, fill the **Adoption**
block, update the metric (e.g. `lib/db.ts` line count), set the row **✅ Owner → —**, append to the
Handoff log, commit, and tell me (the human) so I can relay the next one. If the block is missing
anything you need, set it ⛔ Owner → platform-builder with the gap instead of guessing.
````

---

## Guardrails (do not violate)

- **Never edit forge-os** except `PLATFORM_CAPABILITIES.md` (platform-builder fields only). App code,
  specs, *Refactors OUT*, and *Adoption* blocks are forge-os's.
- **R1:** no `latest` / bare tag / missing digest anywhere you write.
- **R2:** exactly one row goes 🟢 per run; never two; never proceed if one is already 🟢.
- **Domain purity:** behavior→Capability, state→Resource, facts→Event; plugins only at a real tech
  boundary; the API exposes `Build`/`Deploy`/… never "run <tool>".
- **Don't invent capabilities.** Add a new `Cn` row only for a real forge-os need; if you're blocked
  by something only forge-os can supply, set the row ⛔ Owner → forge-os and say what you need.
- **Compact output** everywhere the app consumes — every returned token costs money.

## Definition of done

`make test` + typecheck green · **`CHANGELOG.md` updated with the new `X.Y.Z` section** (in the
release commit) · a version-pinned image published (`X.Y.Z @ sha256:digest`) · the `Cn` Delivery
block + Runtime table filled completely · row 🟢 Owner → forge-os · Handoff log appended · ledger
committed in forge-os · relay prompt printed **and** saved to `relays/<Cn>-adopt.md` · exactly one
capability handed over (R2). Then it's the human's turn to relay.
