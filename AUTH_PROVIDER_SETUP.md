# Setting up auth sign-in providers (Google OAuth + SMTP)

Companion to [PROVISIONING.md](PROVISIONING.md). A Forge app's hosted auth (capability **C10**) offers
**Google sign-in** and **email + password**. Each needs credentials only a human can create:

- **Google sign-in** → `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`
- **Email + password** (signup verification + password reset, via **C12** email) → `SMTP_URL` + `EMAIL_FROM`

With **neither** configured, `/auth/signup` shows no form and there is no way to sign in — configure at
least one. Throughout, replace **`<your-app-host>`** with your app's public host (example:
`forge-os.mardash.ai`) and **`<app>`** with your app name (example: `forge-os`). Put the resulting
values in your app's gitignored `app/.env.prod` and run `forge deploy --app <app>` (see
[PROVISIONING.md](PROVISIONING.md)).

## Google OAuth client (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`)

Done in the Google Cloud Console. Free — you do **not** need to enable billing.

**Where:** <https://console.cloud.google.com> — sign in with the Google account that should own it (a
personal Gmail is fine).

1. **Create a project** — top-bar project dropdown → **New Project** → name it (e.g. `<app>`) →
   **Create** → select it.
2. **Configure the consent screen** — ☰ → **APIs & Services** → **OAuth consent screen** (newer
   console: **Google Auth Platform → Get started**). Set **App name**, **User support email**,
   **Audience: External**, **Developer contact email** → **Create**. On the **Audience** tab, click
   **Publish app → In production** to allow anyone to sign up (basic sign-in scopes need no Google
   verification; an "unverified app" notice may appear). *Alternative:* leave it in **Testing** and add
   specific accounts under **Test users**.
3. **Create the OAuth client** — **APIs & Services → Credentials → Create credentials → OAuth client
   ID** → **Application type: Web application** → name it → under **Authorized redirect URIs** add
   EXACTLY:

   ```
   https://<your-app-host>/auth/google/callback
   ```

   (Authorized JavaScript origins can be left empty — the token exchange is server-side.) → **Create**.
4. **Copy** the **Client ID** (ends `…apps.googleusercontent.com`) and **Client secret** → these are
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

**Notes:** the redirect URI must match **exactly** (scheme, host, path, no trailing slash) — a mismatch
is the #1 cause of `redirect_uri_mismatch`. If the console UI differs, the anchors are **"OAuth consent
screen"** and **"Credentials → OAuth client ID"**.

## SMTP provider (`SMTP_URL` + `EMAIL_FROM`)

There's no single "SMTP site" — pick a transactional email provider, verify a sender, and get SMTP
credentials. You will produce:

```
SMTP_URL=smtp://<user>:<password>@<host>:<port>
EMAIL_FROM=<App> <no-reply@<your-domain>>
```

**Recommended: SendGrid** (simplest SMTP — the username is the literal word `apikey`, the password is
your API key):

1. **Sign up** — <https://sendgrid.com> → **Start for free** (Twilio SendGrid; free tier ~100
   emails/day). Verify your email, finish onboarding.
2. **Verify who you send as** — Settings → **Sender Authentication**. Either **Verify a Single Sender**
   (no DNS; enter a from-address you can *receive* at, click the emailed link — then `EMAIL_FROM` must
   be that address) **or** **Authenticate Your Domain** (add the given CNAME records to
   `<your-domain>` DNS — then you can send from any `@<your-domain>` address, including `no-reply@`).
   For a `no-reply@<your-domain>` address, use Domain Authentication.
3. **Create the API key** — Settings → **API Keys → Create API Key** → **Full Access** (or Restricted
   with **Mail Send**) → copy the `SG.…` key (shown once).
4. **Assemble:**

   ```
   SMTP_URL=smtp://apikey:SG.xxxxxxxxxxxx@smtp.sendgrid.net:587
   EMAIL_FROM=<App> <no-reply@<your-domain>>
   ```

**Other providers** follow the same pattern (sign up → verify sender/domain → get SMTP creds →
assemble the URL):

| Provider | SMTP host | Port | Username | Password |
|---|---|---|---|---|
| SendGrid | `smtp.sendgrid.net` | 587 | `apikey` (literal) | `SG.…` API key |
| Brevo | `smtp-relay.brevo.com` | 587 | your Brevo login email | SMTP key from the dashboard |
| Mailgun | `smtp.mailgun.org` | 587 | `postmaster@<your-domain>` | the domain's SMTP password |
| Amazon SES | `email-smtp.<region>.amazonaws.com` | 587 | SES SMTP username | SES SMTP password |

**Gotcha:** if the password contains reserved URL characters (`@ : / #`), URL-encode them (e.g. `@` →
`%40`) since it's embedded in the `smtp://user:pass@host` URL. SendGrid keys are URL-safe.

## Apply it

Put the values in `app/.env.prod`, then:

```sh
forge deploy --app <app>
curl https://<your-app-host>/auth/config     # → google:true and/or password_signup:true
```

Reload `/auth/signup` — the form appears (SMTP) and/or "Sign in with Google" works. DNS-based domain
authentication can take minutes to propagate before it verifies; everything else is instant.
