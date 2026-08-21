### Added
- `email:microsoft` sender registered in C25 `senders.ts` dispatch table — dispatches to `message-microsoft` plugin calling Microsoft Graph `POST /me/sendMail`, alongside the existing `email:google` entry
- `message-microsoft` plugin (`src/plugins/message-microsoft/index.ts`) — Graph sendMail implementation with `buildGraphSendBody`, `sanitizeError`, and a swappable `GraphMailSender` for test injection (synthesises a local UUID as `message_id` since Graph returns 202 with an empty body)
- Microsoft `ProviderDescriptor` in `src/connectors/providers.ts` with `account_label_claims: ['email', 'preferred_username']` fallback chain so personal MSA accounts (which lack the `email` claim) still resolve a display label via `preferred_username`
- `MICROSOFT_CONNECT_CLIENT_ID` and `MICROSOFT_CONNECT_CLIENT_SECRET` in the C13 productionize secret catalog with Azure Portal obtain instructions
- Default scopes `['openid', 'email', 'offline_access', 'Mail.Read', 'Mail.Send', 'Calendars.ReadWrite']` on the Microsoft descriptor
- Scope-narrowing guard (`unionScopes`) in `completeConnect` — Microsoft has no `include_granted_scopes` equivalent so a partial re-consent callback cannot silently narrow the stored scope list; the union of old + new scopes is always persisted

### Changed
- `tests/connectors.test.ts` — added unit tests for `accountLabelFrom` (preferred_username fallback for personal MSA accounts), `unionScopes`, the Microsoft connect/disconnect flow (no-revoke confirmed), and the **partial-re-consent scope-narrowing guard** (test would fail against a naive scope overwrite)
- `tests/send-message.test.ts` — added Microsoft Graph send path tests (`email:microsoft` dispatch, `insufficient_scope`, `not_found`, failure recording + scrubbing) and `buildGraphSendBody` unit tests (recipients, HTML, cc/bcc, conversationId, internetMessageHeaders, Display-Name parsing)
