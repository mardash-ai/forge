### Added
- **message-microsoft plugin** (`src/plugins/message-microsoft/`): calls Microsoft Graph `POST /me/sendMail` as the connected user (delegated `Mail.Send` permission), with swappable `GraphMailSender` for test isolation. Registered as `email:microsoft` in the `send-message` capability's sender dispatch table alongside `email:google`.
- **MICROSOFT_CONNECT_CLIENT_ID / MICROSOFT_CONNECT_CLIENT_SECRET** added to the productionize secret catalog (C24 · Connectors), so generated provisioning docs and `PROVISIONING.md` describe how to set up the Azure App Registration.

### Changed
- **Connector descriptor default scopes** for Microsoft widened to `openid email offline_access Mail.Read Mail.Send Calendars.ReadWrite` (short-form, matching what Microsoft v2.0 token endpoint returns in scope strings).
- **`account_label_claim` → `account_label_claims: string[]`** in `ProviderDescriptor`: the connector now tries each claim in order and takes the first non-empty value. Microsoft descriptor uses `['email', 'preferred_username']` so personal MSA accounts (which lack `email`) are still labeled via `preferred_username`.
- **Scope-narrowing guard in `completeConnect`**: stored scope list is now always the SET UNION of the previously-stored scopes and the callback's granted scopes. Prevents a partial Microsoft re-consent (Microsoft has no `include_granted_scopes`) from silently revoking already-granted capabilities.
