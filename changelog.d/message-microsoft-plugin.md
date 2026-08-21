### Added
- **message-microsoft plugin** (`src/plugins/message-microsoft/`) — calls Microsoft Graph `POST /me/sendMail` as the authenticated user; registered as `email:microsoft` in the C25 send-message dispatch table alongside `email:google`
- **`account_label_claim` fallback** — connector `accountLabelFrom` tries `preferred_username` when `email` is absent from the OIDC id\_token; personal Microsoft accounts (MSA) are now labeled correctly
- **`MICROSOFT_CONNECT_CLIENT_ID` / `MICROSOFT_CONNECT_CLIENT_SECRET`** entries in the productionize secret catalog with full provisioning docs (Azure Portal app-registration steps)
- **Scope union guard** — `completeConnect` calls `unionScopes(existing, incoming)` instead of overwriting, so a partial Microsoft re-consent can never narrow a connection's stored scope list

### Changed
- Microsoft connector descriptor `default_scopes` widened to `openid email offline_access Mail.Read Mail.Send Calendars.ReadWrite`

### Fixed
- Scope-narrowing hazard on Microsoft re-consent: Microsoft has no `include_granted_scopes` equivalent; the callback's granted-scope list is now unioned with the stored set rather than overwriting it
