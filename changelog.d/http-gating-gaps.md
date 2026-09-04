---
bump: minor
---

### Fixed

- **Gap 1 — `POST /auth/admin/seed-owner` service-token gate:** the route was missing the `x-forge-service-token` check that its five `/auth/admin/*` siblings already enforced; the gate is now applied identically (constant-time compare, fails closed).
- **Gap 2 — App-facing module service-token gates:** applied the service-token gate uniformly to all app-facing data-plane routes: `/app-events`, `/notifications`, `/blobs`, `/authorize`, `/policies`, `/status/incidents`, `/owner/*`, `/search`, `/index`, `/roles`, `/groups/*`, `/identities/*`, and `/invitations/*`. The `compose.prod.yaml` / Cloud Run network boundary is documented as defence-in-depth, not the trust gate.
- **Gap 3 — Twilio webhook HMAC-SHA1 signature verification:** `POST /hooks/sms/twilio` now verifies the `X-Twilio-Signature` header (HMAC-SHA1 over URL + sorted form params, signed with `TWILIO_AUTH_TOKEN`) before any handler logic runs; missing or invalid signatures are rejected `403` with an empty TwiML response to avoid information leakage.
- **Gap 4 — `/auth/phone/*` production routing:** `registerSmsRoutes` (which mounts `/auth/phone/send-code` and `/auth/phone/verify-code`) is now registered on the data-plane server in addition to the control-plane API; the app's `next-config.ts` rewrites `/auth/:path*` to the data plane, so phone verification routes are now reachable in production.
- PROVISIONING.md and `docs/architecture/09-deployable-consumer.md` updated in the same commit to document the service-token gate scope, the network-boundary defence-in-depth note, the Twilio HMAC gate, and the data-plane SMS route registration.
