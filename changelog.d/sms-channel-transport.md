---
bump: minor
---

### Added

- **SMS delivery channel (C21)**: `Channel` union now includes `'sms'`; the push/email if-ladder in `src/notifications/delivery.ts` is refactored into a `CHANNEL_REGISTRY` — adding a new channel is one entry, the `notify()` control flow never changes.
- **`twilio-sms` plugin** (`src/plugins/twilio-sms/`): raw Twilio Messaging REST (no SDK dependency), swappable `SmsTransport` seam for tests, `appendOptOut()` helper, TwiML builder, and the carrier-registered `HELP_REPLY` exact string. Delivery is inert when `SMS_DELIVERY_ENABLED` env is not `"true"`.
- **Phone fields on `StoredUser`**: `phone`, `phone_verified_at`, `sms_consent_at`, `sms_opt_out`, `sms_opt_out_at` — schema migration lands idempotently on both the FS backend (optional fields, backward-compatible JSON) and the PG backend (five `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements + phone lookup index).
- **Phone verification flow** (`POST /auth/phone/send-code`, `POST /auth/phone/verify-code`): reuses the email-2FA OTP hashing + attempt-cap machinery (`putTwofaCode` / `redeemTwofaCode`, purpose `'phone_verify'`); confirmation stamps `phone_verified_at` + `sms_consent_at` (opt-in consent timestamp).
- **Inbound Twilio webhook** (`POST /hooks/sms/twilio`): handles STOP/START/YES/UNSTOP/HELP keywords per TCPA/CTIA requirements; replies with carrier-registered TwiML copy; STOP records opt-out; START/YES/UNSTOP re-enables only when prior `sms_consent_at` exists (never creates opt-in from inbound keyword alone); HELP returns the exact registered string.
- **C5 secret catalog entries**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `SMS_DELIVERY_ENABLED` in `productionize-nextjs-compose/secret-catalog.ts` with what/why/how-to-obtain prose.
- **`PROVIDER_ACCOUNTS.md`** Twilio section: credentials, inbound webhook URL, carrier registration checklist.
- **`findByPhone`** on both `FsIdentityBackend` and `PgIdentityBackend` (required by the inbound webhook to resolve opt-out/opt-in state by E.164 number).
