Platform capability **C4 · Notifications** is 🟢 **Ready for adoption**.

I'm the platform-builder; you're the forge-os agent. **The write baton is now yours.** Adopt per
*Instructions for the forge-os agent (on adoption)* — don't re-grow `dismissed_notifications`.

- **Delivered images (pin both — R1):**
  - `FORGE_IMAGE=ghcr.io/mardash-ai/forge-control-plane:0.8.0@sha256:95a2aead4549b59a1e36dbf1c24261f70eee3df698ab86f08a9e762786026354`
  - `FORGE_DATA_PLANE_IMAGE=ghcr.io/mardash-ai/forge-data-plane@sha256:7de5566e9292347fb2afda9a0fe1d67b554e491e9eb33f795f51edd68677a037`
- **Ledger:** the C4 **Platform delivery** block is your spec.
- **No new env** — reuse the `FORGE_EVENTS_URL` you already wired for C3 (`http://data-plane:3718`
  prod, `http://host.docker.internal:3717` dev). C4's routes are on the same servers.
- **Consume it** (extend `lib/forge-events.ts` or add `lib/forge-notifications.ts`):
  - *upsert* (idempotent by `key`): `POST ${base}/notifications { key, title, body?, data?, subject? }`
    → re-deriving the same condition updates in place and **preserves `dismissed` + `created_at`**.
  - *dismiss* (persists): `POST ${base}/notifications/dismiss { key }`
  - *clear* (condition gone): `POST ${base}/notifications/clear { key }`
  - *feed*: `GET ${base}/notifications?include_dismissed=` → `{ notifications }` newest-first
  - `Notification { key, title, body?, data, subject?, dismissed, created_at, updated_at }`.
- **Wire it in:** bump both images; on each derive (read-time now, a C2 job later) **upsert** current
  notifications + **clear** stale ones; **dismiss** on the inbox action; render from the **feed**.
- **Refactors OUT:** delete `dismissed_notifications` + the derive/dismiss/persist DB code; routes
  become thin clients. **Keep:** the inbox UI, the copy, and *which* conditions matter.
- **Verify:** `POST $FORGE_EVENTS_URL/notifications {"key":"cold:g1","title":"Goal g1 is cold"}`; a
  second identical POST doesn't duplicate; `/dismiss` hides it from `GET /notifications` (not from
  `?include_dismissed=1`); `/clear` removes it; `forge inspect notifications --app <app>`.
- **Graceful degradation:** sidecar down / older image → `[]`; app stays up (empty inbox, no crash).
- **"Produce while away":** register a **C2** job that upserts on cadence — the store is ready for it
  (external-channel push like email is future).

When done: pin both `tag@digest`, fill the **Adoption** block, update the metric (`lib/db.ts` should
shrink again as `dismissed_notifications` + its logic leave), set C4 **✅ Owner → —**, append to the
Handoff log, commit, and tell the human.

**Also on the platform-builder's plate (FYI):** **P4** (🔴 — `build`→`dev` corrupts `.next`), **C8**
(Productionize), **P2** (secrets unset). And **C1 (Agent runtime)** is next in sequence.
