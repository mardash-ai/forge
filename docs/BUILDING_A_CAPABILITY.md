# Building a Forge capability — the pre-ship requirements checklist

> **Read this before adding or extending a capability.** A capability isn't "the feature code" — it's the
> feature code **plus** everything productionize, the operator runbook, and the deploy need in order for it
> to actually work in production. The recurring failure mode is shipping the runtime code and forgetting the
> **wiring** — most often a provider secret that never reaches the tier that reads it. That is exactly how
> billing shipped broken (`billingNotConfigured()` on every checkout even though `.env.prod` was correct):
> the Stripe secret was never injected into the data-plane, because productionize had no billing
> secret-injection path. This checklist exists so that never happens silently again.

Work top-to-bottom. Every box that applies must be checked **in the same change** — not "later".

---

## 0. Which tier runs it, and which host serves it

Answer these first — they decide everything below.

- **Which tier executes the capability?**
  - **Data-plane sidecar** (`forge-data-plane`) — hosts the platform capabilities: C1 agent runtime, C2
    scheduler, C5 secrets vault, C10 `/auth/*`, C-billing `/billing/*` + `/hooks/billing/stripe`, MCP,
    webhooks. **Machine-facing + anything that calls a third-party API with a secret runs here.**
  - **Web tier** (the Next.js app) — SSR + the BFF/proxy. It proxies `/auth/*`, `/billing/*`, etc. to the
    sidecar. **It rarely needs the provider secret itself** (e.g. it never calls Stripe — it proxies to the
    sidecar that does).
- **Which host serves it?** `api.<domain>` = the client-agnostic backend (MCP, webhooks, platform auth).
  `app.<domain>` = the browser BFF (HttpOnly cookies, SSR, same-origin proxy). Machine-facing → `api`;
  interactive browser OAuth → `app`. Never overload the web BFF into a universal backend.

If the capability reads a secret **on the data-plane**, you MUST do §1. This is the most-missed step.

---

## 1. Secret injection (the step billing missed) — MANDATORY if the capability reads any secret

Productionize (`src/plugins/productionize-nextjs-compose/index.ts`) is the **only** thing that puts env on
the containers. A value in `.env.prod` reaches a container **only** if that container's compose env
references it. So a provider secret the sidecar needs must be **wired by productionize into the data-plane**,
or the sidecar boots without it and the capability reports not-configured.

Follow the established pattern (P34 auth = the reference; P41 billing = the most recent copy of it):

- [ ] **Define the provider-var set** as a module const, next to `AUTH_PROVIDER_VARS` / `BILLING_PROVIDER_VARS`.
- [ ] **Pick the "uses X" marker.** A capability is "in use" when the app declares a marker secret — auth:
      `AUTH_SESSION_SECRET`; billing: any `STRIPE_*` (the `STRIPE_PRICE_*` catalog). Gate the wiring on it
      (`usesAuth` / `usesBilling`).
- [ ] **Wire into the correct tier, defined-but-empty.** Mirror `dpAuthProviderEnv` / `dpBillingProviderEnv`:
      `MARKER ? VARS.filter(v => !secrets.includes(v)).map(v => \`      - ${v}=\${${v}:-}\`) : []`, then
      `dpEnv.push(...)`. `${VAR:-}` = defined-but-empty so absence is **detectable, not a crash**. Put it on
      the tier that reads it (usually **data-plane only** — do NOT leak a secret key onto the web tier).
- [ ] **Deploy-required?** Only use `${VAR:?reason}` (fail the deploy loudly) if an unset value **silently**
      breaks the capability outright (e.g. `AUTH_SESSION_SECRET` logs everyone out). Otherwise `${VAR:-}`.
- [ ] **Add a C13 catalog entry** in `secret-catalog.ts` (`SECRET_CATALOG`): `capability`, `requirement`,
      `what`, `requires_note`, `obtain` (exact dashboard steps / generate command). `describeSecret` falls
      back to a bland generic without this — the operator docs will be useless.
- [ ] **Surface it in the operator docs** (`generateEnvProdExample` + `generateProvisioningRunbook`): add a
      `usesX` block that lists the undeclared provider vars with "fill `.env.prod` + redeploy" guidance and
      any host-substituted endpoint (e.g. the webhook URL). Mirror the P34/P41 blocks.

**Reference implementation to copy:** search the plugin for `P41` (billing) or `P34` (auth) — the const, the
`usesBilling`/`usesAuth` gate, the `dp*ProviderEnv`, the env-example block, and the runbook block are all
tagged. Copy that shape exactly.

---

## 2. Durable state + compose wiring

- [ ] **Durable state on a NAMED volume.** Anything the capability persists on the sidecar (auth/session
      store, vault, job state) must live under a declared named volume (`forge_state:/forge-state`), or a
      deploy recreates the sidecar and wipes it. There's a deploy-survival test guarding this — add one if
      your capability persists new state.
- [ ] **Digest-pin images (R1).** Any image reference is `tag@sha256:…`, never `latest`.
- [ ] **`depends_on` + healthcheck** if the capability needs Postgres/another service up first.

---

## 3. Zero-drift docs (a capability isn't done until these match its behavior)

Other agents read these to decide actions, including destructive ones — a stale description is a real bug.

- [ ] **Agent-facing MCP docs** — tool descriptions (`.../mcp/tools.ts`), `contract/mcp-tools.json`, and the
      MCP instructions/"training" block. Update the description + risk/gate label in lockstep with behavior.
- [ ] **Admin / in-app help docs** — the app's `public/docs/*.html` + AdminScreen page for the feature.
- [ ] **`PROVIDER_ACCOUNTS.md`** — any new external account, OAuth client, redirect/webhook URL, scope, or
      key location. Never let account config drift from code.
- [ ] **The C13 catalog + `PROVISIONING.md`** (covered in §1) — the generated per-app runbook.

---

## 4. Tests — in the tool's OWN suite, proven to be real guards

- [ ] **Unit-test the wiring in `tests/productionize.test.ts`** (use the `serviceBlock(yaml, 'data-plane')`
      helper): positive (marker present → var wired), negative (no marker → not wired), dedup (declared +
      auto-wired → emitted once), and docs surfacing (env-example + runbook).
- [ ] **Prove the guard fails without the fix.** Temporarily disable the wiring line, run the test, watch it
      go red, restore. A test that passes with and without the fix guards nothing.
- [ ] **`npx tsc --noEmit` clean** + the full suite green.

---

## 5. Release + adopt (the change isn't rolled out until this is done)

- [ ] **Bump the version** (`package.json` + `package-lock.json`), add a CHANGELOG entry (semver: additive
      capability wiring = minor).
- [ ] **Tag `vX.Y.Z` + push** → CI publishes the control-plane **and** data-plane images in lockstep
      (`.github/workflows/publish-image.yml` + `publish-data-plane.yml`). `forge productionize` ships **in the
      control-plane image**, so a productionize change only reaches consumers once the CP image is released
      **and** the consumer's box CP is on that version.
- [ ] **Adopt in the consumer** — bump its `data_plane_image` (and box CP) to the new version, regenerate its
      compose with the released productionize, and **delete any per-app stopgap** (a workaround declared in
      `forge.app.json`/`.env.prod` to paper over the missing wiring). Deleting the stopgap is only safe once
      the box CP runs the fixed productionize — otherwise a formal `make deploy` regen drops the wiring.

---

## The 30-second self-check before you call it done

1. Does the capability read a secret on the data-plane? → Is it **wired by productionize** (§1), in the
   catalog, and in the generated runbook?
2. Is there a **test that fails without the wiring** (§4)?
3. Do the **MCP + admin + PROVIDER_ACCOUNTS** docs match the new behavior (§3)?
4. Is it **released** (tag + CI) and **adopted** with the stopgap removed (§5)?

If any answer is "no", it's a half-fix — see the `durable-fixes-by-default` rule.
