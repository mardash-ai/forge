Platform capability **C3 · Application event log** is 🟢 **Ready for adoption**.

I'm the platform-builder; you're the forge-os agent. **The write baton is now yours.** Adopt per
*Instructions for the forge-os agent (on adoption)* in PLATFORM_CAPABILITIES.md — don't re-grow the
`events` table.

- **Delivered images (pin both — R1, no `latest`):**
  - `FORGE_IMAGE=ghcr.io/mardash-ai/forge-control-plane:0.7.0@sha256:b4933e46be6af26a655fa565bf3698ad2131fee9412db2ffcc637a86b27b9d6e`
  - `FORGE_DATA_PLANE_IMAGE=ghcr.io/mardash-ai/forge-data-plane@sha256:107ecff57355eee25f58e0cf4c84a1019d844eaaffaf9c0ead50b01bd5a088cb`
- **Ledger:** the C3 **Platform delivery** block is filled — that's your spec. Start there.
- **Consume it** (app→Forge, over HTTP; the running app calls Forge):
  - Base URL `FORGE_EVENTS_URL` — prod `http://data-plane:3718`, dev `http://host.docker.internal:3717`.
  - *emit* (best-effort, swallow errors): `POST ${FORGE_EVENTS_URL}/app-events {type, subject?, data?}`
  - *feed*: `GET ${FORGE_EVENTS_URL}/app-events?subject=&limit=` → `{events}` newest-first
  - *latest-by-subject*: `GET ${FORGE_EVENTS_URL}/app-events/latest` → `{latest: {subject: ISO}}`
  - `AppEvent { id, app_id, type, subject?, data, at }`. Map `subject = goalId`; put `taskId`/titles/from/to in `data`.
- **Wire it in:** bump BOTH images; add `FORGE_EVENTS_URL` to the `web` service in `compose.prod.yaml`
  (`http://data-plane:3718`) and the dev `app/compose.yaml` web env (`http://host.docker.internal:3717`);
  add `app/lib/forge-events.ts` (three `fetch` wrappers; emit swallows errors). No package.json dep.
- **Refactors OUT:** delete the `events` table + indexes + `recordEvent`/`listEvents`; each mutation
  calls `emit`; `/api/events` becomes a thin proxy over `feed`; move cold-goal detection to
  `latest` + your goal list. **Keep** `app/lib/timeline.ts` presentation (that's domain).
- **Verify:** `curl -X POST $FORGE_EVENTS_URL/app-events -d '{"type":"goal.created","subject":"g1"}'`
  → `{event}`; `GET /app-events` newest-first; `forge inspect app-events --app <app>`.
- **Graceful degradation:** if `FORGE_EVENTS_URL` is unset / the sidecar is down, the client swallows
  → `[]`/`{}`, app stays up (empty timeline, no crash).

When done: pin both `tag@digest`, fill the **Adoption** block, update the metric (`lib/db.ts` should
shrink as the `events` table + queries leave), set the C3 row **✅ Owner → —**, append to the Handoff
log, commit, and tell the human. If the delivery block is missing anything, set it ⛔ Owner →
platform-builder with the gap instead of guessing.

**Next per sequence after C3:** C1 (Agent runtime) or C4 (Notifications, needs C2+C3) — your call with the human.
